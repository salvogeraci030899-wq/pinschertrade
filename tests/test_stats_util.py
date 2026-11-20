"""Test delle statistiche comuni e dello storico a pagine. `python3 tests/test_stats_util.py` oppure pytest."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import market_data as md  # noqa: E402
import stats_util as st  # noqa: E402
from market_data import FEE_PCT, SLIPPAGE_PCT, TAX_RATE  # noqa: E402

H = 3600
T0 = 1_700_000_000 - (1_700_000_000 % (28 * H))  # nel passato: le candele risultano chiuse
COSTS = (FEE_PCT + SLIPPAGE_PCT) * 2


def test_costi_e_tasse_sul_totale():
    assert abs(st.COST_ROUND_TRIP - COSTS) < 1e-12
    assert abs(st.after_tax_total(10.0) - 10.0 * (1 - TAX_RATE)) < 1e-12 and st.after_tax_total(-4.0) == -4.0


def test_intervalli_e_giudizio():
    rng = np.random.default_rng(1)
    v = rng.normal(1.0, 1.0, 400)
    ci = st.cluster_ci(v, np.arange(400))
    assert ci[0] < 1.0 < ci[1] and ci[0] > 0.7 and ci[1] < 1.3
    # stessi valori ma tutti dipendenti a gruppi di 40: intervallo più largo
    wide = st.cluster_ci(np.repeat(v[:10], 40), np.repeat(np.arange(10), 40))
    assert wide[1] - wide[0] > ci[1] - ci[0]
    assert st.cluster_ci(v[:4], np.arange(4)) is None       # troppo pochi blocchi
    assert st.verdict([0.1, 0.5], 100) == "positivo" and st.verdict([-0.5, -0.1], 100) == "negativo"
    assert st.verdict([-0.1, 0.5], 100) == "non_dimostrato"
    assert st.verdict([0.1, 0.5], 10) == "campione_insufficiente" and st.verdict(None, 100) == "campione_insufficiente"


def _net(gross):
    return gross - COSTS   # tasse escluse dal singolo trade


def test_simulazione_di_un_piano():
    flat = {"open": 100, "high": 100.5, "low": 99.5, "close": 100}
    long = {"direction": "LONG", "entry": 100.0, "stop_loss": 98.0, "take_profit": 104.0}
    # target toccato
    t = st.simulate_plan(long, [flat, flat, {"open": 100, "high": 104.5, "low": 99.8, "close": 104}])
    assert t["exit_reason"] == "TP" and abs(t["net_pct"] - round(_net(4.0), 4)) < 1e-9
    # stop e target nella stessa candela: conta lo stop
    t = st.simulate_plan(long, [flat, {"open": 100, "high": 105, "low": 97, "close": 100}])
    assert t["exit_reason"] == "SL" and abs(t["net_pct"] - round(_net(-2.0), 4)) < 1e-9
    # nessun tocco: uscita alla chiusura dell'ultima candela
    t = st.simulate_plan(long, [flat, {"open": 100, "high": 101.5, "low": 99.5, "close": 101}])
    assert t["exit_reason"] == "TEMPO" and t["exit_price"] == 101
    # short
    short = {"direction": "SHORT", "entry": 100.0, "stop_loss": 102.0, "take_profit": 96.0}
    t = st.simulate_plan(short, [flat, {"open": 100, "high": 100.2, "low": 95.5, "close": 96}])
    assert t["exit_reason"] == "TP" and t["gross_pct"] == 4.0


def test_statistiche_dei_trade():
    s = st._trade_stats([2.0, -1.0, 3.0, -1.0])
    assert s["n"] == 4 and s["win_rate"] == 50.0 and s["total_net_pct"] == 3.0 and s["profit_factor"] == 2.5
    assert s["max_drawdown_pct"] == -1.0 and st._trade_stats([]) == {"n": 0}


def test_download_a_pagine_e_ripresa():
    # finto Bitget: 1000 candele da 1h, pagine da 200 andando indietro
    now = T0 + 400 * H
    all_ts = [(T0 - 599 * H + i * H) * 1000 for i in range(1000)]
    calls = []

    class Resp:
        def __init__(self, data): self.data = data
        def raise_for_status(self): pass
        def json(self): return {"code": "00000", "data": self.data}

    # Bitget arrotonda endTime alla candela; a seconda dell'endpoint la candela di endTime è esclusa
    # o inclusa: in entrambi i casi lo storico scaricato non deve avere buchi tra una pagina e l'altra
    for inclusive in (False, True):
        def fake_get(url, params=None, timeout=None, inclusive=inclusive):
            calls.append(url)
            end = params["endTime"] // (H * 1000) * (H * 1000)
            page = [t for t in all_ts if t < end or (inclusive and t == end)][-params["limit"]:]
            return Resp([[str(t), "50000", "50100", "49900", "50000", "5", "500", "500"] for t in page])

        calls.clear()
        orig = md.requests.get
        md.requests.get = fake_get
        try:
            df = md.download_history("BTCUSDT", "1h", all_ts[300], now_ms=now * 1000, pause=0)
        finally:
            md.requests.get = orig
        assert len(df) >= 700 and df["time"].is_monotonic_increasing and df["time"].is_unique
        assert int(df["time"].iloc[0].timestamp()) * 1000 <= all_ts[300]
        assert set(df["time"].diff().dropna()) == {pd.Timedelta(hours=1)}       # nessuna candela persa
        assert all(u == md.BITGET_HISTORY_URL for u in calls)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test superati")

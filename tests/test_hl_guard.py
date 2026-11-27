"""Guardiano Hyperliquid: decisioni pure e un giro completo con un conto finto (nessuna rete)."""
from datetime import datetime, timezone

import hl_guard as g

NOW = datetime(2026, 11, 27, 16, 0, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
H = 3600000


def long_pos(entry=74.0, liq=67.5):
    return {"dir": 1, "entry": entry, "liq": liq}


def short_pos(entry=77.5, liq=84.5):
    return {"dir": -1, "entry": entry, "liq": liq}


# ---------- regole ----------

def test_nessuna_azione_sotto_le_soglie():
    assert g.plan(long_pos(), 74.8, 75.0, 0.8, 71.5, 3)["action"] is None


def test_pareggio_a_piu_due_per_cento():
    p = g.plan(long_pos(), 75.6, 75.6, 0.8, 71.5, 3)           # +2,16%
    assert p["action"] == "set_sl"
    assert abs(p["sl"] - 74.0 * 1.0015) < 1e-9
    assert "pareggio" in p["why"]


def test_trailing_oltre_tre_e_mezzo():
    p = g.plan(long_pos(), 77.0, 77.2, 0.8, 74.11, 5)           # miglior prezzo +4,3%
    assert p["action"] == "set_sl"
    assert abs(p["sl"] - (77.2 - 1.5 * 0.8)) < 1e-9             # 76,0 > pareggio
    assert "trailing" in p["why"]


def test_lo_stop_non_si_allontana_mai():
    # stop già a 76,5: il trailing a 76,0 lo allargherebbe -> nessuna azione
    assert g.plan(long_pos(), 77.0, 77.2, 0.8, 76.5, 5)["action"] is None


def test_lo_stop_non_supera_il_prezzo():
    # il prezzo è sceso sotto il livello del trailing: lo stop si ferma appena sotto il prezzo
    p = g.plan(long_pos(), 75.0, 78.0, 0.8, 74.11, 5)
    assert p["action"] == "set_sl"
    assert p["sl"] < 75.0 and abs(p["sl"] - 75.0 * 0.997) < 1e-9


def test_short_speculare():
    p = g.plan(short_pos(), 75.9, 75.8, 0.8, 80.5, 4)           # -2,2% a favore dello short
    assert p["action"] == "set_sl"
    assert abs(p["sl"] - 77.5 * (1 - 0.0015)) < 1e-9
    p = g.plan(short_pos(), 74.4, 74.2, 0.8, 77.38, 6)          # trailing: minimo 74,2 + 1,2
    assert abs(p["sl"] - 75.4) < 1e-9


def test_chiusura_vicino_alla_liquidazione():
    assert g.plan(long_pos(liq=67.5), 68.5, 74.0, 0.8, None, 1)["action"] == "close"


def test_chiusura_dopo_48_ore_ferma():
    assert g.plan(long_pos(), 74.5, 75.0, 0.8, 71.5, 49)["action"] == "close"
    assert g.plan(long_pos(), 74.5, 75.0, 0.8, 71.5, 47)["action"] is None
    # se si è mosso oltre ±2% non è "fermo"
    assert g.plan(long_pos(), 72.0, 74.5, 0.8, 71.5, 60)["action"] is None


def test_stop_mancante_mai_oltre_la_liquidazione():
    p = g.plan(long_pos(entry=74.0, liq=72.0), 74.0, 74.0, 0.8, None, 0)
    assert p["action"] == "set_sl"
    assert 72.0 < p["sl"] < 74.0 and abs(p["sl"] - (74.0 - 2.0 * 0.7)) < 1e-9


def test_prezzi_arrotondati_come_vuole_hyperliquid():
    assert g.round_px(74.123456, 2) == 74.123          # 5 cifre significative
    assert g.round_px(0.1234567, 0) == 0.12346
    assert g.round_px(104567.8, 5) == 104568.0
    assert g.round_px(2.1234567, 5) == 2.1             # 6 - 5 decimali


def test_atr():
    c = [{"h": 10, "l": 9, "c": 9.5}, {"h": 10.5, "l": 9.5, "c": 10}, {"h": 11, "l": 10, "c": 10.5}]
    assert g.atr(c) == 1.0


# ---------- un giro completo con un conto finto ----------

class FakeInfo:
    def __init__(self, mark=77.0, sl=74.11, entry=74.0, peak=77.2):
        self.mark, self.sl, self.entry, self.peak = mark, sl, entry, peak

    def meta(self):
        return {"universe": [{"name": "SOL", "szDecimals": 2}]}

    def meta_and_asset_ctxs(self):
        return [self.meta(), [{"funding": "0.0000125"}]]

    def all_mids(self):
        return {"SOL": str(self.mark)}

    def user_state(self, addr):
        return {"assetPositions": [
            {"position": {"coin": "SOL", "szi": "9.5", "entryPx": str(self.entry), "liquidationPx": "67.5"}},
            {"position": {"coin": "xyz:TSLA", "szi": "1", "entryPx": "300", "liquidationPx": None}},
        ]}

    def frontend_open_orders(self, addr):
        out = [{"coin": "SOL", "side": "A", "isTrigger": True, "orderType": "Take Profit Market", "triggerPx": "78", "oid": 2}]
        if self.sl:
            out.append({"coin": "SOL", "side": "A", "isTrigger": True, "orderType": "Stop Market", "triggerPx": str(self.sl), "oid": 1})
        return out

    def user_fills_by_time(self, addr, start):
        return [{"coin": "SOL", "dir": "Open Long", "startPosition": "0", "time": NOW_MS - 5 * H}]

    def candles_snapshot(self, coin, interval, start, end):
        if interval == "1h":
            return [{"t": end - (20 - i) * H, "h": 75 + 0.4, "l": 75 - 0.4, "c": 75} for i in range(20)]
        return [{"t": NOW_MS - 4 * H, "h": self.peak, "l": 74.0, "c": 76.5},
                {"t": NOW_MS - 7 * H, "h": 99.0, "l": 60.0, "c": 70.0},     # prima dell'apertura: ignorata
                {"t": NOW_MS - 5 * 60000, "h": self.mark, "l": self.mark, "c": self.mark}]


class FakeExchange:
    def __init__(self, ok=True):
        self.calls, self.ok = [], ok

    def order(self, *a, **k):
        self.calls.append(("order", a, k))
        if not self.ok:
            return {"status": "ok", "response": {"data": {"statuses": [{"error": "Prezzo non valido"}]}}}
        return {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 3}}]}}}

    def cancel(self, coin, oid):
        self.calls.append(("cancel", coin, oid))
        return {"status": "ok"}

    def market_close(self, coin):
        self.calls.append(("close", coin))
        return {"status": "ok", "response": {"data": {"statuses": [{"filled": {}}]}}}


def test_giro_attivo_prima_mette_il_nuovo_stop_poi_toglie_il_vecchio():
    ex, msgs, state = FakeExchange(), [], {}
    n, npos = g.run_once(FakeInfo(), ex, msgs.append, "0xabc", "attivo", state, now=NOW)
    assert (n, npos) == (1, 1)                                  # il mercato HIP-3 è escluso
    kind, args, kw = ex.calls[0]
    assert kind == "order" and args[0] == "SOL" and args[1] is False and args[2] == 9.5
    assert args[4]["trigger"]["triggerPx"] == 76.0 and args[4]["trigger"]["tpsl"] == "sl"   # 77,2 - 1,5 × ATR 0,8
    assert kw == {"reduce_only": True}
    assert ex.calls[1] == ("cancel", "SOL", 1)                  # solo lo stop, non il take profit
    assert len(ex.calls) == 2
    assert "stop spostato" in msgs[0]


def test_giro_osserva_non_tocca_niente_e_non_ripete():
    ex, msgs, state = FakeExchange(), [], {}
    g.run_once(FakeInfo(), ex, msgs.append, "0xabc", "osserva", state, now=NOW)
    g.run_once(FakeInfo(), ex, msgs.append, "0xabc", "osserva", state, now=NOW)
    assert ex.calls == []
    assert len(msgs) == 1 and msgs[0].startswith("[osserva]")


def test_ordine_rifiutato_lascia_il_vecchio_stop():
    ex, msgs = FakeExchange(ok=False), []
    g.run_once(FakeInfo(), ex, msgs.append, "0xabc", "attivo", {}, now=NOW)
    assert [c[0] for c in ex.calls] == ["order"]               # nessuna cancellazione
    assert "non accettato" in msgs[0]


def test_posizione_chiusa_si_dimentica():
    state = {"positions": {"SOL:1:70.0": {"first_seen": 0}}}
    g.run_once(FakeInfo(), None, lambda m: None, "0xabc", "osserva", state, now=NOW)
    assert "SOL:1:70.0" not in state["positions"]

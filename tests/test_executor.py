"""Test dell'esecutore e del client Bitget (Bitget simulato). `python3 tests/test_executor.py` oppure pytest."""
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import automation as au  # noqa: E402
import bitget_client as bg  # noqa: E402
import executor as ex  # noqa: E402

D = 86400
NOW = datetime(2026, 12, 1, 0, 30, tzinfo=timezone.utc)
T_SIGNAL = int(NOW.timestamp()) // D * D - D          # candela di ieri: si entra alla sua chiusura (mezzanotte)
SPECS = lambda s: {"volume_place": 3, "price_place": 1, "min_size": 0.001}


def trade(symbol="BTCUSDT", direction=1, entry=100_000.0, stop=98_000.0, t=T_SIGNAL, open_=True):
    return {"id": f"big_candle_trail:1d:{symbol}:{t}", "symbol": symbol, "t": t, "t_entry": t + D, "dir": direction,
            "entry": entry, "stop": stop, "open": open_, "gross": 0.0}


def setup(trades, mode="live", cfg_extra=None):
    cfg = {"strategies": {"big_candle_trail:1d": mode}, "emergency": False, "risk": {}}
    cfg.update(cfg_extra or {})
    ledger = {"strategies": {"big_candle_trail:1d": {"mode": mode, "trades": trades}}}
    return cfg, ledger


def go(cfg, ledger, path, client=None, now=NOW, notes=None):
    # prezzi e funding finti: i test non devono dipendere dalla rete (su GitHub i prezzi veri di Bitget farebbero cambiare il conto)
    return ex.run(cfg, ledger, client, "demo" if client else "simulata", path, now=now, notify=(notes.append if notes is not None else None), specs_fn=SPECS,
                  prices_fn=lambda syms: {}, funding_fn=lambda syms: {})


def test_dimensionamento():
    risk = ex.risk_config({})
    # patrimonio 10.000, rischio 0,5% = 50 USDT, stop al 2%: nominale 2.500 -> 0,025 BTC
    size, why = ex.size_position(10_000, 100_000, 98_000, risk, 0, SPECS(""))
    assert size == 0.025 and why == ""
    # stop strettissimo: la leva massima (3x) taglia a 30.000, poi l'esposizione totale (1,5x) a 15.000
    size, _ = ex.size_position(10_000, 100_000, 99_990, risk, 0, SPECS(""))
    assert size == 0.15
    size, _ = ex.size_position(10_000, 100_000, 99_990, dict(risk, max_exposure_x=3.0, max_leverage=2), 0, SPECS(""))
    assert size == 0.2                                                    # qui decide la leva
    # esposizione totale: 1,5x = 15.000, già 14.000 aperti -> restano 1.000
    size, _ = ex.size_position(10_000, 100_000, 98_000, risk, 14_000, SPECS(""))
    assert size == 0.01
    assert ex.size_position(10_000, 100_000, 98_000, risk, 15_000, SPECS(""))[1] == "esposizione totale al massimo"
    assert ex.size_position(10, 100_000, 98_000, risk, 0, SPECS(""))[1] == "quantità sotto il minimo del contratto"
    assert ex.size_position(10_000, 100_000, 100_000, risk, 0, SPECS(""))[1] == "stop uguale all'ingresso"


def test_ciclo_apertura_e_chiusura_simulato():
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        cfg, ledger = setup([trade()], cfg_extra={"risk": {"dry_run_equity": 10_000}})
        assert go(cfg, ledger, path, notes=notes) is True
        st = json.load(open(path))
        p = st["positions"][trade()["id"]]
        assert p["status"] == "open" and p["size"] == 0.025 and p["stop"] == 98_000.0 and p["side"] == "long" and st["mode"] == "simulata"
        assert st["simulated"]["positions"] == {"BTCUSDT": {"side": "long", "size": 0.025, "entry": 100_000.0, "funded_to": int(NOW.timestamp())}}
        assert len(notes) == 1 and "SIMULATA" in notes[0] and "Aperta BTCUSDT LONG" in notes[0]
        # stesso giro: nessun doppione
        assert go(cfg, ledger, path, notes=notes) is False and len(notes) == 1
        # il trade su carta si chiude: si chiude anche la posizione
        cfg, ledger = setup([trade(open_=False)], cfg_extra={"risk": {"dry_run_equity": 10_000}})
        go(cfg, ledger, path, notes=notes)
        st = json.load(open(path))
        assert st["positions"][trade()["id"]]["status"] == "closed" and st["simulated"]["positions"] == {} and "Chiusa BTCUSDT" in notes[-1]


def test_solo_strategie_live():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        # con un client vero REALE una strategia su carta non apre mai ordini; la demo (soldi finti) la segue
        cfg, ledger = setup([trade()], mode="paper")
        ex.run(cfg, ledger, bg.DryRunClient(10_000), "reale", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {})
        assert json.load(open(path))["positions"] == {}
        # scelta esplicita: con real_follows_paper = 1 anche il reale segue la carta (stessi limiti), altrimenti no
        cfg_f, ledger_f = setup([trade()], mode="paper", cfg_extra={"risk": {"real_follows_paper": 1}})
        ex.run(cfg_f, ledger_f, bg.DryRunClient(10_000), "reale", os.path.join(d, "follow.json"), now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {})
        assert [p["status"] for p in json.load(open(os.path.join(d, "follow.json")))["positions"].values()] == ["open"]
        assert ex.risk_config({})["real_follows_paper"] == 0 and ex.RISK_BOUNDS["real_follows_paper"] == (0, 1)
        demo = os.path.join(d, "demo.json")
        go(cfg, ledger, demo, bg.DryRunClient(10_000))                                     # mode "demo"
        assert [p["status"] for p in json.load(open(demo))["positions"].values()] == ["open"]
        cfg0, ledger0 = setup([trade()], mode="paper", cfg_extra={"risk": {"shadow_paper": False}})
        go(cfg0, ledger0, os.path.join(d, "demo0.json"), bg.DryRunClient(10_000))          # con shadow spento neanche la demo
        assert json.load(open(os.path.join(d, "demo0.json")))["positions"] == {}
        # shadow spento: neanche il conto simulato segue la carta
        cfg, ledger = setup([trade()], mode="paper", cfg_extra={"risk": {"shadow_paper": False}})
        go(cfg, ledger, os.path.join(d, "b.json"))
        assert json.load(open(os.path.join(d, "b.json")))["positions"] == {}
        # live nel registro ma non più live in automation.json: nessun ingresso
        cfg, ledger = setup([trade()])
        cfg["strategies"] = {}
        go(cfg, ledger, path)
        assert json.load(open(path))["positions"] == {}


def test_la_carta_segue_il_reale_con_gli_stessi_limiti():
    # con gli ordini simulati le strategie su carta sono seguite come se fossero live: stessi limiti, stessa dimensione
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        shorts = [trade("BTCUSDT", -1, 100_000, 102_000), trade("ETHUSDT", -1, 3000, 3060), trade("SOLUSDT", -1, 150, 153), trade("XRPUSDT", -1, 1.0, 1.02)]
        cfg, ledger = setup(shorts, mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "max_open_positions": 4, "risk_per_trade_pct": 1.0}})
        go(cfg, ledger, path)
        st = json.load(open(path))
        opened = [p for p in st["positions"].values() if p["status"] == "open"]
        assert len(opened) == 2 and all(p["side"] == "short" for p in opened)             # max_same_direction = 2, come nel reale
        assert sum("stesso verso" in (p.get("reason") or "") for p in st["positions"].values()) == 2
        btc = st["positions"][shorts[0]["id"]]
        assert btc["size"] == 0.05 and btc["status"] == "open"                              # 1% di 10.000 = 100 USDT, stop al 2%: nominale 5.000
        assert st["simulated"]["start"] == 10_000


def test_conto_simulato_vero_cassa_commissioni_e_non_realizzato():
    c = bg.DryRunClient(10_000)
    c.set_marks({"BTCUSDT": 100_000})
    c.open_position("BTCUSDT", "short", 0.1, 102_000, price=100_000)
    assert round(c._equity, 2) == 10_000 - 0.1 * 100_000 * 0.0011                          # commissione d'ingresso (11 USDT)
    c.set_marks({"BTCUSDT": 98_000})
    assert round(c.equity(), 2) == round(10_000 - 11 + 200, 2)                              # short in guadagno di 200 (non realizzato)
    c.close_position("BTCUSDT", "short", price=98_000)
    assert c.positions() == {} and round(c._equity, 2) == round(10_000 - 11 + 200 - 0.1 * 98_000 * 0.0011, 2)
    assert abs(c.realized - (c._equity - 10_000)) < 1e-9
    # senza prezzo d'ingresso (stato vecchio) niente guadagno non realizzato e nessun errore
    old = bg.DryRunClient(5_000, {"ETHUSDT": {"side": "long", "size": 1}})
    assert old.equity() == 5_000 and old.close_position("ETHUSDT", "long") == {} and old._equity == 5_000


def test_la_carta_chiude_al_prezzo_della_carta_e_conta_il_netto():
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        t0 = trade("BTCUSDT", -1, 100_000.0, 102_000.0)
        cfg, ledger = setup([t0], mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0}})
        go(cfg, ledger, path, notes=notes)
        closed = dict(t0, open=False, exit=98_000.0)
        cfg, ledger = setup([closed], mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0}})
        go(cfg, ledger, path, notes=notes)
        st = json.load(open(path))
        p = st["positions"][t0["id"]]
        # nominale 5.000 (0,05 BTC): short da 100.000 a 98.000 = +100 USDT lordi, meno 2 x 0,11% di commissione
        assert p["status"] == "closed" and p["exit"] == 98_000.0
        assert abs(p["net"] - (100 - 0.05 * 100_000 * 0.0011 - 0.05 * 98_000 * 0.0011)) < 0.01
        assert abs(st["simulated"]["cash"] - (10_000 + 100 - 5.5 - 5.39)) < 0.02 and st["simulated"]["positions"] == {}
        assert "netto" in notes[-1]


def test_funding_e_statistiche_per_strategia_del_conto_simulato():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        t0 = trade("BTCUSDT", 1, 100_000.0, 98_000.0)
        risk = {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0}
        cfg, ledger = setup([t0], mode="paper", cfg_extra={"risk": risk})
        go(cfg, ledger, path)
        # dopo 17 ore (due regolazioni: 08:00 e 16:00) il long paga il funding sul nominale 5.000 (0,05 BTC a 100.000)
        later = datetime(2026, 12, 1, 17, 30, tzinfo=timezone.utc)
        ex.run(cfg, ledger, None, "simulata", path, now=later, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 100_000.0}, funding_fn=lambda s: {"BTCUSDT": 0.0001})
        st = json.load(open(path))
        pos = st["simulated"]["positions"]["BTCUSDT"]
        assert abs(pos["funding"] - 2 * 0.05 * 100_000 * 0.0001) < 1e-6 and pos["funded_to"] == int(later.timestamp())
        # senza una nuova regolazione non si paga di nuovo
        ex.run(cfg, ledger, None, "simulata", path, now=later, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 100_000.0}, funding_fn=lambda s: {"BTCUSDT": 0.0001})
        assert abs(json.load(open(path))["simulated"]["positions"]["BTCUSDT"]["funding"] - 1.0) < 1e-6
        # chiusura a +2%: il netto comprende commissioni e funding
        closed = dict(t0, open=False, exit=102_000.0)
        cfg, ledger = setup([closed], mode="paper", cfg_extra={"risk": risk})
        ex.run(cfg, ledger, None, "simulata", path, now=later, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {})
        st = json.load(open(path))
        p = st["positions"][t0["id"]]
        expected = 0.05 * 2_000 - 0.05 * 100_000 * 0.0011 - 0.05 * 102_000 * 0.0011 - 1.0
        assert abs(p["net"] - expected) < 0.01 and p["funding"] == 1.0
        s = st["strategy_stats"]["big_candle_trail:1d"]
        assert s["n"] == 1 and s["open"] == 0 and abs(s["avg_net_pct"] - expected / 5_000 * 100) < 0.01


def test_perdita_del_giorno_con_il_non_realizzato_nel_conto_simulato():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        longs = [trade("BTCUSDT", 1, 100_000, 98_000)]
        cfg, ledger = setup(longs, mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0, "max_daily_loss_pct": 3}})
        go(cfg, ledger, path)                                                              # apre a 100.000
        # il prezzo scende del 4% con 0,5 BTC a mercato... esposizione 5.000: -4% di 5.000 = -200 = -2% del conto
        big = [trade("BTCUSDT", 1, 100_000, 98_000), trade("ETHUSDT", 1, 3000, 2940, t=T_SIGNAL + 1)]
        cfg, ledger = setup(big, mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0, "max_daily_loss_pct": 1.5}})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda syms: {"BTCUSDT": 96_000.0})
        st = json.load(open(path))
        assert st["day"]["blocked"] is True and st["positions"][big[1]["id"]]["reason"] == "limite di perdita giornaliera"
        assert st["simulated"]["unrealized"] < 0


def test_ripartenza_da_zero_solo_il_conto_simulato():
    with tempfile.TemporaryDirectory() as d:
        path, ep = os.path.join(d, "live.json"), os.path.join(d, "reset_epoch.json")
        cfg, ledger = setup([trade()], mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000}})
        json.dump({"epoch": "A"}, open(ep, "w"))
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {}, epoch_path=ep)
        st = json.load(open(path))
        assert st["epoch"] == "A" and st["positions"][trade()["id"]]["status"] == "open"
        # stessa epoca: non si azzera
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {}, epoch_path=ep)
        assert json.load(open(path))["positions"][trade()["id"]]["status"] == "open"
        # nuova epoca con ordini simulati: riparte da capo (qui l'ingresso e' nuovo e il conto torna al capitale)
        json.dump({"epoch": "B"}, open(ep, "w"))
        cfg2, ledger2 = setup([], mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000}})
        ex.run(cfg2, ledger2, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {}, epoch_path=ep)
        st = json.load(open(path))
        assert st["epoch"] == "B" and st["positions"] == {} and st["simulated"]["cash"] == 10_000
        # con un client vero l'epoca cambia ma le posizioni non si toccano
        cfg3, ledger3 = setup([trade()], mode="live", cfg_extra={"risk": {"dry_run_equity": 10_000}})
        client = bg.DryRunClient(10_000)
        ex.run(cfg3, ledger3, client, "demo", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {}, epoch_path=ep)
        json.dump({"epoch": "C"}, open(ep, "w"))
        ex.run(cfg3, ledger3, client, "demo", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {}, funding_fn=lambda s: {}, epoch_path=ep)
        st = json.load(open(path))
        assert st["epoch"] == "C" and st["positions"][trade()["id"]]["status"] == "open"


def test_ingressi_rifiutati():
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        old = trade(t=T_SIGNAL - 3 * D)
        cfg, ledger = setup([old, trade(), trade(symbol="BTCUSDT", t=T_SIGNAL + 1), trade("ETHUSDT", -1, 3000, 3060), trade("SOLUSDT", 1, 150, 145)],
                            cfg_extra={"risk": {"dry_run_equity": 10_000, "max_open_positions": 2}})
        go(cfg, ledger, path, notes=notes)
        pos = json.load(open(path))["positions"]
        assert pos[old["id"]]["status"] == "skipped" and "troppo vecchio" in pos[old["id"]]["reason"]
        assert pos[trade()["id"]]["status"] == "open"
        assert pos[trade(t=T_SIGNAL + 1)["id"]]["reason"] == "già una posizione su questa coin"
        assert pos[trade("ETHUSDT")["id"]]["status"] == "open" and pos[trade("ETHUSDT")["id"]]["side"] == "short"
        assert pos[trade("SOLUSDT")["id"]]["reason"] == "numero massimo di posizioni"
        assert sum("NON aperta" in n for n in notes) == 3


def test_massimo_nello_stesso_verso():
    # quattro short insieme (le coin scendono insieme): con il limite a 2 se ne aprono solo due
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        shorts = [trade("BTCUSDT", -1, 100_000, 102_000), trade("ETHUSDT", -1, 3000, 3060), trade("SOLUSDT", -1, 150, 153), trade("XRPUSDT", -1, 1.0, 1.02)]
        cfg, ledger = setup(shorts + [trade("DOGEUSDT", 1, 0.1, 0.098)], cfg_extra={"risk": {"dry_run_equity": 10_000, "max_open_positions": 6}})
        go(cfg, ledger, path)
        pos = json.load(open(path))["positions"]
        opened = [p for p in pos.values() if p["status"] == "open"]
        assert sum(p["side"] == "short" for p in opened) == 2
        assert sum(p["side"] == "long" for p in opened) == 1                    # un long passa ancora
        assert sum("stesso verso" in (p.get("reason") or "") for p in pos.values()) == 2
    assert ex.risk_config({})["max_same_direction"] == 2
    assert au.PROFILES["prudente"]["max_same_direction"] == 1


def test_perdita_giornaliera():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        client = bg.DryRunClient(10_000)
        cfg, ledger = setup([], cfg_extra={"risk": {"max_daily_loss_pct": 3}})
        go(cfg, ledger, path, client)
        client._equity = 9_600                                               # -4% nel giorno
        cfg, ledger = setup([trade()], cfg_extra={"risk": {"max_daily_loss_pct": 3}})
        go(cfg, ledger, path, client)
        st = json.load(open(path))
        assert st["day"]["blocked"] is True and st["positions"][trade()["id"]]["reason"] == "limite di perdita giornaliera"
        # il giorno dopo si riparte
        tomorrow = datetime(2026, 12, 2, 0, 30, tzinfo=timezone.utc)
        cfg, ledger = setup([trade(t=T_SIGNAL + D)])
        go(cfg, ledger, path, client, now=tomorrow)
        assert json.load(open(path))["positions"][trade(t=T_SIGNAL + D)["id"]]["status"] == "open"


def test_obiettivo_di_portafoglio_somma_vincenti_e_perdenti():
    """In aggiunta a stop e target dei singoli trade: se il totale delle posizioni aperte arriva a +X% si chiude tutto,
    anche se una posizione è in perdita. Le posizioni chiuse così non si riaprono."""
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        two = [trade("BTCUSDT", 1, 100_000, 98_000), trade("ETHUSDT", 1, 3000, 2940, t=T_SIGNAL + 1)]
        risk = {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0, "portfolio_target_pct": 0.5}
        cfg, ledger = setup(two, mode="paper", cfg_extra={"risk": risk})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 100_000.0, "ETHUSDT": 3000.0})
        st = json.load(open(path))
        assert sum(p["status"] == "open" for p in st["positions"].values()) == 2
        # BTC sale del 3% (guadagno), ETH scende dell'1% (perdita): il totale (circa +0,8% dopo i costi) supera +0,5% del conto
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, notify=notes.append, specs_fn=SPECS, funding_fn=lambda s: {},
               prices_fn=lambda s: {"BTCUSDT": 103_000.0, "ETHUSDT": 2970.0})
        st = json.load(open(path))
        assert all(p["status"] == "closed" and p["close_reason"] == "OBIETTIVO DI PORTAFOGLIO" for p in st["positions"].values())
        assert any("OBIETTIVO DI PORTAFOGLIO" in n for n in notes) and st["simulated"]["positions"] == {}
        # al giro dopo i trade su carta ancora aperti non si riaprono
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {})
        assert all(p["status"] == "closed" for p in json.load(open(path))["positions"].values())
    # spento (0): resta tutto aperto
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        cfg, ledger = setup(two, mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0}})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 100_000.0, "ETHUSDT": 3000.0})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 103_000.0, "ETHUSDT": 2970.0})
        assert sum(p["status"] == "open" for p in json.load(open(path))["positions"].values()) == 2
    # stop di portafoglio: -1% totale chiude tutto
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        cfg, ledger = setup(two, mode="paper", cfg_extra={"risk": {"dry_run_equity": 10_000, "risk_per_trade_pct": 1.0, "portfolio_stop_pct": 0.5}})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 100_000.0, "ETHUSDT": 3000.0})
        ex.run(cfg, ledger, None, "simulata", path, now=NOW, specs_fn=SPECS, prices_fn=lambda s: {"BTCUSDT": 98_500.0, "ETHUSDT": 2950.0})
        assert all(p["close_reason"] == "STOP DI PORTAFOGLIO" for p in json.load(open(path))["positions"].values())


def test_obiettivo_giornaliero():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        client = bg.DryRunClient(10_000)
        risk = {"risk": {"daily_target_pct": 2}}
        go(cfg=setup([], cfg_extra=risk)[0], ledger=setup([], cfg_extra=risk)[1], path=path, client=client)
        client._equity = 10_250                                              # +2,5% nel giorno
        notes = []
        cfg, ledger = setup([trade()], cfg_extra=risk)
        go(cfg, ledger, path, client, notes=notes)
        st = json.load(open(path))
        assert st["day"]["target_hit"] is True and st["positions"][trade()["id"]]["reason"] == "obiettivo del giorno già raggiunto"
        assert any("Obiettivo del giorno raggiunto" in n for n in notes)
        # senza obiettivo (0) si entra
        with tempfile.TemporaryDirectory() as d2:
            p2 = os.path.join(d2, "live.json")
            c2 = bg.DryRunClient(10_000)
            go(*setup([]), p2, c2)
            c2._equity = 10_500
            go(*setup([trade()]), p2, c2)
            assert json.load(open(p2))["positions"][trade()["id"]]["status"] == "open"


def test_riconciliazione_e_sblocco():
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        client = bg.DryRunClient(10_000)
        sym = trade()["symbol"]
        other = "ETHUSDT" if sym != "ETHUSDT" else "SOLUSDT"
        # posizione aperta a mano su un'altra coin: non blocca, l'esecutore apre la sua
        client._positions = {other: {"side": "long", "size": 1.0, "entry": 2000.0}}
        cfg, ledger = setup([trade()])
        go(cfg, ledger, path, client, notes=notes)
        st = json.load(open(path))
        assert st["halted"] is False and st["manual"] == [other] and st["positions"][trade()["id"]]["status"] == "open"
        # posizione manuale sulla stessa coin di un segnale nuovo: niente ingresso su quella coin
        with tempfile.TemporaryDirectory() as d2:
            p2, c2 = os.path.join(d2, "live.json"), bg.DryRunClient(10_000)
            c2._positions = {sym: {"side": "short", "size": 0.1, "entry": 70000.0}}
            go(cfg, ledger, p2, c2, notes=notes)
            s2 = json.load(open(p2))
            assert s2["halted"] is False and s2["positions"][trade()["id"]]["status"] == "skipped" and "a mano" in s2["positions"][trade()["id"]]["reason"]
        # la posizione dell'esecutore sparisce da Bitget senza che l'abbia chiusa lui: blocco
        client._positions.pop(sym)
        go(cfg, ledger, path, client, notes=notes)
        st = json.load(open(path))
        assert st["halted"] is True and "bloccato" in notes[-1]
        # sistemato e sbloccato dall'app: riparte
        st["positions"][trade()["id"]]["status"] = "closed"
        json.dump(st, open(path, "w"))
        cfg_file = os.path.join(d, "automation.json")
        json.dump({"strategies": {}, "emergency": False, "history": []}, open(cfg_file, "w"))
        au.run(["resume"], cfg_file, os.path.join(d, "none.json"), state_path=path)
        assert json.load(open(path))["halted"] is False


def test_stop_scattato_su_bitget_non_blocca():
    """Lo stop sull'exchange chiude la posizione prima che il trade su carta si chiuda (fine candela):
    lo storico di Bitget lo conferma, quindi niente blocco e niente riapertura."""
    class WithHistory(bg.DryRunClient):
        history = []
        def closed_positions(self, limit=30):
            return list(self.history)
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        client = WithHistory(10_000)
        cfg, ledger = setup([trade()])
        go(cfg, ledger, path, client, notes=notes)
        assert json.load(open(path))["positions"][trade()["id"]]["status"] == "open"
        # stop scattato su Bitget: posizione sparita, storico con la chiusura
        client._positions.pop("BTCUSDT")
        later = NOW.replace(hour=5)
        client.history = [{"symbol": "BTCUSDT", "side": "long", "net": -9.8, "exit": 98_000.0, "closed_at": int(later.timestamp() * 1000)}]
        go(cfg, ledger, path, client, now=later, notes=notes)
        st = json.load(open(path))
        p = st["positions"][trade()["id"]]
        assert st["halted"] is False and p["status"] == "closed" and p["close_reason"] == "CHIUSA SU BITGET", st
        assert "chiusa su Bitget" in notes[-1] and "-9.80" in notes[-1]
        # il trade su carta è ancora aperto (si chiude a fine candela): l'esecutore non lo riapre
        go(cfg, ledger, path, client, now=later.replace(hour=6))
        assert client.positions() == {} and json.load(open(path))["halted"] is False
        # chiusura vecchia (prima dell'apertura) non conta: sparita senza spiegazione → blocco
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "live.json")
        client = WithHistory(10_000)
        client.history = [{"symbol": "BTCUSDT", "side": "long", "closed_at": 1}]
        go(cfg, ledger, path, client)
        client._positions.pop("BTCUSDT")
        go(cfg, ledger, path, client, now=NOW.replace(hour=5))
        assert json.load(open(path))["halted"] is True


def test_emergenza_chiude_tutto():
    with tempfile.TemporaryDirectory() as d:
        path, notes = os.path.join(d, "live.json"), []
        client = bg.DryRunClient(10_000)
        cfg, ledger = setup([trade(), trade("ETHUSDT", -1, 3000, 3060)])
        go(cfg, ledger, path, client)
        assert set(client.positions()) == {"BTCUSDT", "ETHUSDT"}
        cfg["emergency"] = True
        go(cfg, ledger, path, client, notes=notes)
        st = json.load(open(path))
        assert client.positions() == {} and st["halted"] is True and all(p["status"] == "closed" for p in st["positions"].values())
        assert "Emergenza: chiuse 2" in notes[-1]
        # emergenza tolta (anche se lo sblocco dall'app è arrivato prima del salvataggio del blocco):
        # al giro dopo l'esecutore riparte da solo, senza riaprire i trade già chiusi
        cfg["emergency"] = False
        go(cfg, ledger, path, client)
        st = json.load(open(path))
        assert st["halted"] is False and st["events"][-1]["kind"] in ("unhalt", "skip") and client.positions() == {}
        # il blocco per posizioni diverse dal previsto invece resta (una posizione dell'esecutore sparita da Bitget)
        st["positions"]["x"] = {"key": "k", "symbol": "SOLUSDT", "side": "long", "size": 1.0, "entry": 100.0, "status": "open"}
        json.dump(st, open(path, "w"))
        go(cfg, ledger, path, client)
        go(cfg, ledger, path, client)
        assert json.load(open(path))["halted"] is True and json.load(open(path))["halt_reason"] == "mismatch"


def test_client_vero_solo_con_tutto_in_ordine():
    keys = {"BITGET_API_KEY": "k", "BITGET_API_SECRET": "s", "BITGET_API_PASSPHRASE": "p"}
    saved = {k: os.environ.pop(k, None) for k in list(keys) + ["BITGET_DEMO"]}
    try:
        assert ex.make_client({"risk": {"trading_enabled": True}}) == (None, "simulata")      # niente chiavi
        os.environ.update(keys)
        assert ex.make_client({"risk": {"trading_enabled": False}}) == (None, "simulata")     # interruttore spento
        assert ex.make_client({"risk": {"trading_enabled": True}, "emergency": True}) == (None, "simulata")
        os.environ["BITGET_DEMO"] = "1"
        client, mode = ex.make_client({"risk": {"trading_enabled": True}})
        assert isinstance(client, bg.BitgetClient) and client.demo and mode == "demo"
        os.environ["BITGET_DEMO"] = "0"
        assert ex.make_client({"risk": {"trading_enabled": True}})[1] == "reale"
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


class FakeResponse:
    def __init__(self, status, data):
        self.status_code, self._data = status, data

    def json(self):
        return self._data


class FakeSession:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, method, url, headers=None, data=None, timeout=None):
        self.calls.append({"method": method, "url": url, "headers": headers, "data": data})
        return self.responses.pop(0)


def test_client_firma_e_richieste():
    # firma: base64(hmac_sha256(secret, timestamp + metodo + percorso + ?query + corpo))
    expected = base64.b64encode(hmac.new(b"s3cr3t", b"1700000000000GET/api/v2/mix/position/all-position?marginCoin=USDT&productType=USDT-FUTURES",
                                         hashlib.sha256).digest()).decode()
    assert bg.sign("s3cr3t", "1700000000000", "get", "/api/v2/mix/position/all-position", "marginCoin=USDT&productType=USDT-FUTURES") == expected
    sess = FakeSession([
        FakeResponse(200, {"code": "00000", "data": [{"symbol": "BTCUSDT", "holdSide": "long", "total": "0.025", "openPriceAvg": "70000", "unrealizedPL": "12.5", "leverage": "3"}, {"symbol": "ETHUSDT", "holdSide": "short", "total": "0"}]}),
        FakeResponse(200, {"code": "00000", "data": {"orderId": "1"}}),
        FakeResponse(200, {"code": "40001", "msg": "errore"}),
        FakeResponse(200, {"code": "00000", "data": [{"marginCoin": "USDT", "accountEquity": "1234.5"}]}),
    ])
    c = bg.BitgetClient("key", "s3cr3t", "pass", demo=True, session=sess, clock=lambda: 1_700_000_000)
    pos = c.positions()
    assert list(pos) == ["BTCUSDT"] and pos["BTCUSDT"]["side"] == "long" and pos["BTCUSDT"]["size"] == 0.025
    assert pos["BTCUSDT"]["entry"] == 70000.0 and pos["BTCUSDT"]["upl"] == 12.5 and pos["BTCUSDT"]["mark"] is None
    h = sess.calls[0]["headers"]
    assert sess.calls[0]["url"] == "https://api.bitget.com/api/v2/mix/position/all-position?marginCoin=USDT&productType=USDT-FUTURES"
    assert h["ACCESS-KEY"] == "key" and h["ACCESS-PASSPHRASE"] == "pass" and h["ACCESS-TIMESTAMP"] == "1700000000000" and h["ACCESS-SIGN"] == expected
    assert h["paptrading"] == "1"                                                               # conto demo
    c.open_position("BTCUSDT", "long", 0.025, 98000.0, client_oid="abc")
    body = json.loads(sess.calls[1]["data"])
    assert body["side"] == "buy" and body["tradeSide"] == "open" and body["orderType"] == "market" and body["marginMode"] == "isolated"
    assert body["presetStopLossPrice"] == "98000.0" and body["size"] == "0.025" and body["clientOid"] == "abc"
    assert sess.calls[1]["headers"]["ACCESS-SIGN"] == bg.sign("s3cr3t", "1700000000000", "POST", "/api/v2/mix/order/place-order", "", sess.calls[1]["data"])
    try:
        c.close_position("BTCUSDT", "long")
        raise AssertionError("un errore di Bitget deve fermare l'operazione")
    except bg.BitgetError as e:
        assert "40001" in str(e)
    assert c.equity() == 1234.5
    assert bg.round_down(0.02599, 3) == 0.025


def test_comandi_rischio_e_interruttore():
    with tempfile.TemporaryDirectory() as d:
        cfg_file, summ = os.path.join(d, "automation.json"), os.path.join(d, "lab.json")
        json.dump({"confirmed": []}, open(summ, "w"))
        assert "-> 1.0" in au.run(["risk", "risk_per_trade_pct", "1"], cfg_file, summ)
        for argv, text in ((["risk", "risk_per_trade_pct", "5"], "tra 0.1 e 2"), (["risk", "max_leverage", "2.5"], "intero"),
                           (["risk", "max_leverage", "20"], "tra 1 e 5"), (["risk", "boh", "1"], "sconosciuto"), (["trading", "forse"], "on oppure off")):
            try:
                au.run(argv, cfg_file, summ)
                raise AssertionError(argv)
            except au.CommandError as e:
                assert text in str(e), (argv, str(e))
        assert "ABILITATI" in au.run(["trading", "on"], cfg_file, summ)
        c = json.load(open(cfg_file))
        assert c["risk"] == {"risk_per_trade_pct": 1.0, "trading_enabled": True}
        au.run(["emergency"], cfg_file, summ)
        assert json.load(open(cfg_file))["risk"]["trading_enabled"] is False                   # l'emergenza spegne anche gli ordini veri
        try:
            au.run(["trading", "on"], cfg_file, summ)
            raise AssertionError("durante l'emergenza non si accende")
        except au.CommandError:
            pass


def test_lettura_conto_sola_lettura():
    class Fake:
        demo = False
        def __init__(self, fail=False):
            self.fail, self.orders = fail, 0
        def equity(self):
            if self.fail:
                raise bg.BitgetError("40014 chiave scaduta")
            return 123.456
        def positions(self):
            return {"BTCUSDT": {"side": "long", "size": 0.01}}
        def open_position(self, *a, **k):
            self.orders += 1
    saved = {k: os.environ.pop(k, None) for k in ("BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE")}
    try:
        with tempfile.TemporaryDirectory() as d:
            path, msgs = os.path.join(d, "live.json"), []
            assert ex.account_snapshot(path) == {"connected": False, "reason": "chiavi non impostate"}
            os.environ.update({"BITGET_API_KEY": "k", "BITGET_API_SECRET": "s", "BITGET_API_PASSPHRASE": "p"})
            ok = Fake()
            a = ex.account_snapshot(path, ok, NOW, msgs.append)
            assert a["connected"] and a["equity"] == 123.46 and a["positions"] == 1 and not a["demo"] and ok.orders == 0
            assert json.load(open(path))["account"]["equity"] == 123.46
            class WithSpot(Fake):
                def spot_balances(self):
                    return {"USDT": 500.0, "BTC": 0.01, "XYZ": 3.0}
                def spot_price_usdt(self, coin):
                    return {"USDT": 1.0, "BTC": 70000.0}.get(coin)
            s = ex.account_snapshot(path, WithSpot(), NOW, msgs.append)
            assert s["spot_usdt"] == 1200.0 and s["total_usdt"] == 1323.46, s                     # 500 + 0,01*70000; XYZ senza prezzo
            assert [c["coin"] for c in s["spot_coins"]] == ["BTC", "USDT", "XYZ"] and s["spot_coins"][2]["usdt"] is None
            class WithAll(WithSpot):
                def all_balances_usdt(self):
                    return {"spot": 1200.0, "futures": 123.456, "earn": 500.0}
            a2 = ex.account_snapshot(path, WithAll(), NOW, msgs.append)
            assert a2["total_usdt"] == 1823.46 and a2["accounts_usdt"]["earn"] == 500.0, a2
            assert a2["positions_detail"][0]["symbol"] == "BTCUSDT" and a2["day"] == NOW.strftime("%Y-%m-%d")
            # variazione di oggi: rispetto alla prima lettura del giorno
            class Richer(WithAll):
                def all_balances_usdt(self):
                    return {"spot": 1200.0, "futures": 223.456, "earn": 500.0}
            a3 = ex.account_snapshot(path, Richer(), NOW, msgs.append)
            assert a3["day_start_total"] == a2["day_start_total"] == 123.46 and a3["day_change"] == 1800.0, a3   # base: prima lettura del giorno
            b = ex.account_snapshot(path, Fake(fail=True), NOW, msgs.append)
            assert not b["connected"] and "scaduta" in b["reason"] and len(msgs) == 1        # avviso al passaggio ok -> errore
            ex.account_snapshot(path, Fake(fail=True), NOW, msgs.append)
            assert len(msgs) == 1                                                            # una volta sola
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


def test_versamenti_non_sono_guadagni():
    """Conto vuoto a inizio giornata, poi 16 USDT trasferiti nei futures e una posizione aperta:
    la variazione di oggi è il PnL, non il versamento."""
    import tempfile
    saved = {k: os.environ.get(k) for k in ("BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_API_PASSPHRASE")}
    for k in saved:
        os.environ[k] = "x"
    try:
        class Acc:
            demo = False
            def __init__(self, total, pos=None):
                self.total, self.pos = total, pos or {}
            def positions(self):
                return {k: dict(v) for k, v in self.pos.items()}
            def equity(self):
                return self.total
            def tpsl_orders(self, symbol):
                return []
            def all_balances_usdt(self):
                return {"futures": self.total}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "live.json")
            json.dump({"positions": {}, "day": {}, "halted": False, "events": []}, open(path, "w"))
            a = ex.account_snapshot(path, Acc(0.0), NOW)
            assert a["day_start_total"] == 0.0 and a["day_change"] == 0.0
            a = ex.account_snapshot(path, Acc(15.98), NOW)                                     # versamento, nessuna posizione
            assert a["day_start_total"] == 15.98 and a["day_change"] == 0.0, a
            pos = {"SOLUSDT": {"side": "short", "size": 0.1, "entry": 83.7, "mark": 83.5, "upl": 0.02, "leverage": 3, "margin": 2.79, "liq": 111.0}}
            a = ex.account_snapshot(path, Acc(16.0, pos), NOW)                                 # posizione aperta: il resto è PnL
            assert a["day_start_total"] == 15.98 and a["day_change"] == 0.02, a
            a = ex.account_snapshot(path, Acc(15.9), NOW)                                      # chiusa in perdita: resta nel giorno
            assert a["day_change"] == -0.08, a
            a = ex.account_snapshot(path, Acc(25.9), NOW)                                      # altro versamento senza posizioni
            assert a["day_start_total"] == 25.98 and a["day_change"] == -0.08, a
            # storico del giorno accanto allo stato: apertura 0, chiusura 25,90, versati 25,98, perdita 0,08
            row = json.load(open(os.path.join(d, ex.EQUITY_PATH)))["days"][NOW.strftime("%Y-%m-%d")]
            assert (row["open"], row["close"], row["flows"], row["pnl"]) == (0.0, 25.9, 25.98, -0.08), row
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


def test_storico_posizioni_chiuse():
    """Formato dello storico di Bitget (campi verificati con la lettura reale): fee in valore assoluto, netto di Bitget."""
    c = bg.BitgetClient("k", "s", "p", demo=False)
    rows = {"list": [{"positionId": "123", "symbol": "SOLUSDT", "holdSide": "short", "openAvgPrice": "83.724", "closeAvgPrice": "83.16",
                      "openTotalPos": "0.1", "closeTotalPos": "0.1", "pnl": "0.0564", "openFee": "-0.00502", "closeFee": "-0.00499",
                      "totalFunding": "0", "netProfit": "0.04638696", "ctime": "1794447000000", "utime": "1794449000000", "marginMode": "isolated"}]}
    c._request = lambda method, path, params=None, body=None: rows
    h = c.closed_positions(5)[0]
    assert h["id"] == "123" and h["side"] == "short" and h["size"] == 0.1 and h["entry"] == 83.724 and h["exit"] == 83.16
    assert abs(h["fees"] - 0.01001) < 1e-9 and h["net"] == 0.04638696 and h["opened_at"] == 1794447000000 and h["closed_at"] == 1794449000000


def test_avviso_posizione_chiusa():
    """Telegram per ogni posizione reale chiusa su Bitget: una volta sola, solo dal giro del bot, mai alla prima lettura."""
    st = {}
    now = datetime(2026, 11, 12, 2, 0, tzinfo=timezone.utc)
    ms = now.timestamp() * 1000
    h1 = {"id": "1", "symbol": "SOLUSDT", "side": "short", "size": 0.1, "entry": 83.724, "exit": 83.16, "pnl": 0.0564, "fees": 0.01, "funding": 0, "net": 0.0464, "closed_at": ms - 3600e3}
    acc = {"connected": True, "demo": False, "history": [h1]}
    msgs = []
    assert ex._notify_closed(st, acc, msgs.append, now) and msgs == [] and st["closed_notified"] == ["1"]       # prima lettura: nessun messaggio
    h2 = dict(h1, id="2", side="long", entry=84.0, exit=83.0, pnl=-0.1, net=-0.11, closed_at=ms - 60e3)
    old = dict(h1, id="0", closed_at=ms - 3 * 86400e3)
    acc = {"connected": True, "demo": False, "history": [h2, h1, old]}
    assert ex._notify_closed(st, acc, msgs.append, now)
    assert len(msgs) == 1 and msgs[0].startswith("❌ POSIZIONE CHIUSA · Bitget reale") and "SOL LONG 0,1: entrata 84 → uscita 83" in msgs[0]
    assert "Netto -0,11 USDT" in msgs[0] and "_" not in msgs[0] and "*" not in msgs[0]                     # la chiusura di 3 giorni fa: niente
    assert not ex._notify_closed(st, acc, msgs.append, now) and len(msgs) == 1                             # già avvisata
    assert not ex._notify_closed(st, {"connected": True, "history": [dict(h1, id="9")]}, None, now)        # rilettura dall'app: niente


def test_spot_round_trips_average_cost():
    import executor as e
    fills = [
        {"side": "buy", "size": "0.1", "priceAvg": "80", "cTime": "1", "feeDetail": {"totalFee": "-0.008", "feeCoin": "USDT"}},
        {"side": "buy", "size": "0.1", "priceAvg": "90", "cTime": "2", "feeDetail": {"totalFee": "-0.0001", "feeCoin": "SOL"}},
        {"side": "sell", "size": "0.15", "priceAvg": "100", "cTime": "3", "tradeId": "x", "feeDetail": {"totalFee": "-0.015", "feeCoin": "USDT"}},
        {"side": "sell", "size": "0.5", "priceAvg": "110", "cTime": "4", "tradeId": "y"},   # vende solo i 0.05 rimasti
        {"side": "sell", "size": "1", "priceAvg": "120", "cTime": "5", "tradeId": "z"},     # niente costo noto: fuori
    ]
    out = e.spot_round_trips(fills, "SOLUSDT")
    assert [o["id"] for o in out] == ["spot-x", "spot-y"]
    assert out[0]["market"] == "spot" and abs(out[0]["entry"] - 85.085) < 1e-9
    assert abs(out[0]["net"] - 2.22225) < 1e-6
    assert abs(out[1]["size"] - 0.05) < 1e-9 and abs(out[1]["entry"] - 85.085) < 1e-9


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test superati")

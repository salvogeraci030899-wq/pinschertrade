"""Test del bot (nessuna rete). `python3 tests/test_run_bot.py` oppure pytest."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import run_bot  # noqa: E402


def test_main_senza_kronos_aggiorna_carta_ed_esecutore():
    """Il giro non carica nessun modello: scarica le candele, aggiorna la carta, fa girare l'esecutore.
    Rete e moduli esterni simulati."""
    import pandas as pd
    with tempfile.TemporaryDirectory() as d:
        cwd = os.getcwd()
        os.chdir(d)
        saved = {k: getattr(run_bot, k) for k in ("ASSETS_TO_RUN", "TIMEFRAMES_TO_RUN", "get_historical_data", "automation_step")}
        saved_fd = run_bot.futures_data.collect
        try:
            t = pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=300)   # candele tutte chiuse
            kl = [[str(int((t + pd.Timedelta(hours=i)).timestamp() * 1000)), "100", "101", "99", "100", "1", "1", "1"] for i in range(200)]
            run_bot.ASSETS_TO_RUN, run_bot.TIMEFRAMES_TO_RUN = ["BTCUSDT"], ["1h"]
            run_bot.get_historical_data = lambda s, tf: kl
            run_bot.futures_data.collect = lambda: False
            seen = {}
            run_bot.automation_step = lambda frames, notify=None: seen.update(frames)
            run_bot.main()
            assert list(seen) == ["BTCUSDT_1h"] and len(seen["BTCUSDT_1h"]) > 100
            assert not os.path.exists("dashboard.json") and not os.path.exists("track_record.jsonl")   # niente previsioni
        finally:
            for k, v in saved.items():
                setattr(run_bot, k, v)
            run_bot.futures_data.collect = saved_fd
            os.chdir(cwd)


def test_il_modello_non_c_e_piu():
    assert not hasattr(run_bot, "load_predictor") and not hasattr(run_bot, "process_alerts") and not hasattr(run_bot, "build_alert_text")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test superati")

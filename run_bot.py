"""Giro principale del bot (ogni 15 minuti, avviato da Cloudflare).

Dal 2026-11-20 il modello Kronos non c'è più: le sue previsioni non battevano il caso (direzione giusta il 37,7%
delle volte, errore di calibrazione peggiore di una previsione costante). Il giro scarica le candele, aggiorna la prova su
carta, fa girare l'esecutore e l'agente eventi, invia il riepilogo giornaliero e raccoglie i dati futures.
"""
import json
import os
import sys
import tempfile

import requests

import futures_data
import daily_report
import event_guard
import executor
import paper
from market_data import ALL_ASSETS, TRADE_ASSETS, ALL_TIMEFRAMES, ATR_PERIOD, get_historical_data, klines_to_df

SYMBOL_ENV = os.environ.get("SYMBOL", "ALL")
TIMEFRAME_ENV = os.environ.get("TIMEFRAME", "ALL")
ASSETS_TO_RUN = ALL_ASSETS if SYMBOL_ENV == "ALL" else [SYMBOL_ENV]
TIMEFRAMES_TO_RUN = ALL_TIMEFRAMES if TIMEFRAME_ENV == "ALL" else [TIMEFRAME_ENV]

# Telegram
TG_TOKEN = os.environ.get("TELEGRAM_TOKEN")
TG_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")


def send_telegram_alert(text):
    """Ritorna True solo se il messaggio è stato inviato davvero."""
    if not TG_TOKEN or not TG_CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    import watchdog
    payload = {"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown", "reply_markup": watchdog.keyboard_for(text)}
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
        return True
    except Exception as e:
        print(f"Errore invio Telegram: {e}")
        return False



def automation_step(frames, notify=None):
    """Prova su carta (automation.json) ed esecutore, in una funzione a parte: le sue variabili non
    possono sovrascrivere quelle di main (nella v64 'ledger' sovrascriveva il registro delle previsioni).
    Un errore qui non ferma mai il bot."""
    notify = notify or send_telegram_alert
    try:
        last = {k: int(df['time'].iloc[-1].timestamp()) for k, df in frames.items()}
        # il giro scarica solo BTC, ETH e SOL; le altre coin delle strategie chiudono le candele agli stessi
        # orari (UTC), quindi prendono l'ora dell'ultima candela chiusa dello stesso timeframe
        for k, ts in list(last.items()):
            tf = k.rsplit("_", 1)[1]
            for s in TRADE_ASSETS:
                last.setdefault(f"{s}_{tf}", ts)
        paper.update(last, notify=notify)
    except Exception as e:
        print(f"Prova su carta non aggiornata: {e}")
    try:
        event_guard.run(notify=notify)          # agente eventi: al massimo un controllo all'ora, solo difesa
    except Exception as e:
        print(f"Agente eventi non eseguito: {e}")
    try:
        cfg = paper.load_config()
        paper_ledger = load_json(paper.LEDGER_PATH) if os.path.exists(paper.LEDGER_PATH) else {}
        client, mode = executor.make_client(cfg)
        executor.run(cfg, paper_ledger, client, mode, notify=notify)
    except Exception as e:
        print(f"Esecutore non eseguito: {e}")
        notify(f"⚠️ Esecutore: errore inatteso ({e}). Controlla le posizioni su Bitget.")
    try:
        executor.account_snapshot(notify=notify)
    except Exception as e:
        print(f"Lettura del conto Bitget non riuscita: {e}")


# =========================
# MAIN
# =========================
def load_json(path):
    """File assente -> {} (primo avvio). File presente ma illeggibile -> stop:
    ripartire da {} cancellerebbe la dashboard e farebbe ripartire tutti gli alert."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("il contenuto non è un oggetto JSON")
        return data
    except Exception as e:
        sys.exit(f"ERRORE: {path} esiste ma non è leggibile ({e}). Interrompo per non sovrascrivere lo stato.")


def save_json(path, data):
    """Scrittura atomica: il file finale è sempre o la versione vecchia o quella nuova completa."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise



def main():
    print(f"Avvio elaborazione per: {ASSETS_TO_RUN} su {TIMEFRAMES_TO_RUN}")
    alerts_state = load_json("alerts_state.json")
    alerts_before = dict(alerts_state)

    frames = {}       # candele chiuse scaricate in questo giro: servono alla prova su carta e al riepilogo
    for symbol in ASSETS_TO_RUN:
        for tf in TIMEFRAMES_TO_RUN:
            klines = get_historical_data(symbol, tf)
            if not klines:
                continue
            df = klines_to_df(klines, tf, closed_only=True)
            if len(df) < ATR_PERIOD + 50:
                print(f"Dati insufficienti per {symbol} {tf}, salto.")
                continue
            frames[f"{symbol}_{tf}"] = df

    # Riepilogo giornaliero su Telegram (senza AI), una volta al giorno. Un errore qui non ferma il bot.
    try:
        daily_report.maybe_send(alerts_state, frames, send_telegram_alert)
    except Exception as e:
        print(f"Riepilogo giornaliero non inviato: {e}")

    # Dati futures (funding, open interest, long/short): una volta per ora, in file separati.
    try:
        futures_data.collect()
    except Exception as e:
        print(f"Dati futures non aggiornati: {e}")

    automation_step(frames)

    if alerts_state != alerts_before:
        save_json("alerts_state.json", alerts_state)
        print("alerts_state.json aggiornato.")
    else:
        print("Nessun cambio di stato: file non modificati.")


if __name__ == "__main__":
    main()

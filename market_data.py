"""Dati di mercato e parametri comuni: elenco coin e timeframe, costi, candele Bitget e storico a pagine.

Usato dal bot (run_bot.py), dalla prova su carta, dall'esecutore, dall'agente, dal laboratorio e dalle
validazioni. Nessun modello di previsione: Kronos è stato tolto il 2026-11-20.
"""
import time

import pandas as pd
import requests

# Costi per trade usati da laboratorio e validazioni (in %, applicati a ingresso e uscita)
FEE_PCT = 0.1        # commissione exchange per lato
SLIPPAGE_PCT = 0.05  # slippage stimato per lato
TAX_RATE = 0.33      # tassa sulle plusvalenze, applicata ai trade in utile (stima prudente)

ATR_PERIOD = 14
ALL_ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]          # coin scaricate a ogni giro del bot (candele per riepilogo e carta)
# Coin delle strategie (laboratorio, prova su carta, esecutore, agente, avvisi): più mercati = più trade e più
# conferme indipendenti. Futures USDT molto scambiati su Bitget, con storico dal 2020 e quantità minime piccole.
TRADE_ASSETS = ALL_ASSETS + ["XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "LINKUSDT"]
ALL_TIMEFRAMES = ["1d", "4h", "1h"]
TF_DELTA = {"1d": pd.Timedelta(days=1), "4h": pd.Timedelta(hours=4), "1h": pd.Timedelta(hours=1)}

BITGET_CANDLES_URL = "https://api.bitget.com/api/v2/spot/market/candles"
BITGET_HISTORY_URL = "https://api.bitget.com/api/v2/spot/market/history-candles"
_TF_MAP = {"1d": "1day", "4h": "4h", "1h": "1h"}
OUT_DIR = "validation"          # cartella dei rapporti del laboratorio (LABORATORIO.md, STRATEGIE.md)

# Scarta candele con prezzi palesemente errati (glitch dell'API)
MIN_PRICE = {"BTCUSDT": 1000, "ETHUSDT": 100, "SOLUSDT": 10}


# =========================
# DATI
# =========================
def get_historical_data(symbol, interval, limit=500, end_time=None):
    """Candele Bitget in ordine cronologico (lista di righe grezze), None se la chiamata fallisce."""
    params = {"symbol": symbol, "granularity": _TF_MAP.get(interval, "1day"), "limit": limit}
    if end_time:
        params["endTime"] = end_time
    try:
        r = requests.get(BITGET_CANDLES_URL, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()["data"][::-1]
        min_price = MIN_PRICE.get(symbol, 0)
        return [row for row in data if float(row[4]) >= min_price]
    except Exception as e:
        print(f"Errore API Bitget {symbol} {interval}: {e}")
        return None


def klines_to_df(klines, tf=None, closed_only=False):
    """Righe grezze Bitget -> DataFrame ordinato. Con closed_only tiene solo le candele CHIUSE."""
    df = pd.DataFrame(klines, columns=['time', 'open', 'high', 'low', 'close', 'volume', 'qav', 'usdt_vol'])
    df['time'] = pd.to_datetime(df['time'].astype(float), unit='ms', utc=True)
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = df[col].astype(float)
    df = df.drop_duplicates(subset=['time']).sort_values('time').reset_index(drop=True)
    if closed_only:
        # time = apertura della candela
        df = df[df['time'] + TF_DELTA[tf] <= pd.Timestamp.now(tz='UTC')].reset_index(drop=True)
    return df


def compute_atr(df, period=ATR_PERIOD):
    high, low, close = df['high'], df['low'], df['close']
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    return float(tr.rolling(period).mean().iloc[-1])


# =========================
# STORICO
# =========================
def _fetch(url, symbol, tf, end_ms, limit):
    r = requests.get(url, params={"symbol": symbol, "granularity": _TF_MAP[tf], "endTime": end_ms, "limit": limit}, timeout=20)
    r.raise_for_status()
    body = r.json()
    if str(body.get("code")) != "00000":
        raise RuntimeError(f"Bitget: {body.get('msg')}")
    return body.get("data") or []


def download_history(symbol, tf, start_ms, now_ms=None, pause=0.15):
    """Candele chiuse da start_ms a oggi, scaricate a pagine andando indietro nel tempo.
    Prova l'archivio storico di Bitget e, se una pagina fallisce, l'endpoint usato dal bot."""
    end = now_ms or int(time.time() * 1000)
    rows = {}
    while end > start_ms:
        data = None
        for url, limit in ((BITGET_HISTORY_URL, 200), (BITGET_CANDLES_URL, 1000)):
            for attempt in range(3):
                try:
                    data = _fetch(url, symbol, tf, end, limit)
                    break
                except Exception as e:
                    print(f"  download {symbol} {tf} fallito ({e}), riprovo...")
                    time.sleep(1 + attempt * 2)
            if data:
                break
        if not data:
            break
        new = 0
        for row in data:
            t = int(float(row[0]))
            if t not in rows:
                rows[t] = row
                new += 1
        oldest = min(int(float(row[0])) for row in data)
        if new == 0:
            break  # nessuna candela nuova: l'archivio è finito
        # Riparto dalla candela più vecchia ricevuta, non da un millisecondo prima: Bitget arrotonda
        # endTime alla candela e la esclude, quindi con "oldest - 1" si perdeva una candela per pagina.
        # Se invece la include, torna un doppione che viene scartato.
        end = oldest
        time.sleep(pause)
    min_price = MIN_PRICE.get(symbol, 0)
    klines = [list(r[:6]) + [0, 0] for r in rows.values() if float(r[4]) >= min_price]
    if not klines:
        return None
    return klines_to_df(klines, tf, closed_only=True)

"""Guardiano delle posizioni su Hyperliquid (anche quelle aperte da Phantom Perps).

Gestisce da solo i trade che apri tu: non ne apre mai di nuovi e non li aumenta.
Ogni minuto, per ogni posizione aperta:
  1. pareggio: quando il prezzo è andato a favore di almeno +2%, lo stop va all'ingresso (più le commissioni);
  2. trailing: oltre +3,5% lo stop segue il miglior prezzo a 1,5 ATR (candele da 1 ora);
  3. tempo: dopo 48 ore con il prezzo ancora entro ±2% dall'ingresso, chiude;
  4. liquidazione: se il prezzo arriva a meno del 2% dalla liquidazione, chiude;
  5. stop mancante: se la posizione non ha uno stop, ne mette uno al 4% dall'ingresso (mai oltre la liquidazione);
  6. avvisi: movimento di oltre il 3% in 5 minuti, funding alto contro la posizione.
Ogni azione arriva su Telegram con il motivo.

Regole fisse: lo stop si sposta solo per proteggere di più (mai per allontanarlo); prima si mette lo stop
nuovo e solo dopo si toglie quello vecchio, così la posizione non resta mai scoperta; i take profit non si toccano.

Modalità: "off" spento, "osserva" scrive cosa farebbe senza toccare niente, "attivo" esegue. Si sceglie
dall'app (Posizioni → Phantom, salvata in hl_guard_config.json e riletta ogni minuto: lo spegnimento vale
entro un minuto); in mancanza vale la variabile del repository HL_GUARD_MODE, poi "osserva". Chiavi (segreti del repository): HL_ACCOUNT_ADDRESS, l'indirizzo del conto
Hyperliquid (quello EVM di Phantom), e HL_API_PRIVATE_KEY, la chiave di un API wallet creato su
app.hyperliquid.xyz → API: può fare ordini ma non prelevare.

Il repository è pubblico: nel log non finiscono mai indirizzi, prezzi o dimensioni, solo conteggi.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

from fmt_it import it

STATE_PATH = "hl_guard_state.json"
CONFIG_PATH = "hl_guard_config.json"
LOG_MAX = 30
MODES = ("off", "osserva", "attivo")

CFG = {
    "be_trigger": 2.0,       # % a favore per portare lo stop in pareggio
    "be_offset": 0.15,       # % oltre l'ingresso, per coprire le commissioni di apertura e chiusura
    "trail_trigger": 3.5,    # % a favore da cui parte il trailing
    "trail_atr": 1.5,        # distanza del trailing in ATR (1 ora, 14 candele)
    "time_stop_h": 48,       # ore dopo le quali un trade fermo si chiude
    "time_flat_pct": 2.0,    # "fermo": entro ±2% dall'ingresso
    "liq_buffer": 2.0,       # chiusura se il prezzo è a meno del 2% dalla liquidazione
    "default_sl": 4.0,       # stop messo se manca, in % dall'ingresso
    "min_step": 0.25,        # lo stop si sposta solo se migliora di almeno lo 0,25% del prezzo (meno messaggi)
    "jump_pct": 3.0,         # avviso: movimento oltre il 3% in 5 minuti
    "funding_alert": 0.01,   # avviso: funding oltre lo 0,01% l'ora pagato dalla posizione
    "sl_slippage": 0.10,     # prezzo limite dello stop a mercato: 10% oltre il prezzo di attivazione
}


def pct(a, b):
    return (a - b) / b * 100.0


def round_px(px, sz_decimals):
    """Prezzi ammessi da Hyperliquid (perpetui): al massimo 5 cifre significative e 6 - szDecimals decimali."""
    if px >= 100000:
        return float(round(px))
    return round(float(f"{px:.5g}"), max(0, 6 - int(sz_decimals)))


def atr(candles, n=14):
    """ATR semplice sulle ultime n candele (h, l, c come numeri)."""
    if len(candles) < 2:
        return None
    trs = []
    for prev, cur in zip(candles[:-1], candles[1:]):
        h, low, pc = cur["h"], cur["l"], prev["c"]
        trs.append(max(h - low, abs(h - pc), abs(low - pc)))
    trs = trs[-n:]
    return sum(trs) / len(trs) if trs else None


def plan(pos, mark, peak, atr_1h, current_sl, age_h, cfg=CFG):
    """Decisione pura per una posizione. pos: {"dir": 1 long / -1 short, "entry", "liq"}.
    peak: miglior prezzo dall'apertura (massimo per il long, minimo per lo short).
    Restituisce {"action": "close"|"set_sl"|None, "sl": prezzo, "why": testo}."""
    d, entry, liq = pos["dir"], pos["entry"], pos.get("liq")
    move = pct(mark, entry) * d              # % a favore adesso
    best = pct(peak, entry) * d               # % a favore nel momento migliore

    # 1. liquidazione vicina: si esce subito
    if liq and liq > 0 and abs(pct(mark, liq)) < cfg["liq_buffer"]:
        return {"action": "close", "why": f"prezzo a meno del {it(cfg['liq_buffer'], 1)}% dalla liquidazione"}

    # 2. trade fermo da troppo tempo
    if age_h is not None and age_h >= cfg["time_stop_h"] and abs(move) <= cfg["time_flat_pct"]:
        return {"action": "close", "why": f"{int(age_h)} ore senza movimento (entro ±{it(cfg['time_flat_pct'], 0)}%)"}

    # 3. stop da proporre: il più protettivo tra le regole che si applicano
    candidates = []
    if current_sl is None:
        sl = entry * (1 - d * cfg["default_sl"] / 100)
        if liq and liq > 0:                   # mai oltre la liquidazione: al massimo al 70% della distanza
            limit = entry - (entry - liq) * 0.7
            sl = max(sl, limit) if d == 1 else min(sl, limit)
        candidates.append((sl, f"stop mancante, messo al {it(cfg['default_sl'], 0)}% dall'ingresso"))
    if best >= cfg["be_trigger"]:
        candidates.append((entry * (1 + d * cfg["be_offset"] / 100), f"pareggio: il trade è arrivato a +{it(best, 1)}%"))
    if best >= cfg["trail_trigger"] and atr_1h:
        candidates.append((peak - d * cfg["trail_atr"] * atr_1h, f"trailing: {it(cfg['trail_atr'], 1)} ATR dal miglior prezzo (+{it(best, 1)}%)"))
    if not candidates:
        return {"action": None}
    sl, why = max(candidates, key=lambda c: c[0] * d)      # il più vicino al prezzo dal lato giusto

    # mai oltre il prezzo attuale: lo stop scatterebbe subito
    edge = mark * (1 - d * 0.003)
    if (sl - edge) * d > 0:
        sl = edge
    # si sposta solo se protegge di più, e di almeno min_step
    if current_sl is not None and (sl - current_sl) * d < mark * cfg["min_step"] / 100:
        return {"action": None}
    return {"action": "set_sl", "sl": sl, "why": why}


# ---------- lettura del conto (Info dell'SDK Hyperliquid o un finto equivalente nei test) ----------

def read_positions(info, addr):
    st = info.user_state(addr)
    out = []
    for ap in st.get("assetPositions", []):
        p = ap.get("position", {})
        szi = float(p.get("szi") or 0)
        coin = p.get("coin", "")
        if not szi or ":" in coin:            # mercati HIP-3 (azioni, indici): esclusi
            continue
        liq = p.get("liquidationPx")
        out.append({"coin": coin, "dir": 1 if szi > 0 else -1, "size": abs(szi),
                    "entry": float(p["entryPx"]), "liq": float(liq) if liq else None})
    return out


def stop_orders(orders, coin, d):
    """Stop (trigger, riduzione) della posizione: per un long sono vendite sotto il prezzo, per uno short acquisti."""
    side = "A" if d == 1 else "B"
    res = []
    for o in orders:
        if o.get("coin") != coin or not o.get("isTrigger") or o.get("side") != side:
            continue
        if "Stop" not in str(o.get("orderType", "")):        # i take profit non si toccano
            continue
        res.append({"oid": o["oid"], "px": float(o["triggerPx"])})
    return res


def opened_at(info, addr, coin, now_ms):
    """Momento dell'apertura: l'ultimo fill che ha aperto la posizione partendo da zero (ultimi 30 giorni)."""
    try:
        fills = info.user_fills_by_time(addr, now_ms - 30 * 86400000)
    except Exception:
        return None
    t = None
    for f in fills or []:
        if f.get("coin") == coin and str(f.get("dir", "")).startswith("Open") and float(f.get("startPosition") or 0) == 0:
            t = max(t or 0, int(f["time"]))
    return t


def candles(info, coin, interval, start_ms, end_ms):
    raw = info.candles_snapshot(coin, interval, start_ms, end_ms) or []
    return [{"t": int(c["t"]), "h": float(c["h"]), "l": float(c["l"]), "c": float(c["c"])} for c in raw]


# ---------- un giro ----------

def describe(pos):
    return f"{pos['coin']} {'long' if pos['dir'] == 1 else 'short'}"


def run_once(info, exchange, notify, addr, mode, state, now=None, cfg=CFG):
    """Un controllo di tutte le posizioni. Restituisce il numero di azioni (o proposte, in osserva)."""
    now = now or datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    meta = {u["name"]: u for u in info.meta().get("universe", [])}
    mids = info.all_mids()
    orders = info.frontend_open_orders(addr)
    positions = read_positions(info, addr)
    try:
        ctx_meta, ctxs = info.meta_and_asset_ctxs()
        funding = {u["name"]: float(c.get("funding") or 0) for u, c in zip(ctx_meta["universe"], ctxs)}
    except Exception:
        funding = {}

    log = state.setdefault("log", [])

    def say(kind, coin, text):
        notify(text)
        log.append({"t": now_ms, "kind": kind, "coin": coin, "text": text})
        del log[:-LOG_MAX]

    seen = state.setdefault("positions", {})
    alive = set()
    actions = 0
    for pos in positions:
        coin, d = pos["coin"], pos["dir"]
        key = f"{coin}:{d}:{pos['entry']}"
        alive.add(key)
        rec = seen.setdefault(key, {"first_seen": now_ms})
        mark = float(mids.get(coin) or 0)
        if not mark:
            continue
        szd = int(meta.get(coin, {}).get("szDecimals", 2))
        start = opened_at(info, addr, coin, now_ms) or rec["first_seen"]
        age_h = (now_ms - start) / 3600000
        # miglior prezzo dall'apertura (candele da 5 minuti) e ATR da 1 ora
        c5 = candles(info, coin, "5m", start, now_ms)
        peak = mark
        for c in c5:
            if c["t"] < start:            # la candela dell'apertura può avere un massimo di prima dell'ingresso
                continue
            peak = max(peak, c["h"]) if d == 1 else min(peak, c["l"])
        c1h = candles(info, coin, "1h", now_ms - 20 * 3600000, now_ms)
        a = atr(c1h)
        stops = stop_orders(orders, coin, d)
        cur = max((s["px"] for s in stops), key=lambda p: p * d) if stops else None

        p = plan(pos, mark, peak, a, cur, age_h, cfg)
        tag = "[osserva] " if mode == "osserva" else ""
        if p["action"] == "close":
            if rec.get("proposed") == "close":
                continue
            msg = f"{tag}🛡 {describe(pos)}: {'chiudo' if mode == 'attivo' else 'chiuderei'} la posizione a {it(mark, 3)} ({p['why']})."
            if mode == "attivo":
                r = exchange.market_close(coin)
                if not _ok(r):
                    say("error", coin, f"⚠️ {describe(pos)}: chiusura non riuscita ({_err(r)}). Controlla la posizione su Phantom.")
                    continue
            rec["proposed"] = "close"
            say("close", coin, msg)
            actions += 1
        elif p["action"] == "set_sl":
            sl = round_px(p["sl"], szd)
            if cur is not None and (sl - cur) * d <= 0:
                continue
            last = rec.get("proposed")
            if mode == "osserva" and isinstance(last, (int, float)) and abs(sl - last) < mark * cfg["min_step"] / 100:
                continue
            msg = (f"{tag}🛡 {describe(pos)}: stop {'spostato' if mode == 'attivo' else 'da spostare'} "
                   f"{('da ' + it(cur, 3) + ' ') if cur else ''}a {it(sl, 3)} — {p['why']}. Prezzo {it(mark, 3)}.")
            if mode == "attivo":
                limit = round_px(sl * (1 - d * cfg["sl_slippage"]), szd)
                r = exchange.order(coin, d == -1, pos["size"], limit,
                                   {"trigger": {"triggerPx": sl, "isMarket": True, "tpsl": "sl"}}, reduce_only=True)
                if not _ok(r):
                    say("error", coin, f"⚠️ {describe(pos)}: nuovo stop a {it(sl, 3)} non accettato ({_err(r)}). Resta quello di prima.")
                    continue
                for s in stops:            # solo dopo che il nuovo è attivo
                    exchange.cancel(coin, s["oid"])
            rec["proposed"] = sl
            say("stop", coin, msg)
            actions += 1

        # avvisi (una volta per posizione)
        recent = [c for c in c5 if c["t"] >= now_ms - 6 * 60000]
        if recent:
            ref = recent[0]["c"]
            jump = pct(mark, ref)
            if abs(jump) >= cfg["jump_pct"] and now_ms - rec.get("jump_at", 0) > 30 * 60000:
                rec["jump_at"] = now_ms
                say("alert", coin, f"⚡ {describe(pos)}: {it(jump, 1, sign=True)}% in 5 minuti (prezzo {it(mark, 3)}).")
        f = funding.get(coin, 0) * 100           # % l'ora; positivo = pagano i long
        if f * d >= cfg["funding_alert"] and not rec.get("funding_alert"):
            rec["funding_alert"] = True
            say("alert", coin, f"💸 {describe(pos)}: funding alto contro di te ({it(f, 4)}% l'ora). Tenerla a lungo costa.")

    state["last_check"] = now_ms
    state["mode"] = mode
    for k in list(seen):                      # posizioni chiuse: si dimenticano
        if k not in alive:
            del seen[k]
    return actions, len(positions)


def _ok(r):
    try:
        if r.get("status") != "ok":
            return False
        st = r["response"]["data"]["statuses"]
        return not any("error" in s for s in st if isinstance(s, dict))
    except Exception:
        return isinstance(r, dict) and r.get("status") == "ok"


def _err(r):
    try:
        for s in r["response"]["data"]["statuses"]:
            if isinstance(s, dict) and "error" in s:
                return str(s["error"])[:120]
    except Exception:
        pass
    return str(r)[:120] if r else "nessuna risposta"


def load_state(path=STATE_PATH):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state, path=STATE_PATH):
    with open(path, "w") as f:
        json.dump(state, f, separators=(",", ":"), sort_keys=True)


def config_mode(text):
    try:
        m = str(json.loads(text).get("mode", "")).strip().lower()
        return m if m in MODES else None
    except Exception:
        return None


def current_mode(default):
    """Modalità scelta nell'app: la versione più recente di hl_guard_config.json su GitHub (riletta ogni minuto),
    altrimenti quella del checkout, altrimenti la variabile del repository."""
    import subprocess
    try:
        subprocess.run(["git", "fetch", "-q", "--depth=1", "origin", "main"], timeout=30, check=True, capture_output=True)
        out = subprocess.run(["git", "show", f"origin/main:{CONFIG_PATH}"], timeout=10, capture_output=True, text=True)
        if out.returncode == 0 and config_mode(out.stdout):
            return config_mode(out.stdout)
    except Exception:
        pass
    try:
        with open(CONFIG_PATH) as f:
            return config_mode(f.read()) or default
    except Exception:
        return default


def set_mode(mode, path=CONFIG_PATH):
    """Comando dall'app (automation.yml, action guard): salva la modalità scelta."""
    mode = str(mode or "").strip().lower()
    if mode not in MODES:
        print("Modalità non valida.")
        return 1
    with open(path, "w") as f:
        json.dump({"mode": mode}, f)
        f.write("\n")
    print(f"Guardiano Hyperliquid: modalità {mode}.")
    return 0


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--set-mode":
        return set_mode(sys.argv[2])
    env_mode = (os.environ.get("HL_GUARD_MODE") or "osserva").strip().lower()
    mode = current_mode(env_mode)
    addr = (os.environ.get("HL_ACCOUNT_ADDRESS") or "").strip()
    key = (os.environ.get("HL_API_PRIVATE_KEY") or "").strip()
    minutes = int(os.environ.get("HL_GUARD_MINUTES") or 14)
    if mode not in MODES or mode == "off":
        print("Guardiano spento.")
        return 0
    if not addr:
        print("Manca HL_ACCOUNT_ADDRESS: niente da controllare.")
        return 0
    if mode == "attivo" and not key:
        print("Modalità attivo senza HL_API_PRIVATE_KEY: passo a osserva.")
        mode = "osserva"

    import watchdog
    from hyperliquid.info import Info
    from hyperliquid.utils import constants
    info = Info(constants.MAINNET_API_URL, skip_ws=True)
    exchange = None
    if key:
        import eth_account
        from hyperliquid.exchange import Exchange
        exchange = Exchange(eth_account.Account.from_key(key), constants.MAINNET_API_URL, account_address=addr)

    state = load_state()
    state["account"] = addr                   # per l'app (il file è cifrato)
    before = json.dumps(state, sort_keys=True)
    end = time.time() + minutes * 60
    errors = 0
    while True:
        mode = current_mode(mode)
        if mode == "off":
            state["mode"] = "off"
            print("Guardiano spento dall'app.")
            break
        if mode == "attivo" and exchange is None:
            mode = "osserva"
        try:
            n, npos = run_once(info, exchange, watchdog.send, addr, mode, state)
            print(f"{datetime.now(timezone.utc):%H:%M} posizioni {npos}, azioni {n}")
            errors = 0
        except Exception as e:
            errors += 1
            print(f"Errore nel controllo: {type(e).__name__}")
            if errors == 3:
                watchdog.send(f"⚠️ Guardiano Hyperliquid: 3 errori di fila ({type(e).__name__}). Gli stop già impostati restano attivi.")
        if time.time() + 60 > end:
            break
        time.sleep(60)
    if json.dumps(state, sort_keys=True) != before:
        save_state(state)
        print("Stato aggiornato.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Statistiche comuni a laboratorio e validazioni: intervalli di confidenza con bootstrap a blocchi,
giudizio sul vantaggio, costi, tasse sul totale e simulazione di un piano stop/target.

Ogni media ha un intervallo di confidenza al 95% calcolato con bootstrap a blocchi di tempo: operazioni vicine
(e coin diverse nello stesso periodo) si muovono insieme, quindi si ricampionano blocchi interi e non singoli
casi. Un vantaggio è "dimostrato" solo se l'intero intervallo sta sopra lo zero.
"""
from datetime import datetime, timezone

import numpy as np

from market_data import FEE_PCT, SLIPPAGE_PCT, TAX_RATE

N_BOOT = 2000
MIN_N = 30            # sotto questo numero di casi non si dà nessun giudizio
COST_ROUND_TRIP = (FEE_PCT + SLIPPAGE_PCT) * 2   # commissione e slippage, ingresso più uscita (in %)


def after_tax_total(total_net_pct):
    """Tasse sul risultato complessivo: si pagano solo se la somma di guadagni e perdite è positiva."""
    return total_net_pct * (1 - TAX_RATE) if total_net_pct > 0 else total_net_pct


def cluster_ci(values, clusters, n_boot=N_BOOT, seed=20260101):
    """IC 95% della media con bootstrap a blocchi: si ricampionano i blocchi (clusters), non i singoli valori."""
    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return None
    _, inv = np.unique(np.asarray(clusters), return_inverse=True)
    sums = np.bincount(inv, weights=values)
    counts = np.bincount(inv).astype(float)
    g = len(sums)
    if g < 5:
        return None
    rng = np.random.default_rng(seed)
    means = np.empty(n_boot)
    chunk = max(1, 2_000_000 // g)
    for start in range(0, n_boot, chunk):
        idx = rng.integers(0, g, size=(min(chunk, n_boot - start), g))
        means[start:start + len(idx)] = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return [round(float(lo), 4), round(float(hi), 4)]


def verdict(ci, n):
    if n < MIN_N or ci is None:
        return "campione_insufficiente"
    if ci[0] > 0:
        return "positivo"
    if ci[1] < 0:
        return "negativo"
    return "non_dimostrato"


VERDICT_TEXT = {
    "positivo": "vantaggio dimostrato",
    "negativo": "svantaggio dimostrato",
    "non_dimostrato": "vantaggio NON dimostrato",
    "campione_insufficiente": "campione insufficiente",
}


def _ci(ci, unit="%"):
    return "n/d" if ci is None else f"[{ci[0]:+.2f}{unit}, {ci[1]:+.2f}{unit}]"


def _day(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%d/%m/%Y")


def _day(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%d/%m/%Y")


def simulate_plan(plan, candles):
    """candles: lista di dict (open/high/low/close) delle candele dell'orizzonte, in ordine.
    Stop e target controllati candela per candela; se nella stessa candela si toccano entrambi
    conta lo stop (ipotesi prudente). Senza tocchi si esce alla chiusura dell'ultima candela."""
    entry, sl, tp = plan["entry"], plan["stop_loss"], plan["take_profit"]
    long = plan["direction"] == "LONG"
    exit_price, reason = None, "TEMPO"
    for c in candles:
        if long:
            if c["low"] <= sl:
                exit_price, reason = sl, "SL"
                break
            if c["high"] >= tp:
                exit_price, reason = tp, "TP"
                break
        else:
            if c["high"] >= sl:
                exit_price, reason = sl, "SL"
                break
            if c["low"] <= tp:
                exit_price, reason = tp, "TP"
                break
    if exit_price is None:
        exit_price = candles[-1]["close"]
    gross = (exit_price - entry) / entry * 100 * (1 if long else -1)
    net = gross - COST_ROUND_TRIP   # tasse escluse: si calcolano sul totale, vedi after_tax_total
    return {"exit_reason": reason, "exit_price": round(exit_price, 6), "gross_pct": round(gross, 4), "net_pct": round(net, 4)}


def _trade_stats(rets):
    n = len(rets)
    if n == 0:
        return {"n": 0}
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    gl = abs(sum(losses))
    equity, peak, max_dd = 0.0, 0.0, 0.0
    for r in rets:  # drawdown sulla somma dei rendimenti, in ordine cronologico
        equity += r
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return {
        "n": n,
        "win_rate": round(len(wins) / n * 100, 1),
        "avg_net_pct": round(sum(rets) / n, 3),
        "total_net_pct": round(sum(rets), 2),
        "total_after_tax_pct": round(after_tax_total(sum(rets)), 2),
        "profit_factor": round(sum(wins) / gl, 2) if gl > 0 else None,
        "max_drawdown_pct": round(max_dd, 2),
    }


def _strategy_stats(points, clusters, name):
    sel = [i for i, x in enumerate(points) if x["gross"][name] is not None]
    n = len(sel)
    if n == 0:
        return {"n": 0, "verdict": "campione_insufficiente"}
    sel.sort(key=lambda i: points[i]["t"])
    gross = np.array([points[i]["gross"][name] for i in sel])
    net = gross - COST_ROUND_TRIP          # netto dei costi; le tasse solo sul totale
    cl = clusters[sel]
    net_ci = cluster_ci(net, cl)
    stats = _trade_stats([float(v) for v in net])
    return {
        "n": n,
        "win_rate": stats["win_rate"],
        "avg_gross_pct": round(float(gross.mean()), 3),
        "avg_net_pct": stats["avg_net_pct"],
        "avg_net_ci": net_ci,
        "total_net_pct": stats["total_net_pct"],
        "total_after_tax_pct": stats["total_after_tax_pct"],
        "profit_factor": stats["profit_factor"],
        "max_drawdown_pct": stats["max_drawdown_pct"],
        "verdict": verdict(net_ci, n),
    }

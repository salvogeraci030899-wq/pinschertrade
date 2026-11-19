"""Ripartenza da zero della prova su carta e dell'esecutore simulato.

I registri personali (paper_trades.json, live_trades.json) sono cifrati e non si possono riscrivere senza la chiave.
Il file `reset_epoch.json` è in chiaro: contiene una data/etichetta. Quando cambia, il registro della prova su carta e il conto
simulato dell'esecutore ricominciano da zero (mai le posizioni vere: con un client reale l'epoca si aggiorna e basta).
"""
import json

PATH = "reset_epoch.json"


def current(path=None):
    try:
        with open(path or PATH) as f:
            return str(json.load(f).get("epoch") or "")
    except (OSError, ValueError):
        return ""

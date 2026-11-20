"""Numeri in formato italiano per i messaggi (Telegram, attività dell'agente): punto per le migliaia,
virgola per i decimali, come nell'app. 3.015 diventa 3,02 e non si scambia per tremila."""


def it(v, d=2, sign=False):
    """1523.4 -> '1.523,40'; con sign=True anche il segno esplicito ('+1,00')."""
    txt = f"{v:+,.{d}f}" if sign else f"{v:,.{d}f}"
    return txt.replace(",", "§").replace(".", ",").replace("§", ".")


def it_g(v):
    """Numero corto senza zeri inutili: 1.0 -> '1', 0.25 -> '0,25', 2.5 -> '2,5'."""
    return f"{float(v):g}".replace(".", ",")

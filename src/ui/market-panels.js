// --- MERCATO: pannelli a scorrimento orizzontale accanto al grafico ---
// Livelli e indicatori: EMA 20/50/200, RSI, ATR, massimo e minimo delle ultime 20 candele chiuse, con la distanza dal prezzo.
// Carta su questa coin: cosa stanno facendo le strategie su carta sulla coin selezionata (aperte e ultime chiuse).
// Verifica strategia e Futures sono in terminal.js (usano gli stessi dati del grafico).
import { State } from '../core/state.js';
import { $, SYM, escapeHtml, fmtIt, fmtPrice } from '../utils/helpers.js';
import { getAutoState, loadAutomation } from './automation.js';

const pct = (v, d = 1) => `${v >= 0 ? '+' : ''}${fmtIt(v, d)}%`;
const tile = (label, value, sub, cls = 'neutral') =>
    `<div class="filter-item ${cls}"><span class="f-label">${label}</span><span class="f-val">${value}${sub ? `<small>${sub}</small>` : ''}</span></div>`;

// t: dati calcolati da terminal.js (price, ema20/50/200, trend.rsi, riskData.atrPct, hh20, ll20)
export function renderLevels(t, asset, tf) {
    const grid = $('levGrid'), foot = $('levFoot'), badge = $('lev-badge');
    if (!grid || !foot || !badge) return;
    if (!t || !t.price) { badge.textContent = '—'; grid.innerHTML = ''; foot.textContent = 'Calcolo in corso…'; return; }
    const dist = v => (v > 0 && t.price > 0 ? pct((v / t.price - 1) * 100) : '');
    const rsi = t.trend && t.trend.rsi != null ? t.trend.rsi : null;
    badge.textContent = `${SYM(asset)} · ${tf.toUpperCase()}`;
    grid.innerHTML =
        tile('Prezzo', fmtPrice(t.price), '') +
        tile('RSI 14', rsi == null ? '—' : fmtIt(rsi, 1), rsi == null ? '' : rsi >= 70 ? 'alto' : rsi <= 30 ? 'basso' : 'neutro') +
        tile('EMA 20', fmtPrice(t.ema20), dist(t.ema20)) +
        tile('EMA 50', fmtPrice(t.ema50), dist(t.ema50)) +
        tile('EMA 200', fmtPrice(t.ema200), dist(t.ema200)) +
        tile('ATR', t.riskData ? `${fmtIt(t.riskData.atrPct, 2)}%` : '—', 'a candela') +
        tile('Massimo 20', fmtPrice(t.hh20), dist(t.hh20)) +
        tile('Minimo 20', fmtPrice(t.ll20), dist(t.ll20));
    foot.textContent = `Candele chiuse ${tf.toUpperCase()} di Bitget; la percentuale è la distanza dal prezzo. Solo informativi.`;
}

// ---------- Carta su questa coin ----------
let askedLoad = false;
const stratName = key => { const [name, tf] = String(key).split(':'); return `${name.replace(/_/g, ' ')}${tf ? ' ' + tf.toUpperCase() : ''}`; };
const since = ts => {
    const h = (Date.now() / 1000 - ts) / 3600;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} giorni`;
};

function paperTrades(asset) {
    const { ledger } = getAutoState();
    const out = [];
    for (const [key, e] of Object.entries((ledger && ledger.strategies) || {})) {
        if (e && e.mode === 'off') continue;
        for (const t of (e && e.trades) || []) if (t.symbol === asset && t.entry) out.push({ ...t, key });
    }
    return out;
}

export function renderPaperOnCoin() {
    const list = $('paperList'), foot = $('paperFoot'), badge = $('paper-badge');
    if (!list || !foot || !badge) return;
    const st = getAutoState(), asset = State.currentAsset;
    if (!st.loaded) {
        if (!askedLoad) { askedLoad = true; loadAutomation(); }
        badge.textContent = '—'; list.innerHTML = '<div class="paper-empty">Carico i dati della carta…</div>'; foot.textContent = '';
        return;
    }
    const all = paperTrades(asset);
    const open = all.filter(t => t.open).sort((a, b) => (b.t_entry || b.t || 0) - (a.t_entry || a.t || 0));
    const closed = all.filter(t => !t.open && t.net != null).sort((a, b) => (b.t_exit || b.t || 0) - (a.t_exit || a.t || 0)).slice(0, 3);
    const px = State.livePx[asset];
    const row = (t, isOpen) => {
        const side = t.dir > 0 ? 'LONG' : 'SHORT';
        const v = isOpen ? (px ? t.dir * (px / t.entry - 1) * 100 : null) : t.net;
        const ts = isOpen ? (t.t_entry || t.t) : (t.t_exit || t.t);
        const cls = v == null ? '' : v > 0 ? 'text-accent' : v < 0 ? 'text-danger' : '';
        return `<div class="paper-row"><div class="paper-name"><span>${escapeHtml(stratName(t.key))}</span><small>${side} da ${fmtPrice(t.entry)} · ${isOpen ? 'aperta da' : 'chiusa'} ${ts ? since(ts) : '—'}${isOpen ? '' : ' fa'}</small></div><b class="${cls}">${v == null ? '—' : pct(v, 2)}</b></div>`;
    };
    badge.textContent = `${open.length} ${open.length === 1 ? 'aperta' : 'aperte'}`;
    const rows = [...open.map(t => row(t, true)), ...closed.map(t => row(t, false))];
    list.innerHTML = rows.length ? rows.join('') : `<div class="paper-empty">Nessuna strategia su carta ha operato su ${SYM(asset)} da quando la carta è ripartita.</div>`;
    foot.textContent = rows.length ? 'Aperte: risultato lordo ai prezzi di adesso. Chiuse: al netto dei costi. Tutto il resto in Risultati → Carta.' : '';
    // mostra solo le righe che entrano per intero
    const kids = [...list.querySelectorAll('.paper-row')];
    kids.forEach(r => { r.hidden = false; });
    const limit = list.clientHeight;
    if (limit) kids.forEach(r => { if (r.offsetTop + r.offsetHeight > limit + 1) r.hidden = true; });
}

import { State } from '../core/state.js';
import { SYM, fetchT, escapeHtml, fmtUsdt, fmtPrice } from '../utils/helpers.js';
import * as Calculator from './calculator.js';
import * as AI from './ai.js';
import { tradingMode } from './account.js';
import { getAutoState, maybeRefreshAccount, isRealOrderRemoving, isRefreshingAccount } from './automation.js';
import { realPositions } from './history.js';
import { netPnlAt } from '../core/rules.js';

export function initTrade() {
    // posizioni reali: prezzo mark dei futures ogni 5 secondi (solo in modalità Reale e con posizioni aperte)
    setInterval(pollMarks, 5000);
    // ritorno nell'app (per esempio dopo aver aperto una posizione nell'app Bitget): conto riletto subito
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isReal()) maybeRefreshAccount(true); });
}
export function onOpenTrade() { if (isReal()) maybeRefreshAccount(true); }

// --- Posizioni reali "vive": il bot legge Bitget ogni 15 minuti; tra un giro e l'altro l'app stima
// PnL e prezzo con il mark price pubblico dei futures (stessa base che usa Bitget per il PnL aperto).
const markPx = {};
let marksInFlight = false;
const realList = () => realPositions();       // futures e coin spot (history.js)

async function pollMarks() {
    if (marksInFlight || !isReal() || document.hidden) return;
    maybeRefreshAccount();
    const symbols = [...new Set(realList().map(p => p.symbol))];
    if (!symbols.length) return;
    marksInFlight = true;
    try {
        await Promise.all(symbols.map(async sym => {
            try {
                const r = await fetchT(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`);
                const j = await r.json();
                const d = j && j.code === '00000' && j.data && j.data[0];
                const m = d ? parseFloat(d.markPrice || d.lastPr) : NaN;
                if (isFinite(m) && m > 0) markPx[sym] = m;
            } catch (e) { /* rete: resta l'ultimo valore */ }
        }));
    } finally { marksInFlight = false; }
    updateRealLive();
    if (window.updateHome) window.updateHome();
}

// PnL aperto stimato al prezzo mark attuale; senza mark resta quello letto dal bot
export function liveUpl(p) {
    const m = markPx[p.symbol];
    if (!p.entry) return p.upl ?? null;           // coin spot senza prezzo d'acquisto noto
    return m ? (p.side === 'short' ? -1 : 1) * (m - p.entry) * p.size : p.upl;
}
export const hasLiveMarks = () => realList().some(p => markPx[p.symbol]);

function updateRealLive() {
    const el = document.getElementById('activeTradesList');
    if (!el || !document.getElementById('page-trade')?.classList.contains('active')) return;
    const n = (v, d = 2) => (v == null ? '—' : Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
    for (const p of realList()) {
        const card = el.querySelector(`.at-real[data-key="${p.key}"]`);
        const m = markPx[p.symbol];
        if (!card || !m) continue;
        const u = liveUpl(p);
        const val = card.querySelector('[data-f="value"]');
        if (val) val.textContent = n(m * p.size);
        if (u == null) { const mk0 = card.querySelector('[data-f="mark"]'); if (mk0) mk0.textContent = n(m); continue; }
        const mk = card.querySelector('[data-f="mark"]'), up = card.querySelector('[data-f="upl"]'), lbl = card.querySelector('[data-f="upl-lbl"]');
        if (mk) mk.textContent = n(m);
        if (up) { up.textContent = (u >= 0 ? '+' : '') + n(u); up.style.color = u >= 0 ? 'var(--accent)' : 'var(--danger)'; }
        if (lbl) lbl.textContent = 'PnL live (stima)';
    }
}

// In modalità Reale la pagina mostra il conto Bitget (letto dal bot): saldo non modificabile e
// posizioni vere in sola lettura. In Simulato la pagina mostra il conto della carta.
export const isReal = () => tradingMode().mode === 'on';
const bitgetAccount = () => { const st = getAutoState(); return st.live && st.live.account; };

export function refreshCapitalUI() {
    const el = document.getElementById('simCapitalDisplay');
    const real = isReal(), acc = bitgetAccount();
    const total = acc && acc.connected ? (acc.total_usdt != null ? acc.total_usdt : acc.equity) : null;
    const st = getAutoState(), sim = st.live && st.live.simulated;
    const paper = sim && Number.isFinite(Number(sim.equity)) ? Number(sim.equity) : null;
    if (el) el.textContent = real ? (total != null ? fmtUsdt(total) : '—') : (paper != null ? fmtUsdt(paper) : '—');
    const lbl = document.getElementById('capitalLabel'), sub = document.getElementById('tradeSubtitle');
    if (lbl) lbl.textContent = real ? 'Saldo Bitget' : 'Patrimonio carta';
    if (sub) sub.textContent = real ? 'Bitget · reale' : 'Conto simulato · carta';
    Calculator.syncCapital();
}

// Quanto si vince o si perde (USDT) se il prezzo arriva a un livello: posizioni reali con le commissioni di Bitget
// (0,06% futures, 0,1% spot, niente tasse)
const usdAt = v => (v == null || !isFinite(v) ? '' : `<small class="at-usd ${v >= 0 ? 'green' : 'red'}">${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')} USDT</small>`);
function realAt(p, level) {
    if (!level || !p.entry) return null;
    return netPnlAt({ type: p.side === 'short' ? 'SHORT' : 'LONG', entryPrice: p.entry, size: p.size, feeRate: p.market === 'spot' ? 0.001 : 0.0006, noTax: true }, level);
}

// Comandi attivi (regole, stop e target) in una striscia che scorre in orizzontale: una riga sola, qualunque numero
const rulesStrip = items => (items.length ? `<div class="at-rules${items.length > 1 ? ' many' : ''}">${items.join('')}</div>` : '');

// "Comandi attivi" di una posizione reale: TP e SL che stanno su Bitget (messi con Chat o Voce, o a mano
// nell'app Bitget), ciascuno con ✕ per toglierlo; sotto, l'esito dell'ultimo comando dato dall'app.
function realCommands(p, events) {
    const short = p.side === 'short';
    const row = (kind, price) => {
        const label = kind === 'tp' ? `Target Bitget ${short ? '≤' : '≥'} ${fmtPrice(price)}` : `Stop Bitget ${short ? '≥' : '≤'} ${fmtPrice(price)}`;
        return isRealOrderRemoving(`${p.market}:${p.symbol}`, kind)
            ? `<div class="at-rule"><span>${label} · in rimozione…</span></div>`
            : `<div class="at-rule"><span>${label}</span><button type="button" onclick="removeRealOrder('${p.symbol}','${p.side}','${kind}',${Number(price)},'${p.market}')" title="Togli">✕</button></div>`;
    };
    const rows = rulesStrip([p.sl ? row('sl', p.sl) : '', p.tp ? row('tp', p.tp) : ''].filter(Boolean));
    const ev = events.filter(e => e.symbol === p.symbol && e.side === (p.market === 'spot' ? 'spot' : p.side)).pop();
    const recent = ev && Date.now() - Date.parse(ev.at) < 24 * 3600e3;
    const last = recent ? `<div class="at-meta at-last">Ultimo comando ${new Date(ev.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}: <span class="${ev.ok === false ? 'text-danger' : 'text-accent'}">${ev.ok === false ? 'non eseguito,' : 'eseguito,'}</span> ${escapeHtml(ev.msg || ev.action)}</div>` : '';
    const none = !p.sl && !p.tp ? `<div class="at-meta">Nessuno stop né target su Bitget: chiedili con Chat o Voce.</div>` : '';
    return rows + none + last;
}

export function requestAIAnalysisReal(key) {
    const p = realList().find(x => x.key === key || x.symbol === key);
    if (p) { const symbol = p.symbol; return analyzeReal(p, symbol); }
}
function analyzeReal(p, symbol) {
    if (!p) return;
    const trade = { symbol, type: p.side === 'short' ? 'SHORT' : 'LONG', entryPrice: p.entry, slPrice: p.sl || null, tpPrice: p.tp || null,
        leverage: p.leverage, size: p.size, currentPrice: markPx[symbol] || p.mark || p.entry, pnl: liveUpl(p) || 0, real: true };
    return AI.runAIAnalysis({ symbol, tf: '4h', trade });
}

function renderRealPositions(el) {
    const acc = bitgetAccount();
    const list = realList();
    const events = ((getAutoState().live || {}).events || []).filter(e => e && e.kind === 'manual');
    const lastEv = events[events.length - 1];
    const sig = `real|${acc && acc.checked_at}|${list.map(p => `${p.key}${p.tp}/${p.sl}/${isRealOrderRemoving(p.key, 'tp')}${isRealOrderRemoving(p.key, 'sl')}`).join()}|${lastEv && lastEv.at}|${isRefreshingAccount()}`;
    if (sig === State.atSig) return;
    State.atSig = sig;
    const when = acc && acc.checked_at ? `, letto alle ${new Date(acc.checked_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : '';
    const note = `<div class="at-real-note">${isRefreshingAccount() ? '<span class="text-ui">Aggiorno da Bitget…</span> ' : ''}Da Bitget${when}. Ordini veri solo dopo la tua conferma.</div>`;
    if (!acc || !acc.connected) {
        el.classList.add('empty');
        el.innerHTML = `<div class="at-empty">Conto Bitget non letto.${note}</div>`;
    } else if (!list.length) {
        el.classList.add('empty');
        el.innerHTML = `<div class="at-empty">Nessuna posizione aperta su Bitget (futures) e nessuna coin spot.${note}</div>`;
    } else {
        el.classList.remove('empty');
        setCardRows(el, list.length);
        const n = (v, d = 2) => (v == null ? '—' : Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
        el.innerHTML = list.map(p => `
            <div class="active-trade-card at-real" data-symbol="${p.symbol}" data-key="${p.key}">
                <div class="at-header"><div class="at-title">
                    <span class="at-coin">${SYM(p.symbol)} ${p.market === 'spot' ? '' : String(p.side || '').toUpperCase()}</span>
                    ${p.market === 'spot' ? '<span class="at-market spot">SPOT</span>' : `<span class="at-market futures">FUTURES</span>${p.leverage ? `<span class="at-lev">${n(p.leverage, 0)}x</span>` : ''}`}
                </div><button type="button" class="at-assist" onclick="openAssistantReal('${p.key}', false)" title="Assistente: scrivi o parla" aria-label="Assistente"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4"/><path d="M10 9.5a2 2 0 0 0 4 0"/></svg></button></div>
                ${realCommands(p, events)}
                <div class="at-body">
                    <div class="at-item"><span class="at-lbl">${p.market === 'spot' ? 'Acquisto' : 'Entry'}</span><span class="at-val">${n(p.entry)}</span></div>
                    <div class="at-item"><span class="at-lbl">${p.market === 'spot' ? 'Prezzo' : 'Mark'}</span><span class="at-val" data-f="mark">${n(p.mark)}</span></div>
                    <div class="at-item"><span class="at-lbl">Quantità</span><span class="at-val">${n(p.size, 4)}</span></div>
                    ${p.market === 'spot'
                        ? `<div class="at-item"><span class="at-lbl">Valore</span><span class="at-val" data-f="value">${n(p.value)}</span></div>
                    <div class="at-item"><span class="at-lbl">Mercato</span><span class="at-val">spot, 1x</span></div>`
                        : `<div class="at-item"><span class="at-lbl">Margine</span><span class="at-val">${n(p.margin)}</span></div>
                    <div class="at-item"><span class="at-lbl">Liquidazione</span><span class="at-val red">${n(p.liq)}${p.liq ? usdAt(-(p.margin || 0)) : ''}</span></div>`}
                    <div class="at-item"><span class="at-lbl" data-f="upl-lbl">PnL aperto</span><span class="at-val" data-f="upl" style="color:${(p.upl || 0) >= 0 ? 'var(--accent)' : 'var(--danger)'}">${p.upl == null ? '—' : (p.upl >= 0 ? '+' : '') + n(p.upl)}</span></div>
                    <div class="at-item"><span class="at-lbl">Take profit</span><span class="at-val green">${p.tp ? fmtPrice(p.tp) + usdAt(realAt(p, p.tp)) : '—'}</span></div>
                    <div class="at-item"><span class="at-lbl">Stop loss</span><span class="at-val red">${p.sl ? fmtPrice(p.sl) + usdAt(realAt(p, p.sl)) : '—'}</span></div>
                </div>
                ${note}
            </div>`).join('');
        updateRealLive();
    }
    renderActiveTradeDots();
}

// Due schede una sopra l'altra solo se c'è spazio per entrambe a grandezza piena; altrimenti una alla volta
// (scorrendo di lato). Con una sola scheda niente seconda riga vuota che costringe a rimpicciolire tutto.
function setCardRows(el, count) {
    const one = count <= 1 || window.innerHeight < 760;
    if (el.classList.contains('one-row') !== one) el.classList.toggle('one-row', one);
}

export function renderActiveTrades() {
    const el = document.getElementById('activeTradesList');
    if (!el) return;
    // Pagina Posizioni non visibile: niente da ridisegnare (lo fa switchTab all'apertura)
    const pg = document.getElementById('page-trade');
    if (pg && !pg.classList.contains('active')) return;
    if (window.renderOrders) window.renderOrders();       // vista Ordini, se è quella aperta
    if (isReal()) renderRealPositions(el);        // in Simulato la pagina mostra solo il conto della carta (orders.js)
}

export function renderActiveTradeDots() {
    const dotsContainer = document.getElementById('activeTradeDots');
    const counter = document.getElementById('activeTradeCounter');
    if (!dotsContainer) return;
    // schede della modalità attiva; per pagina: due, una sugli schermi bassi (righe della griglia)
    const container = document.getElementById('activeTradesList');
    const count = isReal() ? realList().length : 0;
    if (count === 0) { dotsContainer.innerHTML = ''; if (counter) counter.textContent = ''; return; }
    const perPage = container ? Math.max(1, getComputedStyle(container).gridTemplateRows.split(' ').filter(Boolean).length) : 2;
    const totalPages = Math.ceil(count / perPage);
    let activeIdx = 0;
    if (container && container.firstElementChild) { const itemWidth = container.firstElementChild.offsetWidth + 12; if (itemWidth > 0) activeIdx = Math.round(container.scrollLeft / itemWidth); }
    activeIdx = Math.max(0, Math.min(activeIdx, totalPages - 1));
    if (totalPages > 15) dotsContainer.innerHTML = '';
    else {
        let html = '';
        for (let i = 0; i < totalPages; i++) html += `<div class="info-dot${i === activeIdx ? ' active' : ''}" onclick="goToActiveTradePage(${i})"></div>`;
        dotsContainer.innerHTML = html;
    }
    if (counter) counter.textContent = `${activeIdx + 1} / ${totalPages}`;
}

export function goToActiveTradePage(idx) {
    const container = document.getElementById('activeTradesList');
    if (!container) return;
    container.scrollTo({ left: idx * container.clientWidth, behavior: 'smooth' });
}

export function closeAIAnalysisModal() { document.getElementById('aiAnalysisModal').classList.remove('active'); }

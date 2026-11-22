// --- POSIZIONI → ORDINI e BOT SU CARTA ---
// Ordini: tutto ciò che è in attesa o è stato chiesto, in un posto solo.
// Bot su carta: i trade aperti dalle strategie del bot in prova su carta (paper_trades.json, nessun ordine reale),
// con il risultato del momento ai prezzi Bitget. I chiusi stanno in Risultati → Strategie su carta.
// Solo ciò che aspetta di scattare. Reale: stop e target in attesa su Bitget, futures e spot (con ✕).
// Comandi inviati ed esiti stanno nel Registro; gli avvisi di prezzo in Mercato → Avvisi.
// Gli ordini veri si creano dalla pagina Trade o con l'assistente; qui si vedono e si tolgono.
// In Simulato la pagina mostra solo il conto della carta (Bot su carta): niente trade simulati a mano.
import { $, SYM, escapeHtml, fmtIt, fmtPrice, markChosen, fetchData, fetchT } from '../utils/helpers.js';
import { realPositions } from './history.js';
import { isRealOrderRemoving, getAutoState } from './automation.js';
import { isNearCandidate } from '../core/strategy-status.js';

const VIEW_KEY = 'pt_pos_view';
let view = 'open';
const VIEWS = ['open', 'orders', 'bot'];
try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(v)) view = v; } catch (e) {}

export function setPosView(v, manual = true) {
    if (manual) markChosen('posView');
    view = VIEWS.includes(v) ? v : 'open';
    try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
    applyView();
    if (view !== 'open') renderOrders();
    if (view === 'bot') loadPaper().then(renderOrders);
    liveBot(view === 'bot');
}

// Vista scelta da sola all'apertura della pagina: in Reale le posizioni vere, in Simulato il conto della carta.
export async function autoPosView() {
    setPosView('open', false);
}

function applyView() {
    const open = $('activeTradesList'), dots = $('activeTradeDots'), orders = $('ordersView'), tabs = document.querySelector('#page-trade .pos-views');
    if (!open || !orders) return;
    if (tabs) tabs.style.display = '';                                       // la pagina ha sempre le stesse viste, anche con Reale spento
    open.style.display = view === 'open' ? '' : 'none';
    if (dots) dots.style.display = view === 'open' ? '' : 'none';
    orders.style.display = view === 'open' ? 'none' : '';
    VIEWS.forEach(v => $('btn-pos-' + v)?.classList.toggle('active', view === v));
}

// Nessuno scroll verticale: ogni scheda ha i suoi elementi in fila, da scorrere in orizzontale
// Oltre allo scorrimento col dito, frecce ‹ › e posizione (1/4): su iPhone si scorre anche senza trascinare
const nav = n => n > 1 ? `<span class="ord-nav"><button type="button" aria-label="Precedente" onclick="ordStep(this,-1)">‹</button><span class="ord-pos">1/${n}</span><button type="button" aria-label="Successivo" onclick="ordStep(this,1)">›</button></span>` : '';
const section = (title, rows, empty, count = rows.length) => `<div class="ord-sec"><div class="ord-title">${title}${count > 1 ? ` <span class="ord-count">${count}</span>` : ''}${nav(rows.length)}</div>`
    + `<div class="ord-list${rows.length > 1 ? ' many' : ''}" onscroll="ordSync(this)">${rows.length ? rows.join('') : `<div class="ord-empty">${empty}</div>`}</div></div>`;

const listIndex = list => {
    const rows = [...list.children], x = list.scrollLeft;
    let best = 0;
    rows.forEach((r, i) => { if (Math.abs(r.offsetLeft - x) < Math.abs(rows[best].offsetLeft - x)) best = i; });
    return list.scrollLeft + list.clientWidth >= list.scrollWidth - 2 ? rows.length - 1 : best;
};
export function ordSync(list) {
    const sec = list.closest('.ord-sec'), pos = sec && sec.querySelector('.ord-pos');
    if (!pos) return;
    const i = listIndex(list), n = list.children.length;
    pos.textContent = `${i + 1}/${n}`;
    const [prev, next] = sec.querySelectorAll('.ord-nav button');
    prev.disabled = i === 0; next.disabled = i === n - 1;
}
export function ordStep(btn, dir) {
    const list = btn.closest('.ord-sec')?.querySelector('.ord-list');
    if (!list) return;
    const rows = [...list.children], i = Math.max(0, Math.min(rows.length - 1, listIndex(list) + dir));
    list.scrollTo({ left: rows[i].offsetLeft, behavior: 'smooth' });
}
const row = (main, sub, action = '') => `<div class="ord-row"><div class="ord-main"><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</div>${action}</div>`;

function realOrders(market) {
    const rows = [];
    for (const p of realPositions().filter(x => (x.market === 'spot') === (market === 'spot'))) {
        const name = p.market === 'spot' ? `${SYM(p.symbol)} spot` : `${SYM(p.symbol)} ${String(p.side).toUpperCase()} futures`;
        const short = p.side === 'short';
        for (const [kind, price] of [['sl', p.sl], ['tp', p.tp]]) {
            if (!price) continue;
            const what = kind === 'sl' ? `Stop ${short ? '≥' : '≤'} ${fmtPrice(price)}` : `Target ${short ? '≤' : '≥'} ${fmtPrice(price)}`;
            const removing = isRealOrderRemoving(p.key, kind);
            rows.push(row(`${escapeHtml(name)} · ${what}`, kind === 'sl' ? 'chiude in perdita a mercato' : 'chiude in guadagno a mercato',
                removing ? '<span class="ord-tag">in rimozione…</span>'
                    : `<button type="button" class="ord-x" title="Togli" onclick="removeRealOrder('${p.symbol}','${p.side}','${kind}',${Number(price)},'${p.market}')">✕</button>`));
        }
        if (!p.sl) rows.push(row(`${escapeHtml(name)} · nessuno stop`, 'aggiungilo con Chat o Voce sulla posizione', '<span class="ord-tag warn">senza stop</span>'));
    }
    return rows;
}

// --- Bot su carta ---
// Importi in $: ogni trade dimensionato come farebbe l'esecutore con i soldi veri, cioè sul conto Bitget di oggi
// (o sul capitale di prova se il conto non è collegato) con il rischio per trade attuale: se tocca lo stop iniziale
// perde quella percentuale del conto. Su carta si prendono però tutti i segnali, senza i limiti di posizioni.
let paper = null, live = null, paperAcct = null, riskCfg = {}, paperAt = 0, pricesAt = 0, base = { capital: 1000, risk: 0.5, real: false };
const prices = {};
const paperAll = () => {
    const out = [];
    for (const [key, e] of Object.entries((paper && paper.strategies) || {})) {
        if (e && e.mode === 'off') continue;              // strategia spenta: i suoi vecchi trade non contano (come in Mercato)
        for (const t of (e && e.trades) || []) out.push({ ...t, key });
    }
    return out;
};
// Con gli ordini simulati l'esecutore segue la carta con gli STESSI limiti del reale (posizioni massime, stesso verso, perdita del giorno,
// dimensione, leva): quel conto è la "carta" che precede il reale. Le posizioni e il conto stanno in live_trades.json.
// il conto della carta sta in paper_account.json (sempre acceso); prima del primo giro dopo l'aggiornamento vale quello dell'esecutore simulato
const simSrc = () => (paperAcct && paperAcct.simulated ? paperAcct : (live && live.mode === 'simulata' && live.simulated ? live : null));
export const simActive = () => !!simSrc();
const simPositions = () => Object.entries((simSrc() && simSrc().positions) || {}).map(([id, p]) => ({ id, ...p }));
const simOpen = () => (simActive() ? simPositions().filter(p => p.status === 'open').sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at))) : []);
const paperOpen = () => paperAll().filter(t => t.open).sort((a, b) => (b.t_entry || b.t || 0) - (a.t_entry || a.t || 0));
// Un solo caricamento alla volta: chi arriva mentre è in corso aspetta lo stesso (e trova anche i prezzi)
let inflight = null;
function loadPaper(force = false) {
    if (!inflight) inflight = fetchPaper(force).finally(() => { inflight = null; });
    return inflight;
}
async function fetchPaper(force) {
    if (force || !paper || Date.now() - paperAt > 60000) {
        paperAt = Date.now();
        const get = async n => { try { const r = await fetchData(n); return r.ok ? await r.json() : null; } catch (e) { return null; } };
        const [p, cfg, lv, pa] = await Promise.all([get('paper_trades.json'), get('automation.json'), get('live_trades.json'), get('paper_account.json')]);
        if (p) paper = p;
        if (lv) live = lv;
        if (pa) paperAcct = pa;
        riskCfg = (cfg && cfg.risk) || riskCfg;
        const eq = Number(lv && lv.account && lv.account.connected && lv.account.equity);
        const risk = Number(cfg && cfg.risk && cfg.risk.risk_per_trade_pct);
        base = { capital: eq > 0 ? eq : Number(cfg && cfg.risk && cfg.risk.dry_run_equity) || 1000, risk: risk > 0 ? risk : 0.5, real: eq > 0 };
    }
    if (Date.now() - pricesAt < 8000) return;
    pricesAt = Date.now();
    const syms = [...new Set([...paperOpen().map(t => t.symbol), ...simOpen().map(p => p.symbol)])];
    await Promise.all(syms.map(async s => {
        try {
            const r = await fetchT(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${s}`);
            const p = Number((await r.json())?.data?.[0]?.lastPr);
            if (p > 0) prices[s] = p;
        } catch (e) {}
    }));
}
// Prezzi aggiornati ogni 10 s finché la vista è aperta (e la pagina è in primo piano)
let liveTimer = null;
function liveBot(on) {
    if (on && !liveTimer) {
        liveTimer = setInterval(() => {
            const pg = document.getElementById('page-trade');
            if (view !== 'bot' || document.hidden || !(pg && pg.classList.contains('active'))) return;
            loadPaper().then(renderOrders);
        }, 10000);
    } else if (!on && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}
const stratName = key => { const [name, tf] = String(key).split(':'); return `${name.replace(/_/g, ' ')}${tf ? ' ' + tf.toUpperCase() : ''}`; };
const day = ts => (ts ? new Date(ts * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) : '—');
const pctTxt = v => `${v >= 0 ? '+' : ''}${fmtIt(v, 2)}%`;
const usd = v => `${v >= 0 ? '+' : '−'}${fmtIt(Math.abs(v), 2)} $`;
const tone = v => (v >= 0 ? 'text-accent' : 'text-danger');
// nominale del trade: perdita allo stop iniziale = rischio per trade del conto
// Trade registrati prima che il bot salvasse lo stop iniziale (si aggiungono alla candela successiva): se lo stop
// attuale è già passato in guadagno non dice più il rischio preso, quindi niente importo (null), solo la %.
const notional = t => {
    const e = Number(t.entry), s = Number(t.stop0 || t.stop);
    if (!t.stop0 && e && s && (t.dir > 0 ? s >= e : s <= e)) return null;
    const dist = e && s ? Math.abs(e - s) / e : 0;
    return dist > 0 ? base.capital * base.risk / 100 / dist : null;
};
const usdOf = (size, pct) => (size == null ? '' : ` · ${usd(size * pct / 100)}`);
const livePct = t => { const now = prices[t.symbol]; return now && t.entry ? (t.dir > 0 ? 1 : -1) * (now - t.entry) / t.entry * 100 : null; };
const simPct = p => { const now = prices[p.symbol]; return now && p.entry ? (p.side === 'long' ? 1 : -1) * (now - p.entry) / p.entry * 100 : null; };
const simUsd = (p, pct) => (p.size && p.entry && pct != null ? p.size * p.entry * pct / 100 : null);
function simRows() {
    return simOpen().map(p => {
        const pct = simPct(p), usdv = simUsd(p, pct), side = String(p.side).toUpperCase();
        const res = pct == null ? '' : ` · <span class="${tone(pct)}">${pctTxt(pct)}${usdv == null ? '' : ` · ${usd(usdv)}`}</span>`;
        const risk = p.size && p.entry && p.stop ? p.size * Math.abs(p.entry - p.stop) : null;
        const lock = p.entry && p.stop ? (p.side === 'long' ? 1 : -1) * (p.stop - p.entry) / p.entry * 100 : null;
        const lockTxt = lock == null ? `stop ${fmtPrice(p.stop)}`
            : `stop ${fmtPrice(p.stop)} <span class="${tone(lock)}">${lock >= 0 ? 'al sicuro' : 'rischio'} ${pctTxt(lock)}${risk != null && lock < 0 ? ` · ${usd(-risk)}` : ''}</span>`;
        return row(`${escapeHtml(SYM(p.symbol))} ${side}${res}`,
            `${escapeHtml(stratName(p.key))} · dal ${p.opened_at ? new Date(p.opened_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) : '—'} · ingresso ${fmtPrice(p.entry)} · ${fmtIt(p.size, 4)} coin<br>${lockTxt}`);
    });
}
// Conto della carta con i limiti del reale: cassa + guadagno non realizzato ai prezzi di adesso
// Quali strategie segue ora il conto (stessa regola del bot): live, candidate o confermate e, con alto rischio, quasi candidate
function followedLine() {
    const { cfg, lab } = getAutoState();
    const strategies = (cfg && cfg.strategies) || {};
    const best = new Set([...((lab && lab.confirmed) || []), ...((lab && lab.candidates) || [])]);
    const nearOn = Number(cfg && cfg.risk && cfg.risk.near_candidates) === 1;
    const names = [];
    for (const [key, mode] of Object.entries(strategies)) {
        if (mode === 'off') continue;
        if (mode === 'live' || best.has(key) || (nearOn && lab && lab.results && lab.results[key] && isNearCandidate(lab.results[key]))) names.push(stratName(key));
    }
    return names.length ? `<br>segue ora ${names.length} ${names.length === 1 ? 'strategia' : 'strategie'}: ${escapeHtml(names.join(', '))}`
        : '<br>nessuna strategia candidata o confermata: il conto non apre trade finché una non lo diventa (le altre restano in osservazione)';
}
function simAccount() {
    const sim = simSrc().simulated, pos = simPositions(), start = Number(sim.start) || Number(riskCfg.dry_run_equity) || 1000;
    let unreal = 0, nOpen = 0;
    for (const p of pos.filter(x => x.status === 'open')) { const pct = simPct(p), u = simUsd(p, pct); if (u != null) { unreal += u; nOpen++; } else nOpen++; }
    if (!nOpen) unreal = 0; else if (!Object.keys(prices).length) unreal = Number(sim.unrealized) || 0;
    const cash = Number(sim.cash ?? sim.equity) || start, total = cash + unreal;
    const closed = pos.filter(p => p.status === 'closed' && p.net != null), netClosed = closed.reduce((a, p) => a + Number(p.net), 0);
    const skipped = pos.filter(p => p.status === 'skipped'), reasons = {};
    for (const p of skipped) { const k = String(p.reason || 'altro').replace(/^già \d+ posizioni (long|short) aperte.*/, 'già troppe posizioni nello stesso verso'); reasons[k] = (reasons[k] || 0) + 1; }
    const why = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${escapeHtml(k)} (${n})`).join(' · ');
    const r = riskCfg, lim = [`rischio ${fmtIt(r.risk_per_trade_pct ?? 0.5, 2)}% a trade`, `leva ${r.max_leverage ?? 3}x`, `max ${r.max_open_positions ?? 3} posizioni`, `${r.max_same_direction ?? 2} nello stesso verso`, `stop del giorno −${fmtIt(r.max_daily_loss_pct ?? 3, 1)}%`].join(' · ');
    const day = simSrc().day || {}, dayTxt = day.blocked ? '<br><span class="text-danger">limite di perdita del giorno raggiunto: nessun nuovo ingresso fino a domani</span>' : day.target_hit ? '<br><span class="text-accent">obiettivo del giorno raggiunto: nessun nuovo ingresso fino a domani</span>' : '';
    return `<div class="ord-sec bot-acc"><div class="ord-title">Conto su carta del bot</div>`
        + `<div class="bot-acc-main"><b>${fmtIt(total, 2)} $</b><span class="${tone(total - start)}">${usd(total - start)}</span></div>`
        + `<small>chiusi ${closed.length}: <span class="${tone(netClosed)}">${usd(netClosed)}</span> · aperti ${nOpen}: <span class="${tone(unreal)}">${usd(unreal)}</span>`
        + `<br>base ${fmtIt(start, 2)} $ (capitale di prova) · commissioni comprese · stesse regole del reale: ${lim}`
        + followedLine() + (skipped.length ? `<br>${skipped.length} segnali non aperti dal conto: ${why}` : '') + ((simSrc().rounds || []).length ? `<br><span class="text-danger">partite perse: ${(simSrc().rounds || []).length} (capitale esaurito, il conto è ripartito)</span>` : '') + dayTxt + '</small></div>';
}
// Righe dei trade delle strategie su carta (paper_trades.json), anche quelli che il conto non ha aperto
function paperRows(list) {
    return list.map(t => {
        const side = t.dir > 0 ? 'LONG' : 'SHORT', pnl = livePct(t), size = notional(t);
        const res = pnl == null ? '' : ` · <span class="${tone(pnl)}">${pctTxt(pnl)}${usdOf(size, pnl)}</span>`;
        // dove sta lo stop ora: sopra l'ingresso (long) o sotto (short) il guadagno è già al sicuro
        const lock = t.entry && t.stop ? (t.dir > 0 ? 1 : -1) * (t.stop - t.entry) / t.entry * 100 : null;
        const lockTxt = lock == null ? `stop ${fmtPrice(t.stop)}`
            : `stop ${fmtPrice(t.stop)} <span class="${tone(lock)}">${lock >= 0 ? 'al sicuro' : 'rischio'} ${pctTxt(lock)}${usdOf(size, lock)}</span>`;
        return row(`${escapeHtml(SYM(t.symbol))} ${side}${res}`,
            `${escapeHtml(stratName(t.key))} · dal ${day(t.t_entry || t.t)} · ingresso ${fmtPrice(t.entry)}<br>${lockTxt}`);
    });
}
function botRows() {
    if (simActive()) return simRows();
    return paperRows(paperOpen());
}
// Trade aperti delle strategie che il conto della carta non ha (ancora) aperto: segnali già in corso prima del conto, o fermati dai limiti.
// Sono gli stessi che Mercato mostra in "Carta su questa coin".
function extraPaperRows() {
    if (!simActive()) return [];
    const held = new Set(simPositions().filter(p => p.status === 'open').map(p => p.id));
    return paperRows(paperOpen().filter(t => !held.has(t.id)));
}
// Conto su carta: base + trade chiusi (netti di costi) + aperti ai prezzi di adesso
function botAccount() {
    if (simActive()) return simAccount();
    if (!paper) return '';
    let closed = 0, nClosed = 0, open = 0, nOpen = 0, noSize = 0;
    for (const t of paperAll()) {
        const size = notional(t);
        if (t.open) { const p = livePct(t); if (p != null && size != null) { open += size * p / 100; nOpen++; } else if (size == null) noSize++; continue; }
        const r = t.net != null ? t.net : t.gross;
        if (r == null || t.reason === 'ANNULLATO') continue;
        if (size == null) { noSize++; continue; }
        closed += size * r / 100; nClosed++;
    }
    const total = base.capital + closed + open;
    return `<div class="ord-sec bot-acc"><div class="ord-title">Conto su carta del bot</div>`
        + `<div class="bot-acc-main"><b>${fmtIt(total, 2)} $</b><span class="${tone(closed + open)}">${usd(closed + open)}</span></div>`
        + `<small>chiusi ${nClosed}: <span class="${tone(closed)}">${usd(closed)}</span> · aperti ${nOpen}: <span class="${tone(open)}">${usd(open)}</span>`
        + `<br>base ${fmtIt(base.capital, 2)} $ (${base.real ? 'conto Bitget di oggi' : 'capitale di prova'}), rischio ${fmtIt(base.risk, 2)}% a trade, tutti i segnali`
        + (noSize ? `<br>${noSize} trade senza importo: registrati prima dello stop iniziale` : '') + '</small></div>';
}
// Tanti trade: a pagine, ognuna piena di righe fino in fondo allo schermo, da scorrere di lato
let perPage = 5;
const pagesOf = (rows, per = perPage) => { const pages = []; for (let i = 0; i < rows.length; i += per) pages.push(`<div class="ord-page">${rows.slice(i, i + per).join('')}</div>`); return pages; };
const botHtml = () => {
    const rows = botRows(), extra = extraPaperRows();
    return botAccount() + section('Bot su carta · nessun ordine reale', pagesOf(rows, extra.length ? 2 : perPage), paper || simActive() ? 'Nessun trade aperto nel conto: aprono solo i segnali recenti, entro i limiti.' : 'Caricamento…', rows.length)
        + (extra.length ? section('Segnali aperti delle strategie · fuori dal conto', pagesOf(extra), '', extra.length) : '');
};
// righe che stanno in una pagina, misurate sullo schermo (una volta disegnata la prima)
function fitPerPage(box) {
    const lists = box.querySelectorAll('.ord-list'), list = lists[lists.length - 1], sec = list && list.closest('.ord-sec'), r = list && list.querySelector('.ord-row');   // l'ultima lista riempie lo spazio che resta
    if (!r) return false;
    // spazio dall'inizio della lista al fondo della vista, meno il margine interno della scheda sotto la lista
    const free = box.getBoundingClientRect().bottom - list.getBoundingClientRect().top - (sec.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom) - 4;
    const n = Math.max(1, Math.floor((free + 8) / (r.offsetHeight + 8)));
    if (n === perPage) return false;
    perPage = n;
    return true;
}

export function renderOrders() {
    const box = $('ordersView');
    if (!box || view === 'open') return;
    const real = true;
    const html = view === 'bot'
        ? botHtml()
        : real
        ? section('Futures · in attesa su Bitget', realOrders('futures'), 'Nessuno stop o target in attesa sui futures.')
          + section('Spot · in attesa su Bitget', realOrders('spot'), 'Nessun ordine spot in attesa.')
        : '';
    // Viene chiamata a ogni aggiornamento dei prezzi: ridisegnare sempre riportava ogni lista al primo
    // elemento mentre la si scorreva. Si ridisegna solo se il contenuto cambia, e si tiene la posizione.
    if (html === lastHtml && box.childElementCount) return;
    const keep = [...box.querySelectorAll('.ord-list')].map(l => l.scrollLeft);
    lastHtml = html;
    box.innerHTML = html;
    box.querySelectorAll('.ord-list').forEach((l, i) => { if (keep[i]) l.scrollLeft = keep[i]; ordSync(l); });
    if (view === 'bot' && fitPerPage(box)) renderOrders();
}
let lastHtml = '';

export function initOrders() { applyView(); if (view === 'bot') { loadPaper().then(renderOrders); liveBot(true); } }

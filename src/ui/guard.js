// --- POSIZIONI → PHANTOM: il guardiano delle posizioni su Hyperliquid / Phantom Perps (hl_guard.py) ---
// Stato, ultimo controllo e azioni dal file del guardiano (hl_guard_state.json, cifrato); modalità scelta qui
// (hl_guard_config.json, comando guard_mode). Posizioni, stop e prezzi letti in diretta dall'API pubblica di
// Hyperliquid (sola lettura, nessuna chiave): l'indirizzo del conto viene dal file cifrato.
import { escapeHtml, fmtIt, fmtPrice, fetchData, apiPost } from '../utils/helpers.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
// stesse soglie di hl_guard.py (CFG)
const BE = 2.0, BE_OFF = 0.15, TRAIL = 3.5, FLAT_H = 48;

let state = null, cfg = null, live = null, loadedAt = 0, liveAt = 0, liveErr = false, pending = null;

async function hl(body) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try {
        const r = await fetch(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
        return r.ok ? await r.json() : null;
    } finally { clearTimeout(t); }
}
const getJson = async n => { try { const r = await fetchData(n); return r.ok ? await r.json() : null; } catch (e) { return null; } };

export async function loadGuard(force = false) {
    if (force || Date.now() - loadedAt > 60000) {
        loadedAt = Date.now();
        const [s, c] = await Promise.all([getJson('hl_guard_state.json'), getJson('hl_guard_config.json')]);
        state = s; cfg = c;
        if (pending && cfg && cfg.mode === pending) pending = null;
    }
    const addr = state && state.account;
    if (!addr || Date.now() - liveAt < 8000) return;
    liveAt = Date.now();
    try {
        const [ch, orders, mids] = await Promise.all([hl({ type: 'clearinghouseState', user: addr }), hl({ type: 'frontendOpenOrders', user: addr }), hl({ type: 'allMids' })]);
        if (ch) { live = { ch, orders: orders || [], mids: mids || {} }; liveErr = false; } else liveErr = true;
    } catch (e) { liveErr = true; }
}

export async function setGuardMode(mode) {
    if (!['off', 'osserva', 'attivo'].includes(mode) || mode === currentMode()) return;
    if (mode === 'attivo' && !window.confirm('Il guardiano sposterà gli stop e chiuderà le posizioni Phantom da solo. Attivarlo?')) return;
    let ok = false;
    try { ok = (await apiPost('/api/command', { type: 'guard_mode', mode })).ok; } catch (e) {}
    if (!ok) { window.showAlert && window.showAlert('Comando non inviato', 'Non sono riuscito a cambiare la modalità: controlla la connessione al server nelle Opzioni.'); return; }
    pending = mode;
    window.renderOrders && window.renderOrders();
}

const currentMode = () => (cfg && cfg.mode) || (state && state.mode) || 'osserva';
const pct = (a, b) => (a - b) / b * 100;
const pctTxt = v => `${v >= 0 ? '+' : ''}${fmtIt(v, 2)}%`;
const tone = v => (v >= 0 ? 'text-accent' : 'text-danger');
const hhmm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const when = ms => {
    const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
    return today ? hhmm(ms) : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hhmm(ms)}`;
};

function positions() {
    if (!live) return [];
    const out = [];
    for (const ap of (live.ch && live.ch.assetPositions) || []) {
        const p = ap.position || {}, szi = Number(p.szi);
        if (!szi || String(p.coin).includes(':')) continue;
        const dir = szi > 0 ? 1 : -1, side = dir === 1 ? 'A' : 'B';
        const stops = live.orders.filter(o => o.coin === p.coin && o.isTrigger && o.side === side && String(o.orderType).includes('Stop')).map(o => Number(o.triggerPx));
        const tps = live.orders.filter(o => o.coin === p.coin && o.isTrigger && o.side === side && String(o.orderType).includes('Take')).map(o => Number(o.triggerPx));
        out.push({
            coin: p.coin, dir, size: Math.abs(szi), entry: Number(p.entryPx), liq: p.liquidationPx ? Number(p.liquidationPx) : null,
            lev: p.leverage && p.leverage.value, mark: Number(live.mids[p.coin]) || null, pnl: Number(p.unrealizedPnl),
            sl: stops.length ? stops.reduce((a, b) => (dir === 1 ? Math.max(a, b) : Math.min(a, b))) : null,
            tp: tps.length ? tps.reduce((a, b) => (dir === 1 ? Math.min(a, b) : Math.max(a, b))) : null
        });
    }
    return out;
}

// prossimo passo del guardiano per questa posizione (in base a stop e ingresso: il miglior prezzo lo conosce lui)
function nextStep(p) {
    const be = p.entry * (1 + p.dir * BE_OFF / 100);
    const safe = p.sl != null && (p.sl - be) * p.dir >= -p.entry * 0.0001;
    if (p.sl == null) return '<span class="text-danger">senza stop: il guardiano ne mette uno al 4%</span>';
    if (!safe) return `pareggio quando arriva a ${fmtPrice(p.entry * (1 + p.dir * BE / 100))} (+${fmtIt(BE, 0)}%)`;
    return `trailing oltre ${fmtPrice(p.entry * (1 + p.dir * TRAIL / 100))} (+${fmtIt(TRAIL, 1)}%)`;
}

function posRow(p, row) {
    const move = p.mark ? pct(p.mark, p.entry) * p.dir : null;
    const head = `${escapeHtml(p.coin)} ${p.dir === 1 ? 'LONG' : 'SHORT'}${p.lev ? ` ${p.lev}x` : ''}`
        + (move == null ? '' : ` · <span class="${tone(move)}">${pctTxt(move)}${Number.isFinite(p.pnl) ? ` · ${p.pnl >= 0 ? '+' : '−'}${fmtIt(Math.abs(p.pnl), 2)} $` : ''}</span>`);
    const lock = p.sl != null ? pct(p.sl, p.entry) * p.dir : null;
    const stop = p.sl == null ? 'stop: nessuno'
        : `stop ${fmtPrice(p.sl)} <span class="${tone(lock)}">${lock >= 0 ? 'al sicuro' : 'rischio'} ${pctTxt(lock)}</span>`;
    return row(head, `ingresso ${fmtPrice(p.entry)} · prezzo ${p.mark ? fmtPrice(p.mark) : '—'}${p.tp ? ` · target ${fmtPrice(p.tp)}` : ''}${p.liq ? ` · liq. ${fmtPrice(p.liq)}` : ''}`
        + `<br>${stop}<br>prossimo: ${nextStep(p)}`);
}

export function guardHtml(section, row) {
    const mode = currentMode(), shown = pending || mode;
    const btn = (m, label) => `<button type="button" class="pill-btn${shown === m ? ' active' : ''}" onclick="setGuardMode('${m}')">${label}</button>`;
    const what = { off: 'spento: non controlla niente', osserva: 'osserva: ti scrive su Telegram cosa farebbe, senza toccare niente', attivo: 'attivo: sposta gli stop e chiude da solo' }[shown];
    const last = state && state.last_check ? `ultimo controllo alle ${when(state.last_check)}` : 'nessun controllo ancora';
    const head = `<div class="ord-sec bot-acc"><div class="ord-title">Guardiano Phantom</div>`
        + `<div class="guard-modes">${btn('off', 'Spento')}${btn('osserva', 'Osserva')}${btn('attivo', 'Attivo')}</div>`
        + `<small>${what}${pending ? ' · <b>cambio in corso…</b>' : ''}<br>${last} · pareggio a +${fmtIt(BE, 0)}%, trailing da +${fmtIt(TRAIL, 1)}%, chiusura dopo ${FLAT_H} ore ferme o vicino alla liquidazione. Non apre mai posizioni.</small></div>`;
    if (!state || !state.account) {
        return head + section('Da collegare', [row('Il guardiano non ha ancora controllato il conto',
            'Su GitHub, nei segreti delle Actions, aggiungi HL_ACCOUNT_ADDRESS (indirizzo Ethereum di Phantom) e HL_API_PRIVATE_KEY (API wallet di app.hyperliquid.xyz: ordini sì, prelievi no). Il primo controllo parte entro 15 minuti.')], '');
    }
    const pos = positions();
    const empty = liveErr && !live ? 'Hyperliquid non risponde: riprovo tra poco.' : live ? 'Nessuna posizione aperta su Phantom.' : 'Caricamento…';
    const log = ((state && state.log) || []).slice().reverse().slice(0, 12)
        .map(e => row(escapeHtml(String(e.text || '').replace(/^\[osserva\] /, '')), `${when(e.t)}${String(e.text || '').startsWith('[osserva]') ? ' · solo proposta' : ''}`));
    return head + section('Posizioni Phantom · in diretta', pos.map(p => posRow(p, row)), empty, pos.length)
        + section('Ultime azioni del guardiano', log, 'Ancora nessuna azione.', log.length);
}

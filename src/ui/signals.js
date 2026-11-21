import { State } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { $, SYM, fetchT, fmtDateTime, analyzeTrend, buildRiskData, calcEMA, parseBitgetCandles } from '../utils/helpers.js';

export function initSignals() {
    updateSignalNotifStatus();
    renderSignalGrid();
    renderSignalHistory();
    startSignalAutoScan();
    setTimeout(() => { scanAllSignals(false); }, 3000);
}

async function fetchCandlesForSignal(asset, tf, limit = 300) {
    try {
        const gran = tf === '1d' ? '1day' : tf;
        const r = await fetchT(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${asset}&granularity=${gran}&limit=${limit}`);
        if (!r.ok) return null;
        const j = await r.json();
        if (j.code !== '00000' || !j.data) return null;
        return parseBitgetCandles(j.data);
    } catch(e) { return null; }
}

function computeStrategySignal(candles, strategy, price) {
    if (!candles || candles.length < 210) return { signal: 'NEUTRAL', strength: 0, reason: 'Dati insufficienti' };
    const closed = candles.slice(0, -1);
    const closes = closed.map(c => c.close);
    const trend = analyzeTrend(candles, price);
    const rsi = trend.rsi || 50;
    if (strategy === 'breakout') {
        const risk = buildRiskData(closed, price);
        if (trend.direction === 'bullish' && risk.breakoutPass && risk.macroPass && rsi >= 55 && trend.volRatio >= 1.5) {
            const str = Math.min(100, 55 + (trend.volRatio - 1.5) * 20 + (rsi - 55));
            return { signal: 'LONG', strength: Math.round(str), reason: `Trend ${trend.duration}↑ · RSI ${rsi.toFixed(0)} · Vol ${(trend.volRatio*100).toFixed(0)}%` };
        }
        if (trend.direction === 'bearish' && !risk.macroPass && rsi <= 45 && trend.volRatio >= 1.5) {
            const str = Math.min(100, 55 + (trend.volRatio - 1.5) * 20 + (45 - rsi));
            return { signal: 'SHORT', strength: Math.round(str), reason: `Trend ${trend.duration}↓ · RSI ${rsi.toFixed(0)} · Vol ${(trend.volRatio*100).toFixed(0)}%` };
        }
        return { signal: 'NEUTRAL', strength: 0, reason: `Trend ${trend.direction === 'neutral' ? 'piatto' : trend.duration + (trend.direction === 'bullish' ? '↑' : '↓')} · RSI ${rsi.toFixed(0)}` };
    }
    if (strategy === 'mean_reversion') {
        const ema20 = calcEMA(closes, 20);
        const ema200 = calcEMA(closes, 200);
        const distEma20 = Math.abs(price - ema20) / ema20 * 100;
        if (rsi < 35 && price > ema200 * 0.95) {
            const str = Math.min(100, 50 + (35 - rsi) * 4);
            return { signal: 'LONG', strength: Math.round(str), reason: `RSI ${rsi.toFixed(0)} ipervenduto · Prezzo > EMA200*0.95` };
        }
        if (rsi > 65 && price < ema200 * 1.05) {
            const str = Math.min(100, 50 + (rsi - 65) * 4);
            return { signal: 'SHORT', strength: Math.round(str), reason: `RSI ${rsi.toFixed(0)} ipercomprato · Prezzo < EMA200*1.05` };
        }
        return { signal: 'NEUTRAL', strength: 0, reason: `RSI ${rsi.toFixed(0)} · Dist.EMA20 ${distEma20.toFixed(1)}%` };
    }
    if (strategy === 'ma_crossover') {
        const ema20 = calcEMA(closes, 20);
        const ema50 = calcEMA(closes, 50);
        const ema200 = calcEMA(closes, 200);
        if (ema20 > ema50 && ema50 > ema200 && price > ema50) return { signal: 'LONG', strength: 75, reason: `EMA20 > EMA50 > EMA200 · Prezzo > EMA50` };
        if (ema20 < ema50 && ema50 < ema200 && price < ema50) return { signal: 'SHORT', strength: 75, reason: `EMA20 < EMA50 < EMA200 · Prezzo < EMA50` };
        return { signal: 'NEUTRAL', strength: 0, reason: `EMA20 ${ema20 > ema50 ? '>' : '<'} EMA50 · EMA50 ${ema50 > ema200 ? '>' : '<'} EMA200` };
    }
    return { signal: 'NEUTRAL', strength: 0, reason: 'Nessuna regola' };
}

export function aggregateCellSignals(asset, tf) {
    const key = `${asset}_${tf}`;
    const matrix = State.signalMatrix[key];
    if (!matrix) return null;
    let longs = 0, shorts = 0, neutral = 0, totalLong = 0, totalShort = 0;
    CONFIG.SIGNAL_STRATEGIES.forEach(s => {
        const r = matrix[s];
        if (!r) return;
        if (r.signal === 'LONG') { longs++; totalLong += r.strength; }
        else if (r.signal === 'SHORT') { shorts++; totalShort += r.strength; }
        else neutral++;
    });
    const maxSide = Math.max(longs, shorts);
    let consensus = 'NEUTRAL';
    if (maxSide >= 2) consensus = longs > shorts ? 'LONG' : 'SHORT';
    const avgStrength = maxSide > 0 ? Math.round((longs > shorts ? totalLong : totalShort) / maxSide) : 0;
    return { consensus, agreement: maxSide, longs, shorts, neutral, avgStrength };
}

export async function scanAllSignals(manual = false) {
    if (State.signalScanInFlight) return;
    State.signalScanInFlight = true;
    const btn = $('btnScanSignals');
    const status = $('signalScanStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Scansione...'; }
    if (status) { status.textContent = 'In corso'; status.className = 'be-badge warn'; }

    const newMatrix = {};
    let errors = 0;

    // le richieste partono a gruppi di 6 insieme (prima una dopo l'altra: 24 attese in fila)
    const jobs = CONFIG.SIGNAL_ASSETS.flatMap(asset => CONFIG.SIGNAL_TFS.map(tf => ({ asset, tf })));
    for (let i = 0; i < jobs.length; i += 6) {
        const batch = jobs.slice(i, i + 6);
        const got = await Promise.all(batch.map(j => fetchCandlesForSignal(j.asset, j.tf)));
        batch.forEach(({ asset, tf }, k) => {
            const candles = got[k];
            if (!candles || candles.length < 210) { errors++; return; }
            const price = State.livePx[asset] || candles[candles.length - 1].close;
            const cellData = {};
            CONFIG.SIGNAL_STRATEGIES.forEach(strat => { cellData[strat] = computeStrategySignal(candles, strat, price); });
            newMatrix[`${asset}_${tf}`] = cellData;
        });
    }

    const prevMatrix = State.signalPrevMatrix;
    State.signalMatrix = newMatrix;
    const fired = [];
    
    if (Object.keys(prevMatrix).length > 0) {
        for (const key of Object.keys(newMatrix)) {
            const [asset, tf] = key.split('_');
            const newAgg = aggregateCellSignals(asset, tf);
            if (!newAgg || newAgg.consensus === 'NEUTRAL') continue;
            if (newAgg.agreement < State.signalSettings.minAgreement) continue;
            const prevCell = prevMatrix[key];
            if (!prevCell) continue;
            let prevLong = 0, prevShort = 0;
            CONFIG.SIGNAL_STRATEGIES.forEach(s => {
                if (!prevCell[s]) return;
                if (prevCell[s].signal === 'LONG') prevLong++;
                else if (prevCell[s].signal === 'SHORT') prevShort++;
            });
            const prevMax = Math.max(prevLong, prevShort);
            const prevConsensus = prevMax >= 2 ? (prevLong > prevShort ? 'LONG' : 'SHORT') : 'NEUTRAL';
            
            if (newAgg.consensus !== prevConsensus && newAgg.consensus !== 'NEUTRAL') {
                const entry = {
                    timestamp: Date.now(), asset, tf,
                    consensus: newAgg.consensus, agreement: newAgg.agreement,
                    sources: {
                        breakout: newMatrix[key].breakout?.signal || 'NEUTRAL',
                        mean_reversion: newMatrix[key].mean_reversion?.signal || 'NEUTRAL',
                        ma_crossover: newMatrix[key].ma_crossover?.signal || 'NEUTRAL'
                    },
                    strength: newAgg.avgStrength,
                    price: State.livePx[asset] || 0
                };
                State.signalHistory.unshift(entry);
                fired.push(entry);
            }
        }
    }
    
    State.signalPrevMatrix = newMatrix;
    State.saveSignalState();
    fired.forEach(s => fireSignalNotifications(s));

    if (btn) { btn.disabled = false; btn.textContent = 'Scansiona ora'; }
    if (status) {
        if (errors === CONFIG.SIGNAL_ASSETS.length * CONFIG.SIGNAL_TFS.length) { status.textContent = 'Errore'; status.className = 'be-badge bad'; }
        else { status.textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); status.className = 'be-badge good'; }
    }
    State.signalScanInFlight = false;
    const sigVisible = $('mktSig') && $('mktSig').style.display !== 'none' && $('page-terminal').classList.contains('active');
    if (!sigVisible) orderSignalAssets();
    renderSignalGrid();
    renderSignalHistory();
    if (manual && fired.length === 0) window.showAlert('Scansione completata', 'Nessun nuovo segnale forte rilevato.');
}

export function startSignalAutoScan() {
    if (State.signalScanInterval) clearInterval(State.signalScanInterval);
    State.signalScanInterval = setInterval(() => { if (!document.hidden) scanAllSignals(false); }, CONFIG.SIGNAL_SCAN_INTERVAL_MS);
}

export function renderSignalGrid() {
    const grid = $('signalGrid');
    if (!grid) return;
    // pagine da 9 celle (3 × 3) che scorrono di lato, le più accese per prime
    const pages = [];
    for (let i = 0; i < cellOrder.length; i += CELLS_PER_PAGE) pages.push(cellOrder.slice(i, i + CELLS_PER_PAGE));
    const prevPage = grid.clientWidth ? Math.round(grid.scrollLeft / gridStride(grid)) : 0;
    const html = pages.map(list => `<div class="signal-page">${list.map(c => cellHtml(c.asset, c.tf)).join('')}</div>`).join('');
    // niente ridisegno se non è cambiato nulla, né mentre scorri col dito (la pagina saltava all'inizio)
    if (grid.dataset.sig === html) return;
    if (gridTouching() && grid.dataset.sig) { clearTimeout(renderSignalGrid.retry); renderSignalGrid.retry = setTimeout(renderSignalGrid, 400); return; }
    grid.dataset.sig = html;
    grid.innerHTML = html;
    grid.style.scrollBehavior = 'auto';
    grid.scrollLeft = prevPage * gridStride(grid);
    grid.style.scrollBehavior = '';
    const dots = $('signalDots');
    if (dots) dots.innerHTML = pages.map((_, i) => `<div class="info-dot${i === prevPage ? ' active' : ''}" onclick="goToSignalPage(${i})"></div>`).join('');
}
// dito sulla griglia o scorrimento ancora in corso
let touchUntil = 0;
const gridTouching = () => Date.now() < touchUntil;
document.addEventListener('touchstart', e => { if (e.target.closest && e.target.closest('#signalGrid')) touchUntil = Date.now() + 1500; }, { passive: true });
document.addEventListener('touchend', e => { if (e.target.closest && e.target.closest('#signalGrid')) touchUntil = Date.now() + 700; }, { passive: true });

// Ordine delle coin nelle pagine: prima quelle con il segnale più forte, poi posizione aperta o avviso vicino.
// Si decide quando si apre la scheda Segnali (e dopo una scansione se la scheda non è in vista), mai mentre la guardi.
// Ordine delle 24 celle (coin × timeframe): prima i segnali accesi (accordo di almeno 2 strategie, i più forti per primi),
// poi quelli parziali (una sola strategia), poi i neutri. A parità conta la coin che ti interessa (posizione, avviso) e il timeframe più alto.
// Si ricalcola solo all'apertura della scheda o dopo una scansione a scheda chiusa, mai mentre la guardi.
const CELLS_PER_PAGE = 9;
const defaultCells = () => CONFIG.SIGNAL_ASSETS.flatMap(asset => CONFIG.SIGNAL_TFS.map(tf => ({ asset, tf })));
let cellOrder = defaultCells();

export function cellScore(asset, tf) {
    const agg = aggregateCellSignals(asset, tf);
    if (!agg) return -1;
    const rel = window.coinRelevance ? window.coinRelevance(asset) : 0;
    if (agg.consensus !== 'NEUTRAL') return 2000 + agg.agreement * 100 + (agg.avgStrength || 0) / 10 + rel * 5;
    if (agg.longs + agg.shorts > 0) return 1000 + (agg.avgStrength || 0) / 10 + rel * 5;
    return rel * 5;
}

export function orderSignalAssets() {
    const tfRank = tf => CONFIG.SIGNAL_TFS.indexOf(tf), assetRank = a => CONFIG.SIGNAL_ASSETS.indexOf(a);
    cellOrder = defaultCells().sort((a, b) => (cellScore(b.asset, b.tf) - cellScore(a.asset, a.tf)) || (tfRank(a.tf) - tfRank(b.tf)) || (assetRank(a.asset) - assetRank(b.asset)));
    const g = $('signalGrid');
    if (g) g.scrollLeft = 0;
}

// Passo reale tra una pagina e l'altra della griglia (larghezza + spazio)
function gridStride(grid) {
    const pages = grid.querySelectorAll('.signal-page');
    return pages.length > 1 ? pages[1].offsetLeft - pages[0].offsetLeft : (grid.clientWidth || 1);
}
export function goToSignalPage(i) { const g = $('signalGrid'); if (g) g.scrollTo({ left: i * gridStride(g), behavior: 'smooth' }); }
let dotsFrame = 0;
export function updateSignalDots() {
    if (dotsFrame) return;
    dotsFrame = requestAnimationFrame(() => {
        dotsFrame = 0;
        const g = $('signalGrid');
        if (!g || !g.clientWidth) return;
        touchUntil = Math.max(touchUntil, Date.now() + 300);      // finché scorre, la griglia non si ridisegna
        const i = Math.round(g.scrollLeft / gridStride(g));
        document.querySelectorAll('#signalDots .info-dot').forEach((d, k) => d.classList.toggle('active', k === i));
    });
}

function cellHtml(asset, tf) {
    const agg = aggregateCellSignals(asset, tf);
    const key = `${asset}_${tf}`;
    if (!agg) {
        return `<div class="signal-cell loading"><div class="sc-head"><span class="sc-asset">${SYM(asset)}</span><span class="sc-tf">${tf}</span></div><div class="sc-badge neutral">—</div><div class="sc-foot"><div class="sc-agree">—</div></div></div>`;
    }
    const cls = agg.consensus.toLowerCase();
    const m = State.signalMatrix[key];
    const sDots = CONFIG.SIGNAL_STRATEGIES.map(s => {
        const st = m[s];
        const on = st && st.signal !== 'NEUTRAL';
        const sideCls = st && st.signal === 'SHORT' ? 'short' : (st && st.signal === 'LONG' ? 'long' : '');
        return `<span class="sc-agree-dot ${on ? 'on ' + sideCls : ''}"></span>`;
    }).join('');
    return `<div class="signal-cell ${cls}" onclick="openSignalDetail('${asset}','${tf}')">
        <div class="sc-head"><span class="sc-asset">${SYM(asset)}</span><span class="sc-tf">${tf}</span></div>
        <div class="sc-badge ${cls}">${agg.consensus === 'NEUTRAL' ? '—' : agg.consensus + ' ' + agg.agreement + '/3'}</div>
        <div class="sc-foot">
            <div class="sc-agree">${sDots}</div>
        </div>
    </div>`;
}

export function renderSignalHistory() {
    const el = $('signalHistoryList');
    if (!el) return;
    const prevScroll = el.scrollLeft;
    if (State.signalHistory.length === 0) {
        el.innerHTML = '<div class="empty-hint">Nessun segnale registrato. La scansione parte da sola ogni 10 minuti.</div>';
        renderSignalHistoryDots();
        return;
    }
    el.innerHTML = State.signalHistory.slice(0, 30).map(s => {
        const cls = s.consensus.toLowerCase();
        const src = s.sources || s.strategies || {};
        const stratTags = [];
        CONFIG.SIGNAL_STRATEGIES.forEach(k => {
            const sig = src[k];
            if (!sig || sig === 'NEUTRAL') return;
            const tcls = sig.toLowerCase();
            stratTags.push(`<span class="shi-strat-tag ${tcls}">${CONFIG.SIGNAL_STRATEGY_LABELS[k]} ${sig}</span>`);
        });
        return `<div class="log-item">
            <div class="signal-history-item">
                <div class="shi-row1">
                    <div><span class="shi-coin">${SYM(s.asset)}</span> <span class="shi-tf">${s.tf}</span></div>
                    <span class="shi-badge ${cls}">${s.consensus} ${s.agreement}/3</span>
                </div>
                <div class="shi-meta">${fmtDateTime(s.timestamp)} · Forza ${s.strength}%</div>
                <div class="shi-strategies">${stratTags.join('')}</div>
            </div>
        </div>`;
    }).join('');
    el.scrollLeft = prevScroll;
    renderSignalHistoryDots();
}

// Passo reale tra una scheda e l'altra (larghezza + spazio), per sapere a che scheda si è arrivati scorrendo
function historyStride(container) {
    const items = container.querySelectorAll('.log-item');
    return items.length > 1 ? items[1].offsetLeft - items[0].offsetLeft : (items[0] ? items[0].offsetWidth : 0);
}
const HISTORY_DOTS_MAX = 8;       // oltre questo numero di schede si mostra "3 / 30" al posto dei punti

function paintHistoryDots(shown, activeIdx) {
    const dotsContainer = $('signalHistoryDots');
    if (!dotsContainer) return;
    if (shown > HISTORY_DOTS_MAX) {
        const txt = `${activeIdx + 1} / ${shown}`;
        const cur = dotsContainer.querySelector('.pager-count');
        if (cur) { if (cur.textContent !== txt) cur.textContent = txt; }
        else dotsContainer.innerHTML = `<span class="pager-count">${txt}</span>`;
        return;
    }
    if (dotsContainer.querySelectorAll('.info-dot').length !== shown) {
        dotsContainer.innerHTML = Array.from({ length: shown }, (_, i) => `<div class="info-dot" onclick="goToSignalSlide(${i})"></div>`).join('');
    }
    dotsContainer.querySelectorAll('.info-dot').forEach((d, i) => d.classList.toggle('active', i === activeIdx));
}

export function renderSignalHistoryDots() {
    const dotsContainer = $('signalHistoryDots');
    if (!dotsContainer) return;
    const shown = Math.min(State.signalHistory.length, 30);
    if (shown === 0) { dotsContainer.innerHTML = ''; return; }
    const container = $('signalHistoryList');
    const stride = container ? historyStride(container) : 0;
    const activeIdx = stride > 0 ? Math.max(0, Math.min(Math.round(container.scrollLeft / stride), shown - 1)) : 0;
    paintHistoryDots(shown, activeIdx);
}

export function goToSignalSlide(idx) {
    const container = $('signalHistoryList');
    if (!container) return;
    const items = container.querySelectorAll('.log-item');
    if (!items[idx]) return;
    items[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

export function updateSignalHistoryDots() {
    const container = $('signalHistoryList');
    if (!container) return;
    const items = container.querySelectorAll('.log-item');
    if (items.length === 0) return;
    const stride = historyStride(container);
    const activeIdx = stride > 0 ? Math.max(0, Math.min(Math.round(container.scrollLeft / stride), items.length - 1)) : 0;
    paintHistoryDots(items.length, activeIdx);
}

export function openSignalDetail(asset, tf) {
    const key = `${asset}_${tf}`;
    const matrix = State.signalMatrix[key];
    if (!matrix) return;
    const agg = aggregateCellSignals(asset, tf);
    $('signalDetailTitle').textContent = `${SYM(asset)} · ${tf}`;
    const body = $('signalDetailBody');
    const rows = CONFIG.SIGNAL_STRATEGIES.map(s => {
        const m = matrix[s] || { signal: 'NEUTRAL', strength: 0, reason: '—' };
        const cls = m.signal.toLowerCase();
        const badgeCls = cls === 'long' ? 'long' : (cls === 'short' ? 'short' : 'neutral');
        return `<div style="border-top:1px solid var(--border); padding-top:8px; margin-top:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <b style="color:var(--text);">${CONFIG.SIGNAL_STRATEGY_LABELS[s]}</b>
                <span class="sc-badge ${badgeCls}">${m.signal}${m.strength ? ' · ' + m.strength + '%' : ''}</span>
            </div>
            <div style="font-size:11px; color:var(--text-secondary);">${m.reason || '—'}</div>
        </div>`;
    }).join('');
    const consensusRow = agg ? `<div style="text-align:center; margin-top:14px; padding-top:10px; border-top:1px solid var(--border);">
        <div style="font-size:10px; color:var(--text-secondary); text-transform:uppercase; margin-bottom:6px;">Consensus Finale</div>
        <span class="sc-badge ${agg.consensus.toLowerCase()}" style="font-size:14px; padding:6px 12px;">${agg.consensus} (${agg.agreement}/3)</span>
    </div>
    <button class="btn-generic" style="margin-top:14px; background:var(--blue); color:#fff;" onclick="closeSignalDetailModal(); switchTab('terminal'); setAsset('${asset}'); setTF('${tf}');">Apri sul Terminal</button>` : '';
    body.innerHTML = rows + consensusRow;
    $('signalDetailModal').classList.add('active');
}

export function closeSignalDetailModal() { $('signalDetailModal').classList.remove('active'); }
export function clearSignalHistory() { State.signalHistory = []; State.saveSignalState(); renderSignalHistory(); }

export function updateSignalNotifStatus() {
    const el = $('signalNotifStatus');
    if (!el) return;
    const tgOn = !!State.signalSettings.telegramBotToken && !!State.signalSettings.telegramChatId;
    if (tgOn) { el.textContent = 'Telegram attivo'; el.className = 'badge-notif-on'; }
    else if (State.signalSettings.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') { el.textContent = 'Browser attivo'; el.className = 'badge-notif-on'; }
    else { el.textContent = 'Spente'; el.className = 'badge-notif-off'; }
}

export async function toggleBrowserNotifications() {
    if (!('Notification' in window)) { window.showAlert('Non supportato', 'Il browser non supporta le notifiche.'); return; }
    if (Notification.permission === 'granted') { State.signalSettings.notificationsEnabled = !State.signalSettings.notificationsEnabled; State.saveSignalState(); updateSignalNotifStatus(); updateNotifButton(); return; }
    if (Notification.permission === 'denied') { window.showAlert('Bloccate', 'Notifiche bloccate nelle impostazioni.'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { State.signalSettings.notificationsEnabled = true; State.saveSignalState(); updateSignalNotifStatus(); updateNotifButton(); window.showAlert('Attivate', 'Notifiche abilitate.'); }
    else window.showAlert('Negate', 'Permesso negato.');
}

export function updateNotifButton() {
    const btn = $('btnToggleNotif');
    if (!btn) return;
    const granted = 'Notification' in window && Notification.permission === 'granted';
    if (State.signalSettings.notificationsEnabled && granted) { btn.textContent = 'Disabilita'; btn.style.background = 'rgba(255,69,58,0.15)'; btn.style.color = 'var(--danger)'; }
    else if (granted) { btn.textContent = 'Abilita'; btn.style.background = 'var(--surface-hover)'; btn.style.color = 'var(--text)'; }
    else { btn.textContent = 'Richiedi permesso'; btn.style.background = 'var(--blue)'; btn.style.color = 'var(--on-ui)'; }
}

export function openSignalSettings() {
    $('signalMinAgreement').value = String(State.signalSettings.minAgreement);
    document.querySelectorAll('.option-toggle[data-target="signalMinAgreement"] button').forEach(b => b.classList.toggle('active', b.dataset.value === $('signalMinAgreement').value));
    $('signalTelegramToken').value = State.signalSettings.telegramBotToken || '';
    $('signalTelegramChat').value = State.signalSettings.telegramChatId || '';
    $('signalWebhookUrl').value = State.signalSettings.webhookUrl || '';
    updateNotifButton();
    $('signalSettingsModal').classList.add('active');
}

export function closeSignalSettings() { $('signalSettingsModal').classList.remove('active'); }

export function saveSignalSettingsFromUI() {
    State.signalSettings.minAgreement = parseInt($('signalMinAgreement').value, 10) || 2;
    State.signalSettings.telegramBotToken = ($('signalTelegramToken').value || '').trim();
    State.signalSettings.telegramChatId = ($('signalTelegramChat').value || '').trim();
    State.signalSettings.webhookUrl = ($('signalWebhookUrl').value || '').trim();
    State.saveSignalState();
    updateSignalNotifStatus();
    closeSignalSettings();
    window.showAlert('Salvato', 'Opzioni segnali aggiornate.');
}

function sendTelegramMessage(text) {
    const token = State.signalSettings.telegramBotToken;
    const chatId = State.signalSettings.telegramChatId;
    if (!token || !chatId) return false;
    try {
        const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}&parse_mode=HTML&disable_web_page_preview=true`;
        fetch(url, { mode: 'no-cors' }).catch(() => {});
        return true;
    } catch (e) { return false; }
}

export function testTelegramNotification() {
    const token = ($('signalTelegramToken').value || '').trim();
    const chatId = ($('signalTelegramChat').value || '').trim();
    if (!token || !chatId) { window.showAlert('Telegram', 'Inserisci Token del bot e Chat ID prima del test.'); return; }
    const savedToken = State.signalSettings.telegramBotToken;
    const savedChat = State.signalSettings.telegramChatId;
    State.signalSettings.telegramBotToken = token;
    State.signalSettings.telegramChatId = chatId;
    const ok = sendTelegramMessage('🧪 <b>PinscherTrade Test</b>\nNotifiche Telegram configurate.\n' + new Date().toLocaleString('it-IT'));
    State.signalSettings.telegramBotToken = savedToken;
    State.signalSettings.telegramChatId = savedChat;
    if (ok) window.showAlert('Telegram', 'Test inviato. Controlla Telegram.\n\nSe non arriva: verifica token/chatId e avvia il bot con /start.');
    else window.showAlert('Telegram', 'Impossibile inviare.');
}

function fireSignalNotifications(sig) {
    const title = `Segnale · ${SYM(sig.asset)} ${sig.tf} · ${sig.consensus}`;
    const body = `${sig.agreement}/3 strategie · Strength ${sig.strength}%`;

    if (State.signalSettings.telegramBotToken && State.signalSettings.telegramChatId) {
        const lines = [
            `🚨 <b>${title}</b>`, '', body, '',
            `Breakout: ${sig.sources?.breakout || '—'}`,
            `Mean rev: ${sig.sources?.mean_reversion || '—'}`,
            `MA cross: ${sig.sources?.ma_crossover || '—'}`,
            '', fmtDateTime(sig.timestamp)
        ];
        sendTelegramMessage(lines.join('\n'));
    }
    if (State.signalSettings.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(title, { body, tag: `${sig.asset}_${sig.tf}_${sig.timestamp}` }); } catch (e) {}
    }
    if (State.signalSettings.webhookUrl) {
        try {
            fetch(State.signalSettings.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'signal', timestamp: sig.timestamp, asset: sig.asset, timeframe: sig.tf,
                    consensus: sig.consensus, agreement: sig.agreement,
                    strength: sig.strength, sources: sig.sources, price: sig.price
                })
            }).catch(() => {});
        } catch (e) {}
    }
}

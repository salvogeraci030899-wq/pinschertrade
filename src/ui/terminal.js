import { State } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { journalTrades, realPositions } from './history.js';
import { $, SYM, fetchT, apiPost, fmtUsd, analyzeTrend, buildRiskData, calcEMA, parseBitgetCandles, fetchData, markChosen } from '../utils/helpers.js';
import { createChart, setCandles, setMarkers, setPriceLines, relayout } from './chart.js';
import { TRADE_SYMBOLS } from '../core/commands.js';

const chartContainer = document.getElementById('chart');
const mainChartContainer = document.getElementById('mainChartContainer');
let chartHandle = null;
let techData = { trend: null, riskData: null, ema20: 0, ema50: 0, ema200: 0, price: 0 };

// --- TIMEFRAME HELPER ---
function getTFLabel(tf) {
    return ({ '1d': '1D', '4h': '4H', '1h': '1H' })[tf] || tf;
}

// --- INIZIALIZZAZIONE ---
export function initTerminal() {
    try { initChart(); } catch (e) { Logger.log('ERROR', 'TERMINAL', 'Errore chart init', e); }
    loadData();
    startPricePoll();
    // il bot pubblica ogni 15 minuti: l'app se ne accorge entro un minuto (solo in primo piano; al ritorno subito)
    setInterval(() => { if (!document.hidden) loadData(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastDataAt > 30000) loadData(); });
    initRefreshState();
    loadTechData();
}

function initChart() {
    if (chartHandle) chartHandle.destroy();
    chartHandle = createChart(chartContainer, {
        interactive: true
    });
    // Il grafico segue sempre la misura reale del contenitore (cambio tab, barra di Safari,
    // altezza dello schermo che si assesta all'avvio della PWA, pannelli che cambiano altezza)
    if (chartContainer && 'ResizeObserver' in window && !initChart.observer) {
        initChart.observer = new ResizeObserver(() => resizeChart());
        initChart.observer.observe(chartContainer);
    }
}

// --- CHART ACTIONS ---
// Barra dello schermo intero: coin e timeframe correnti (stessa grafica del grafico della Home)
function syncFsHeader() {
    const sym = document.getElementById('fsChartSymbol');
    if (sym) sym.textContent = `${State.currentAsset.replace('USDT', '')} / USDT`;
    document.querySelectorAll('#fsChartTf .home-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === State.currentTF));
}

export function toggleFullscreenChart() {
    syncFsHeader();
    let isFullscreen = false;
    relayout(chartHandle, document.getElementById('chart'), () => {
        isFullscreen = mainChartContainer.classList.toggle('fullscreen');
        document.body.classList.toggle('chart-fullscreen', isFullscreen);
    });
    const btn = document.getElementById('btnFullscreen');
    if (isFullscreen) btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;
    else btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
}

// Condividi: immagine del grafico a schermo intero (Segnali) o della pagina; target = elemento da fotografare
export async function takeSnapshot(btn, target = null, label = null) {
    btn.style.opacity = '0.5';
    btn.disabled = true;
    document.body.classList.add('snapshot-mode');
    try {
        await new Promise(r => setTimeout(r, 300));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        const targetEl = target || (mainChartContainer.classList.contains('fullscreen') ? mainChartContainer : document.getElementById('page-terminal'));
        const canvas = await html2canvas(targetEl, {
            backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000000', scale: 3, useCORS: true, allowTaint: true, logging: false,
            onclone: (clonedDoc) => {
                clonedDoc.querySelectorAll('*').forEach(el => {
                    el.style.backdropFilter = 'none';
                    el.style.webkitBackdropFilter = 'none';
                    el.style.opacity = '1';
                });
            }
        });
        const imgData = canvas.toDataURL('image/png');
        const blob = await (await fetch(imgData)).blob();
        const fileName = `grafico_${new Date().toISOString().slice(0,19).replace(/[:T]/g, '-')}.png`;
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    files: [file],
                    title: 'Grafici',
                    text: label || `${State.currentAsset.replace('USDT','')} · ${getTFLabel(State.currentTF)}`
                });
                return;
            } catch (shareErr) { if (shareErr.name === 'AbortError') return; }
        }
        const link = document.createElement('a');
        link.href = imgData;
        link.download = fileName;
        link.click();
    } catch (err) {
        if (window.showAlert) window.showAlert("Errore", "Snapshot fallito: " + err.message);
    } finally {
        btn.style.opacity = '1';
        btn.disabled = false;
        document.body.classList.remove('snapshot-mode');
    }
}

export function chartAlertSignals() {
    window.openChartAlert(State.currentAsset, State.livePx[State.currentAsset]);
}

// --- DATA FETCHING ---
// --- FUTURES (futures_data.json, scritto dal bot una volta per ora) ---
// Funding, open interest, long/short e premio dei futures USDT di Bitget per la coin selezionata.
// Solo informativi: non entrano ancora nei segnali, quindi nessun colore verde/rosso.
let futData = null;
let futLoaded = false;

async function loadFutures() {
    try {
        const r = await fetchData('futures_data.json');
        futData = r.ok ? await r.json() : null;
    } catch (e) { futData = null; }
    futLoaded = true;
    renderFutures();
    if (window.onFuturesData) window.onFuturesData();
}

// Dati futures di una coin (o null): usati anche dal calcolatore Rischio
export const getFutures = symbol => (futData && futData.symbols && futData.symbols[symbol]) || null;

const fmtSigned = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;

function trItem(label, value, cls) {
    return `<div class="filter-item ${cls}"><span class="f-label">${label}</span><span class="f-val">${value}</span></div>`;
}

function fmtUsdCompact(v) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    return `$${Math.round(v).toLocaleString('en-US')}`;
}

export function renderFutures() {
    const grid = document.getElementById('futGrid'), foot = document.getElementById('futFoot'), badge = document.getElementById('fut-badge');
    if (!grid || !foot || !badge) return;
    const f = futData && futData.symbols && futData.symbols[State.currentAsset];
    if (!f) {
        badge.textContent = '—';
        grid.innerHTML = '';
        foot.textContent = !futLoaded ? 'Dati futures in caricamento…'
            : `Dati futures ${SYM(State.currentAsset)} non ancora disponibili: il bot li raccoglie una volta per ora.`;
        return;
    }
    const has = v => v !== null && v !== undefined;
    badge.textContent = `${SYM(State.currentAsset)} perpetuo`;
    const every = has(f.funding_interval_h) ? ` ogni ${f.funding_interval_h} h` : '';
    grid.innerHTML =
        trItem('Funding', has(f.funding_rate_pct) ? fmtSigned(f.funding_rate_pct, 4) : '—', 'neutral') +
        trItem('Open int.', has(f.open_interest_usd) ? fmtUsdCompact(f.open_interest_usd) : '—', 'neutral') +
        trItem('Conti long', has(f.long_accounts_pct) ? `${f.long_accounts_pct.toFixed(0)}%` : '—', 'neutral') +
        trItem('Premio', has(f.premium_pct) ? fmtSigned(f.premium_pct, 3) : '—', 'neutral');
    const when = new Date(f.t * 1000).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const oi = has(f.open_interest_change_24h_pct) ? ` · open interest 24 h ${fmtSigned(f.open_interest_change_24h_pct, 1)}` : '';
    const pos = has(f.long_positions_pct) ? ` · posizioni long ${f.long_positions_pct.toFixed(0)}%` : '';
    foot.textContent = `Bitget, ${when} · funding${every}: positivo = i long pagano gli short${oi}${pos} · solo informativi, non usati nei segnali`;
}

let lastDataAt = 0;
export async function loadData() {
    lastDataAt = Date.now();
    loadFutures();
    liveChart();
}

// Grafico: candele vere di Bitget per ogni coin
export function updateChart() {
    renderFutures();
    liveChart();
}

let liveSeq = 0;
async function liveChart() {
    const asset = State.currentAsset, tf = State.currentTF, seq = ++liveSeq;
    $('last-update-footer').textContent = 'Prezzi dal vivo da Bitget';
    if (State.livePx[asset]) setHeaderPrice(State.livePx[asset]);
    else { State.lastHeaderPrice = null; $('live-price').textContent = '…'; }
    try {
        const gran = tf === '1d' ? '1day' : tf;
        const r = await fetchT(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${asset}&granularity=${gran}&limit=300`);
        const j = r.ok ? await r.json() : null;
        if (seq !== liveSeq || !j || j.code !== '00000') return;          // cambiata coin o timeframe nel frattempo
        const hist = parseBitgetCandles(j.data || []).map(c => ({ time: Math.floor(c.ts / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
        if (chartHandle) {
            setCandles(chartHandle, hist);
            State.candleTimes = hist.map(d => d.time);
            applyDefaultViewIfNeeded();
        } else State.candleTimes = hist.map(d => d.time);
        if (!State.livePx[asset] && hist.length) setHeaderPrice(hist[hist.length - 1].close);
        refreshMarkers();
        updatePriceLines();
    } catch (e) { if (seq === liveSeq) $('live-price').textContent = 'N/D'; }
}

// --- MARKERS & LINES ---
function snap(ts) {
    const s = Math.floor(ts / 1000);
    let lo = 0, hi = State.candleTimes.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (State.candleTimes[m] <= s) { r = m; lo = m + 1; } else hi = m - 1; }
    return r >= 0 ? State.candleTimes[r] : null;
}

export function refreshMarkers() {
    if (!chartHandle) return;
    const out = [];
    const add = (ts, m) => { const t = snap(ts); if (t !== null) out.push(Object.assign({ time: t }, m)); };
    journalTrades().filter(h => h.symbol === State.currentAsset).forEach(h => {
        if (h.entryTime) add(h.entryTime, { position: 'belowBar', color: '#30d158', shape: 'arrowUp', text: 'In' });
        if (h.exitTime) add(h.exitTime, { position: 'aboveBar', color: '#ff453a', shape: 'circle', text: 'Out' });
    });
    out.sort((a, b) => a.time - b.time);
    setMarkers(chartHandle, out);
}

export function updatePriceLines() {
    if (!chartHandle) return;
    const lines = [];
    // posizione vera su questa coin: entry, stop e target sul grafico
    const pos = realPositions().find(p => p.symbol === State.currentAsset && p.market === 'futures') || realPositions().find(p => p.symbol === State.currentAsset);
    if (pos) {
        if (pos.entry) lines.push({ price: pos.entry, color: 'rgba(142,142,147,0.7)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'ENTRY' });
        if (pos.sl) lines.push({ price: pos.sl, color: 'rgba(255,69,58,0.8)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: 'SL' });
        if (pos.tp) lines.push({ price: pos.tp, color: 'rgba(48,209,88,0.8)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: 'TP' });
    }
        setPriceLines(chartHandle, lines);
}

// --- PRICE POLLING ---
export function setHeaderPrice(px) {
    if (!isFinite(px)) return;
    const el = $('live-price');
    if (!el) return;
    const prev = State.lastHeaderPrice;
    if (prev != null && px !== prev) {
        const cls = px > prev ? 'flash-up' : 'flash-down';
        el.classList.remove('flash-up', 'flash-down');
        void el.offsetWidth;
        el.classList.add(cls);
    }
    el.textContent = px >= 1 ? fmtUsd(px) : '$' + px.toFixed(px >= 0.01 ? 4 : 6);      // coin sotto 1 dollaro: più decimali
    State.lastHeaderPrice = px;
}

export async function pollPrices() {
    if (State.pollInFlight || document.hidden) return;     // app in background: niente richieste
    State.pollInFlight = true;
    try {
        const symbols = new Set([State.currentAsset]);
        const results = await Promise.all([...symbols].map(async (sym) => {
            try {
                const r = await fetchT(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`);
                if (!r.ok) return null;
                const j = await r.json();
                if (j.code !== '00000' || !j.data[0]) return null;
                const px = parseFloat(j.data[0].lastPr);
                return isFinite(px) ? { sym, px } : null;
            } catch (e) { return null; }
        }));
        for (const res of results) {
            if (!res) continue;
            State.livePx[res.sym] = res.px;
            if (res.sym === State.currentAsset) setHeaderPrice(res.px);
        }
        } finally { State.pollInFlight = false; }
}

export function startPricePoll() {
    if (State.pricePollInterval) { pollPrices(); return; }
    pollPrices();
    State.pricePollInterval = setInterval(pollPrices, 5000);
    // ritorno nell'app: prezzi subito, senza aspettare il prossimo giro
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollPrices(); });
}

// Sfumature della riga delle coin: a sinistra se hai scorso, a destra se ci sono altre coin dopo
export function updateCoinFade() {
    const row = document.getElementById('mktCoins');
    if (!row) return;
    row.classList.toggle('more-left', row.scrollLeft > 4);
    row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 4);
}

// --- ASSET / TF SWITCH ---
export function setAsset(asset, manual = true) {
    if (manual) markChosen('asset');
    State.currentAsset = asset;
    State.lastHeaderPrice = null;
    TRADE_SYMBOLS.forEach(a => { const b = document.getElementById(`btn-${a}`); if (b) b.classList.toggle('active', a === asset); });
    const active = document.getElementById(`btn-${asset}`);
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    setTimeout(updateCoinFade, 400);
    document.getElementById('current-asset-label').textContent = `${asset.replace('USDT', '')} / USDT · ${getTFLabel(State.currentTF)}`;
    syncFsHeader();
    updateChart();
    pollPrices();
    loadTechData();
}

export function setTF(tf) {
    State.currentTF = tf;
    ['1d', '4h', '1h'].forEach(t => document.getElementById(`btn-${t}`).classList.toggle('active', t === tf));
    document.getElementById('current-asset-label').textContent = `${State.currentAsset.replace('USDT', '')} / USDT · ${getTFLabel(tf)}`;
    syncFsHeader();
    updateChart();
    loadTechData();
}

// --- TECH PANEL ---
export async function loadTechData() {
    try {
        const gran = State.currentTF === '1d' ? '1day' : State.currentTF;
        const r = await fetchT(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${State.currentAsset}&granularity=${gran}&limit=300`);
        if (!r.ok) return;
        const j = await r.json();
        if (j.code !== '00000' || !j.data) return;
        const candles = parseBitgetCandles(j.data);
        if (candles.length === 0) return;
        const price = State.livePx[State.currentAsset] || candles[candles.length-1].close;
        const closes = candles.slice(0, -1).map(c => c.close);
        techData = {
            trend: analyzeTrend(candles, price),
            riskData: buildRiskData(candles.slice(0, -1), price),
            ema20: calcEMA(closes, 20), ema50: calcEMA(closes, 50), ema200: calcEMA(closes, 200), price
        };
        renderTechFilters();
        if (window.updateCalcHints) window.updateCalcHints();
    } catch(e) { Logger.log('ERROR', 'TERMINAL', 'Tech fetch error', e); }
}

export function renderTechFilters() {
    if (!techData.trend) return;
    const strategy = $('dashStrategy').value;
    const grid = $('filterGrid');
    const trendLabel = $('tech-trend-label');
    if (techData.trend.direction === 'bullish') { trendLabel.textContent = `${techData.trend.duration} verdi`; trendLabel.style.color = 'var(--accent)'; }
    else if (techData.trend.direction === 'bearish') { trendLabel.textContent = `${techData.trend.duration} rosse`; trendLabel.style.color = 'var(--danger)'; }
    else { trendLabel.textContent = 'Neutro'; trendLabel.style.color = 'var(--text-secondary)'; }

    const buildItem = (label, value, pass) => `<div class="filter-item ${pass ? 'pass' : 'fail'}"><span class="f-label">${label}</span><span class="f-val">${value}</span><span class="f-dot"></span></div>`;
    const html = [];

    if (strategy === 'breakout') {
        html.push(buildItem('Volumi', (techData.trend.volRatio * 100).toFixed(0) + '%', techData.trend.volRatio >= 1.5));
        html.push(buildItem('RSI (>55)', techData.trend.rsi ? techData.trend.rsi.toFixed(1) : '—', techData.trend.rsi >= 55));
        html.push(buildItem('Breakout 20', techData.riskData.breakoutPass ? 'SI' : 'NO', techData.riskData.breakoutPass));
        html.push(buildItem('Macro (EMA200)', techData.riskData.macroPass ? 'SI' : 'NO', techData.riskData.macroPass));
    } else if (strategy === 'mean_reversion') {
        html.push(buildItem('RSI (<35)', techData.trend.rsi ? techData.trend.rsi.toFixed(1) : '—', techData.trend.rsi < 35));
        html.push(buildItem('EMA200 * 0.95', techData.price > techData.ema200 * 0.95 ? 'OK' : 'NO', techData.price > techData.ema200 * 0.95));
        const distEma20 = Math.abs(techData.price - techData.ema20) / techData.ema20 * 100;
        html.push(buildItem('Dist. EMA20', distEma20.toFixed(1) + '%', distEma20 < 5));
        html.push(buildItem('Candela', techData.trend.direction === 'bearish' ? 'ROSSA' : 'VERDE', techData.trend.direction === 'bearish'));
    } else if (strategy === 'ma_crossover') {
        html.push(buildItem('EMA20 > EMA50', techData.ema20 > techData.ema50 ? 'SI' : 'NO', techData.ema20 > techData.ema50));
        html.push(buildItem('EMA50 > EMA200', techData.ema50 > techData.ema200 ? 'SI' : 'NO', techData.ema50 > techData.ema200));
        html.push(buildItem('Price > EMA50', techData.price > techData.ema50 ? 'SI' : 'NO', techData.price > techData.ema50));
        html.push(buildItem('Volumi', (techData.trend.volRatio * 100).toFixed(0) + '%', techData.trend.volRatio >= 1.0));
    }
    grid.innerHTML = html.join('');
}

// --- DASHBOARD CAROUSEL ---
export function goToDashboardSlide(idx) {
    const carousel = document.getElementById('dashboardCarousel');
    if (!carousel) return;
    carousel.scrollTo({ left: idx * carousel.clientWidth, behavior: 'smooth' });
}

export function updateDashboardDots() {
    const carousel = document.getElementById('dashboardCarousel');
    if (!carousel || carousel.clientWidth === 0) return;
    const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
    document.querySelectorAll('#dashboardDots .info-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

// --- GIRO DEL BOT A RICHIESTA (Home → Stato → "Aggiorna ora") ---
// Il bot parte da solo ogni 15 minuti (Cloudflare). Il link serve solo a non aspettare: avvia un giro
// completo e segue i dati pubblicati finché non cambiano (o 15 minuti al massimo).
function refreshLabel(text, busy) {
    const btn = $('btn-refresh'), lbl = $('btn-refresh-label');
    if (lbl) lbl.textContent = text;
    if (btn) btn.disabled = !!busy;
}
export function startRefreshCountdown(remainingSeconds) {
    if (State.refreshTimerInterval) clearInterval(State.refreshTimerInterval);
    let left = remainingSeconds;
    const tick = () => {
        if (left <= 0) {
            clearInterval(State.refreshTimerInterval);
            localStorage.removeItem('pt_refresh_start_ts');
            refreshLabel('Aggiorna ora', false);
            return;
        }
        refreshLabel(`In corso ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`, true);
        left--;
    };
    tick();
    State.refreshTimerInterval = setInterval(tick, 1000);
}

export function initRefreshState() {
    const startTs = localStorage.getItem('pt_refresh_start_ts');
    if (!startTs) return;
    const elapsedSecs = Math.floor((Date.now() - parseInt(startTs, 10)) / 1000);
    if (elapsedSecs >= 0 && elapsedSecs < CONFIG.REFRESH_MAX_WAIT) startRefreshCountdown(CONFIG.REFRESH_MAX_WAIT - elapsedSecs);
    else localStorage.removeItem('pt_refresh_start_ts');
}

function refreshDone(text) {
    if (State.refreshTimerInterval) clearInterval(State.refreshTimerInterval);
    localStorage.removeItem('pt_refresh_start_ts');
    refreshLabel(text, true);
    setTimeout(() => refreshLabel('Aggiorna ora', false), 2000);
}

export async function triggerRefresh() {
    const btn = $('btn-refresh');
    if (btn && btn.disabled) return;
    localStorage.setItem('pt_refresh_start_ts', Date.now());
    startRefreshCountdown(CONFIG.REFRESH_MAX_WAIT);
    try {
        const r = await apiPost('/api/trigger', { symbol: 'ALL', timeframe: 'ALL' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // il giro dura pochi secondi: dopo un minuto si rileggono i dati pubblicati
        refreshDone('Avviato');
        setTimeout(() => { loadData(); }, 60000);
    } catch (e) {
        refreshDone('Non avviato');
        if (window.showAlert) window.showAlert('Errore', "Impossibile avviare il giro del bot. Controlla Impostazioni → Altro → Connessioni.");
    }
}

// Inquadratura iniziale (ultime 60 candele) per l'asset/timeframe corrente. Va applicata solo quando
// il grafico ha una larghezza reale: all'avvio i dati arrivano con la pagina Grafici nascosta
// (larghezza 0) e la libreria calcolerebbe la spaziatura minima, con tutte le candele schiacciate.
// In quel caso resta in attesa e viene applicata al primo ridimensionamento con larghezza > 0.
function applyDefaultViewIfNeeded() {
    if (!chartHandle || !chartContainer || chartContainer.clientWidth === 0) return;
    const key = `${State.currentAsset}_${State.currentTF}`;
    const n = State.candleTimes.length;
    if (key === State.viewKey || n === 0) return;
    chartHandle.resize(); // la spaziatura si calcola sulla larghezza attuale del grafico
    State.viewKey = key;
    chartHandle.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 60), to: n + 8 });
}

export function resizeChart() {
    if (chartHandle) chartHandle.resize();
    applyDefaultViewIfNeeded();
}

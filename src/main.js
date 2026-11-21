import { State } from './core/state.js';
import { Logger } from './core/logger.js';
import * as Helpers from './utils/helpers.js';
import * as TerminalUI from './ui/terminal.js';
import * as CalculatorUI from './ui/calculator.js';
import * as TradeUI from './ui/trade.js';
import * as SignalsUI from './ui/signals.js';
import * as BacktestUI from './ui/backtest.js';
import * as HomeUI from './ui/home.js';
import * as AI from './ui/ai.js';
import * as Assist from './ui/assistant.js';
import * as Backup from './core/backup.js';
import * as LabUI from './ui/lab.js';
import * as AutoUI from './ui/automation.js';
import * as AccountUI from './ui/account.js';
import { initTheme, watchWalls } from './core/theme.js';
import { initManual } from './ui/manual.js';
import * as Lock from './ui/lock.js';
import * as Orders from './ui/orders.js';
import { initPageFit, refitPages } from './ui/page-fit.js';
import { initA11y } from './ui/a11y.js';
import { initMarquee } from './ui/marquee.js';
import { initTitleIcon } from './ui/title-icon.js';
import { normalizeWindows } from './ui/windows.js';
import * as Market from './ui/market.js';
import * as Results from './ui/results.js';
import * as Log from './ui/log.js';

State.loadSignalState();

window.H = Helpers;
window.KState = State;

// ==========================================
// FUNZIONI GLOBALI (definite SUBITO per l'HTML)
// ==========================================
// Account (icona in Home) e Opzioni (barra in basso): src/ui/account.js
window.openAccount = AccountUI.openAccount;
window.setTheme = AccountUI.setTheme;
window.setGlass = AccountUI.setGlass;
window.setWallColor = AccountUI.setWallColor;
window.renderAccount = AccountUI.renderAccount;
window.setTradingMode = AutoUI.setTradingMode;
window.openConnections = AccountUI.openConnections;
window.saveDataKey = AccountUI.saveDataKey;
window.generateDataKey = AccountUI.generateDataKey;
window.removeDataKey = AccountUI.removeDataKey;
// dati cifrati senza chiave (o con quella sbagliata): un avviso solo, poi le pagine restano vuote
let dataLockedShown = false;
window.addEventListener('pt-data-locked', e => {
    if (dataLockedShown || !window.showAlert) return;
    dataLockedShown = true;
    window.showAlert('Dati cifrati', e.detail === 'wrong' ? 'La chiave dei dati salvata non apre i file: inseriscila di nuovo in Opzioni → Connessioni.' : 'Saldo, posizioni e strategie sono cifrati. Inserisci la chiave dei dati in Opzioni → Connessioni.');
});
window.closeConnections = AccountUI.closeConnections;
window.goToSlide = (idx) => {
    const carousel = document.getElementById('infoCarousel');
    if (!carousel) return;
    carousel.scrollTo({ left: idx * carousel.clientWidth, behavior: 'smooth' });
};
window.updateInfoDots = () => {
    const carousel = document.getElementById('infoCarousel');
    if (!carousel || carousel.clientWidth === 0) return;
    const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
    document.querySelectorAll('#infoDots .info-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
};
window.showAlert = (title, msg) => {
    const t = document.getElementById('alertTitle');
    const m = document.getElementById('alertMessage');
    const modal = document.getElementById('alertModal');
    if (t) t.textContent = title;
    if (m) m.textContent = msg;
    if (modal) modal.classList.add('active');
};
window.closeAlert = () => {
    const modal = document.getElementById('alertModal');
    if (modal) modal.classList.remove('active');
};

// ==========================================
// UI MODULES WIRING
// ==========================================
// Terminal
window.setAsset = TerminalUI.setAsset;
window.setTF = TerminalUI.setTF;
window.triggerRefresh = TerminalUI.triggerRefresh;
window.toggleFullscreenChart = TerminalUI.toggleFullscreenChart;
window.takeSnapshot = TerminalUI.takeSnapshot;
window.renderTechFilters = TerminalUI.renderTechFilters;
window.goToDashboardSlide = TerminalUI.goToDashboardSlide;
window.refreshMarkers = TerminalUI.refreshMarkers;
window.updatePriceLines = TerminalUI.updatePriceLines;

// Calculator
window.setMarket = CalculatorUI.setMarket;
window.calc = CalculatorUI.calc;
window.updateCalcHints = CalculatorUI.updateCalcHints;
window.openTradeFromCalculator = CalculatorUI.openTradeFromCalculator;
window.setCtxLabel = CalculatorUI.setCtxLabel;
window.setCalcDirection = CalculatorUI.setCalcDirection;
window.onFuturesData = CalculatorUI.onFuturesData;

// Trade
window.renderActiveTrades = TradeUI.renderActiveTrades;
window.refreshCapitalUI = TradeUI.refreshCapitalUI;
window.closeAIAnalysisModal = TradeUI.closeAIAnalysisModal;
window.renderActiveTradeDots = TradeUI.renderActiveTradeDots;
window.goToActiveTradePage = TradeUI.goToActiveTradePage;

// trade chiusi o conto cambiati: si ridisegna la pagina Risultati (se è aperta)
window.renderHistory = Results.renderResults;
window.setResultsSource = Results.setResultsSource;
window.setLogFilter = Log.setLogFilter;
window.logDay = Log.logDay;
window.setResultsPeriod = Results.setResultsPeriod;
window.setResultsWho = Results.setResultsWho;
window.openCompare = Results.openCompare;
window.closeCompare = Results.closeCompare;
window.renderBreakEven = CalculatorUI.renderBreakEven;
window.syncTradeMode = CalculatorUI.syncTradeMode;

// Signals
window.scanAllSignals = SignalsUI.scanAllSignals;
window.goToSignalPage = SignalsUI.goToSignalPage;
window.updateSignalDots = SignalsUI.updateSignalDots;
window.openSignalDetail = SignalsUI.openSignalDetail;
window.closeSignalDetailModal = SignalsUI.closeSignalDetailModal;
window.clearSignalHistory = SignalsUI.clearSignalHistory;
window.toggleBrowserNotifications = SignalsUI.toggleBrowserNotifications;
window.openSignalSettings = SignalsUI.openSignalSettings;
window.closeSignalSettings = SignalsUI.closeSignalSettings;
window.saveSignalSettingsFromUI = SignalsUI.saveSignalSettingsFromUI;
window.testTelegramNotification = SignalsUI.testTelegramNotification;
window.goToSignalSlide = SignalsUI.goToSignalSlide;
window.renderSignalHistoryDots = SignalsUI.renderSignalHistoryDots;
window.updateSignalHistoryDots = SignalsUI.updateSignalHistoryDots;

// Scelta a tasti (strategia, coin, timeframe): aggiorna il campo nascosto indicato da data-target
// (letto dal codice con .value come prima con le tendine), evidenzia il tasto e richiama la
// funzione in data-onchange, se c'è
window.selectOption = (btn) => {
    const group = btn.closest('.option-toggle');
    const input = group && document.getElementById(group.dataset.target);
    if (!input) return;
    input.value = btn.dataset.value;
    group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    const cb = group.dataset.onchange && window[group.dataset.onchange];
    if (typeof cb === 'function') cb();
};

// Backtest
window.runBacktestSingle = BacktestUI.runBacktestSingle;
window.exportBacktestCSV = BacktestUI.exportBacktestCSV;
window.applyBtParams = BacktestUI.applyBtParams;
window.openBtStrategies = BacktestUI.openBtStrategies;
window.closeBtStrategies = BacktestUI.closeBtStrategies;
window.pickBtStrategy = BacktestUI.pickBtStrategy;

// Laboratorio strategie (stessa pagina del Backtest)
window.setTestView = LabUI.setTestView;
window.renderLab = LabUI.renderLab;
window.goToLabPage = LabUI.goToLabPage;
window.openLabDetail = LabUI.openLabDetail;

// Automazione (pagina Segnali, vista Auto) e server comandi (Opzioni)
window.setSignalsView = AutoUI.setSignalsView;
window.setAutoMode = AutoUI.setAutoMode;
window.askAutoMode = AutoUI.askAutoMode;
window.askRunLab = AutoUI.askRunLab;
window.openPortfolioHelp = AutoUI.openPortfolioHelp;
window.askRemovePriceAlert = AutoUI.askRemovePriceAlert;
window.toggleEmergency = AutoUI.toggleEmergency;
window.runAutoJob = AutoUI.runAutoJob;
window.openAutoAdd = AutoUI.openAutoAdd;
window.closeAutoAdd = AutoUI.closeAutoAdd;
window.openAlerts = () => { window.switchTab('terminal'); Market.setMarketView('alerts'); };   // Home → Avvisi prezzo
window.setMarketView = Market.setMarketView;
window.renderMarketAlerts = Market.renderMarketAlerts;
window.newPriceAlert = Market.newPriceAlert;
window.resizeChart = TerminalUI.resizeChart;
window.openAgent = AutoUI.openAgent;
window.closeAgent = AutoUI.closeAgent;
window.agentPromote = AutoUI.agentPromote;
window.runAgent = AutoUI.runAgent;
window.setAgent = AutoUI.setAgent;
window.setAgentTab = AutoUI.setAgentTab;
window.openChartAlert = AutoUI.openChartAlert;
window.closeChartAlert = AutoUI.closeChartAlert;
window.chartAlertStep = AutoUI.chartAlertStep;
window.caHint = AutoUI.caHint;
window.confirmChartAlert = AutoUI.confirmChartAlert;
window.chartAlertSignals = TerminalUI.chartAlertSignals;
window.closeAlerts = AutoUI.closeAlerts;
window.removePriceAlert = AutoUI.removePriceAlert;
Object.assign(window, { lockKey: Lock.lockKey, lockFaceId: Lock.lockFaceId, lockCancel: Lock.lockCancel,
    openLockSettings: Lock.openLockSettings, closeLockSettings: Lock.closeLockSettings, lockSetup: Lock.lockSetup, lockChange: Lock.lockChange,
    lockDisable: Lock.lockDisable, lockSetAfter: Lock.lockSetAfter, lockSetFace: Lock.lockSetFace });
normalizeWindows();          // finestre a schermo intero con l'intestazione delle pagine
watchWalls();                // sfondo dinamico: luci allineate tra app, finestre, Assistente e blocco
Lock.initLock();
window.setPosView = Orders.setPosView;
window.openBotPaper = () => { window.switchTab('trade'); Orders.setPosView('bot'); };
window.updateCoinFade = TerminalUI.updateCoinFade;
window.orderSignalAssets = SignalsUI.orderSignalAssets;
window.renderSignalGrid = SignalsUI.renderSignalGrid;
window.coinRelevance = HomeUI.coinRelevance;
window.renderOrders = Orders.renderOrders;
window.ordStep = Orders.ordStep;
window.ordSync = Orders.ordSync;
Orders.initOrders();
window.removeRealOrder = AutoUI.removeRealOrder;
window.requestAIAnalysisReal = TradeUI.requestAIAnalysisReal;
window.addAutoPaper = AutoUI.addAutoPaper;
window.closeAutoConfirm = AutoUI.closeAutoConfirm;
window.okAutoConfirm = AutoUI.okAutoConfirm;
window.saveServerSettings = AutoUI.saveServerSettings;
window.resetAppKey = AutoUI.resetAppKey;
window.saveGhToken = AutoUI.saveGhToken;
window.openAutoRisk = AutoUI.openAutoRisk;
window.openPaperTrades = AutoUI.openPaperTrades;
window.closePaperTrades = AutoUI.closePaperTrades;
window.goToAutoPage = AutoUI.goToAutoPage;
window.updateAutoDots = AutoUI.updateAutoDots;
window.closeAutoRisk = AutoUI.closeAutoRisk;
window.saveAutoRisk = AutoUI.saveAutoRisk;
window.removeGhToken = AutoUI.removeGhToken;

// Home
window.updateHome = HomeUI.updateHome;
window.requestMarketAnalysis = AI.requestMarketAnalysis;
// Assistente sulle posizioni (chat e voce)
window.openAssistant = Assist.openAssistant;
window.openAssistantReal = Assist.openAssistantReal;
window.assistQuick = Assist.assistQuick;
window.closeAssistant = Assist.closeAssistant;
window.sendAssist = Assist.sendAssist;
window.toggleRecording = Assist.toggleRecording;
// dalla Home: Agente → Strategie in un tocco
window.openHomeCoin = HomeUI.openHomeCoin;
window.openAutomation = () => { window.switchTab('signals'); AutoUI.setSignalsView('auto'); };   // Home → Automazione: Agente → Strategie

// Home Live Charts

// Backup
window.exportBackup = Backup.exportBackup;
window.doExportBackup = Backup.doExportBackup;
window.closeBackupModal = Backup.closeBackupModal;
window.triggerImportBackup = Backup.triggerImportBackup;
window.handleImportBackup = Backup.handleImportBackup;


window.scrollNavTo = (idx) => {
    const navScroll = document.getElementById('navScroll');
    if (navScroll) navScroll.scrollTo({ left: idx * navScroll.clientWidth, behavior: 'smooth' });
};

function updateNavDots() {
    const navScroll = document.getElementById('navScroll');
    if (!navScroll) return;
    const pages = navScroll.querySelectorAll('.nav-page');
    if (pages.length === 0) return;
    const scrollLeft = navScroll.scrollLeft;
    let closestIdx = 0, minDist = Infinity;
    pages.forEach((page, idx) => {
        const dist = Math.abs(page.offsetLeft - scrollLeft);
        if (dist < minDist) { minDist = dist; closestIdx = idx; }
    });
    document.querySelectorAll('#navDots .nav-dot').forEach((d, i) => d.classList.toggle('active', i === closestIdx));
}

window.switchTab = (tabId) => {
    // il Backtest ora è Agente → Laboratorio
    if (tabId === 'test') { window.switchTab('signals'); AutoUI.setSignalsView('lab'); return; }
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const targetPage = document.getElementById(`page-${tabId}`);
    const targetNav = document.getElementById(`nav-${tabId}`);
    if (targetPage) targetPage.classList.add('active');
    if (targetNav) targetNav.classList.add('active');

    const navItem = document.getElementById(`nav-${tabId}`);
    if (navItem) {
        const navScroll = document.getElementById('navScroll');
        const page = navItem.closest('.nav-page');
        if (page && navScroll) {
            const pageIdx = Array.from(navScroll.children).indexOf(page);
            if (pageIdx >= 0) {
                navScroll.scrollTo({ left: pageIdx * navScroll.clientWidth, behavior: 'smooth' });
                setTimeout(updateNavDots, 100);
            }
        }
    }

    if (tabId === 'trade') TradeUI.onOpenTrade();
    // pagine che si sistemano da sole all'apertura (mai mentre le guardi; una scelta tua vale 30 minuti). Il grafico di Mercato no: ricorda sempre l'ultima coin e l'ultimo timeframe
    if (tabId === 'trade' && !Helpers.chosenRecently('posView')) Orders.autoPosView();
    if (tabId === 'journal') Results.autoResultsSource();
    if (tabId === 'home') {
        HomeUI.updateHome();
        requestAnimationFrame(() => requestAnimationFrame(HomeUI.updateHome));   // dopo l'assestamento del layout (due fotogrammi): le righe delle ultime chiuse si adattano allo spazio
    } else if (tabId === 'terminal') {
        // il grafico va ridimensionato (e inquadrato) quando la pagina ha la misura definitiva:
        // su iOS il layout si assesta più tardi, quindi ripeto dopo che si è stabilizzato
        requestAnimationFrame(() => requestAnimationFrame(TerminalUI.resizeChart));   // se il layout cambia dopo, ci pensa il ResizeObserver del grafico
    } else if (tabId === 'trade') {
        TradeUI.refreshCapitalUI();
        TradeUI.renderActiveTrades();
        TradeUI.renderActiveTradeDots();
    } else if (tabId === 'journal') {
        Results.renderResults();
    } else if (tabId === 'log') {
        Log.renderLog(true);
    } else if (tabId === 'calculator') {
        CalculatorUI.setCtxLabel();
    } else if (tabId === 'account') {
        AccountUI.renderAccount();
    } else if (tabId === 'settings') {
        AccountUI.renderSettings();
    } else if (tabId === 'signals') {
        // pagina Agente: Rischio se c'è un blocco o una pausa, altrimenti Stato (o la scheda scelta da poco)
        AutoUI.setSignalsView(AutoUI.autoSignalsView(), false);
    }
    if (tabId === 'terminal') {
        // Mercato → Segnali: griglia e storico dei segnali tecnici
        SignalsUI.renderSignalGrid();
        SignalsUI.renderSignalHistory();
        SignalsUI.updateSignalNotifStatus();
        SignalsUI.updateSignalHistoryDots();
    }
    refitPages(true);                        // la pagina appena aperta si adatta subito, senza aspettare i cambi di contenuto
};

initTheme();

document.addEventListener('DOMContentLoaded', () => {
    Logger.log('INFO', 'SYSTEM', 'PinscherTrade avviato');

    // Versione dell'app (da <meta name="app-version">, aggiornata da tools/bump_version.py):
    // serve a verificare sul telefono di avere davvero l'ultima versione e non una in cache
    const appVersion = document.querySelector('meta[name="app-version"]')?.content || '—';
    const versionEl = document.getElementById('homeAppVersion');
    if (versionEl) versionEl.textContent = 'v' + appVersion;

    document.body.classList.remove('chart-fullscreen', 'snapshot-mode');

    TerminalUI.initTerminal();
    CalculatorUI.initCalculator();
    TradeUI.initTrade();
    SignalsUI.initSignals();
    HomeUI.initHome();

    initManual();
    initPageFit();
    initTitleIcon();            // icona in alto a sinistra di ogni titolo (prima di a11y: i titoli diventano tasti)
    initA11y();
    initMarquee();
    setTimeout(() => Log.prefetchLog(), 1500);          // il Registro si apre già pronto

    CalculatorUI.setMarket('SPOT');
    CalculatorUI.setCtxLabel();
    CalculatorUI.syncCapital();
    TradeUI.refreshCapitalUI();

    HomeUI.updateHome();

    const navScroll = document.getElementById('navScroll');
    if (navScroll) {
        navScroll.addEventListener('scroll', () => {
            clearTimeout(window._navScrollTimeout);
            window._navScrollTimeout = setTimeout(updateNavDots, 50);
        });
        updateNavDots();

        // In PWA la fila di icone non è scorrevole al tocco (vedi style.css, html.pwa-mode):
        // il passaggio tra le due pagine della navbar lo gestisce questo swipe.
        if (document.documentElement.classList.contains('pwa-mode')) {
            let startX = null, startY = null;
            navScroll.addEventListener('touchstart', e => {
                startX = e.touches[0].clientX; startY = e.touches[0].clientY;
            }, { passive: true });
            navScroll.addEventListener('touchend', e => {
                if (startX === null) return;
                const dx = e.changedTouches[0].clientX - startX;
                const dy = e.changedTouches[0].clientY - startY;
                startX = startY = null;
                if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
                const pages = navScroll.querySelectorAll('.nav-page').length;
                const current = Math.round(navScroll.scrollLeft / navScroll.clientWidth);
                const next = Math.max(0, Math.min(pages - 1, current + (dx < 0 ? 1 : -1)));
                if (next !== current) window.scrollNavTo(next);
            }, { passive: true });
        }
    }

    const dashCarousel = document.getElementById('dashboardCarousel');
    if (dashCarousel) dashCarousel.addEventListener('scroll', () => {
        clearTimeout(window._dashScrollTimeout);
        window._dashScrollTimeout = setTimeout(TerminalUI.updateDashboardDots, 50);
    });

    const activeTradesListEl = document.getElementById('activeTradesList');
    if (activeTradesListEl) activeTradesListEl.addEventListener('scroll', () => {
        clearTimeout(window._activeTradeScrollTimeout);
        window._activeTradeScrollTimeout = setTimeout(TradeUI.renderActiveTradeDots, 50);
    });

    const signalHistoryEl = document.getElementById('signalHistoryList');
    if (signalHistoryEl) signalHistoryEl.addEventListener('scroll', () => {
        clearTimeout(window._signalHistoryScrollTimeout);
        window._signalHistoryScrollTimeout = setTimeout(SignalsUI.updateSignalHistoryDots, 50);
    });

    const infoCarouselEl = document.getElementById('infoCarousel');
    if (infoCarouselEl) infoCarouselEl.addEventListener('scroll', () => {
        clearTimeout(window._infoScrollTimeout);
        window._infoScrollTimeout = setTimeout(() => {
            if (typeof window.updateInfoDots === 'function') window.updateInfoDots();
        }, 50);
    });

    window.addEventListener('resize', () => {
        clearTimeout(window._resizeTimer);
        window._resizeTimer = setTimeout(() => HomeUI.updateHome(), 200);
    });
});

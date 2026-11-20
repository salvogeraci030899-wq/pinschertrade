import { CONFIG } from './config.js';

export const State = {
    signalSettings: { ...CONFIG.DEFAULT_SETTINGS },
    signalHistory: [],
    signalMatrix: {},
    signalPrevMatrix: {},
    currentAsset: 'BTCUSDT',
    currentTF: '1d',
    currentMarket: 'SPOT',
    pendingTradePayload: null,
    lastBacktestData: null,
    
    // Stato runtime
    capitalTouched: false,
    livePx: {},
    viewKey: '',
    candleTimes: [],
    atSig: null,
    currentAtrPct: 0,
    lastHeaderPrice: null,
    pollInFlight: false,
    signalScanInFlight: false,
    calcContext: null,
    
    // Intervals
    pricePollInterval: null,
    refreshTimerInterval: null,
    signalScanInterval: null,

    saveSignalState() {
        try {
            localStorage.setItem(CONFIG.SIGNAL_STORAGE_KEY, JSON.stringify({
                settings: this.signalSettings,
                history: this.signalHistory.slice(0, 200),
                prevMatrix: this.signalPrevMatrix
            }));
        } catch (e) {}
    },

    loadSignalState() {
        try {
            const raw = localStorage.getItem(CONFIG.SIGNAL_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed.settings) {
                const s = parsed.settings;
                if (s.notificationsEnabled != null) this.signalSettings.notificationsEnabled = s.notificationsEnabled;
                if (s.telegramBotToken != null) this.signalSettings.telegramBotToken = s.telegramBotToken;
                if (s.telegramChatId != null) this.signalSettings.telegramChatId = s.telegramChatId;
                if (s.webhookUrl != null) this.signalSettings.webhookUrl = s.webhookUrl;
                if (s.minAgreement != null) this.signalSettings.minAgreement = s.minAgreement;
                if ('barkKey' in s) delete s.barkKey;
            }
            if (Array.isArray(parsed.history)) this.signalHistory = parsed.history;
            if (parsed.prevMatrix && typeof parsed.prevMatrix === 'object') this.signalPrevMatrix = parsed.prevMatrix;
        } catch (e) {}
    }
};

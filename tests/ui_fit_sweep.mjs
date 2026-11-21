// Stabilità dell'adattamento delle pagine a tutte le altezze di schermo: per ogni altezza apre Mercato → Segnali (e le altre pagine
// indicate), fa cambiare il prezzo in alto a destra come nell'app e verifica che zoom e margine in fondo restino fermi.
// Uso: node tests/ui_fit_sweep.mjs [altezza_min altezza_max passo]   (predefinito 560 920 8; LWC_PATH come in ui_smoke)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8900 + Math.floor(Math.random() * 90);
const [lo, hi, step] = [process.argv[2] || 560, process.argv[3] || 920, process.argv[4] || 8].map(Number);
const PAGES = (process.env.SWEEP_PAGES || 'terminal:sig,terminal:chart,home,trade,journal,signals:agent,signals:auto').split(',');
const now = Date.now();
const candles = (n = 200) => Array.from({ length: n }, (_, i) => { const p = 70000 + Math.sin(i / 7) * 900 + i * 3; return [String(now - (n - i) * 3600e3), String(p), String(p + 250), String(p - 250), String(p + 40), '12', '0', '0']; });
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ui_data.json'), 'utf8'));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const bad = [];
try {
    for (let i = 0; i < 50; i++) { const up = await new Promise(res => { const c = net.connect(PORT, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); }); if (up) break; await new Promise(r => setTimeout(r, 200)); }
    const browser = await chromium.launch();
    for (let h = lo; h <= hi; h += step) {
        const ctx = await browser.newContext({ viewport: { width: 402, height: h }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
        await ctx.addInitScript(() => {
            try { localStorage.setItem('pt_gh_token', 'github_pat_' + 'x'.repeat(30)); } catch (e) {} Object.defineProperty(navigator, 'standalone', { get: () => true });
            // su iPhone la misura dell'area visibile oscilla di 1-2 px tra una lettura e l'altra: lo simulo
            if (window.visualViewport) { let k = 0; const real = window.visualViewport.height; Object.defineProperty(window.visualViewport, 'height', { get: () => real + ((k++ >> 1) % 2) * 2 - 1 }); }
        });
        const page = await ctx.newPage();
        if (process.env.LWC_PATH) await page.route('https://unpkg.com/**', r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.LWC_PATH, 'utf8') }));
        await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
        await page.route('https://api.bitget.com/**', r => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: '00000', data: r.request().url().includes('candles') ? candles() : [] }) }));
        await page.route(/\/(automation|live_trades|paper_trades|agent_state|equity_history|quick_state|alerts_state|guard_state|lab_summary)\.json/, r => { const n = new URL(r.request().url()).pathname.split('/').pop(); return r.fulfill({ contentType: 'application/json', body: JSON.stringify(FIX[n] || {}) }); });
        await page.route(/api\.github\.com|workers\.dev|api\.telegram\.org|\/events\//, r => r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
        // iPhone con isola e barra home: le zone sicure (59 px sopra, 34 px sotto) fanno parte del calcolo dell'adattamento
        await page.route(/\/(style|tokens)\.css/, async r => {
            const body = fs.readFileSync(path.join(ROOT, new URL(r.request().url()).pathname.replace(/^\//, '')), 'utf8')
                .replaceAll('env(safe-area-inset-top, 0px)', '59px').replaceAll('env(safe-area-inset-bottom, 0px)', '34px');
            await r.fulfill({ contentType: 'text/css', body });
        });
        await page.goto(`http://127.0.0.1:${PORT}/index.html`);
        await page.waitForTimeout(2500);
        await page.evaluate(async () => {
            const { State } = await import('./src/core/state.js'); const sm = await import('./src/ui/signals.js');
            const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
            for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) State.signalMatrix[`${a}_${tf}`] = sig('SHORT', 'NEUTRAL', 'SHORT');
            State.signalHistory = Array.from({ length: 30 }, (_, i) => ({ asset: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'][i % 3], tf: ['1h', '4h', '1d'][i % 3], consensus: 'SHORT', agreement: 2, timestamp: Date.now() - i * 3600e3, strength: 60 + (i % 9), sources: { breakout: 'SHORT', mean_reversion: i % 3 ? 'NEUTRAL' : 'SHORT', ma_crossover: 'SHORT' } }));
            window.__sm = sm;
        });
        for (const view of PAGES) {
            const [tab, sub] = view.split(':');
            await page.evaluate(async ([t, sv]) => {
                window.switchTab(t); if (sv && t === 'terminal') window.setMarketView(sv); if (sv && t === 'signals') window.setSignalsView(sv);
                if (t === 'terminal' && sv === 'sig') { window.__sm.orderSignalAssets(); window.__sm.renderSignalGrid(); window.__sm.renderSignalHistory(); }
            }, [tab, sub]);
            await page.waitForTimeout(700);
            const seen = await page.evaluate(async ([t]) => {
                const price = document.getElementById('live-price') || document.querySelector('.header-row .price-val');
                const root = document.documentElement, seen = {}, mark = (k, v) => { (seen[k] = seen[k] || new Set()).add(v); };
                const id = (document.querySelector('.page.active') || {}).id.replace('page-', '');
                let n = 0, stop = false;
                const frame = () => { if (stop) return; const cs = getComputedStyle(root); mark('zoom', cs.getPropertyValue('--fit-zoom-' + id).trim()); mark('extra', cs.getPropertyValue('--fit-extra-bottom-' + id).trim()); requestAnimationFrame(frame); };
                requestAnimationFrame(frame);
                const tick = setInterval(() => { n++; const txt = (1700 + (n % 2) * 0.04).toFixed(2).replace('.', ',') + ' $'; if (price) price.textContent = txt; else document.querySelector('.header-row').appendChild(document.createTextNode(' ')); }, 450);
                await new Promise(res => setTimeout(res, 3200));
                stop = true; clearInterval(tick);
                return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]]));
            }, [tab]);
            if (Object.values(seen).some(v => v.length > 1)) bad.push(`altezza ${h} · ${view}: ${JSON.stringify(seen)}`);
        }
        await ctx.close();
    }
    await browser.close();
} finally { server.kill(); }
if (bad.length) { console.log(bad.length + ' PROBLEMI di stabilità:\n- ' + bad.join('\n- ')); process.exit(1); }
console.log(`Adattamento stabile a tutte le altezze da ${lo} a ${hi} (passo ${step}).`);

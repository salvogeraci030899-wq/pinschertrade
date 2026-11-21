// Prova dell'interfaccia in un browser vero (Playwright, Chromium), su iPhone 15 Safari e iPhone 17 Pro installata:
// ogni pagina e vista, in Simulato e in Reale, deve caricarsi senza errori JavaScript e senza scroll verticale
// (regola dell'app: si scorre solo di lato); poi le azioni principali: assistente dalla scheda, grafico a
// schermo intero con l'avviso, conferma prima dell'autonomia Reale. Dati: i file del repository; Bitget e GitHub simulati.
//   node tests/ui_smoke.mjs                 (serve Playwright: npm i playwright && npx playwright install chromium)
//   LWC_PATH=...lightweight-charts.js       facoltativo: libreria dei grafici da file invece che da unpkg
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8800 + Math.floor(Math.random() * 100);
const DEVICES = [{ n: 'iPhone SE', w: 375, h: 667 }, { n: 'iPhone 15 Safari', w: 393, h: 659 }, { n: 'iPhone 17 Pro app', w: 402, h: 874, pwa: true }];
const VIEWS = { log: [['setLogFilter', 'all'], ['setLogFilter', 'agente']], journal: [['setResultsSource', 'real'], ['setResultsSource', 'sim'], ['setResultsSource', 'paper'], ['setResultsPeriod', 'all'], ['setResultsPeriod', 'day']], terminal: [['setMarketView', 'chart'], ['setMarketView', 'sig'], ['setMarketView', 'alerts']], trade: [['setPosView', 'open'], ['setPosView', 'orders']], signals: [['setSignalsView', 'agent'], ['setSignalsView', 'auto'], ['setSignalsView', 'lab'], ['setTestView', 'bt'], ['setSignalsView', 'risk']] };

const now = Date.now();
const candles = (n = 200) => Array.from({ length: n }, (_, i) => {
    const p = 70000 + Math.sin(i / 7) * 900 + i * 3;
    return [String(now - (n - i) * 3600e3), String(p), String(p + 250), String(p - 250), String(p + 40), '12', '0', '0'];
});

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const problems = [];
const seenClip = new Set();      // ogni testo troppo lungo si segnala una volta sola per dispositivo (alla prima pagina dove compare)
try {
    for (let i = 0; i < 50; i++) {
        const up = await new Promise(res => { const c = net.connect(PORT, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); });
        if (up) break;
        await new Promise(r => setTimeout(r, 200));
    }
    const browser = await chromium.launch();
    // ogni dispositivo in Simulato e Reale; l'app installata anche in Reale con il vetro e il tema chiaro
    const ALL_RUNS = DEVICES.flatMap(dev => [{ dev, mode: 'sim' }, { dev, mode: 'real' }, ...(dev.pwa ? [{ dev, mode: 'real', glass: true }] : [])]);
    // SHARD=i/n: esegue solo le prove con indice = i (mod n), per dividere il lavoro tra più job in CI
    const [shardI, shardN] = (process.env.SHARD || '0/1').split('/').map(Number);
    const RUNS = ALL_RUNS.filter((_, i) => i % shardN === shardI);
    for (const { dev, mode, glass } of RUNS) {
        const tag = (mode === 'real' ? 'Reale' : 'Simulato') + (glass ? ', vetro dinamico chiaro' : '');
        const ctx = await browser.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: true, hasTouch: true, deviceScaleFactor: process.env.SHOT_DIR ? 2 : 1, colorScheme: glass ? 'light' : 'dark' });
        await ctx.addInitScript(([pwa, glass, wide]) => {
            try {
                localStorage.setItem('pt_gh_token', 'github_pat_' + 'x'.repeat(30));
            } catch (e) {}
            // telefono più stretto: lettere un po' più larghe, per simulare i caratteri dell'iPhone e lasciare margine ai testi
            if (wide) document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '* { letter-spacing: 0.02em !important; }'; document.head.appendChild(st); });
            if (pwa) Object.defineProperty(navigator, 'standalone', { get: () => true });
            if (glass) try { localStorage.setItem('pt_glass', 'anim'); localStorage.setItem('pt_theme', 'light'); } catch (e) {}
        }, [!!dev.pwa, !!glass, dev.n === 'iPhone SE']);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        if (process.env.LWC_PATH) await page.route('https://unpkg.com/**', r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.LWC_PATH, 'utf8') }));
        await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
        await page.route('https://api.bitget.com/**', r => {
            const u = r.request().url();
            const data = u.includes('candles') ? candles() : u.includes('ticker') ? [{ symbol: 'BTCUSDT', lastPr: '70500', open24h: '69000', change24h: '0.021', high24h: '71000', low24h: '68800', baseVolume: '1000', usdtVolume: '7e7', markPrice: '70500' }] : [];
            return r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: '00000', data }) });
        });
        let dataDelay = 0;          // ms di rete simulati sui dati (solo nella misura del contenuto pronto)
        await page.route('**/events/*.jsonl*', async r => {
            if (dataDelay) await new Promise(res => setTimeout(res, dataDelay));
            const at = new Date().toISOString();
            const ev = Array.from({ length: 14 }, (_, i) => JSON.stringify({ at, kind: ['ordini', 'agente', 'carta', 'avvisi', 'posizioni', 'sistema', 'conto'][i % 7], action: 'prova', text: `🔔 Evento di prova numero ${i + 1} ✅, con un testo di lunghezza normale come quelli veri.`, id: 'e' + i, ok: i % 5 !== 0, net: i % 2 ? 0.5 : -0.2 }));
            return r.fulfill({ contentType: 'text/plain', body: ev.join('\n') + '\n' });
        });
        // dati personali inventati (quelli veri nel repository sono cifrati): conto, posizioni, carta, agente, storico
        const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ui_data.json'), 'utf8'));
        await page.route(/\/(automation|live_trades|paper_account_senza_chiusura|paper_account|paper_trades|agent_state|equity_history|quick_state|alerts_state|guard_state|lab_summary)\.json/, async r => {
            if (dataDelay) await new Promise(res => setTimeout(res, dataDelay));
            const name = new URL(r.request().url()).pathname.split('/').pop();
            const j = structuredClone(name === 'paper_account.json' ? { ...FIX['live_trades.json'], mode: 'simulata' } : name === 'paper_account_senza_chiusura.json' ? { ...FIX['live_trades.json'], mode: 'simulata', first_run: '2026-11-01T00:00:00+00:00' } : FIX[name]);
            if (name === 'paper_trades.json' && process.env.MANY_OPEN) {         // prova di layout: tanti trade su carta aperti (come nei dati veri)
                const coins = ['ADAUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT'];
                j.strategies.many_open = { mode: 'paper', stats: { n: 0, open: coins.length }, trades: coins.map((symbol, i) => ({ id: `many_open:1d:${symbol}:${i}`, symbol, t: 1790000000 + i, t_entry: 1790086400 + i, dir: -1, entry: 100 + i, stop: 110 + i, open: true, gross: 0 })) };
            }
            if (name === 'automation.json') j.risk = { ...(j.risk || {}), trading_enabled: mode === 'real', real_follows_paper: mode === 'real' ? 1 : 0 };
            return r.fulfill({ contentType: 'application/json', body: JSON.stringify(j) });
        });
        await page.route(/api\.github\.com|workers\.dev|api\.telegram\.org/, r => r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } }));
        await page.goto(`http://127.0.0.1:${PORT}/index.html`);
        await page.waitForTimeout(3500);
        const pages = await page.evaluate(() => [...document.querySelectorAll('section.page')].map(s => s.id.replace('page-', '')));
        // Con SHOT_DIR=cartella salva gli screenshot delle schermate indicate in SHOT_VIEWS (es. "terminal:sig,home"): serve a guardare il layout
        if (process.env.SHOT_DIR) {
            const fs2 = await import('node:fs');
            fs2.mkdirSync(process.env.SHOT_DIR, { recursive: true });
            if (process.env.SHOT_SEED === 'signals') {
                await page.evaluate(async () => {
                    const { State } = await import('./src/core/state.js');
                    const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
                    for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) {
                        const strong = tf === '1d' && ['ETHUSDT', 'XRPUSDT', 'SOLUSDT'].includes(a);
                        State.signalMatrix[`${a}_${tf}`] = strong ? sig('SHORT', 'NEUTRAL', 'SHORT') : sig('NEUTRAL', 'NEUTRAL', tf === '1h' ? 'SHORT' : 'NEUTRAL');
                    }
                    const now = Date.now();
                    State.signalHistory = Array.from({ length: 12 }, (_, i) => ({ asset: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'][i % 3], tf: ['1h', '4h', '1d'][i % 3], consensus: i % 4 === 0 ? 'LONG' : 'SHORT', agreement: i % 5 === 0 ? 3 : 2,
                        timestamp: now - i * 3600e3, strength: 68 - i, sources: { breakout: i % 4 === 0 ? 'LONG' : 'SHORT', mean_reversion: i % 2 ? 'NEUTRAL' : (i % 4 === 0 ? 'LONG' : 'SHORT'), ma_crossover: i % 4 === 0 ? 'LONG' : 'SHORT' } }));
                    window.renderSignalGrid(); window.renderSignalHistory && window.renderSignalHistory();
                });
            }
            for (const v of (process.env.SHOT_VIEWS || 'home').split(',')) {
                const [tab, sub] = v.split(':');
                await page.evaluate(([t, sv]) => { window.switchTab(t); if (sv && t === 'terminal') window.setMarketView(sv); if (sv && t === 'signals') window.setSignalsView(sv); }, [tab, sub]);
                if (process.env.SHOT_JS) await page.evaluate(process.env.SHOT_JS);
                await page.waitForTimeout(1200);
                await page.screenshot({ path: `${process.env.SHOT_DIR}/${dev.n.replace(/\s+/g, '_')}-${tag.replace(/[^A-Za-z]+/g, '_')}-${tab}${sub ? '-' + sub : ''}.png` });
            }
        }
        // barra in basso: centrata, staccata dal fondo, stesso margine interno sopra (puntini) e sotto (voci)
        const nav = await page.evaluate(() => { const n = document.querySelector('.nav-bar').getBoundingClientRect(), d = document.querySelector('.nav-dots').getBoundingClientRect(), it = document.querySelector('.nav-item').getBoundingClientRect();
            return { l: Math.round(n.left), r: Math.round(innerWidth - n.right), b: Math.round(innerHeight - n.bottom), fuori: Math.round(n.top - d.bottom), sopra: Math.round(it.top - n.top), sotto: Math.round(n.bottom - it.bottom) }; });
        if (glass && !(await page.evaluate(() => document.documentElement.classList.contains('glass')))) problems.push(`${dev.n}, ${tag}: il vetro non si accende`);
        if (nav.l !== nav.r || nav.l < 4 || nav.b < 4 || nav.b > 60 || nav.fuori < 0 || nav.sopra !== nav.sotto) problems.push(`${dev.n}, ${tag}: barra in basso fuori posto ${JSON.stringify(nav)}`);
        // Fluidità: tempo di cambio pagina con CPU rallentata 4x (come un telefono), 3 giri su tutte le pagine.
        // Mediana e massimo in console; fallisce solo oltre soglie larghe, per accorgersi dei peggioramenti grossi.
        if (!glass) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            const times = await page.evaluate(async list => {
                const out = [];
                for (let k = 0; k < 3; k++) for (const p of list) {
                    const t0 = performance.now(); window.switchTab(p);
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    out.push(performance.now() - t0);
                }
                return out;
            }, pages);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
            times.sort((a, b) => a - b);
            const med = Math.round(times[Math.floor(times.length / 2)]), max = Math.round(times[times.length - 1]);
            console.log(`  fluidità ${dev.n}, ${tag}: cambio pagina (CPU 4x) mediana ${med} ms, massimo ${max} ms`);
            if (med > 400 || max > 1200) problems.push(`${dev.n}, ${tag}: cambio pagina lento (mediana ${med} ms, massimo ${max} ms)`);
            // Contenuto pronto: dopo l'apertura di una pagina o di una scheda, quando avviene l'ultima modifica visibile
            // (testo, nodi, classi, zoom di adattamento)? Se avviene dopo qualche centinaio di ms, il contenuto "arriva dopo".
            const steps = [...pages.map(p => ['pagina ' + p, 'switchTab', p]),
                ...['agent', 'auto', 'lab', 'risk'].map(v => ['Agente ' + v, 'setSignalsView', v]),
                ...['chart', 'sig', 'alerts'].map(v => ['Mercato ' + v, 'setMarketView', v])];
            const cdp2 = await page.context().newCDPSession(page);
            await cdp2.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            const ready = [];
            dataDelay = 350;                                           // rete da telefono: ogni file di dati impiega 350 ms
            for (const [label, fn, arg] of steps) {
                if (fn === 'setSignalsView') await page.evaluate(() => window.switchTab('signals'));
                if (fn === 'setMarketView') await page.evaluate(() => window.switchTab('terminal'));
                await page.waitForTimeout(900);
                const r = await page.evaluate(([fn, arg]) => new Promise(resolve => {
                    const t0 = performance.now(); let last = 0, what = '';
                    const desc = n => { const e = n.nodeType === 1 ? n : n.parentElement; return e ? (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : '')) : '?'; };
                    // Conta solo ciò che cambia davvero: il testo visibile della pagina o lo zoom di adattamento. Le riscritture
                    // periodiche dello stesso contenuto (aggiornamenti ogni 5 s) non sono "contenuto che arriva dopo".
                    const textNow = () => ((document.querySelector('.page.active') || {}).innerText || '');
                    let lastText = textNow();
                    const mo = new MutationObserver(ms => {
                        let changed = null;
                        for (const m of ms) {
                            if (m.target === document.documentElement) continue;          // lo zoom si misura a ogni fotogramma (sotto)
                            if (m.target.closest && m.target.closest('.nav-wrap')) continue;     // la barra in basso non è contenuto
                            const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
                            if (el && el.getClientRects().length === 0) continue;               // elemento nascosto: non si vede
                            changed = el;
                        }
                        if (changed) { const t = textNow(); if (t !== lastText) { lastText = t; last = performance.now() - t0; what = desc(changed); } }
                    });
                    mo.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
                    window[fn](arg);
                    // Zoom di adattamento della pagina che si guarda, campionato a ogni fotogramma: un salto visibile lo cambia tra due fotogrammi
                    // (i passaggi dentro lo stesso fotogramma, come azzerare e rimisurare, non si vedono e non contano)
                    const pg = ((document.querySelector('.page.active') || {}).id || '').replace('page-', '');
                    const zoomNow = () => getComputedStyle(document.documentElement).getPropertyValue('--fit-zoom-' + pg).trim();
                    let prev = null, stop = false;
                    const tick = () => {
                        if (stop) return;
                        const z = zoomNow();
                        if (prev !== null && z !== prev) { last = performance.now() - t0; what = `zoom ${pg} ${prev}→${z}`; }
                        prev = z;
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(() => requestAnimationFrame(tick));      // dopo il primo fotogramma: lo stato di apertura è quello iniziale
                    setTimeout(() => { stop = true; mo.disconnect(); resolve([Math.round(last), what]); }, 1500);
                }), [fn, arg]);
                ready.push([label, r[0], r[1]]);
            }
            dataDelay = 0;
            await cdp2.send('Emulation.setCPUThrottlingRate', { rate: 1 });
            const worst = [...ready].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, t, w]) => `${l} ${t} ms (${w})`).join(', ');
            if (process.env.READY_ALL) console.log('  tutte: ' + ready.map(([l, t]) => `${l}=${t}`).join(' '));
            console.log(`  contenuto pronto ${dev.n}, ${tag} (CPU 4x), ultima modifica dopo l'apertura: ${worst}`);
            // Schede che mostrano dati caricati: devono disegnarsi dalla memoria, senza attendere la rete (350 ms simulati).
            // Prima della correzione: Agente 410-440 ms, Registro 750 ms. Soglia larga contro le oscillazioni della CI.
            // Posizioni resta fuori: i prezzi dal vivo arrivano dalla rete dopo l'apertura, non sono dati in memoria.
            for (const [l, t, w] of ready) if ((l.startsWith('Agente') || /^pagina (log|signals|journal)$/.test(l)) && t > 300) problems.push(`${dev.n}, ${tag}: ${l} pronta dopo ${t} ms (${w}): deve disegnarsi subito dai dati in memoria`);
        }
        // Mercato: l'ultima coin e l'ultimo timeframe si ricordano dopo il riavvio, con i tasti già giusti
        await page.evaluate(() => { window.switchTab('terminal'); window.setAsset('ETHUSDT'); window.setTF('4h'); });
        await page.waitForTimeout(300);
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(1200);
        const chartMem = await page.evaluate(() => ({ a: document.getElementById('btn-ETHUSDT').classList.contains('active'), t: document.getElementById('btn-4h').classList.contains('active'), b: document.getElementById('btn-BTCUSDT').classList.contains('active'), l: document.getElementById('current-asset-label').textContent }));
        if (!chartMem.a || !chartMem.t || chartMem.b) problems.push(`${dev.n}, ${tag}: Mercato non ricorda l'ultima coin e l'ultimo timeframe (${JSON.stringify(chartMem)})`);
        await page.evaluate(() => { window.setAsset('BTCUSDT'); window.setTF('1d'); });
        // Colori sfondo: ogni pallino cicla i colori (la luce compare), alla fine torna al colore di base e le luci spariscono
        const wall = await page.evaluate(() => {
            const root = document.documentElement, out = {};
            window.setWallColor(1); out.on = root.classList.contains('tint') && root.style.getPropertyValue('--wall-c2') !== '';
            out.saved = !!(JSON.parse(localStorage.getItem('pt_wall') || 'null') || {}).css;
            for (let i = 0; i < 9; i++) window.setWallColor(1);
            out.off = !root.classList.contains('tint') && root.style.getPropertyValue('--wall-c2') === '';
            return out;
        });
        if (!wall.on || !wall.saved || !wall.off) problems.push(`${dev.n}, ${tag}: i colori sfondo non cambiano o non tornano alla base (${JSON.stringify(wall)})`);
        // Risultati: cambiando periodo (Oggi, Settimana, ...) e fonte (Reale, Carta) nulla si sposta né cambia misura
        await page.evaluate(() => window.switchTab('journal'));
        await page.waitForTimeout(700);
        const openedOn = await page.evaluate(() => (document.getElementById('res-src-real').classList.contains('active') ? 'real' : document.getElementById('res-src-paper').classList.contains('active') ? 'paper' : 'nessuna'));
        if (openedOn !== (mode === 'real' ? 'real' : 'paper')) problems.push(`${dev.n}, ${tag}: Risultati si apre su ${openedOn}, deve aprirsi su ${mode === 'real' ? 'Reale' : 'Carta'}`);
        const resSig = async () => page.evaluate(() => {
            const r = e => { const b = e.getBoundingClientRect(); return [b.top, b.left, b.width, b.height].map(Math.round).join(','); };
            const parts = [document.querySelector('#page-journal .header-row'), document.getElementById('resTabs'), ...document.getElementById('resBody').children];
            return parts.map(r).join(' | ') + ' | zoom ' + document.documentElement.style.getPropertyValue('--fit-zoom-journal');
        });
        // Confronto chiusura totale: il tasto c'è solo su Carta e apre la tabella (Con/Senza); si chiude
        await page.evaluate(() => { window.setResultsSource('paper'); });
        await page.waitForTimeout(300);
        const cmpBtn = await page.evaluate(() => !![...document.querySelectorAll('#resBody .btn-link-secondary')].find(b => /Confronto chiusura totale/.test(b.textContent)));
        if (!cmpBtn) problems.push(`${dev.n}, ${tag}: Risultati (Carta) deve avere il tasto Confronto chiusura totale`);
        else {
            await page.evaluate(() => window.openCompare());
            await page.waitForTimeout(300);
            const cmp = await page.evaluate(() => ({ on: document.getElementById('cmpModal').classList.contains('active'), rows: document.querySelectorAll('#cmpBody .cmp-table tbody tr').length, verdict: !!document.querySelector('#cmpBody .cmp-verdict') }));
            if (!cmp.on || cmp.rows !== 4 || !cmp.verdict) problems.push(`${dev.n}, ${tag}: il confronto chiusura totale non si apre bene (${JSON.stringify(cmp)})`);
            await page.evaluate(() => window.closeCompare());
        }
        const resSigs = {};
        for (const sv of ['real', 'paper']) for (const pv of ['day', 'week', 'month', 'year', 'all']) {
            await page.evaluate(([a, b]) => { window.setResultsSource(a); window.setResultsPeriod(b); }, [sv, pv]);
            await page.waitForTimeout(450);
            resSigs[`${sv}/${pv}`] = await resSig();
        }
        const resKeys = Object.keys(resSigs);
        for (const kk of resKeys.slice(1)) if (resSigs[kk] !== resSigs[resKeys[0]]) problems.push(`${dev.n}, ${tag}: Risultati si sposta o cambia misura tra ${resKeys[0]} e ${kk}\n    ${resSigs[resKeys[0]]}\n    ${resSigs[kk]}`);
        // Home: schede una sotto l'altra, tutte sopra la barra in basso e senza righe tagliate; l'ultima riempie lo spazio rimasto
        await page.evaluate(() => window.switchTab('home'));
        await page.waitForTimeout(700);
        // Reale con "Reale segue la carta": Home mostra insieme conto reale e conto carta; in Simulato solo la carta
        const both = await page.evaluate(() => { const v = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; }; return { two: v('homeKpis2'), title: document.getElementById('homeAccTitle').textContent }; });
        if (!both.two) problems.push(`${dev.n}, ${tag}: la Home deve mostrare anche il conto carta (Reale spento, o Reale che segue la carta)`);
        const glow = await page.evaluate(() => document.documentElement.classList.contains('mode-real'));
        if (glow !== (mode === 'real')) problems.push(`${dev.n}, ${tag}: il bordo dell'icona del titolo si illumina solo in Reale (acceso: ${glow})`);
        if (!/Bitget/.test(both.title)) problems.push(`${dev.n}, ${tag}: la Home deve sempre mostrare il conto Bitget`);
        const home = await page.evaluate(() => {
            const top = document.querySelector('.nav-wrap').getBoundingClientRect().top;
            const kids = [...document.querySelectorAll('#page-home .home-container > *')].filter(e => e.getClientRects().length);
            const last = kids[kids.length - 1].getBoundingClientRect();
            const list = document.getElementById('homeRecentList');
            const clipped = [...list.children].filter(r => !r.hidden && r.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom + 1).length;
            return { fuori: kids.filter(e => e.getBoundingClientRect().bottom > top + 1).length, vuoto: Math.round(top - last.bottom), tagliate: clipped, rows: list.children.length, noChart: !document.getElementById('homeChartsList') };
        });
        // Home con i dati di prova: ogni campo importante pieno, niente NaN o undefined, ultime chiuse presenti (carta)
        const hd = await page.evaluate(() => { const t = id => (document.getElementById(id) || {}).textContent || '';
            return { eq: t('homeEquity'), pnl: t('homePnlToday'), pf: t('homePortfolio'), strat: t('homeAutoStrategies'), bad: /NaN|undefined|null|\[object/.test(document.getElementById('page-home').innerText),
                rows: document.querySelectorAll('#homeRecentList .home-line:not(.home-empty)').length }; });
        if (hd.bad || hd.eq === '—' || hd.eq === '' || hd.pf === '—' || hd.pf === '' || hd.strat === '—' || (mode !== 'real' && hd.rows < 1)) problems.push(`${dev.n}, ${tag}: Home, dati mancanti o errati ${JSON.stringify(hd)}`);
        if (home.fuori || home.tagliate || !home.noChart) problems.push(`${dev.n}, ${tag}: Home fuori posto ${JSON.stringify(home)}`);
        // Mercato: grafico grande, pannelli a scorrimento orizzontale (Grafico, Verifica strategia, Futures, Livelli, Carta),
        // in basso solo i pallini e il tasto dell'analisi; niente contenuto tagliato nei pannelli
        await page.evaluate(() => { window.switchTab('terminal'); window.setMarketView('chart'); });
        await page.waitForTimeout(800);
        const mk = await page.evaluate(() => {
            const nav = document.querySelector('.nav-wrap').getBoundingClientRect().top, car = document.getElementById('dashboardCarousel');
            const chart = document.getElementById('mainChartContainer').getBoundingClientRect(), btn = document.getElementById('btn-live-analysis').getBoundingClientRect();
            return { chartH: Math.round(chart.height), vh: innerHeight, btnOk: btn.height >= 40 && btn.bottom <= nav + 1, slides: car.children.length,
                dots: document.querySelectorAll('#dashboardDots .info-dot').length, oldPanel: !!document.getElementById('ai-panel') };
        });
        if (mk.slides !== 5 || mk.dots !== 5 || !mk.btnOk || mk.oldPanel || mk.chartH < mk.vh * 0.3) problems.push(`${dev.n}, ${tag}: Mercato fuori posto ${JSON.stringify(mk)}`);
        for (let i = 1; i < 5; i++) {
            await page.evaluate(n => window.goToDashboardSlide(n), i);
            await page.waitForTimeout(600);
            const clip = await page.evaluate(i => {
                const car = document.getElementById('dashboardCarousel'), panel = car.children[i].querySelector('.mkt-panel'), pb = panel.getBoundingClientRect();
                const bad = [...panel.querySelectorAll('.filter-item, .tr-foot, .paper-row:not([hidden]), .tech-header, .option-toggle')]
                    .filter(e => e.getClientRects().length && (e.getBoundingClientRect().bottom > pb.bottom + 1 || e.scrollHeight > e.clientHeight + 2)).map(e => e.className.split(' ')[0] + ':' + Math.round(e.scrollHeight - e.clientHeight));
                const active = document.querySelector('#dashboardDots .info-dot.active'), idx = [...document.querySelectorAll('#dashboardDots .info-dot')].indexOf(active);
                return { bad, idx, vis: Math.abs(car.children[i].offsetLeft - car.scrollLeft) < 4 };
            }, i);
            if (clip.bad.length || clip.idx !== i || !clip.vis) problems.push(`${dev.n}, ${tag}: Mercato, pannello ${i}: ${JSON.stringify(clip)}`);
        }
        await page.evaluate(() => window.goToDashboardSlide(0));
        await page.waitForTimeout(400);
        // identificativi doppi: il codice troverebbe l'elemento sbagliato
        const dup = await page.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach(e => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter(k => c[k] > 1); });
        if (dup.length) problems.push(`${dev.n}, ${tag}: identificativi doppi: ${dup.join(', ')}`);
        for (const p of pages) for (const v of (VIEWS[p] || [[null]])) {
            await page.evaluate(t => window.switchTab(t), p);
            await page.waitForTimeout(400);
            if (v[0]) { await page.evaluate(([f, a]) => window[f] && window[f](a), v); await page.waitForTimeout(400); }
            const r = await page.evaluate(W => {
                const pg = document.querySelector('section.page.active');
                const emoji = pg ? (pg.innerText.match(/\p{Extended_Pictographic}/gu) || []).join('') : '';
                return { over: pg ? pg.scrollHeight - pg.clientHeight : -1, wide: document.documentElement.scrollWidth - W, emoji };
            }, dev.w);
            const where = `${dev.n}, ${tag}, ${p}${v[1] ? '/' + v[1] : ''}`;
            if (r.over > 1) problems.push(`${where}: la pagina scorre in verticale di ${r.over}px`);
            if (r.over < 0) problems.push(`${where}: pagina non trovata`);
            if (r.wide > 1) problems.push(`${where}: più larga dello schermo di ${r.wide}px`);
            if (r.emoji) problems.push(`${where}: emoji nella pagina (${r.emoji}); nell'app non ce ne devono essere`);
            // Testi troppo lunghi: tagliati (con o senza puntini), fuori dallo schermo, o su più righe dentro un tasto.
            // Le liste che scorrono di lato (coin, schede, navbar a due pagine) sono fatte per uscire dallo schermo e non contano.
            const clipped = await page.evaluate(W => {
                const out = [], seen = new Set();
                const roots = [document.querySelector('section.page.active'), document.querySelector('.nav-wrap')].filter(Boolean);
                const scrollable = el => { for (let e = el.parentElement; e; e = e.parentElement) { if (e.classList && e.classList.contains('nav-scroll')) return true; const o = getComputedStyle(e).overflowX; if ((o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth + 1) return true; } return false; };
                for (const root of roots) for (const el of root.querySelectorAll('*')) {
                    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
                    if (el.closest('.mq-on')) continue;                    // testo che scorre da solo: non è tagliato
                    const nodes = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
                    const txt = nodes.map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
                    if (!txt) continue;
                    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
                    if (!r.width || !r.height) continue;
                    let why = null;
                    // la riga di testo più larga contro lo spazio utile dell'elemento (anche se il testo sborda senza essere nascosto)
                    let tw = 0;
                    for (const n of nodes) { const range = document.createRange(); range.selectNodeContents(n); for (const x of range.getClientRects()) tw = Math.max(tw, x.width); }
                    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
                    if (el.clientWidth > 0 && tw > room + 1 && cs.display !== 'inline' && !scrollable(el)) why = 'sborda';
                    else if (el.scrollWidth > el.clientWidth + 1 && (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') && !scrollable(el)) why = 'tagliato';
                    else if ((r.right > W + 1 || r.left < -1) && !scrollable(el)) why = 'fuori schermo';
                    else if (el.matches('button, .pill-btn, .nav-item, .set-label, label, .home-card-header span, .tech-title, .tech-trend-label')) {
                        const tops = new Set();
                        for (const n of nodes) { const range = document.createRange(); range.selectNodeContents(n); for (const x of range.getClientRects()) if (x.width > 0) tops.add(Math.round(x.top / 4)); }
                        if (tops.size > 1) why = 'va a capo';
                    }
                    if (!why) continue;
                    const key = why + txt;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push(`"${txt.slice(0, 46)}" ${why} <${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}>`);
                }
                return out;
            }, dev.w);
            for (const c of clipped) { const k = `${dev.n}|${c}`; if (!seenClip.has(k)) { seenClip.add(k); problems.push(`${where}: testo troppo lungo: ${c}`); } }
        }
        // Regole fisse: ogni finestra a schermo intero, intestazione nello stesso punto della Home, niente scroll verticale
        await page.evaluate(() => window.switchTab('home'));
        await page.waitForTimeout(300);
        const wins = await page.evaluate(() => {
            const pos = el => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; };
            const home = document.querySelector('#page-home .header-row');
            const ref = { row: pos(home), h1: pos(home.querySelector('h1')), p: pos(home.querySelector('.header-title p')), btn: pos(home.querySelector('.header-icon-btn')) };
            const out = [];
            for (const ov of document.querySelectorAll('.modal-overlay')) {
                ov.classList.add('active');
                const box = ov.querySelector('.modal-box, .assist-box'), row = ov.querySelector('.header-row');
                const r = box.getBoundingClientRect();
                const bad = [];
                if (Math.round(r.left) !== 0 || Math.round(r.top) !== 0 || Math.round(r.width) !== innerWidth || Math.round(r.height) !== innerHeight) bad.push(`non a schermo intero (${Math.round(r.width)}x${Math.round(r.height)})`);
                if (!row) bad.push('senza intestazione');
                else {
                    const got = { row: pos(row), h1: pos(row.querySelector('h1')), p: pos(row.querySelector('.header-title p')), btn: row.querySelector('.header-icon-btn') ? pos(row.querySelector('.header-icon-btn')) : null };
                    for (const k of ['row', 'h1', 'p', 'btn']) if (got[k] && JSON.stringify(got[k]) !== JSON.stringify(ref[k])) bad.push(`${k} a ${got[k]} invece di ${ref[k]}`);
                }
                for (const el of [box, ...box.querySelectorAll('.win-body, .assist-log')]) if (el.scrollHeight - el.clientHeight > 1 && getComputedStyle(el).overflowY !== 'hidden') bad.push(`scorre in verticale (${el.className})`);
                if (bad.length) out.push(`${ov.id}: ${bad.join(', ')}`);
                ov.classList.remove('active');
            }
            return out;
        });
        for (const w of wins) problems.push(`${dev.n}, ${tag}: finestra ${w}`);
        // Azioni principali, come le farebbe una persona
        const where = `${dev.n}, ${tag}`;
        const step = async (name, fn) => { try { if (!(await fn())) problems.push(`${where}: ${name}`); } catch (e) { problems.push(`${where}: ${name} (${e.message.split('\n')[0]})`); } };
        if (mode === 'sim') {
            // la pagina Posizioni ha sempre le stesse schede (Aperte, Ordini, Bot su carta), anche con Reale spento
            await page.evaluate(() => window.switchTab('trade'));
            await page.waitForTimeout(500);
            await step('posizioni: anche con Reale spento ci sono le schede Aperte, Ordini e Bot su carta', async () => page.evaluate(() => getComputedStyle(document.querySelector('#page-trade .pos-views')).display !== 'none'));
            // assistente generale, dall'icona in Home
            await page.evaluate(() => window.switchTab('home'));
            await page.waitForTimeout(400);
            await step('assistente: si apre dall\'icona in Home, senza tasto audio e senza rettangolo nel campo di testo', async () => { await page.click('.header-icon-btn[title="Assistente"]'); await page.waitForTimeout(500); return page.evaluate(() => { const i = document.getElementById('assistInput'); i.focus(); return document.getElementById('assistModal').classList.contains('active') && !document.getElementById('assistSpeak') && getComputedStyle(i).outlineStyle === 'none'; }); });
            await step('assistente: la X chiude', async () => { await page.click('.assist-head [title="Chiudi"]'); await page.waitForTimeout(300); return page.evaluate(() => !document.getElementById('assistModal').classList.contains('active')); });
        }
        await page.evaluate(() => { window.switchTab('terminal'); window.setMarketView('chart'); });
        await page.waitForTimeout(600);
        await step('grafico: schermo intero senza tasti avviso e condividi', async () => {
            await page.click('#btnFullscreen'); await page.waitForTimeout(500);
            return page.evaluate(() => [...document.querySelectorAll('#mainChartContainer .chart-tool')].filter(b => b.offsetParent !== null).length === 2);
        });
        await step('grafico: la finestra dell\'avviso non si apre', async () => {
            await page.click('#mainChartContainer .chart-tool >> nth=0'); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('chartAlertModal').classList.contains('active'));
            await page.evaluate(() => window.closeChartAlert()); await page.click('#mainChartContainer .home-chart-fullscreen'); await page.waitForTimeout(300);
            return on;
        });
        // Segnali: struttura, schede dello storico e scorrimento (dati di prova messi nella memoria dell'app)
        await step('segnali: stato su una riga per colonna, storico senza tagli e con aggancio, contatore e griglia a pagine', async () => {
            await page.evaluate(async () => {
                window.switchTab('terminal'); window.setMarketView('sig');
                const { State } = await import('./src/core/state.js');
                const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
                for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) State.signalMatrix[`${a}_${tf}`] = sig('SHORT', 'NEUTRAL', 'SHORT');
                const now = Date.now();
                State.signalHistory = Array.from({ length: 12 }, (_, i) => ({ asset: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'][i % 3], tf: ['1h', '4h', '1d'][i % 3], consensus: 'SHORT', agreement: 2, timestamp: now - i * 3600e3, strength: 68 - i,
                    sources: { breakout: 'SHORT', mean_reversion: 'SHORT', ma_crossover: 'SHORT' } }));
                const sm = await import('./src/ui/signals.js');
                sm.renderSignalGrid(); sm.renderSignalHistory();
            });
            await page.waitForTimeout(500);
            const r = await page.evaluate(async () => {
                const wait = ms => new Promise(res => setTimeout(res, ms));
                const out = {};
                // stato della scansione: due colonne, nessuna delle due su più righe
                const cells = [...document.querySelectorAll('#signalInfoBar .sib-cell')];
                out.infoOk = cells.length === 2 && cells.every(c => [...c.children].every(e => e.getBoundingClientRect().height < 40));
                // storico: la prima scheda sta al margine, la seconda si intravede, niente contenuto tagliato
                const list = document.getElementById('signalHistoryList'), items = [...list.querySelectorAll('.log-item')];
                const lr = list.getBoundingClientRect(), r0 = items[0].getBoundingClientRect(), r1 = items[1].getBoundingClientRect();
                out.zoom = lr.width / (list.offsetWidth || lr.width);          // lo zoom di adattamento della pagina riduce tutte le misure
                out.margin = Math.round(r0.left - lr.left); out.peek = Math.round(innerWidth - r1.left);
                out.noClip = items.slice(0, 3).every(i => i.scrollHeight <= i.clientHeight + 1 && i.querySelector('.shi-strategies').getBoundingClientRect().bottom <= i.getBoundingClientRect().bottom);
                // scorrimento: si aggancia alla seconda scheda e il contatore lo segue
                const stride = items[1].offsetLeft - items[0].offsetLeft;
                list.scrollTo({ left: stride, behavior: 'smooth' }); await wait(900);
                out.snap = Math.abs(list.scrollLeft - stride) <= 2; out.counter = (document.querySelector('#signalHistoryDots .pager-count') || {}).textContent;
                list.scrollTo({ left: 0, behavior: 'auto' }); await wait(200);
                // griglia: pagina 2 agganciata e punto attivo
                const grid = document.getElementById('signalGrid');
                const gp = grid.querySelectorAll('.signal-page'), gstride = gp[1].offsetLeft - gp[0].offsetLeft;
                grid.scrollTo({ left: gstride, behavior: 'smooth' }); await wait(900);
                out.gridSnap = Math.abs(grid.scrollLeft - gstride) <= 2;
                out.dot = [...document.querySelectorAll('#signalDots .info-dot')].findIndex(d => d.classList.contains('active'));
                grid.scrollTo({ left: 0, behavior: 'auto' }); await wait(100);
                const { State } = await import('./src/core/state.js'); State.signalHistory = [];
                (await import('./src/ui/signals.js')).renderSignalHistory();
                return out;
            });
            const ok = r.infoOk && Math.abs(r.margin - 16) <= 2 && r.peek > 8 * r.zoom && r.peek < 60 && r.noClip && r.snap && r.counter === '2 / 12' && r.gridSnap && r.dot === 1;
            if (!ok) console.log('  segnali, dettagli:', JSON.stringify(r));
            return ok;
        });
        // Scorrimento col dito (eventi di tocco veri, non scrollTo): griglia dei segnali e storico devono muoversi e agganciarsi
        await step('segnali: scorrimento col dito su griglia e storico', async () => {
            await page.evaluate(async () => {
                window.switchTab('terminal'); window.setMarketView('sig');
                const { State } = await import('./src/core/state.js');
                const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
                for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) State.signalMatrix[`${a}_${tf}`] = sig('SHORT', 'NEUTRAL', 'SHORT');
                const now = Date.now();
                State.signalHistory = Array.from({ length: 12 }, (_, i) => ({ asset: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'][i % 3], tf: ['1h', '4h', '1d'][i % 3], consensus: 'SHORT', agreement: 2, timestamp: now - i * 3600e3, strength: 68 - i, sources: { breakout: 'SHORT', mean_reversion: 'SHORT', ma_crossover: 'SHORT' } }));
                const sm = await import('./src/ui/signals.js'); sm.renderSignalGrid(); sm.renderSignalHistory();
            });
            await page.waitForTimeout(500);
            const cdp = await page.context().newCDPSession(page);
            const swipe = async (x1, x2, y) => {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y }] });
                for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * i / 8, y }] }); await page.waitForTimeout(16); }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await page.waitForTimeout(700);
            };
            const pos = sel => page.evaluate(sel => { const e = document.querySelector(sel), r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, sl: e.scrollLeft, cw: e.clientWidth }; }, sel);
            const g0 = await pos('#signalGrid');
            await swipe(g0.x + g0.w * 0.35, g0.x - g0.w * 0.35, g0.y);                    // sulle celle: da destra a sinistra
            const g1 = await pos('#signalGrid');
            const h0 = await pos('#signalHistoryList');
            await swipe(h0.x + h0.w * 0.35, h0.x - h0.w * 0.35, h0.y);
            const h1 = await pos('#signalHistoryList');
            await page.evaluate(() => { document.getElementById('signalGrid').scrollLeft = 0; document.getElementById('signalHistoryList').scrollLeft = 0; });
            const geo = await page.evaluate(() => {
                const g = document.getElementById('signalGrid'), pgs = g.querySelectorAll('.signal-page');
                return { stride: pgs[1].offsetLeft - pgs[0].offsetLeft, w: pgs[0].offsetWidth, left: Math.round(g.getBoundingClientRect().left), gap: pgs[1].offsetLeft - pgs[0].offsetLeft - pgs[0].offsetWidth };
            });
            // la griglia scorre a tutto schermo e fra una pagina e l'altra c'è uno spazio: non sembrano incollate
            const ok = g1.sl > g0.sl + 20 && Math.abs(g1.sl - geo.stride) <= 2 && h1.sl > h0.sl + 20 && geo.gap >= 12 && geo.left <= 1;
            if (!ok) console.log('  scorrimento col dito:', JSON.stringify({ g0: g0.sl, g1: g1.sl, cw: g1.cw, h0: h0.sl, h1: h1.sl, geo }));
            return ok;
        });
        await step('segnali: le celle accese vengono mostrate per prime, le più forti in testa', async () => {
            const r = await page.evaluate(async () => {
                window.switchTab('terminal'); window.setMarketView('sig');
                const { State } = await import('./src/core/state.js');
                const sm = await import('./src/ui/signals.js');
                const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
                for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) State.signalMatrix[`${a}_${tf}`] = sig('NEUTRAL', 'NEUTRAL', 'NEUTRAL');
                State.signalMatrix['LINKUSDT_1h'] = sig('SHORT', 'SHORT', 'SHORT');       // 3/3: la più forte, anche se è l'ultima coin e il timeframe più basso
                State.signalMatrix['DOGEUSDT_4h'] = sig('LONG', 'NEUTRAL', 'LONG');       // 2/3
                State.signalMatrix['BTCUSDT_1d'] = sig('NEUTRAL', 'SHORT', 'NEUTRAL');    // parziale: una sola strategia
                sm.orderSignalAssets(); sm.renderSignalGrid();
                await new Promise(res => setTimeout(res, 2000));            // la griglia non si ridisegna mentre la tocchi: dopo un tocco aspetta un attimo
                const cells = [...document.querySelectorAll('#signalGrid .signal-page:first-child .signal-cell')].map(c => ({ t: c.querySelector('.sc-asset').textContent + ' ' + c.querySelector('.sc-tf').textContent, lit: /long|short/.test(c.className) }));
                return cells;
            });
            const lit = r.filter(c => c.lit).map(c => c.t);
            const firstNeutral = r.findIndex(c => !c.lit), lastLit = r.map(c => c.lit).lastIndexOf(true);
            const ok = r.length === 9 && lit[0] === 'LINK 1h' && lit[1] === 'DOGE 4h' && lit.length === 2 && lastLit < firstNeutral && r[2].t === 'BTC 1d';
            if (!ok) console.log('  ordine celle:', JSON.stringify(r.map(c => c.t + (c.lit ? '*' : ''))));
            return ok;
        });
        // Stabilità: con i segnali aperti, prezzi che cambiano e una nuova scansione, niente deve spostarsi o ridimensionarsi
        await step('segnali: nessun ridimensionamento in 6 secondi con prezzi e scansione che cambiano', async () => {
            const r = await page.evaluate(async () => {
                const { State } = await import('./src/core/state.js');
                const sm = await import('./src/ui/signals.js');
                window.switchTab('terminal'); window.setMarketView('sig');
                const sig = (a, b, c) => ({ breakout: { signal: a, strength: 70 }, mean_reversion: { signal: b, strength: 60 }, ma_crossover: { signal: c, strength: 66 } });
                for (const a of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT']) for (const tf of ['1d', '4h', '1h']) State.signalMatrix[`${a}_${tf}`] = sig('SHORT', 'NEUTRAL', 'SHORT');
                const mk = i => ({ asset: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'][i % 3], tf: ['1h', '4h', '1d'][i % 3], consensus: 'SHORT', agreement: i % 3 ? 2 : 3, timestamp: Date.now() - i * 3600e3, strength: 60 + (i % 9),
                    sources: i % 3 ? { breakout: 'SHORT', mean_reversion: 'NEUTRAL', ma_crossover: 'SHORT' } : { breakout: 'SHORT', mean_reversion: 'SHORT', ma_crossover: 'SHORT' } });
                State.signalHistory = Array.from({ length: 30 }, (_, i) => mk(i));
                sm.orderSignalAssets(); sm.renderSignalGrid(); sm.renderSignalHistory();
                await new Promise(res => setTimeout(res, 800));
                const price = document.getElementById('live-price'), seen = {}, mark = (k, v) => { (seen[k] = seen[k] || new Set()).add(v); };
                let n = 0, stop = false, t0 = performance.now();
                const frame = () => {
                    if (stop) return;
                    if (performance.now() - t0 > 300) {          // dopo l'assestamento iniziale
                        mark('zoom', getComputedStyle(document.documentElement).getPropertyValue('--fit-zoom-terminal').trim());
                        for (const [k, sel] of [['griglia', '#signalGrid'], ['storico', '#signalHistoryList'], ['stato', '#signalInfoBar'], ['pagina', '#mktSig']]) { const e = document.querySelector(sel); if (e) mark(k, Math.round(e.getBoundingClientRect().height * 10) / 10 + '@' + Math.round(e.getBoundingClientRect().top)); }
                    }
                    requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
                // prezzi che cambiano (ogni mezzo secondo, anche la larghezza del testo) e una nuova scansione a metà
                const tick = setInterval(() => { n++; if (price) price.textContent = (n % 2 ? '9.999,10' : '70.500,00') + ' $'; }, 500);
                await new Promise(res => setTimeout(res, 3000));
                State.signalHistory.unshift(mk(31)); State.signalMatrix['LINKUSDT_1h'] = sig('SHORT', 'SHORT', 'SHORT'); sm.renderSignalGrid(); sm.renderSignalHistory();
                await new Promise(res => setTimeout(res, 3000));
                stop = true; clearInterval(tick);
                // tutte le celle della griglia e tutte le schede dello storico hanno la stessa altezza, da una pagina all'altra
                const h = sel => [...new Set([...document.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().height)))];
                const sizes = { celle: h('#signalGrid .signal-page:nth-child(-n+2) .signal-cell'), schede: h('#signalHistoryList .log-item') };
                return { seen: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]])), sizes, uniform: sizes.celle.length === 1 && sizes.schede.length === 1 };
            });
            const moving = Object.entries(r.seen).filter(([, v]) => v.length > 1);
            if (moving.length) console.log('  si muovono:', JSON.stringify(Object.fromEntries(moving)));
            if (!r.uniform) console.log('  altezze diverse:', JSON.stringify(r.sizes));
            return moving.length === 0 && r.uniform;
        });
        await step('titoli: icona a sinistra di ogni titolo, un tocco la nasconde, i titoli si allineano e la scelta vale ovunque', async () => {
            const r = await page.evaluate(async () => {
                const wait = ms => new Promise(res => setTimeout(res, ms));
                const ids = [...document.querySelectorAll('section.page')].filter(p => p.querySelector('.header-title')).map(p => p.id.replace('page-', ''));
                const look = id => {
                    window.switchTab(id);
                    const t = document.querySelector(`#page-${id}.active .header-title`);
                    if (!t) return null;
                    const ic = t.querySelector('.title-icon').getBoundingClientRect(), h1 = t.querySelector('h1').getBoundingClientRect(), tr = t.getBoundingClientRect();
                    return { id, iw: Math.round(ic.width), gap: Math.round(h1.left - ic.right), h1x: Math.round(h1.left), side: ic.left >= tr.left - 1 && ic.right <= h1.left + 1, top: ic.top >= tr.top - 2, ratio: tr.width / (t.offsetWidth || tr.width) };
                };
                window.localStorage.removeItem('pt_title_icon'); document.documentElement.classList.remove('title-icon-off');
                await wait(300);
                const on = ids.map(look).filter(Boolean);
                // un tocco sul titolo della pagina aperta: icona nascosta, titolo a sinistra
                const first = ids[0]; window.switchTab(first); await wait(200);
                document.querySelector(`#page-${first}.active .header-title`).click(); await wait(500);
                const off = ids.map(look).filter(Boolean);              // la scelta vale in tutte le pagine
                const kept = window.localStorage.getItem('pt_title_icon');
                window.switchTab(first); await wait(100);
                document.querySelector(`#page-${first}.active .header-title`).click(); await wait(500);
                const back = look(first);
                window.switchTab('terminal');                            // i passi seguenti partono da Mercato
                return { on, off, kept, back, n: ids.length };
            });
            const z = r.on.every(x => x.iw >= 30 * x.ratio - 2 && x.side && x.top && x.gap >= 4);
            const hid = r.off.every((x, i) => x.iw <= 1 && x.h1x < r.on[i].h1x - 30 * r.on[i].ratio + 4);
            const ok = r.n >= 6 && z && hid && r.kept === '0' && r.back.iw >= 30 * r.back.ratio - 2;
            if (!ok) console.log('  titoli:', JSON.stringify({ n: r.n, kept: r.kept, on: r.on[0], off: r.off[0], back: r.back }));
            return ok;
        });
        await step('mercato: Nuovo avviso non apre la finestra', async () => {
            await page.evaluate(() => window.setMarketView('alerts')); await page.waitForTimeout(300);
            await page.click('.mkt-new-alert'); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('chartAlertModal').classList.contains('active') && document.querySelectorAll('#caCoins .pill-btn').length === 8);
            await page.evaluate(() => window.closeChartAlert());
            return on;
        });
        await step('home: un testo più lungo della riga scorre da solo, uno corto resta fermo', async () => {
            await page.evaluate(() => window.switchTab('home')); await page.waitForTimeout(500);
            const r = await page.evaluate(async () => {
                const card = document.querySelector('#page-home .home-card');
                const line = document.createElement('div');
                line.className = 'home-line';
                line.innerHTML = '<span>Prova</span><b id="mqTest">Agente: simulato · carta: ancora nessun trade chiuso e un testo davvero molto lungo da leggere</b>';
                card.appendChild(line);
                await new Promise(res => setTimeout(res, 400));
                const b = document.getElementById('mqTest'), inner = b.querySelector('.mq-inner');
                const long = { on: b.classList.contains('mq-on'), anim: getComputedStyle(inner).animationName, startVisible: inner.getBoundingClientRect().left >= b.getBoundingClientRect().left - 1,
                    shift: Number(b.style.getPropertyValue('--mq-shift')) };
                inner.textContent = 'ok';
                await new Promise(res => setTimeout(res, 400));
                const short = { on: b.classList.contains('mq-on'), anim: getComputedStyle(inner).animationName };
                line.remove();
                return { long, short };
            });
            return r.long.on && r.long.anim === 'mq-scroll' && r.long.startVisible && r.long.shift > 10 && !r.short.on && r.short.anim === 'none';
        });
        await page.evaluate(() => { window.switchTab('signals'); window.setSignalsView('agent'); });
        await page.waitForTimeout(800);
        // Strategie su carta: lo stato viene dal laboratorio e vale per chiunque le abbia messe (agente o tu).
        // Dati di prova: 4 su carta = 1 candidata, 1 quasi candidata, 1 in osservazione, 1 bocciata alla prova finale.
        await step('agente: la riga Stato conta le strategie per stato del laboratorio', async () => {
            const t = await page.evaluate(() => document.getElementById('agentStatus').innerText.replace(/\s+/g, ' '));
            return /4 su carta · 0 reali/.test(t) && /1 candidata · 1 quasi candidata · 1 in osservazione · 1 bocciata/.test(t);
        });
        await step('agente: ogni scheda strategia ha la sua etichetta di stato', async () => {
            await page.evaluate(() => window.setSignalsView('auto')); await page.waitForTimeout(400);
            const tags = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#autoList .auto-item')].map(i => [i.querySelector('.auto-open-trades').textContent.replace(/[›\s]+$/, '').trim(), (i.querySelector('.auto-tag') || {}).textContent || ''])));
            await page.evaluate(() => window.setSignalsView('agent')); await page.waitForTimeout(300);
            return tags['big candle trail 1d'] === 'bocciata' && tags['tsmom30 1d'] === 'osservazione' && tags['donchian20 long 1d'] === 'candidata' && tags['donchian20 turtle 1d'] === 'quasi candidata';
        });
        await step('limiti di rischio: Alto rischio c\'è e chiede la conferma con l\'avviso, senza partire da solo', async () => {
            await page.evaluate(() => { window.openAutoRisk(); });
            const has = await page.evaluate(() => !!document.getElementById('risk_near_candidates') && /Alto rischio/.test(document.getElementById('autoRiskFields').innerText));
            await page.evaluate(() => { document.getElementById('risk_near_candidates').value = '1'; window.saveAutoRisk(); });
            await page.waitForTimeout(300);
            const m = await page.evaluate(() => ({ on: document.getElementById('autoConfirmModal').classList.contains('active'), t: document.getElementById('autoConfirmMsg').innerText }));
            await page.evaluate(() => { window.closeAutoConfirm(); window.closeAutoRisk(); });
            return has && m.on && /ALTO RISCHIO/.test(m.t) && /su carta e in Reale/.test(m.t);
        });
        await step('agente: Reale senza la conferma', async () => {
            await page.click('#agentSettings .pill-btn:has-text("Reale")'); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('autoConfirmModal').classList.contains('active'));
            await page.evaluate(() => window.closeAutoConfirm());
            return on;
        });
        // nessun comando parte senza la conferma: avvio dell'agente, rilancio del laboratorio, salvataggio dei limiti di rischio
        await step('agente: Avvia ora chiede la conferma', async () => {
            await page.evaluate(() => window.runAgent()); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('autoConfirmModal').classList.contains('active'));
            await page.evaluate(() => window.closeAutoConfirm());
            return on;
        });
        await step('agente: Rilancia laboratorio chiede la conferma', async () => {
            await page.evaluate(() => window.askRunLab()); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('autoConfirmModal').classList.contains('active'));
            await page.evaluate(() => window.closeAutoConfirm());
            return on;
        });
        await step('rischio: salvare i limiti chiede la conferma e li elenca', async () => {
            await page.evaluate(() => { window.openAutoRisk(); document.getElementById('risk_risk_per_trade_pct').value = '1.5'; window.saveAutoRisk(); });
            await page.waitForTimeout(300);
            const r = await page.evaluate(() => ({ on: document.getElementById('autoConfirmModal').classList.contains('active'), msg: document.getElementById('autoConfirmMsg').textContent,
                still: document.getElementById('autoRiskModal').classList.contains('active') }));
            await page.evaluate(() => { window.closeAutoConfirm(); window.closeAutoRisk(); });
            return r.on && r.still && r.msg.includes('Rischio per trade');
        });
        for (const e of new Set(errors)) problems.push(`${dev.n}, ${tag}: errore JavaScript: ${e}`);
        console.log(`ok ${dev.n}, ${tag}: ${pages.length} pagine`);
        await ctx.close();
    }
    await browser.close();
} finally {
    server.kill();
}
if (problems.length) {
    console.log(`\n${problems.length} PROBLEMI:\n- ` + problems.join('\n- '));
    process.exit(1);
}
console.log('Interfaccia: tutto in ordine.');

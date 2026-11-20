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
        const ctx = await browser.newContext({ viewport: { width: dev.w, height: dev.h }, isMobile: true, hasTouch: true, colorScheme: glass ? 'light' : 'dark' });
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
        await page.route(/\/(automation|live_trades|paper_trades|agent_state|equity_history|quick_state|alerts_state|guard_state)\.json/, async r => {
            if (dataDelay) await new Promise(res => setTimeout(res, dataDelay));
            const name = new URL(r.request().url()).pathname.split('/').pop();
            const j = structuredClone(FIX[name]);
            if (name === 'automation.json') j.risk = { ...(j.risk || {}), trading_enabled: mode === 'real' };
            return r.fulfill({ contentType: 'application/json', body: JSON.stringify(j) });
        });
        await page.route(/api\.github\.com|workers\.dev|api\.telegram\.org/, r => r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } }));
        await page.goto(`http://127.0.0.1:${PORT}/index.html`);
        await page.waitForTimeout(3500);
        const pages = await page.evaluate(() => [...document.querySelectorAll('section.page')].map(s => s.id.replace('page-', '')));
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
                    const mo = new MutationObserver(ms => {
                        for (const m of ms) {
                            if (m.target.closest && m.target.closest('.nav-wrap')) continue;     // la barra in basso non è contenuto
                            const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
                            if (el && el !== document.documentElement && el.getClientRects().length === 0) continue;   // elemento nascosto: non si vede
                            last = performance.now() - t0; what = desc(m.target);
                        }
                    });
                    mo.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
                    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });   // zoom di adattamento
                    window[fn](arg);
                    setTimeout(() => { mo.disconnect(); resolve([Math.round(last), what]); }, 1500);
                }), [fn, arg]);
                ready.push([label, ...r]);
            }
            dataDelay = 0;
            await cdp2.send('Emulation.setCPUThrottlingRate', { rate: 1 });
            const worst = [...ready].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, t, w]) => `${l} ${t} ms (${w})`).join(', ');
            if (process.env.READY_ALL) console.log('  tutte: ' + ready.map(([l, t]) => `${l}=${t}`).join(' '));
            console.log(`  contenuto pronto ${dev.n}, ${tag} (CPU 4x), ultima modifica dopo l'apertura: ${worst}`);
            // Schede che mostrano dati caricati: devono disegnarsi dalla memoria, senza attendere la rete (350 ms simulati).
            // Prima della correzione: Agente 410-440 ms, Registro 750 ms. Soglia larga contro le oscillazioni della CI.
            for (const [l, t, w] of ready) if ((l.startsWith('Agente') || /^pagina (log|signals|journal|trade)$/.test(l)) && t > 300) problems.push(`${dev.n}, ${tag}: ${l} pronta dopo ${t} ms (${w}): deve disegnarsi subito dai dati in memoria`);
        }
        // Home: schede una sotto l'altra, tutte sopra la barra in basso e senza righe tagliate; l'ultima riempie lo spazio rimasto
        await page.evaluate(() => window.switchTab('home'));
        await page.waitForTimeout(700);
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
            // in Simulato la pagina Posizioni mostra solo il conto della carta, senza le schede Aperte e Ordini
            await page.evaluate(() => window.switchTab('trade'));
            await page.waitForTimeout(500);
            await step('posizioni: in Simulato niente schede Aperte e Ordini', async () => page.evaluate(() => getComputedStyle(document.querySelector('#page-trade .pos-views')).display === 'none'));
            // assistente generale, dall'icona in Home
            await page.evaluate(() => window.switchTab('home'));
            await page.waitForTimeout(400);
            await step('assistente: si apre dall\'icona in Home', async () => { await page.click('.header-icon-btn[title="Assistente"]'); await page.waitForTimeout(400); return page.evaluate(() => document.getElementById('assistModal').classList.contains('active')); });
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
        await step('mercato: Nuovo avviso non apre la finestra', async () => {
            await page.evaluate(() => window.setMarketView('alerts')); await page.waitForTimeout(300);
            await page.click('.mkt-new-alert'); await page.waitForTimeout(300);
            const on = await page.evaluate(() => document.getElementById('chartAlertModal').classList.contains('active') && document.querySelectorAll('#caCoins .pill-btn').length === 8);
            await page.evaluate(() => window.closeChartAlert());
            return on;
        });
        await page.evaluate(() => { window.switchTab('signals'); window.setSignalsView('agent'); });
        await page.waitForTimeout(800);
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

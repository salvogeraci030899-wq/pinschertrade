// --- Pagine sempre interamente visibili, senza scroll ---
// Per le pagine che non scorrono (overflow: hidden) controlla a ogni cambio di misura o di contenuto:
// 1) se la pagina scende sotto la parte di schermo visibile (in Safari mobile il contenitore può
//    essere più alto dell'area visibile), lo scarto diventa margine in fondo;
// 2) se il contenuto deborda ancora, i blocchi della pagina vengono rimpiccioliti con CSS zoom
//    quanto basta (mai sotto MIN_ZOOM); se nemmeno così entra, la pagina diventa scorrevole.
// I valori vanno in variabili CSS su <html> (non sulla pagina osservata), così non ci sono cicli.
// La pagina Rischio ha la sua logica in calculator.js, il Manuale in manual.js.

const PAGES = ['home', 'terminal', 'trade', 'journal', 'log', 'signals', 'account', 'settings'];
const MIN_ZOOM = 0.7;

const root = document.documentElement;
let scheduled = false;

function setVar(name, value) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
}

// Quanto la pagina scende oltre il limite visibile (minimo tra area visibile del browser e inizio
// della navbar). Calcolato dal layout, così l'animazione di apertura della tab non falsa la misura.
function overshoot(page) {
    const main = page.closest('main');
    if (!main) return 0;
    const pageBottom = main.getBoundingClientRect().top - main.scrollTop + page.offsetTop - main.offsetTop + page.offsetHeight;
    let limit = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const nav = document.querySelector('.nav-wrap');
    if (nav && nav.getClientRects().length > 0) limit = Math.min(limit, nav.getBoundingClientRect().top);
    return Math.max(0, Math.ceil(pageBottom - limit));
}

// La pagina non ci sta se scorre, o se un suo blocco diretto (visibile, non a scorrimento) ha contenuto che esce dal proprio riquadro:
// quel contenuto finirebbe nel margine in fondo (sulla barra), che lo scrollHeight della pagina non conta
const overflowing = page => page.scrollHeight > page.clientHeight + 1
    || [...page.children].some(c => c.scrollHeight > c.clientHeight + 1 && c.getClientRects().length && getComputedStyle(c).overflowY === 'visible');

// Liste a scorrimento orizzontale che si restringono per riempire lo spazio rimasto (min-height: 0):
// se una scheda non entra, il suo contenuto verrebbe tagliato senza che la pagina "deborda".
// Do alla lista l'altezza minima che serve alla scheda più alta; così, se lo spazio non basta,
// la pagina deborda e interviene lo zoom. #activeTradesList ha due righe di schede: conta doppio.
const SHRINKING_LISTS = '.log-list:not(#signalHistoryList), #activeTradesList';

function reserveListHeights(page) {
    const lists = [...page.querySelectorAll(SHRINKING_LISTS)];
    lists.forEach(l => { l.style.minHeight = ''; });
    for (const list of lists) {
        if (list.getClientRects().length === 0) continue;
        let deficit = 0;
        for (const item of list.children) deficit = Math.max(deficit, item.scrollHeight - item.clientHeight);
        if (deficit <= 1) continue;
        // righe di schede della lista (due, una sugli schermi bassi)
        const rows = list.id === 'activeTradesList' ? Math.max(1, getComputedStyle(list).gridTemplateRows.split(' ').filter(Boolean).length) : 1;
        list.style.minHeight = Math.ceil(list.clientHeight + deficit * rows) + 'px';
    }
}

// full = apertura della pagina o cambio di misura: si ricalcola da zero. Altrimenti (testi, prezzi, elenchi che cambiano) lo zoom
// attuale si tiene finché la pagina ci sta e al massimo si rimpicciolisce: non si ingrandisce mai da solo. Così, quando il contenuto è al
// limite dello spazio, una misura che oscilla di 1 px non fa più passare la pagina da zoom 1 a 0,97 a ogni aggiornamento del prezzo.
const ENLARGE_MIN = 0.04;      // anche in un ricalcolo completo, uno zoom già buono si ingrandisce solo se guadagna almeno il 4%

function fit(page, id, full = true) {
    const zoomVar = `--fit-zoom-${id}`;
    setVar(`--fit-extra-bottom-${id}`, overshoot(page) + 'px');
    const cur = parseFloat(root.style.getPropertyValue(zoomVar)) || 1;
    const fitsNow = root.style.getPropertyValue(`--fit-overflow-${id}`) !== 'auto' && !overflowing(page);
    if (fitsNow && (cur === 1 || !full)) { if (cur === 1) reserveListHeights(page); return; }
    setVar(zoomVar, '1');
    setVar(`--fit-overflow-${id}`, 'hidden');
    reserveListHeights(page);
    if (!overflowing(page)) {
        if (!full && cur < 1) { setVar(zoomVar, String(cur)); reserveListHeights(page); }      // cambio di contenuto: mai ingrandire da soli
        return;
    }

    // Lo zoom cambia la larghezza delle schede (e quindi dove va a capo il testo): l'altezza minima
    // delle liste si ricalcola a ogni passo
    let zoom = Math.max(MIN_ZOOM, Math.min(1, Math.floor((page.clientHeight / page.scrollHeight) * 100) / 100));
    setVar(zoomVar, String(zoom));
    reserveListHeights(page);
    while (overflowing(page) && zoom > MIN_ZOOM) {
        zoom = Math.max(MIN_ZOOM, Math.round((zoom - 0.02) * 100) / 100);
        setVar(zoomVar, String(zoom));
        reserveListHeights(page);
    }
    // Ultima risorsa: anche al minimo non entra (schermi molto bassi) -> la pagina scorre invece di tagliare
    if (overflowing(page)) setVar(`--fit-overflow-${id}`, 'auto');
    else if (!full && zoom > cur) { setVar(zoomVar, String(cur)); reserveListHeights(page); }
    // Lo zoom di prima andava già bene e il nuovo è di poco più grande: si tiene quello di prima
    else if (fitsNow && cur < 1 && zoom > cur && zoom - cur < ENLARGE_MIN) { setVar(zoomVar, String(cur)); reserveListHeights(page); }
}

function fitActive(full = true) {
    for (const id of PAGES) {
        const page = document.getElementById(`page-${id}`);
        if (page && page.classList.contains('active')) fit(page, id, full);
    }
}

// Cambi di misura e apertura pagina: subito (un fotogramma). Cambi di contenuto (testi e liste che si aggiornano ogni pochi
// secondi): al massimo una volta ogni 80 ms, e mai con l'app in background.
let lastRun = 0, timer = null, scrollUntil = 0, wantFull = false;
// Mentre un elenco a scorrimento di lato si muove (dito o inerzia) la pagina non si rimisura: azzerare lo zoom e rimetterlo
// sposta la posizione di scorrimento e lo interrompe (su iPhone rendeva impossibile scorrere i Segnali).
const moving = () => Date.now() < scrollUntil;
function schedule(urgent = true, full = true) {
    if (document.hidden) return;
    if (full) wantFull = true;
    if (!urgent) {
        if (timer) return;
        timer = setTimeout(() => { timer = null; schedule(true, false); }, Math.max(80 - (Date.now() - lastRun), moving() ? scrollUntil - Date.now() : 0, 0));
        return;
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; lastRun = Date.now(); const f = wantFull; wantFull = false; fitActive(f); });
}

// Puntini e contatori delle liste a scorrimento cambiano a ogni scheda: non sono contenuto che cambia la misura della pagina
const INDICATORS = '.info-dots, .nav-dots, .pager-count';
function relevant(m) {
    const el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
    if (el && el.closest && el.closest(INDICATORS)) return false;
    if (el && el.getClientRects && el.getClientRects().length === 0) return false;      // cambia qualcosa che non si vede (scheda nascosta): la misura non cambia
    return true;
}

export function initPageFit() {
    const touching = e => { const t = e.target; if (t && t.closest && t.closest('.signal-grid, #signalHistoryList, .mkt-pager, .auto-pages, .res-hlist, .ord-list, .agent-log')) scrollUntil = Date.now() + 700; };
    document.addEventListener('touchstart', touching, { passive: true, capture: true });
    document.addEventListener('touchmove', touching, { passive: true, capture: true });
    document.addEventListener('scroll', e => { const t = e.target; if (t && t !== document && t.scrollWidth > t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1) scrollUntil = Date.now() + 500; }, { passive: true, capture: true });

    for (const id of PAGES) {
        const page = document.getElementById(`page-${id}`);
        if (!page) continue;
        if ('ResizeObserver' in window) new ResizeObserver(() => schedule(true)).observe(page);
        // Contenuto che cambia (liste, griglie, testi, elementi mostrati/nascosti con una classe)
        new MutationObserver(muts => { if (muts.some(relevant)) schedule(false, false); }).observe(page, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }
    // Con la tastiera aperta (un campo di testo ha il focus) l'area visibile si accorcia: le pagine dietro non si rimisurano,
    // sennò si adattano a uno spazio che sparisce subito dopo. Alla chiusura della tastiera si ripristina lo scorrimento
    // (iOS sposta la pagina per mostrare il campo e può lasciare uno spazio vuoto) e si rimisura una volta sola.
    const typing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
    const onResize = () => { if (!typing()) schedule(true); };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    document.addEventListener('focusout', () => setTimeout(() => {
        if (typing()) return;
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
        const main = document.querySelector('main'); if (main) main.scrollTop = 0;
        schedule(true);
    }, 120));
    schedule(true);
}

export { schedule as refitPages };

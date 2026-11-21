// --- TEMA: chiaro, scuro o automatico (segue iOS) ---
// La preferenza resta su questo dispositivo (localStorage). Il primo frame lo imposta lo script in
// <head> di index.html; qui si gestiscono il cambio dalle Opzioni e il cambio di iOS mentre
// l'app è aperta. Chi deve ridisegnarsi (i grafici) ascolta l'evento "pt-theme".

const KEY = 'pt_theme';
const MODES = ['auto', 'light', 'dark'];
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

export function getThemePref() {
    try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'auto'; } catch (e) { return 'auto'; }
}

export function resolvedTheme(pref = getThemePref()) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'light' : 'dark';
}

export function applyTheme() {
    const theme = resolvedTheme();
    const root = document.documentElement;
    if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
    const meta = document.getElementById('metaThemeColor');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f2f7' : '#000000');
    const bar = document.getElementById('metaStatusBar');
    if (bar) bar.setAttribute('content', theme === 'light' ? 'default' : 'black-translucent');
    window.dispatchEvent(new CustomEvent('pt-theme', { detail: theme }));
    return theme;
}

export function setThemePref(pref) {
    if (!MODES.includes(pref)) return;
    try { localStorage.setItem(KEY, pref); } catch (e) {}
    applyTheme();
}

export function initTheme() {
    applyTheme();
    applyWall();
    if (media) {
        const onChange = () => { if (getThemePref() === 'auto') applyTheme(); };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }
}

// Colore di una variabile CSS del tema (per i grafici, che non leggono il CSS da soli)
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Vetro (stile Liquid Glass) su barra, tasti e schede: 'off' | 'on' (sfondo statico) | 'anim' (sfondo dinamico: luci che cambiano colore e posizione piano), spento all'inizio
const GLASS_KEY = 'pt_glass';
const GLASS = ['off', 'on', 'anim'];
export function getGlassPref() {
    try { const v = localStorage.getItem(GLASS_KEY); return GLASS.includes(v) ? v : 'off'; } catch (e) { return 'off'; }
}
export function setGlassPref(pref) {
    if (!GLASS.includes(pref)) pref = 'off';
    try { localStorage.setItem(GLASS_KEY, pref); } catch (e) {}
    document.documentElement.classList.toggle('glass', pref !== 'off');
    document.documentElement.classList.toggle('glass-anim', pref === 'anim');
    applyTheme();      // i grafici si ridipingono (sfondo trasparente col vetro)
    requestAnimationFrame(syncWalls);
}

// Colori sfondo (Opzioni → Aspetto): tre luci tenui, ognuna del colore scelto, su nero o bianco che restano predominanti.
// Ogni pallino cicla: colore di base della luce → colori → nessuna luce. Si salva anche il valore CSS, così il primo disegno (script nell'head) non lampeggia.
const WALL_KEY = 'pt_wall';
export const WALL_COLORS = [['base', 'Base', null], ['blu', 'Blu', 'rgb(10 132 255)'], ['verde', 'Verde', 'rgb(48 209 88)'], ['viola', 'Viola', 'rgb(191 90 242)'],
    ['rosa', 'Rosa', 'rgb(255 55 95)'], ['arancio', 'Arancio', 'rgb(255 159 10)'], ['ciano', 'Ciano', 'rgb(100 210 255)'], ['giallo', 'Giallo', 'rgb(255 214 10)'],
    ['rosso', 'Rosso', 'rgb(255 69 58)'], ['nessuno', 'Nessuna luce', 'transparent']];
export function getWallPref() {
    try {
        const v = JSON.parse(localStorage.getItem(WALL_KEY) || 'null');
        if (v && Array.isArray(v.ids) && v.ids.length === 3 && v.ids.every(id => WALL_COLORS.some(c => c[0] === id))) return v.ids;
    } catch (e) { /* senza memoria: colori di base */ }
    return ['base', 'base', 'base'];
}
export function applyWall(ids = getWallPref()) {
    const root = document.documentElement;
    ids.forEach((id, i) => {
        const css = (WALL_COLORS.find(c => c[0] === id) || [])[2];
        if (css) root.style.setProperty(`--wall-c${i + 1}`, css); else root.style.removeProperty(`--wall-c${i + 1}`);
    });
    root.classList.toggle('tint', ids.some(id => id !== 'base'));
}
export function cycleWallColor(i) {
    const ids = getWallPref();
    const at = WALL_COLORS.findIndex(c => c[0] === ids[i]);
    ids[i] = WALL_COLORS[(at + 1) % WALL_COLORS.length][0];
    try { localStorage.setItem(WALL_KEY, JSON.stringify({ ids, css: ids.map(id => (WALL_COLORS.find(c => c[0] === id) || [])[2] || null) })); } catch (e) { /* vale fino alla chiusura */ }
    applyWall(ids);
    return ids;
}

// Sfondo dinamico: ogni schermata intera (app, finestre, Assistente, blocco) ha le sue luci. Tutte agganciate allo
// stesso orologio della pagina, così aprendo una finestra le luci sono nello stesso punto (nessun salto).
// Una schermata che ricompare fa ripartire le sue animazioni: per questo si riallinea a ogni apertura.
export function syncWalls() {
    if (!document.documentElement.classList.contains('glass-anim')) return;
    document.querySelectorAll('.wall-anim i').forEach(i => {
        try { i.getAnimations().forEach(a => { a.startTime = 0; }); } catch (e) {}
    });
}
export function watchWalls() {
    const later = () => requestAnimationFrame(syncWalls);
    const mo = new MutationObserver(later);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    document.querySelectorAll('.modal-overlay, .lock-screen').forEach(el => mo.observe(el, { attributes: true, attributeFilter: ['class'] }));
    later();
}

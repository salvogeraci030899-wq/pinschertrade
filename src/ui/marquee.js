/* Testi che non entrano nella riga: scorrono da soli (da sinistra a destra e ritorno, con una pausa a ogni estremo).
   Se entrano restano fermi e allineati a destra, come prima. Vale per i valori delle righe della Home (.home-line > b).
   Con "riduci movimento" attivo non c'è animazione: si vede l'inizio del testo. */
const SELECTOR = '.home-line > b';
const SPEED = 30;           // px al secondo
const MIN_SECONDS = 6;

function layout(b) {
    let inner = b.querySelector(':scope > .mq-inner');
    if (!inner) {
        if (!b.firstChild) return;
        inner = document.createElement('span');
        inner.className = 'mq-inner';
        while (b.firstChild) inner.appendChild(b.firstChild);
        b.appendChild(inner);
    }
    const room = b.clientWidth;
    if (!room) return;                                   // pagina nascosta: si rimisura quando compare
    const shift = Math.ceil(inner.getBoundingClientRect().width / (b.getBoundingClientRect().width / room || 1)) - room;
    if (shift > 1) {
        const dur = Math.max(MIN_SECONDS, (2 * shift / SPEED) / 0.72);
        if (b.style.getPropertyValue('--mq-shift') !== String(shift)) b.style.setProperty('--mq-shift', String(shift));
        if (b.style.getPropertyValue('--mq-dur') !== dur.toFixed(1) + 's') b.style.setProperty('--mq-dur', dur.toFixed(1) + 's');
        b.classList.add('mq-on');
    } else if (b.classList.contains('mq-on')) {
        b.classList.remove('mq-on');
        b.style.removeProperty('--mq-shift');
        b.style.removeProperty('--mq-dur');
    }
}

export function initMarquee() {
    const page = document.getElementById('page-home');
    if (!page || !('MutationObserver' in window)) return;
    const pending = new Set();
    let raf = 0;
    const flush = () => { raf = 0; const list = [...pending]; pending.clear(); list.forEach(b => { if (b.isConnected) layout(b); }); };
    const queue = b => { pending.add(b); if (!raf) raf = requestAnimationFrame(flush); };
    const ro = 'ResizeObserver' in window ? new ResizeObserver(entries => entries.forEach(e => queue(e.target))) : null;
    const watch = b => { if (!b.dataset.mq) { b.dataset.mq = '1'; ro && ro.observe(b); } queue(b); };
    page.querySelectorAll(SELECTOR).forEach(watch);
    new MutationObserver(muts => {
        for (const m of muts) {
            const node = m.target.nodeType === 3 ? m.target.parentElement : m.target;
            const b = node && node.closest ? node.closest(SELECTOR) : null;
            if (b) queue(b);
            else if (node && node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(watch);
        }
    }).observe(page, { subtree: true, childList: true, characterData: true });
    window.addEventListener('resize', () => page.querySelectorAll(SELECTOR).forEach(queue));
}

export const refreshMarquee = () => { const page = document.getElementById('page-home'); if (page) page.querySelectorAll(SELECTOR).forEach(layout); };

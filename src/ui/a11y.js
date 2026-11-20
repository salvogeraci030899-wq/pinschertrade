/* Accessibilita' trasversale: ruoli, etichette, tastiera.
   Non cambia la logica: aggiunge solo attributi e inoltra Invio/Spazio al click.
   Lavora sui soli nodi nuovi, al massimo una volta ogni 400 ms, per non pesare sulla fluidita'. */
const NATIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);

function labelFor(el) {
    const t = (el.textContent || '').trim();
    if (t) return '';
    return el.getAttribute('title') || el.dataset.label || '';
}

function enhance(root) {
    if (!root || root.nodeType !== 1) return;
    const list = [root, ...root.querySelectorAll('[onclick], button, input, select, textarea, .modal-box, .modal-overlay, .nav-item, svg')];
    for (const el of list) {
        const tag = el.tagName;
        if (el.hasAttribute('onclick') && !NATIVE.has(tag) && !el.hasAttribute('role')) {
            el.setAttribute('role', 'button');
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        }
        if (tag === 'BUTTON' && !el.hasAttribute('aria-label')) {
            const l = labelFor(el);
            if (l) el.setAttribute('aria-label', l);
        }
        if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && !el.hasAttribute('aria-label') && !el.labels?.length) {
            const l = el.getAttribute('placeholder') || el.getAttribute('title') || el.closest('.input-group')?.querySelector('label')?.textContent?.trim();
            if (l) el.setAttribute('aria-label', l);
        }
        if (el.classList?.contains('modal-box')) { el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); }
        if (tag === 'svg' && !el.hasAttribute('aria-hidden') && !el.hasAttribute('aria-label')) el.setAttribute('aria-hidden', 'true');
    }
}

function syncNav() {
    document.querySelectorAll('.nav-item').forEach(n => {
        if (n.classList.contains('active')) n.setAttribute('aria-current', 'page');
        else n.removeAttribute('aria-current');
    });
}

export function initA11y() {
    enhance(document.body);
    syncNav();
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target;
        if (el && el.getAttribute && el.getAttribute('role') === 'button' && !NATIVE.has(el.tagName)) {
            e.preventDefault();
            el.click();
        }
    });
    let pending = new Set();
    let timer = 0;
    const flush = () => {
        timer = 0;
        const nodes = pending; pending = new Set();
        nodes.forEach(n => { if (n.isConnected) enhance(n); });
        syncNav();
    };
    new MutationObserver(muts => {
        for (const m of muts) m.addedNodes.forEach(n => { if (n.nodeType === 1) pending.add(n); });
        if (m_hasWork(muts) && !timer) timer = setTimeout(flush, 400);
    }).observe(document.body, { childList: true, subtree: true });
    const nav = document.querySelector('.nav-bar');
    if (nav) new MutationObserver(syncNav).observe(nav, { attributes: true, subtree: true, attributeFilter: ['class'] });
}

function m_hasWork(muts) { return muts.some(m => m.addedNodes.length); }

/* Icona dell'app in alto a sinistra di ogni titolo (pagine e finestre a schermo intero).
   Un tocco su un titolo la mostra o la nasconde in tutte le schermate insieme; i titoli si spostano di conseguenza.
   La scelta resta sul telefono (pt_title_icon). La classe html.title-icon-off viene messa subito dallo script nell'<head>. */
const KEY = 'pt_title_icon';        // '1' mostrata (predefinito), '0' nascosta

function enhance(root = document) {
    root.querySelectorAll('.header-title:not([data-ti])').forEach(t => {
        t.dataset.ti = '1';
        const text = document.createElement('div');
        text.className = 'title-text';
        while (t.firstChild) text.appendChild(t.firstChild);
        const icon = document.createElement('span');
        icon.className = 'title-icon';
        icon.setAttribute('aria-hidden', 'true');
        t.append(icon, text);
        t.setAttribute('role', 'button');
        t.setAttribute('tabindex', '0');
        t.setAttribute('aria-label', 'Mostra o nascondi l\'icona');
    });
}

export function isTitleIconOn() { return !document.documentElement.classList.contains('title-icon-off'); }

export function setTitleIcon(on) {
    document.documentElement.classList.toggle('title-icon-off', !on);
    document.querySelectorAll('.header-title').forEach(t => t.setAttribute('aria-pressed', on ? 'true' : 'false'));
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* senza memoria: vale fino alla chiusura */ }
}

export function initTitleIcon() {
    enhance();
    setTitleIcon(isTitleIconOn());
    document.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('.header-title')) setTitleIcon(!isTitleIconOn());
    });
}

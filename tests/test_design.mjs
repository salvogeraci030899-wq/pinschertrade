// Guardia del design system e dei testi (nessun browser): fallisce se si reintroducono valori sciolti,
// stili inline, termini fuori glossario o contrasti sotto AA. Regole in DESIGN.md.
import { readFileSync, readdirSync } from 'node:fs';

const css = readFileSync('style.css', 'utf8');
const tokens = readFileSync('tokens.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
const jsFiles = ['src/main.js', ...readdirSync('src/ui').map(f => 'src/ui/' + f), ...readdirSync('src/core').map(f => 'src/core/' + f)]
    .filter(f => f.endsWith('.js'));
const problems = [];
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// ---------- 1. style.css: niente valori sciolti ----------
for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) problems.push(`style.css:${lineOf(css, m.index)} font-size sciolto (${m[0]}): usa --fs-*`);
for (const m of css.matchAll(/z-index:\s*(\d+)/g)) problems.push(`style.css:${lineOf(css, m.index)} z-index sciolto (${m[0]}): usa --z-*`);
for (const m of css.matchAll(/(^|[\s;{])(#[0-9a-fA-F]{3,8})\b/g)) {
    const l = lineOf(css, m.index);
    const line = css.split('\n')[l - 1];
    if (/mask-image|gradient/.test(line)) continue;                     // maschere: nero/trasparente tecnici
    problems.push(`style.css:${l} colore sciolto ${m[2]}: usa un token`);
}
for (const m of css.matchAll(/border-radius:\s*([^;{}]+)/g)) {
    const v = m[1];
    if (/(^|[\s(])\d+px\b/.test(v) && !/calc\(|var\(/.test(v)) problems.push(`style.css:${lineOf(css, m.index)} raggio sciolto (${v.trim()}): usa --r-*`);
}
// spaziature: ammessi 0, 1px (bordi), valori negativi, calc/env, 40+ (misure di layout)
for (const m of css.matchAll(/(?:^|[;{\s])((?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?):\s*([^;{}]+)/g)) {
    const v = m[2];
    if (/calc\(|env\(/.test(v)) continue;
    for (const n of v.matchAll(/(^|[\s(,])(-?)(\d+)px\b/g)) {
        if (n[2] === '-') continue;
        const px = Number(n[3]);
        if (px === 0 || px === 1) continue;
        if (px === 56 || px === 82) continue;                              // misure fisse della barra e del blocco
        problems.push(`style.css:${lineOf(css, m.index)} ${m[1]} ${px}px sciolto: usa --sp-*`);
    }
}

// ---------- 2. index.html: niente stili inline (tranne display alternato dal codice) ----------
for (const m of html.matchAll(/\sstyle="([^"]*)"/g)) {
    if (!/^\s*display:\s*(none|flex|block)\s*;?\s*$/.test(m[1])) problems.push(`index.html:${lineOf(html, m.index)} stile inline: ${m[1].slice(0, 60)}`);
}

// ---------- 3. testi: glossario e maiuscole ----------
const visible = [...html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').matchAll(/>([^<>]{2,})</g)].map(m => m[1].trim()).filter(Boolean);
const attrs = [...html.matchAll(/(?:title|placeholder|aria-label|data-sub)="([^"]+)"/g)].map(m => m[1]);
const BANNED = [
    [/\bPanoramica\b/, 'usa «Stato»'], [/\bDashboard\b/, 'usa «Home»'], [/\bsimulat[aoie]\b/, 'usa «Simulato» (modalità) o «su carta»'],
    [/\bsimulazione\b/i, 'usa «Simulato» o «test»'], [/\bpaper\b/i, 'usa «carta»'], [/\bP&amp;L\b|\bP&L\b/, 'usa «PnL»'], [/\bKronos\b/i, 'rimosso'],
];
// eccezioni: frasi del Manuale che citano il termine come concetto (nessuna al momento)
const SENT = /^[A-ZÀ-Ý][a-zà-ÿ]+(?: (?:[A-ZÀ-Ý][a-zà-ÿ]+|&amp;|e|di|del|della|dei|da|il|la))+$/;
const PROPER = /Bitget|Telegram|PinscherTrade|Simulato|Reale|Cloudflare|GitHub|Face ID|Liquid|Take Profit|Stop|Win Rate|Open|Funding|Long|Short/;
for (const t of [...visible, ...attrs]) {
    for (const [re, hint] of BANNED) if (re.test(t)) problems.push(`testo «${t.slice(0, 70)}»: ${hint}`);
    if (SENT.test(t) && t.split(' ').length <= 4 && !PROPER.test(t)) problems.push(`testo «${t}»: maiuscola solo sulla prima parola`);
}
for (const f of jsFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\\\n]){6,})\1/g)) {
        const s = m[2];
        if (/[a-z]{3,}\s+[a-z]{2,}/i.test(s) && /\bPanoramica\b|\bDashboard\b|\bsimulazione\b/.test(s) && !/^\s*\/\//.test(s)) {
            if (/commands\.js/.test(f)) continue;                            // prompt interni del modello
            problems.push(`${f}:${lineOf(src, m.index)} testo fuori glossario: ${s.slice(0, 70)}`);
        }
    }
}

// ---------- 4. contrasto WCAG AA dei token di testo ----------
const lum = hex => {
    const h = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const block = (re) => { const m = tokens.match(re); return m ? Object.fromEntries([...m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map(x => [x[1], x[2]])) : {}; };
const themes = { scuro: block(/:root\s*\{\s*color-scheme: dark;([\s\S]*?)\n\}/), chiaro: block(/html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/) };
for (const [name, t] of Object.entries(themes)) {
    if (!t.bg) { problems.push(`tokens.css: tema ${name} non letto`); continue; }
    for (const k of ['text', 'text-secondary', 'text-muted', 'accent', 'danger', 'warning', 'ui']) {
        for (const bgk of ['bg', 'surface']) {
            const r = ratio(t[k], t[bgk]);
            if (r < 4.5) problems.push(`contrasto tema ${name}: --${k} su --${bgk} = ${r.toFixed(2)} (< 4,5)`);
        }
    }
}

if (problems.length) {
    console.error(problems.length + ' PROBLEMI di design/testi:\n- ' + problems.join('\n- '));
    process.exit(1);
}
console.log('ok design system: token, stili inline, glossario, maiuscole e contrasti');

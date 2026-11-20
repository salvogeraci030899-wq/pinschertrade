# Design system PinscherTrade

Unica fonte dei valori: `tokens.css`. Negli stili dei componenti (`style.css`, classi in `index.html` e nei moduli) non si scrivono px, colori o durate sciolti: si usano i token.

## Token

| Famiglia | Token | Uso |
|---|---|---|
| Colori di base | `--bg`, `--surface`, `--surface-2`, `--surface-hover`, `--border`, `--field` | sfondo, schede, riga attiva, bordi, campi |
| Testo | `--text`, `--text-secondary`, `--text-muted`, `--text-soft` | primario, secondario, etichette, testo lungo |
| Stato | `--accent` (positivo), `--danger`, `--warning`, `--ui`/`--blue` (selezione) | esito, rischio, attenzione, interfaccia |
| Stato morbido | `--accent-soft`, `--danger-soft`, `--warning-soft`, `--danger-line` | fondi e bordi di badge e avvisi |
| Testo sul colore | `--on-accent`, `--on-ui`, `--on-warning` | testo sopra tasti colorati |
| Tipografia | `--fs-xs` 10, `--fs-sm` 11, `--fs-md` 12, `--fs-base` 14, `--fs-lg` 16, `--fs-xl` 20, `--fs-hero` 28 | scala unica |
| Peso | `--fw-regular` 400, `--fw-medium` 600, `--fw-bold` 700, `--fw-black` 800 | |
| Spaziature | `--sp-1` 2, `--sp-2` 4, `--sp-3` 8, `--sp-4` 12, `--sp-5` 16, `--sp-6` 24, `--sp-7` 32 | padding, margin, gap |
| Raggi | `--r-xs` 4, `--r-sm` 8, `--r-md` 12, `--r-lg` 16, `--r-xl` 20, `--r-pill` | alias storici: `--r-card`, `--r-card-sm`, `--r-item`, `--r-ctl`, `--r-ctl-sm` |
| Livelli | `--z-raise` 10, `--z-fullscreen` 3000, `--z-modal` 9999, `--z-lock` 10000 | z-index |
| Movimento | `--dur-fast` 0.15s, `--dur` 0.2s, `--ease` | transizioni (solo trasformazioni e opacita) |
| Tocco | `--touch-min` 44px | altezza minima dei controlli |
| Focus | `--focus-ring` | anello da tastiera su tutti gli interattivi |

Tema chiaro e scuro ridefiniscono solo i colori. Il vetro (`html.glass`) ridefinisce `--surface*` in trasparenza: gli stili non cambiano.

## Componenti e varianti

| Componente | Classi | Varianti | Stati |
|---|---|---|---|
| Tasto | `.pill-btn` (scelta), `.btn-generic` (azione a larghezza piena), `.btn-confirm`/`.btn-cancel` (finestre), `.btn-cta-primary` (azione primaria), `.btn-calc`, `.home-tf-btn` (intervallo), `.header-icon-btn` (icona) | `.btn-blue`, `.btn-danger`, `.btn-neutral`, `.btn-outline`; `.active` per la selezione | active (scala 0.97), disabled (opacita 0.4), loading (`aria-busy="true"`), focus-visible |
| Campo | `.input-group input/select`, `.text-field` | `.mb` | focus-visible, disabled |
| Scheda | `.home-card`, `.home-tile`, `.signal-cell`, `.settings-item` | `.clickable` | active, focus-visible |
| Finestra | `.modal-overlay` + `.modal-box` | `.modal-narrow`, `.modal-head` | `role="dialog"` assegnato da `a11y.js` |
| Testo | `.field-label`, `.field-title`, `.field-note`, `.prose` | `.xs`, `.lg`, `.prose-scroll` | |
| Utilita | `.u-center`, `.u-mt-*`, `.u-mb-0`, `.u-divider-top`, `.stack` | | |

Gli stati vuoto ed errore dei dati restano testi inline nei pannelli (non sono tasti): stesso `--text-secondary`, `--fs-md`.

## Griglia e punti di adattamento

- Margine laterale pagina `--page-gutter` 16; blocchi separati da `--sp-3` o `--sp-4`.
- L'app e' solo mobile (iPhone). Tre classi di schermo gestite: SE (altezza <= 620 e <= 700), standard, Pro (oltre 780). Sotto l'altezza utile `page-fit.js` riduce lo zoom dei blocchi.
- Area di tocco: ogni controllo ha almeno 44 px di superficie attiva; quelli piccoli la estendono con `::after`.

## Accessibilita'

- `src/ui/a11y.js` aggiunge `role="button"` e `tabindex` agli elementi con `onclick` non nativi, Invio/Spazio come click, `aria-label` dai `title`, `aria-current="page"` sulla barra, `role="dialog"` sulle finestre, `aria-hidden` sulle icone decorative.
- Contrasti verificati (script nel PR): testi >= 4.5:1 in entrambi i temi. Eccezione dichiarata: testo bianco su `--ui` nel tema scuro e' 3.65:1; vale solo per tasti in grassetto >= 14 px (testo grande, soglia 3:1).

## Regole per chi aggiunge codice

1. Niente valori sciolti: se serve un valore nuovo, si aggiunge a `tokens.css` e a questa tabella.
2. Niente stili inline, tranne `display` alternato dal codice.
3. Un tasto nuovo usa una famiglia esistente; niente nuove famiglie.
4. Versione: eseguire `python3 tools/bump_version.py` a ogni rilascio dell'interfaccia.

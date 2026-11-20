# PinscherTrade

> **2026-11-20: Kronos è stato tolto.** Il registro delle sue previsioni (789 chiuse) dava la direzione giusta il 37,7% delle volte, quasi come il caso, con un errore di calibrazione peggiore di una previsione costante. Via il modello e le sue dipendenze (torch, pesi), via previsioni, segnali NUOVO SEGNALE, track record, validazione storica e backtest del modello; il giro ogni 15 minuti dura pochi secondi. Restano carta, esecutore, agente eventi, laboratorio e le strategie tecniche. I moduli comuni sono `market_data.py` (coin, costi, candele e storico Bitget) e `stats_util.py` (intervalli di confidenza e simulazione di un piano).


App personale di trading (sulla schermata Home: «Pinscher») su 8 crypto (BTC, ETH, SOL, XRP, DOGE, BNB, ADA, LINK; Bitget, futures e spot) con un bot che lavora da solo su GitHub Actions.
Non è un consiglio finanziario: nessuna strategia ha un vantaggio garantito.

## Com'è fatta

| Parte | Dove | Cosa fa |
| --- | --- | --- |
| App (PWA) | `index.html`, `style.css`, `src/` (GitHub Pages) | Home, Mercato, Trade, Posizioni, Agente, Risultati, Registro, Opzioni, Assistente |
| Bot | `*.py`, `.github/workflows/` (GitHub Actions) | segnali, prova su carta, esecutore, agente, avvisi, controlli |
| Server | `worker/` + `api/_core.js` (Cloudflare Workers) | orologio del bot (ogni 15 min), comandi dall'app, IA (Groq), bot Telegram |
| Dati | file `.json`/`.jsonl` nel repository | stato del bot letto dall'app; quelli personali sono **cifrati** |

Moduli principali del bot: `run_bot.py` (giro completo), `quick.py` (controllo rapido ogni 5 min), `paper.py` (carta),
`executor.py` (ordini reali e storico del conto), `agent.py` (agente giornaliero), `automation.py` / `position_cmd.py`
(comandi dall'app), `strategy_lab.py` + `lab_strategies.py` (laboratorio), `events.py` (registro), `watchdog.py` (salute).

## La carta si comporta come il reale

Con gli ordini simulati (stato di partenza) l'esecutore segue **anche le strategie su carta** (`risk.shadow_paper`, acceso di
default): applica gli stessi limiti del reale (rischio per trade, leva, esposizione totale, posizioni massime, massimo nello stesso verso,
una posizione per coin, perdita e obiettivo del giorno, pausa dell'agente eventi), la stessa dimensione e le stesse commissioni
(0,11% per lato). Il conto simulato è vero: cassa, commissioni, guadagno realizzato e non realizzato ai prezzi Bitget. «Bot su carta» in
Posizioni e «Carta» in Risultati mostrano quel conto; i segnali che il reale non aprirebbe compaiono come «non aperti» con il motivo.
Il passaggio al reale cambia solo il client (chiavi Bitget, interruttore acceso, strategia confermata): decisioni e dimensioni sono le stesse.

**Ripartire da zero:** cambia il testo in `reset_epoch.json` (file in chiaro). Al giro successivo il registro della prova su carta e il conto
simulato ricominciano da capo, senza toccare mai posizioni vere. I file cifrati non si riscrivono a mano.

## Dati cifrati

Il repository è pubblico. I file personali (elencati in `.gitattributes`) sono cifrati con AES-256-GCM da un filtro git
(`tools/datacrypt.py`), configurato in ogni workflow dal passo `.github/actions/data-key`. Nei workflow il bot li vede in
chiaro; l'app e il server li decifrano con la stessa chiave (`src/core/datacrypt.js`). La chiave è il segreto `DATA_KEY`
e, sul telefono, Opzioni → Connessioni. **Non cambiarla**: i file cifrati con la vecchia chiave non si aprirebbero più.

## Segreti (GitHub → Settings → Secrets and variables → Actions)

| Nome | Serve a |
| --- | --- |
| `DATA_KEY` | cifratura dei dati personali |
| `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE` | conto Bitget (lettura e, se acceso dall'app, ordini) |
| `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` | messaggi e bot Telegram |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SERVER_GH_TOKEN` | pubblicazione del server Cloudflare |
| `APP_SECRET` | chiave dei comandi inviati al server |
| `GROQ_API_KEY` | analisi AI, assistente, voce |

Variabile: `BITGET_DEMO` (`1` = conto demo, predefinito).
Nessun file `.env`: tutto passa dai segreti di GitHub e del worker. Ordini veri solo con le chiavi Bitget, l'interruttore
Reale acceso nell'app e una strategia confermata dalla prova finale.

## Controlli

```bash
pip install "pandas>=2.2.2" numpy requests cryptography ruff
ruff check .                                  # lint Python
npx --yes eslint@10.14.0 .                    # lint JavaScript
for t in tests/test_*.py; do python3 "$t"; done
node tests/test_core.mjs && node tests/test_rules.mjs && node tests/test_lab_engine.mjs
node tests/ui_smoke.mjs                       # interfaccia in Chromium (Playwright)
```

Gli stessi controlli girano su GitHub a ogni modifica (`.github/workflows/tests.yml`).

## Versione

`python3 tools/bump_version.py` aggiorna il numero di versione e la mappa dei moduli in `index.html` (serve a ogni
modifica dell'app, così il telefono scarica i file nuovi).

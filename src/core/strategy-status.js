// Stato di una strategia, ricavato dai dati del laboratorio: stessa regola nell'app e nei messaggi Telegram.
//   confermata    ha superato la prova finale
//   bocciata      ha fatto la prova finale e non l'ha superata (non può più andare al reale)
//   candidata     migliore del mercato dopo i costi, in attesa della prova finale
//   osservazione  nel laboratorio ma non candidata: sta su carta per raccogliere dati, qualunque sia chi l'ha messa
//   senza_storico non ha dati nel laboratorio
export const STATUS_LABEL = {
    confermata: 'confermata', candidata: 'candidata', osservazione: 'in osservazione', bocciata: 'bocciata', senza_storico: 'senza storico'
};
export const STATUS_ORDER = ['confermata', 'candidata', 'osservazione', 'bocciata', 'senza_storico'];

export function strategyStatus(key, lab) {
    const r = lab && lab.results && lab.results[key];
    if (lab && (lab.confirmed || []).includes(key)) return 'confermata';
    if (r && r.holdout) return r.holdout.confirmed ? 'confermata' : 'bocciata';
    if (lab && (lab.candidates || []).includes(key)) return 'candidata';
    return r ? 'osservazione' : 'senza_storico';
}

// "3 in osservazione · 1 bocciata": solo gli stati presenti, nell'ordine fisso
export function statusSummary(keys, lab) {
    const c = {};
    for (const k of keys) { const s = strategyStatus(k, lab); c[s] = (c[s] || 0) + 1; }
    return STATUS_ORDER.filter(s => c[s]).map(s => {
        const n = c[s];
        const txt = s === 'osservazione' ? 'in osservazione' : s === 'senza_storico' ? 'senza storico' : n === 1 ? s : s.replace(/a$/, 'e');
        return `${n} ${txt}`;
    }).join(' · ');
}

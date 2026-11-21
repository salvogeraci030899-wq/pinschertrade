// Stato di una strategia, ricavato dai dati del laboratorio: stessa regola nell'app e nei messaggi Telegram.
//   confermata    ha superato la prova finale
//   bocciata      ha fatto la prova finale e non l'ha superata (non può più andare al reale)
//   candidata     migliore del mercato dopo i costi, in attesa della prova finale
//   vicina        non candidata per poco: p-value dell'eccesso sul mercato fino a 0,10 (stessa regola di automation.is_near_candidate)
//   osservazione  nel laboratorio ma non candidata: sta su carta per raccogliere dati, qualunque sia chi l'ha messa
//   senza_storico non ha dati nel laboratorio
export const STATUS_LABEL = {
    confermata: 'confermata', candidata: 'candidata', vicina: 'quasi candidata', osservazione: 'in osservazione', bocciata: 'bocciata', senza_storico: 'senza storico'
};
export const STATUS_ORDER = ['confermata', 'candidata', 'vicina', 'osservazione', 'bocciata', 'senza_storico'];
export const NEAR_P = 0.10;       // stesso valore di automation.NEAR_P

// Non candidata per poco (regola di automation.is_near_candidate)
export function isNearCandidate(r) {
    return !!r && r.family !== 'forza relativa' && r.family !== 'funding' && !r.candidate && !r.holdout && (r.n || 0) >= 50
        && (r.excess_avg_pct || 0) > 0 && !!r.stable && r.excess_p != null && r.excess_p <= NEAR_P;
}

export function strategyStatus(key, lab) {
    const r = lab && lab.results && lab.results[key];
    if (lab && (lab.confirmed || []).includes(key)) return 'confermata';
    if (r && r.holdout) return r.holdout.confirmed ? 'confermata' : 'bocciata';
    if (lab && (lab.candidates || []).includes(key)) return 'candidata';
    if (r && isNearCandidate(r)) return 'vicina';
    return r ? 'osservazione' : 'senza_storico';
}

// "3 in osservazione · 1 bocciata": solo gli stati presenti, nell'ordine fisso
export function statusSummary(keys, lab) {
    const c = {};
    for (const k of keys) { const s = strategyStatus(k, lab); c[s] = (c[s] || 0) + 1; }
    return STATUS_ORDER.filter(s => c[s]).map(s => {
        const n = c[s];
        const txt = s === 'osservazione' ? 'in osservazione' : s === 'senza_storico' ? 'senza storico' : s === 'vicina' ? (n === 1 ? 'quasi candidata' : 'quasi candidate') : n === 1 ? s : s.replace(/a$/, 'e');
        return `${n} ${txt}`;
    }).join(' · ');
}

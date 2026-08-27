// dataLoader.js
//
// The ONLY place in the entire frontend allowed to know where data comes
// from. Calls our own /api/transactions JSON endpoint (which currently
// reads CSV behind the scenes; later, Neo4j). Returns rows in the SAME
// column-name shape as the raw CSV (transaction_hash, output_value_BTC,
// output_address, transaction_inputs, total_input_value_BTC,
// input_addresses, source_file) with `time` already parsed into a Date.
//
// Different views rename these fields to whatever they need internally
// (exactly like they already did with their own d3.csv row parsers) —
// this loader just guarantees everyone gets the same raw material.

function _parseApiTime(timeStr) {
    timeStr = timeStr ? String(timeStr).trim() : "";
    if (!timeStr) return new Date(NaN);

    let iso = timeStr.includes(" ") ? timeStr.replace(" ", "T") : timeStr;

    // Don't add "Z" if the string already carries a timezone (Z, or a
    // +HH:MM/-HH:MM offset like "+00:00") — adding a second one produces
    // an invalid, unparseable string. This was the actual bug.
    const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(iso);
    if (!hasTimezone) {
        iso += iso.includes("T") ? "Z" : "T00:00:00Z";
    }

    let parsed = new Date(iso);
    if (isNaN(parsed.getTime())) parsed = new Date(timeStr); // fallback: let JS try the raw string as-is
    return parsed;
}

async function loadTransactions(filterParams = {}) {
    const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filterParams)
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    return (data.rows || [])
        .map(d => ({ ...d, time: _parseApiTime(d.time) }))
        .filter(d => !isNaN(d.time.getTime()));
}

window.loadTransactions = loadTransactions;

// ── "Last applied filters" bridge ──────────────────────────────────
// Export CSV still writes bitcoin_filtered.csv to disk (unchanged). But
// Matrix View and ExplorativeFlow no longer read that file — instead they
// ask the backend for the SAME filter values as JSON. This is how they
// stay "showing the last-filtered set" without a file round-trip.
function saveLastFilterParams(params) {
    sessionStorage.setItem('lastFilterParams', JSON.stringify(params));
}
function getLastFilterParams() {
    const raw = sessionStorage.getItem('lastFilterParams');
    return raw ? JSON.parse(raw) : null;
}
window.saveLastFilterParams = saveLastFilterParams;
window.getLastFilterParams = getLastFilterParams;
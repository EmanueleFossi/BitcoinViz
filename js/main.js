let currentType = 'scatter'; 
let chartInstance = null; 
let filterManager = null; 
let globalSpentSet = new Set(); 

// ─── Costante globale giorni (da Doc 1) ───────────────────
const ALL_DAYS = [
    { label: "24 May", file: "Bitcoin_Data_2024_05_24.csv" },
    { label: "25 May", file: "Bitcoin_Data_2024_05_25.csv" },
    { label: "26 May", file: "Bitcoin_Data_2024_05_26.csv" },
    { label: "27 May", file: "Bitcoin_Data_2024_05_27.csv" },
    { label: "28 May", file: "Bitcoin_Data_2024_05_28.csv" },
    { label: "29 May", file: "Bitcoin_Data_2024_05_29.csv" },
    { label: "30 May", file: "Bitcoin_Data_2024_05_30.csv" },
    { label: "31 May", file: "Bitcoin_Data_2024_05_31.csv" },
    { label: "01 June", file: "Bitcoin_Data_2024_06_01.csv" },
    { label: "02 June", file: "Bitcoin_Data_2024_06_02.csv" },
    { label: "03 June", file: "Bitcoin_Data_2024_06_03.csv" },
    { label: "04 June", file: "Bitcoin_Data_2024_06_04.csv" },
    { label: "05 June", file: "Bitcoin_Data_2024_06_05.csv" }
];

// ─── Parser riga CSV (da Doc 1, estratto come funzione separata) ───
function parseRow(d) {
    return {
        ...d,
        time: d3.timeParse("%Y-%m-%d %H:%M:%S%Z")(d.time) || new Date(d.time),
        output_value_BTC: +d.output_value_BTC || 0,
        transaction_inputs: +d.transaction_inputs || 1
    };
}
function setViewChrome(view) {
    const isCluster = view === 'cluster';

    // Day dropdown removed from UI — Bubble Chart view is gone, so there's
    // no reason to expose day-switching to the user anymore. The dropdown
    // element still exists (hidden) and still auto-loads the default day
    // in the background, since FilterManager needs that data to compute
    // the live TX-count preview and input/output ranges.
    const daySection = document.getElementById('sb-day-section');
    if (daySection) daySection.style.display = 'none';

    const footer = document.querySelector('.sb-footer');
    if (footer) footer.style.display = isCluster ? '' : 'none';

    document.querySelectorAll('.viz-chip').forEach(el => {
        el.style.display = 'none';
    });
}


// ─── Init app ─────────────────────────────────────────────
// Usa data_cleaned/ come path (Doc 2), coerente con loadDataAndDraw
async function initApp() {
    const chartArea = d3.select("#chart-area");
    chartArea.html("<p class='loading-text'>Loading global index...</p>");

    try {
        const spentData = await d3.csv("data_cleaned/unique_spent_addresses.csv");
        globalSpentSet = new Set(spentData.map(d => d.address));
               chartArea.selectAll("*").remove();
        initScatterFilters();

        // If filters were already applied in this session, redraw the flow chart
        if (getLastFilterParams()) {
            initExplorativeFlow();
        } else {
            showLandingPlaceholder();
        }
    } catch (err) {
        console.error("Critical Error:", err);
        chartArea.html(`
            <div style="color:red;padding:20px;border:1px solid red;">
                <h3>Initialization Error</h3>
                <p>File not found <b>data/unique_spent_addresses.csv</b>.</p>
            </div>
        `);
    }
}

// ─── Load data & draw ─────────────────────────────────────
async function loadDataAndDraw(fileName) {
    console.log(`Loading: ${fileName}`);

const filterContainer = d3.select("#backend-filters-container");
    chartInstance = null;

    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();

    const loadingMsg = chartArea.append("p")
        .attr("class", "loading-text")
        .text(`Analyzing ${fileName}...`);

    try {
    const cleanData = await loadTransactions({ day: fileName });
    loadingMsg.remove();
    if (cleanData.length === 0) throw new Error("Not found or empty data");
       

               if (currentType === 'scatter') {
            filterContainer.selectAll("*").remove();

            // Bubble Chart view removed. FilterManager still runs — it computes
            // the live TX-count preview as the user adjusts filters — it just no
            // longer feeds a chart on this screen. Old chart/drill-down wiring
            // kept below, commented, in case a live preview chart comes back.
            filterManager = new FilterManager(cleanData, (filteredData) => {
                updateTxCount(filteredData.length);

                // if (chartInstance && chartInstance.isDrilledDown && chartInstance.currentCluster) {
                //     const filteredChildren = chartInstance.currentCluster.children.filter(child =>
                //         filteredData.some(fd => fd.transaction_hash === child.transaction_hash)
                //     );
                //     chartInstance.rawData = filteredData;
                //     chartInstance.displayData = filteredChildren.length > 0
                //         ? filteredChildren
                //         : chartInstance.currentCluster.children;
                //     chartInstance.setupScales();
                //     chartInstance.updateZoomTranslateExtent();
                //     chartInstance.updateElements(chartInstance.xScale, chartInstance.yScale);
                // } else {
                //     chartInstance = new ChartDotPlot("#chart-area", filteredData);
                // }
            }, filterContainer);

            filterManager.triggerUpdate();
            showLandingPlaceholder();
        }

    } catch (err) {
        console.error("❌ Error:", err);
        d3.select("#chart-area").html(`
            <div style="color:red;padding:20px;border:1px solid red;">
                <b>Error loading ${fileName}</b><br>${err.message}
            </div>
        `);
    }
}

// ─── Export CSV via Flask (da Doc 1) ──────────────────────
async function exportAllDaysCSV() {
    if (!filterManager) {
        alert("Load a day first to set the filters.");
        return;
    }

    const exportBtn = document.getElementById('export-csv-btn');
    const originalLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting...";
try {
    const params = filterManager.getFilterParams();
    const bodyObj = {
        startDate:           params.startDate,
        endDate:             params.endDate,
        minSingleOutput:     params.minSingleOutput,
        maxSingleOutput:     params.maxSingleOutput,
        minMinOutput:        params.minMinOutput,
        maxMinOutput:        params.maxMinOutput,
        minInputs:           params.filterState.minInputs,
        maxInputs:           params.filterState.maxInputs,
        minOutputs:          params.filterState.minOutputs,
        maxOutputs:          params.filterState.maxOutputs,
        onlySpentInPeriod:   params.onlySpentInPeriod,
    };
    saveLastFilterParams(bodyObj);   // NEW — remembers filters for Matrix/ExplorativeFlow

    const response = await fetch("http://localhost:5501/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj)
    });

        const result = await response.json();

        if (!response.ok || result.error) {
            alert(`Error exporting: ${result.error}`);
            return;
        }

        alert(
            `Export completed!\n\n` +
            `File: ${result.file}\n` +
            `Transactions: ${result.tx_count.toLocaleString('it-IT')}\n` +
            `Total rows: ${result.rows.toLocaleString('it-IT')}\n\n` +
            `Saved in: data_cleaned/${result.file}`
        );

        console.log(`[Export] Saved: data_cleaned/${result.file} — ${result.tx_count} TX, ${result.rows} rows`);
initExplorativeFlow(); 
    } catch (err) {
        console.error("[Export] Errore:", err);
        alert(`Errore di connessione al server.\nAssicurati che server.py sia in esecuzione.\n\n${err.message}`);
    } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = originalLabel;
    }
}

// ─── Header helpers ───────────────────────────────────────
function updateHeaderBadge(label) {
    const badge = document.getElementById('header-badge');
    if (!badge) return;
    if (label) {
        badge.textContent = label + ' · 2024';
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

function updateTxCount(n) {
    const el = document.getElementById('tx-count-val');
    if (el) el.textContent = n != null ? n.toLocaleString('it-IT') : '—';
    const header = document.getElementById('header-tx-count');
    if (header && n != null) header.textContent = n.toLocaleString('en-US') + ' TX loaded';
}
/*function showLandingPlaceholder() {
    d3.select("#chart-area").html(`
        <div class="landing-placeholder">
            <div class="landing-title">₿ BitVas</div>
            <p class="landing-sub">Set your filters on the left, then pick a view above to explore the data.</p>
        </div>
    `);
}*/
function showLandingPlaceholder() {
    d3.select("#chart-area").html(`
        <div class="landing-placeholder-simple">
            <p>Set your filters on the left, then click <b>Apply & Visualize</b>.</p>
        </div>
    `);
}
function initScatterFilters() {
    chartInstance = null;
    cleanupExplorativeUI();

    const filterContainer = d3.select("#backend-filters-container");
    filterContainer.selectAll("*").remove();

    filterManager = new FilterManager([], () => {}, filterContainer);

    // Restore the last applied filters into the form (survives page refresh)
    const saved = getLastFilterParams();
    if (saved) restoreBackendFilters(saved);
}

// Puts previously applied filter values back into the Backend Filters form.
// Infinity is saved as null in JSON, so null/blank shows as empty ("no limit").
function restoreBackendFilters(p) {
    const fm = filterManager;
    const setNum = (sel, v) =>
        sel.property("value", (v === null || v === undefined || !isFinite(v)) ? "" : v);

    fm.startDateInput.property("value", p.startDate || "");
    fm.endDateInput.property("value", p.endDate || "");

    setNum(fm.minValInput, p.minSingleOutput);
    setNum(fm.maxValInput, p.maxSingleOutput);
    setNum(fm.minMinInput, p.minMinOutput);
    setNum(fm.maxMinInput, p.maxMinOutput);
    setNum(fm.minIn,  p.minInputs);
    setNum(fm.maxIn,  p.maxInputs);
    setNum(fm.minOut, p.minOutputs);
    setNum(fm.maxOut, p.maxOutputs);

    fm.updatePreview();
}
function cleanupExplorativeUI() {
    d3.select("#ef-legend-footer").remove();
    d3.select(".ef-chain-panel").remove();
    d3.select(".ef-peel-panel").remove();
    d3.selectAll(".ef-tooltip").remove();
    d3.select(".ef-zoom-notice").remove();
    window._efChart = null;
}
// ─── Event listeners ──────────────────────────────────────
const exportBtn = document.getElementById('export-csv-btn');
if (exportBtn) exportBtn.addEventListener('click', exportAllDaysCSV);


// ─── Avvio ────────────────────────────────────────────────
initApp();
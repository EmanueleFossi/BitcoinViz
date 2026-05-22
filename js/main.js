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

// ─── Init app ─────────────────────────────────────────────
// Usa data_cleaned/ come path (Doc 2), coerente con loadDataAndDraw
async function initApp() {
    const chartArea = d3.select("#chart-area");
    chartArea.html("<p class='loading-text'>Loading global index...</p>");

    try {
        const spentData = await d3.csv("data/unique_spent_addresses.csv");
        globalSpentSet = new Set(spentData.map(d => d.address));
        chartArea.selectAll("*").remove();
        switchChart('scatter');
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

    const filterContainer = d3.select("#filter-controls-container");
    chartInstance = null;

    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();

    const loadingMsg = chartArea.append("p")
        .attr("class", "loading-text")
        .text(`Analyzing ${fileName}...`);

    try {
        const rawData = await d3.csv(`data_cleaned/${fileName}`, parseRow);
        const cleanData = rawData.filter(d => d.transaction_hash);
        loadingMsg.remove();

        if (cleanData.length === 0) throw new Error("Not found or empty data");

        if (currentType === 'scatter') {
            filterContainer.selectAll("*").remove();

            filterManager = new FilterManager(cleanData, (filteredData) => {
                updateTxCount(filteredData.length);

                if (chartInstance && chartInstance.isDrilledDown && chartInstance.currentCluster) {
                    const filteredChildren = chartInstance.currentCluster.children.filter(child =>
                        filteredData.some(fd => fd.transaction_hash === child.transaction_hash)
                    );

                    chartInstance.rawData = filteredData;
                    chartInstance.displayData = filteredChildren.length > 0
                        ? filteredChildren
                        : chartInstance.currentCluster.children;
                    chartInstance.setupScales();
                    chartInstance.updateZoomTranslateExtent();
                    chartInstance.updateElements(chartInstance.xScale, chartInstance.yScale);
                } else {
                    chartInstance = new ChartDotPlot("#chart-area", filteredData);
                }
            }, filterContainer);

            filterManager.triggerUpdate();
        }

    } catch (err) {
        console.error("❌ Errore:", err);
        d3.select("#chart-area").html(`
            <div style="color:red;padding:20px;border:1px solid red;">
                <b>Errore nel caricamento di ${fileName}</b><br>${err.message}
            </div>
        `);
    }
}

// ─── Export CSV via Flask (da Doc 1) ──────────────────────
async function exportAllDaysCSV() {
    if (!filterManager) {
        alert("Carica prima un giorno per impostare i filtri.");
        return;
    }

    const exportBtn = document.getElementById('export-csv-btn');
    const originalLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting...";

    try {
        const params = filterManager.getFilterParams();

        const response = await fetch("http://localhost:5501/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                unbalancedThreshold: params.unbalancedThreshold,
                topRatioThreshold:   params.topRatioThreshold,
                minSingleOutput:     params.minSingleOutput,
                minMinOutput:        params.minMinOutput,
                maxSingleOutput:     params.maxSingleOutput,
                minInputs:           params.filterState.minInputs,
                maxInputs:           params.filterState.maxInputs,
                minOutputs:          params.filterState.minOutputs,
                maxOutputs:          params.filterState.maxOutputs,
                onlySpentInPeriod:   params.onlySpentInPeriod,
            })
        });

        const result = await response.json();

        if (!response.ok || result.error) {
            alert(`Errore export: ${result.error}`);
            return;
        }

        alert(
            `Export completato!\n\n` +
            `File: ${result.file}\n` +
            `Transazioni: ${result.tx_count.toLocaleString('it-IT')}\n` +
            `Righe totali: ${result.rows.toLocaleString('it-IT')}\n\n` +
            `Salvato in: exports/${result.file}`
        );

        console.log(`[Export] Salvato: exports/${result.file} — ${result.tx_count} TX, ${result.rows} righe`);

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

// ─── Switch chart ─────────────────────────────────────────
// Modalità supportate: 'scatter' | 'flow' | 'explorative'
function switchChart(type) {
    currentType = type;
    chartInstance = null;

    const btn            = d3.select("#toggle-btn");
    const btnExplorative = d3.select("#toggle-btn-explorative");
    const controls       = d3.select("#dynamic-controls");
    const filterContainer = d3.select("#filter-controls-container");

    controls.selectAll("*").remove();
    filterContainer.selectAll("*").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    if (type === 'scatter') {
        btn.text("Flow Chart").on("click", () => switchChart('flow'));
        btnExplorative.text("Explorative Flow").on("click", () => switchChart('explorative'));

        const select = controls.append("select")
            .attr("class", "day-selector")
            .on("change", (event) => {
                const chosen = ALL_DAYS.find(d => d.file === event.target.value);
                if (chosen) updateHeaderBadge(chosen.label);
                loadDataAndDraw(event.target.value);
            });

        select.selectAll("option")
            .data(ALL_DAYS).enter()
            .append("option")
            .attr("value", d => d.file)
            .text(d => d.label);

        const defaultDay = ALL_DAYS[0];
        select.property("value", defaultDay.file);
        updateHeaderBadge(defaultDay.label);
        loadDataAndDraw(defaultDay.file);

    } else if (type === 'flow') {
        btn.text("Dot Chart").on("click", () => switchChart('scatter'));
        btnExplorative.text("Explorative Flow").on("click", () => switchChart('explorative'));

        updateHeaderBadge(null);
        updateTxCount(null);
        initFlowChart();

    } else if (type === 'explorative') {
        btn.text("Dot Chart").on("click", () => switchChart('scatter'));
        btnExplorative.text("Flow Chart").on("click", () => switchChart('flow'));

        updateHeaderBadge(null);
        updateTxCount(null);
        initExplorativeFlow();
    }
}

// ─── Event listeners ──────────────────────────────────────
const exportBtn = document.getElementById('export-csv-btn');
if (exportBtn) exportBtn.addEventListener('click', exportAllDaysCSV);

// ─── Avvio ────────────────────────────────────────────────
initApp();
const EF_CSV = "data_cleaned/bitcoin_filtered.csv";

async function initExplorativeFlow() {
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".ef-tooltip").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class","loading-text").text("Loading UTXO flow data…");

    try {
        const raw = await d3.csv(EF_CSV, d => {
            let timeStr = d.time ? d.time.trim() : "";
            if (!timeStr) return null;

            let parsedDate;
            if (timeStr.includes("T") || timeStr.includes("Z")) {
                parsedDate = new Date(timeStr);
            } else if (timeStr.includes(" ")) {
                parsedDate = new Date(timeStr.replace(" ", "T") + "Z");
            } else {
                parsedDate = new Date(timeStr + "T00:00:00Z");
            }

            if (isNaN(parsedDate.getTime())) parsedDate = new Date(timeStr);
            if (isNaN(parsedDate.getTime())) {
                console.warn("Data non valida, riga saltata:", d.time);
                return null;
            }

            return {
                hash:        d.transaction_hash ? d.transaction_hash.trim() : "unknown",
                time:        parsedDate,
                btc_out:    +d.output_value_BTC || 0,
                out_address: d.output_address ? d.output_address.trim() : "unknown",
                in_addresses: (d.input_addresses || "")
                                .split(",").map(a => a.trim()).filter(a => a.length > 0)
            };
        });

        const cleanedRaw = raw.filter(Boolean);
        if (!cleanedRaw.length) throw new Error("Nessun dato temporale valido trovato.");

        chartArea.selectAll("*").remove();

        const chart = new ExplorativeFlowChart(chartArea, cleanedRaw);
        buildExplorativeSidebar(chart);

    } catch (err) {
        console.error("ExplorativeFlow error:", err);
        d3.select("#chart-area").html(`
            <div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;
                        border-radius:8px;margin:20px;background:rgba(244,63,94,0.06)">
                <b>Errore caricamento dati</b><br><br>${err.message}
            </div>
        `);
    }
}

// Color palette for highlighted addresses
const FP_HL_COLORS = [
    "#00FFCC", "#FF6B6B", "#FFD93D", "#6BCB77",
    "#4D96FF", "#FF922B", "#CC5DE8", "#F06595",
    "#20C997", "#74C0FC"
];

function buildExplorativeSidebar(chart) {
    const container = d3.select("#filter-controls-container");
    container.selectAll("*").remove();

    const fpState = { hl: [], ex: [] };

    // Address → color map, stable for the whole session
    const hlColorMap = new Map();
    let hlColorIdx = 0;

    function getHlColor(addr) {
        if (!hlColorMap.has(addr)) {
            hlColorMap.set(addr, FP_HL_COLORS[hlColorIdx % FP_HL_COLORS.length]);
            hlColorIdx++;
        }
        return hlColorMap.get(addr);
    }

    function fpRenderTags(type) {
        const list  = document.getElementById(`fp-${type}-list`);
        const empty = document.getElementById(`fp-${type}-empty`);
        list.querySelectorAll('.fp-tag').forEach(el => el.remove());
        empty.style.display = fpState[type].length ? 'none' : '';
        fpState[type].forEach(val => {
            const tag = document.createElement('div');
            tag.className = `fp-tag fp-tag-${type}`;
            const display = val.length > 28 ? val.slice(0, 12) + '…' + val.slice(-8) : val;

            // Per gli highlight usa il colore assegnato, per gli exclude usa rosso fisso
            if (type === 'hl') {
                const color = getHlColor(val);
                tag.style.background = color + '18';
                tag.style.border = `1px solid ${color}`;
                tag.style.color = color;
            }

            tag.innerHTML = `
                <span title="${val}">${display}</span>
                <button onclick="window.fpRemoveTag('${type}','${val}')" title="Rimuovi">✕</button>
            `;
            list.appendChild(tag);
        });
    }

    window.fpRemoveTag = function(type, val) {
        fpState[type] = fpState[type].filter(v => v !== val);
        // Se rimuoviamo un hl, libera il suo colore per riuso
        if (type === 'hl') hlColorMap.delete(val);
        fpRenderTags(type);
        fpApply();
    };

    function fpAddTag(type) {
        const input = document.getElementById(`fp-${type}-input`);
        const val = input.value.trim().toLowerCase();
        if (!val || fpState[type].includes(val)) { input.value = ''; return; }
        fpState[type].push(val);
        if (type === 'hl') getHlColor(val); // assegna subito il colore
        input.value = '';
        fpRenderTags(type);
        fpApply();
    }

    function fpApply() {
        const gapEnabled     = document.getElementById('fp-gap-enabled');
        const gapInput       = document.getElementById('fp-gap-input');
        const hopsEnabled    = document.getElementById('fp-hops-enabled');
        const hopsInput      = document.getElementById('fp-hops-input');
        const addrTxEnabled  = document.getElementById('fp-addrtx-enabled');
        const addrTxInput    = document.getElementById('fp-addrtx-input');

        chart.applyFilters({
            queries:    fpState.hl,
            excludes:   fpState.ex,
            hlColorMap: hlColorMap,
            minB:       0,
            maxB:       Infinity,
            maxGapH:    gapEnabled.checked  && gapInput.value    ? +gapInput.value    : Infinity,
            minHops:    hopsEnabled.checked && hopsInput.value   ? +hopsInput.value   : 0,
            maxAddrTx:  addrTxEnabled.checked && addrTxInput.value ? +addrTxInput.value : Infinity
        });
    }

    container.html(`
        <style>
            .fp-section { display:flex; flex-direction:column; gap:6px; padding:10px 0; }
            .fp-section + .fp-section { border-top:1px solid var(--border-inner); }
            .fp-lbl {
                font-size:10px; font-weight:600; color:var(--text-hint);
                text-transform:uppercase; letter-spacing:0.07em;
            }
            .fp-input-wrap { display:flex; gap:6px; }
            .fp-input-wrap input[type="text"] {
                flex:1; font-size:11px; padding:6px 8px;
                border:1px solid var(--border); border-radius:5px;
                background:#fafafa; color:var(--text-primary);
                font-family:monospace; outline:none;
                transition:border-color .15s;
            }
            .fp-input-wrap input[type="text"]:focus { border-color:var(--orange); background:white; }
            .fp-add {
                padding:5px 10px; font-size:14px; font-weight:600; line-height:1;
                border:1px solid var(--border); border-radius:5px;
                background:transparent; color:var(--text-primary);
                cursor:pointer; flex-shrink:0;
            }
            .fp-add:hover { background:var(--bg); }
            .fp-tags { display:flex; flex-direction:column; gap:4px; }
            .fp-empty { font-size:11px; color:var(--text-hint); font-style:italic; }
            .fp-tag {
                display:flex; align-items:center; gap:6px;
                padding:4px 8px 4px 10px; border-radius:5px;
                font-size:11px; font-family:monospace;
                /* colore di default per gli exclude, gli hl lo sovrascrivono inline */
                background:rgba(239,68,68,0.08); border:1px solid var(--red); color:#991b1b;
            }
            .fp-tag span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
            .fp-tag button {
                background:none; border:none; cursor:pointer;
                padding:0; line-height:1; color:inherit; opacity:0.5; font-size:14px; flex-shrink:0;
            }
            .fp-tag button:hover { opacity:1; }
            .fp-check-row { display:flex; align-items:center; gap:8px; }
            .fp-check-row input[type="number"] {
                flex:1; padding:6px 8px;
                border:1px solid var(--border); border-radius:5px;
                font-size:11px; background:#fafafa; color:var(--text-primary); outline:none;
                transition:border-color .15s;
            }
            .fp-check-row input[type="number"]:focus { border-color:var(--orange); }
            .fp-check-row input[type="checkbox"] { accent-color:var(--orange); cursor:pointer; }
        </style>

        <div class="fp-section">
            <div class="fp-lbl">Highlight addresses</div>
            <div class="fp-input-wrap">
                <input type="text" id="fp-hl-input" placeholder="Address or prefix…" />
                <button class="fp-add" id="fp-hl-btn">+</button>
            </div>
            <div class="fp-tags" id="fp-hl-list">
                <span class="fp-empty" id="fp-hl-empty">none</span>
            </div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Exclude addresses</div>
            <div class="fp-input-wrap">
                <input type="text" id="fp-ex-input" placeholder="Address or prefix…" />
                <button class="fp-add" id="fp-ex-btn">+</button>
            </div>
            <div class="fp-tags" id="fp-ex-list">
                <span class="fp-empty" id="fp-ex-empty">none</span>
            </div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Max gap (hours)</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-gap-enabled" />
                <input type="number" id="fp-gap-input" placeholder="es. 6" min="1" />
            </div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Min hops (largest output)</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-hops-enabled" />
                <input type="number" id="fp-hops-input" placeholder="es. 2" min="1" />
            </div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Max TX per address</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-addrtx-enabled" />
                <input type="number" id="fp-addrtx-input" placeholder="es. 3" min="1" />
            </div>
            <div style="font-size:10px;color:var(--text-hint);margin-top:2px">
                Excludes addresses appearing as input more than N times
            </div>
        </div>
    `);

    const btcSection = container.append("div").attr("class", "fp-section")
        .style("border-top", "1px solid var(--border-inner)");

    btcSection.append("div").attr("class", "fp-lbl").text("Minimum BTC visible");

    const sliderLabel = btcSection.append("div")
        .style("font-size", "10px")
        .style("color", "var(--orange)")
        .text("0 BTC");

    btcSection.append("input")
        .attr("type", "range").attr("min", 0).attr("max", 500).attr("value", 0)
        .style("width", "100%")
        .on("input", function() {
            chart.btcThreshold = +this.value;
            sliderLabel.text(`${(+this.value).toFixed(0)} BTC`);
            chart.update(d3.zoomTransform(chart.svgEl.node()).k, false);
        });

    container.append("button")
        .text("Apply Filters")
        .attr("class", "btn-apply")
        .style("width", "100%")
        .style("margin-top", "10px")
        .on("click", fpApply);

    document.getElementById('fp-hl-btn').addEventListener('click', () => fpAddTag('hl'));
    document.getElementById('fp-ex-btn').addEventListener('click', () => fpAddTag('ex'));
    document.getElementById('fp-hl-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('hl'); });
    document.getElementById('fp-ex-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('ex'); });

    fpRenderTags('hl');
    fpRenderTags('ex');
}
const EF_CSV = "data_cleaned/bitcoin_filtered.csv";
window.initExplorativeFlowForAddress = function(address) {
    initExplorativeFlow(address);
};

async function initExplorativeFlow(focusAddress) {
   // Enforce chrome state ourselves — don't rely on the caller having
    // done this correctly. Fixes inconsistent behavior depending on
    // which screen you navigated from.
    document.getElementById('sb-day-section')?.style.setProperty('display', 'none');
    document.querySelector('.sb-footer')?.style.setProperty('display', 'none');
    document.querySelectorAll('.viz-chip').forEach(el => el.style.setProperty('display', 'none'));
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
     d3.select(".ef-chain-panel").remove();
    d3.select(".ef-peel-panel").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".ef-tooltip").remove();
    d3.select("#ef-legend-footer").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class","loading-text").text("Loading UTXO flow data…");

    try {
        const raw = await d3.csv(`${EF_CSV}?t=${Date.now()}`, d => {
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
    tx_inputs:  +d.transaction_inputs || 0,
    btc_in:     +d.total_input_value_BTC || 0,
    in_addresses: (d.input_addresses || "")
                    .split(",").map(a => a.trim()).filter(a => a.length > 0)
}
        });

        const cleanedRaw = raw.filter(Boolean);
        if (!cleanedRaw.length) throw new Error("Nessun dato temporale valido trovato.");

   chartArea.selectAll("*").remove();
        d3.select("#ef-legend-footer").remove();

        // Build the footer BEFORE the chart, not after — so the chart measures
        // its available height with the footer's real space already taken
        // into account. Building it after (old order) let the chart claim
        // that space for itself first, then the footer pushed total height
        // past the card's height → gap under the hint text + scrollbar.
        d3.select(chartArea.node().parentNode || chartArea.node())
            .append("div")
            .attr("id", "ef-legend-footer")
            .style("padding", "6px 14px")
            .style("font-size", "10px")
            .style("color", "#888")
            .style("border-top", "1px solid var(--border-inner)")
            .html(`
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
                    <span><b style="color:#265F91">●</b> Blue = aggregated TXs</span>
                    <span><b style="color:#1B7A70">●</b> Teal = single TX</span>
                    <span>darker = more BTC</span>
                    <span title="A point in time where funds arrived or moved on">Circle = node</span>
                    <span title="The chain trace shown after clicking an arc"><b style="color:#EC4899">●</b> Pink = selected chain</span>
                    <span title="A run shown after Run Detection"><b style="color:#F59E0B">●</b> Amber = peeling chain candidate</span>
                </div>
            `);

        const chart = new ExplorativeFlowChart(chartArea, cleanedRaw);
        buildExplorativeSidebar(chart);
        window._efChart = chart;

        chart._drawLegend(chart.filteredLevels[chart.lastGranularity], chart.lastGranularity);
        if (focusAddress) {
            const q = focusAddress.toLowerCase();
            chart.applyFilters({
                queries: [q],
                excludes: [],
hlColorMap: new Map([[q, '#EC4899']]),
                minB: 0, maxB: Infinity
            });

            // ── Explain empty result instead of leaving a silent blank timeline ──
            const hasData = (chart.filteredLevels.day.length + chart.filteredLevels.hour.length) > 0;
            if (!hasData) {
                d3.select("#ef-no-data-banner").remove();
                d3.select(chartArea.node().parentNode || chartArea.node())
                    .insert("div", () => chartArea.node())
                    .attr("id", "ef-no-data-banner")
                    .style("background", "#3a1a1a")
                    .style("border", "1px solid #ef4444")
                    .style("color", "#fca5a5")
                    .style("padding", "10px 14px")
                    .style("font-size", "11px")
                    .style("border-radius", "6px")
                    .style("margin", "10px")
                    .html(`⚠ No address-linked chain found for this address in the linear view.<br>
                           <span style="color:#f87171;font-size:10px;line-height:1.6">
                           This address is likely part of a <b>fresh-address chain</b>, found only by
                           value-based linking (Peeling Chain Detection → Section B). Since a new
                           address is used at every hop, there's no address reuse for this view to
                           trace — the chain is real, it's just not visible this way. Use the
                           "Verify this transaction" toggle in the Section B hop table instead to
                           confirm it directly.
                           </span>`);
            }
        }

    } catch (err) {
        console.error("ExplorativeFlow error:", err);
        d3.select("#chart-area").html(`
            <div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;
                        border-radius:8px;margin:20px;background:rgba(244,63,94,0.06)">
                <b>"Error loading data</b><br><br>${err.message}
            </div>
        `);
    }
}

// Color palette for highlighted (user-searched) addresses.
// This is intentionally a small, distinct set — used ONLY for the
// handful of addresses you actively search/highlight, never for the
// default arc coloring (which now uses a single calm hue, see chart.js).
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
        if (type === 'hl') hlColorMap.delete(val);
        fpRenderTags(type);
        fpApply();
    };

    function fpAddTag(type) {
        const input = document.getElementById(`fp-${type}-input`);
        const val = input.value.trim().toLowerCase();
        if (!val || fpState[type].includes(val)) { input.value = ''; return; }
        fpState[type].push(val);
        if (type === 'hl') getHlColor(val);
        input.value = '';
        fpRenderTags(type);
        fpApply();
    }

    // ── Every control below applies itself immediately (no separate
    // "Apply" button anywhere — tags, checkboxes and number fields all
    // behave the same way: change something, chart updates). ──────────
function fpApply() {
    const minGapEnabled  = document.getElementById('fp-mingap-enabled');
    const minGapInput    = document.getElementById('fp-mingap-input');
    const gapEnabled     = document.getElementById('fp-gap-enabled');
    const gapInput       = document.getElementById('fp-gap-input');
    const hopsEnabled    = document.getElementById('fp-hops-enabled');
    const hopsInput      = document.getElementById('fp-hops-input');

    d3.select("#ef-no-data-banner").remove();

    chart.applyFilters({
        queries:    fpState.hl,
        excludes:   fpState.ex,
        hlColorMap: hlColorMap,
        minB:       0,
        maxB:       Infinity,
        minGapH:    (minGapEnabled.checked && minGapInput.value) ? +minGapInput.value : 0,
        maxGapH:    (gapEnabled.checked && gapInput.value)       ? +gapInput.value    : Infinity,
        minHops:    (hopsEnabled.checked && hopsInput.value)     ? +hopsInput.value   : 0
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
            .fp-hint { font-size:10px; color:var(--text-hint); margin-top:2px; line-height:1.4; }
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
            .fp-check-row select {
                padding:5px 6px; border:1px solid var(--border); border-radius:5px;
                font-size:10px; background:#fafafa; color:var(--text-primary); outline:none;
            }
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
            <div class="fp-lbl">Min gap between hops (hours)</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-mingap-enabled" />
                <input type="number" id="fp-mingap-input" placeholder="e.g. 1" min="0" />
            </div>
            <div class="fp-hint">Hide flows that move again too quickly (below this many hours).</div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Max gap between hops (hours)</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-gap-enabled" />
                <input type="number" id="fp-gap-input" placeholder="e.g. 6" min="1" />
            </div>
            <div class="fp-hint">Hide flows that took too long to move again (above this many hours).</div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Min chain depth</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-hops-enabled" />
                <input type="number" id="fp-hops-input" placeholder="e.g. 2" min="1" />
            </div>
            <div class="fp-hint">Only show flows that belong to a peeling chain with at least this many transactions total (not the same as address reuse).</div>
        </div>

        <div class="fp-section">
            <div class="fp-lbl">Granularity</div>
            <div class="fp-check-row">
                <input type="checkbox" id="fp-forcehour-enabled" />
                <label for="fp-forcehour-enabled" style="font-size:11px;cursor:pointer">
                    One transaction per edge
                </label>
            </div>
            <div class="fp-hint">per transaction view is helpful in detecting peeling chains</div>
        </div>

 <div class="fp-section" id="fp-peel-section">
            <div class="fp-lbl">Suggested Peeling Chain Candidates</div>
            <div class="fp-check-row">
                <label style="font-size:10px;color:var(--text-hint);width:100px">Min retain %</label>
                <input type="number" id="fp-peel-retain-input" value="90" min="50" max="100" step="1" style="width:70px" />
                <span style="font-size:10px;color:var(--text-hint)">%</span>
            </div>
            <div class="fp-check-row">
                <label style="font-size:10px;color:var(--text-hint);width:100px">Min length</label>
                <input type="number" id="fp-peel-minlen-input" value="3" min="2" style="width:70px" />
                <span style="font-size:10px;color:var(--text-hint)">hops</span>
            </div>
            <div class="fp-hint">
                A hop only counts as a "clean peel" if the largest output keeps at least this %
                of the transaction's total input value, and each hop's amount is smaller than the last.
            </div>
            <button id="fp-detect-peel-btn" class="fp-add" style="width:100%;padding:7px;margin-top:6px">
                Run Detection
            </button>
            <div class="fp-hint" id="fp-peel-hint">
                Enable "One transaction per edge" above first — detection needs per-transaction data.
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

    document.getElementById('fp-hl-btn').addEventListener('click', () => fpAddTag('hl'));
    document.getElementById('fp-ex-btn').addEventListener('click', () => fpAddTag('ex'));
    document.getElementById('fp-hl-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('hl'); });
    document.getElementById('fp-ex-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('ex'); });
const peelBtn  = document.getElementById('fp-detect-peel-btn');
    const peelHint = document.getElementById('fp-peel-hint');

function syncPeelAvailability() {
        // Tied strictly to the checkbox — the zoom banner (chart.js) tells users
        // to tick it if they reach hourly view by zooming instead.
        const active = chart.forceHourly;
        peelBtn.disabled = !active;
        peelBtn.style.opacity = active ? 1 : 0.4;
        peelBtn.style.cursor = active ? 'pointer' : 'not-allowed';
        peelHint.style.display = active ? 'none' : '';
    }
    syncPeelAvailability();

    document.getElementById('fp-forcehour-enabled').addEventListener('change', function() {
        chart.forceHourly = this.checked;
        const k = chart._lastK ?? d3.zoomTransform(chart.svgEl.node()).k;
        chart.update(k, true);
        syncPeelAvailability();
    });
  peelBtn.addEventListener('click', () => {
        if (!chart.forceHourly) return;
        const retainPct = Math.min(1, Math.max(0.5, (+document.getElementById('fp-peel-retain-input').value || 90) / 100));
        const minLen     = Math.max(2, +document.getElementById('fp-peel-minlen-input').value || 3);
        const results    = chart._detectPeelingChainCandidates(minLen, retainPct);
        chart._showPeelResults(results);
    });
    // Auto-apply on every threshold control — no separate "Apply" button.
   ['fp-mingap-enabled','fp-mingap-input','fp-gap-enabled','fp-gap-input',
     'fp-hops-enabled','fp-hops-input']
        .forEach(id => {
            const el = document.getElementById(id);
            const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
            el.addEventListener(evt, fpApply);
        });

    fpRenderTags('hl');
    fpRenderTags('ex');
}
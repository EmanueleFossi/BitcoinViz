const EF_CSV = "data_cleaned/bitcoin_filtered.csv";
window.initExplorativeFlowForAddress = function(address) {
    initExplorativeFlow(address);
};

async function initExplorativeFlow(focusAddress) {
   // Enforce chrome state ourselves — don't rely on the caller having
    // done this correctly. Fixes inconsistent behavior depending on
    // which screen you navigated from.
    document.getElementById('sb-day-section')?.style.setProperty('display', 'none');
    document.querySelectorAll('.viz-chip').forEach(el => el.style.setProperty('display', 'none'));
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#ef-hop-panel").remove();
     d3.select(".ef-chain-panel").remove();
d3.select(".ef-peel-panel").remove();
    d3.select(".ef-spark-panel").remove();
     d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".ef-tooltip").remove();
    d3.select("#ef-legend-footer").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class","loading-text").text("Loading…");

    try {

        const savedFilters = getLastFilterParams();
if (!savedFilters) {
    chartArea.html(`<p style="color:#F59E0B;padding:16px">
        No filtered dataset yet — set filters on Dot Chart and click "Export CSV" first.
    </p>`);
    return;
}

const apiRows = await loadTransactions(savedFilters);
const cleanedRaw = apiRows.map(d => ({
    hash:         d.transaction_hash ? d.transaction_hash.trim() : "unknown",
    time:         d.time,
    btc_out:      +d.output_value_BTC || 0,
    out_address:  d.output_address ? d.output_address.trim() : "unknown",
    tx_inputs:    +d.transaction_inputs || 0,
    btc_in:       +d.total_input_value_BTC || 0,
    in_addresses: (d.input_addresses || "").split(",").map(a => a.trim()).filter(a => a.length > 0)
}));
if (!cleanedRaw.length) throw new Error("No valid temporal data found in the filtered dataset — check your filters and try again.");

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
            .style("position", "relative")
                    .html(`
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;white-space:nowrap">
    <span title="Several flows merged into one edge"><b style="color:#265F91">●</b> Merged flows</span>
    <span title="One transaction output (1-hour view)"><b style="color:#2F9E44">●</b> Single transaction</span>
    <span title="The chain or edge you clicked"><b style="color:#EC4899">●</b> Selected</span>
    <span title="Matches the system's peeling-chain rules"><b style="color:#F59E0B">●</b> Suspicious chain</span>
    <span id="ef-amount-slot" style="display:inline-flex;align-items:center;gap:6px;padding-left:16px;border-left:1px solid #ddd"></span>
    <button id="ef-legend-help-btn" title="How to read this view" style="margin-left:auto;background:#fff;border:1px solid var(--border);border-radius:4px;height:20px;padding:0 8px;cursor:pointer;color:#555;font-size:10px;flex-shrink:0;white-space:nowrap">ⓘ Help</button>
</div>
<div id="ef-legend-help" style="display:none;position:absolute;bottom:100%;right:14px;margin-bottom:6px;width:380px;max-width:calc(100vw - 40px);max-height:60vh;overflow-y:auto;padding:12px 14px;background:#ffffff;border:1px solid var(--border);border-radius:8px;line-height:1.55;box-shadow:0 6px 20px rgba(0,0,0,0.14);z-index:20;font-size:11px;color:#444">
    <style>
        #ef-legend-help details { border-top:1px solid var(--border-inner); padding:2px 0; }
        #ef-legend-help summary { cursor:pointer; font-weight:700; color:#222; padding:6px 0; font-size:11px; }
        #ef-legend-help ul { margin:0 0 6px; padding-left:16px; }
        #ef-legend-help li { margin-bottom:3px; }
    </style>
    <div style="font-weight:700;color:#222;font-size:12px;margin-bottom:6px">How to read this view</div>

    <details open>
        <summary>1 · The basics</summary>
        <ul>
            <li>Each <b>dot</b> is a time window. Time runs left to right. All times are UTC.</li>
            <li>Each <b>arc</b> is BTC that moved from one window to a later one.</li>
            <li><b style="color:#2F9E44">Green</b> arc = one transaction output (1-hour windows). <b style="color:#265F91">Blue</b> arc = several flows merged (larger windows).</li>
            <li>A <b>hop</b> is one link of a chain: an output spent as an input of the next transaction.</li>
        </ul>
    </details>

    <details>
        <summary>2 · Move around</summary>
        <ul>
            <li><b>Scroll</b> up or down to open or close all windows one step (day, 12 h, 6 h, 1 h).</li>
            <li><b>Click a dot</b> to open only that window. <b>Click a box label</b> to close it. <b>Drag</b> to pan.</li>
            <li>The <b>day strip</b> on top: drag to jump. "Collapse all" goes back to days.</li>
            <li><b>Long edges</b>: hide arcs that span more than N windows to reduce clutter.</li>
        </ul>
    </details>

    <details>
        <summary>3 · Inspect an edge</summary>
        <ul>
            <li><b>Hover</b> an arc: amount, time, transaction, main output and how long it waited before being spent.</li>
            <li><b>Click a green arc</b>: its whole chain turns <b style="color:#EC4899">pink</b>. Click empty space to step back.</li>
            <li><b>Click a blue arc</b>: it turns pink. Press <b>Details</b> in the left panel for the merged transactions.</li>
            <li><b>Click an hour dot</b> (or Shift+click any dot) to focus on its arcs only. Esc exits.</li>
        </ul>
    </details>

    <details>
        <summary>4 · Suspicious chains</summary>
        <ul>
            <li>Set <b>Retain %</b> (each hop keeps at least this share of the amount), <b>Min hops</b>, then press Detect. The Temporal gap and Min flow filters apply too.</li>
            <li>The longest chains are marked <b style="color:#F59E0B">amber</b>, <b>#1 = longest</b>. Use ◀ ▶ or click a start edge to open a chain. ✕ clears. <b>View all</b> lists every chain.</li>
            <li>In an open chain: <b>dashed ring</b> on a dot = hops inside one hour (no arc; hover the dot for their amounts).</li>
            <li><b>Amount per hop → Show</b>: one dot per hop. Hover to read, click or ◀ ▶ to step; the current hop is thicker on the graph.</li>
            <li>The day strip shows amber ticks where the shown chains live.</li>
            <li>Suspicious means "matches the system's peeling rules". It is a lead to check, not proof.</li>
        </ul>
    </details>

    <details>
        <summary>5 · Amounts, flags, search, filters</summary>
        <ul>
            <li><b>Shade</b> = BTC on all arcs (4 brackets, log scale). <b>Thickness</b> = BTC inside an open chain only.</li>
            <li>Flags on merged edges: <b>self-loop</b> (money returns to the same address), <b>dominant</b> (one transaction is 70%+), <b>repeated address</b>, <b>top 1%</b> amount.</li>
            <li><b>Search</b> an address (top): it gets its own colour on matching flows.</li>
            <li><b>Left filters</b>: Temporal gap, Minimum single flow, Minimum merged-edge volume (blue arcs only).</li>
        </ul>
    </details>
</div>
          `);
         

        let legendHelpOpen = false;
        const legendBtn = document.getElementById('ef-legend-help-btn');
        const legendHelp = document.getElementById('ef-legend-help');
        legendBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            legendHelpOpen = !legendHelpOpen;
            legendHelp.style.display = legendHelpOpen ? 'block' : 'none';
        });
        document.addEventListener('click', (e) => {
            if (legendHelpOpen && !legendHelp.contains(e.target) && e.target !== legendBtn) {
                legendHelpOpen = false;
                legendHelp.style.display = 'none';
            }
        });

        const chart = new ExplorativeFlowChart(chartArea, cleanedRaw);
        buildExplorativeSidebar(chart);
        window._efChart = chart;

        if (focusAddress) {
            const q = focusAddress.toLowerCase();
            chart.applyFilters({
                queries: [q],
                excludes: [],
hlColorMap: new Map([[q, FP_HL_COLORS[0]]]),
                minB: 0, maxB: Infinity
            });

            // ── Explain empty result instead of leaving a silent blank timeline ──
            const hasData = chart.filteredLevels.hour.length > 0;
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
                    .html(` ⚠ No address-linked chain found for this address.<br>
<span style="color:#f87171;font-size:10px;line-height:1.6">
It may appear only in chains that use a new address at every hop, which cannot be traced by address reuse.
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

const FP_HL_COLORS = ["#8B5CF6", "#84CC16", "#D946EF", "#EAB308", "#92400E"];
let hlColorIdx = 0;

function buildExplorativeSidebar(chart) {
const exploreContainer = d3.select("#explore-flow-container");
const peelContainer = d3.select("#peel-detection-container");
    exploreContainer.selectAll("*").remove();
    peelContainer.selectAll("*").remove();

    const fpState = { hl: [] };
    // Address → color map, stable for the whole session
   const hlColorMap = new Map();

function getHlColor(addr) {
    if (!hlColorMap.has(addr)) hlColorMap.set(addr, FP_HL_COLORS[hlColorIdx++ % FP_HL_COLORS.length]);
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
const display = val.length > 14 ? val.slice(0, 6) + '…' + val.slice(-4) : val;
            if (type === 'hl') {
                const color = getHlColor(val);
                tag.style.background = color + '18';
                tag.style.border = `1px solid ${color}`;
                tag.style.color = color;
            }

            tag.innerHTML = `
                <span title="${val}">${display}</span>
                <button onclick="window.fpRemoveTag('${type}','${val}')" title="remove">✕</button>
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
function fpApply(animate) {
    const minGapEnabled  = document.getElementById('fp-mingap-enabled');
    const minGapInput    = document.getElementById('fp-mingap-input');
    const gapEnabled     = document.getElementById('fp-gap-enabled');
    const gapInput       = document.getElementById('fp-gap-input');

    d3.select("#ef-no-data-banner").remove();

    chart.applyFilters({
        queries:    fpState.hl,
        hlColorMap: hlColorMap,
        minB:       +document.getElementById('fp-btc-slider').value,
        animate:    animate !== false,
                maxB:       Infinity,
        minGapH:    (minGapEnabled.checked && minGapInput.value) ? +minGapInput.value : 0,
        maxGapH:    (gapEnabled.checked && gapInput.value)       ? +gapInput.value    : Infinity
    });
}
           d3.select("#frontend-filters-style").remove();
    d3.select("head").append("style").attr("id", "frontend-filters-style").html(`
.fp-section { display:flex; flex-direction:column; gap:4px; padding:6px 0; }
            .fp-section + .fp-section { border-top:1px solid var(--border-inner); }
            .fp-lbl {
                font-size:10px; font-weight:600; color:var(--text-hint);
                text-transform:uppercase; letter-spacing:0.07em;
                display:flex; align-items:center; gap:6px;
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
            .fp-check-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .fp-check-row input[type="number"] {
                flex:1; min-width:70px; padding:6px 8px;
                border:1px solid var(--border); border-radius:5px;
                font-size:11px; background:#fafafa; color:var(--text-primary); outline:none;
                transition:border-color .15s;
            }
            .fp-check-row input[type="number"]:focus { border-color:var(--orange); }
            .fp-check-row input[type="checkbox"] { accent-color:var(--orange); cursor:pointer; flex-shrink:0; }
            .fp-check-row select {
                padding:5px 6px; border:1px solid var(--border); border-radius:5px;
                font-size:10px; background:#fafafa; color:var(--text-primary); outline:none;
            }
           .fp-mini { font-size:10px; color:var(--text-hint); white-space:nowrap; }
            .fp-retain-row input[type=number]::-webkit-inner-spin-button,
            .fp-retain-row input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
            .fp-retain-row input[type=number] { -moz-appearance:textfield; }
                        .fp-peel-box {
                background: rgba(245,158,11,0.05);
                border: 1px solid rgba(245,158,11,0.25);
                border-radius: 8px;
                padding: 10px;
            }
                            .fp-retain-row {
                display: grid;
                grid-template-columns: auto minmax(44px, 1fr) auto minmax(44px, 1fr);
                gap: 6px;
                align-items: center;
            }
            .fp-retain-row input[type="number"] {
                width: 100%;
                min-width: 0;
                box-sizing: border-box;
                padding: 6px 4px;
                border: 1px solid var(--border);
                border-radius: 5px;
                font-size: 11px;
                background: #fafafa;
            }
                
    `);

      exploreContainer.html(`
<div class="fp-section">
<div class="fp-lbl">Temporal Gap (Hours)</div>
    <div class="fp-check-row">
        <input type="checkbox" id="fp-mingap-enabled" />
        <input type="number" id="fp-mingap-input" placeholder="min e.g. 1" min="0" />
        <input type="checkbox" id="fp-gap-enabled" />
        <input type="number" id="fp-gap-input" placeholder="max e.g. 6" min="1" />
    </div>
</div>
<div class="fp-section">
<div class="fp-lbl">Minimum Single Flow Value (BTC)
    <span id="fp-btc-label" style="margin-left:auto;color:var(--orange);font-weight:600;text-transform:none;letter-spacing:0">0 BTC</span></div>
    <input type="range" id="fp-btc-slider" min="0" max="500" value="0" style="width:100%" />
</div>
<div class="fp-section" id="fp-edge-section" title="Blue (merged) edges only. Has an effect only above the minimum single flow value.">
<div class="fp-lbl">Minimum Merged-Edge Volume (BTC)
    <span id="fp-edge-label" style="margin-left:auto;color:var(--orange);font-weight:600;text-transform:none;letter-spacing:0">0 BTC</span></div>
    <input type="range" id="fp-edge-slider" min="0" max="500" value="0" style="width:100%" />
</div>

        `);

         peelContainer.html(`
<div class="fp-peel-box">
    <div class="fp-retain-row">
        <label class="fp-mini">Retain %</label>
        <input type="number" id="fp-peel-retain-input" value="90" min="50" max="100" step="1" />
        <label class="fp-mini">Min hops</label>
        <input type="number" id="fp-peel-minlen-input" value="5" min="2" />
    </div>
    <div class="fp-check-row" style="margin-top:6px">
        <input type="checkbox" id="fp-peel-decreasing" checked />
        <label for="fp-peel-decreasing" style="font-size:10px;cursor:pointer">Require shrinking amount per hop</label>
    </div>
    <button id="fp-detect-peel-btn" class="fp-add" style="width:100%;padding:6px;font-size:11px;margin-top:6px">Suggest Suspicious Chains</button>
</div>
    `);
       // "Chains detected / Amount per hop" card: its own box under Heuristics
    d3.select("#ef-hop-panel").remove();
    const hopHost = document.createElement('div');
    hopHost.id = 'ef-hop-panel';
    hopHost.style.display = 'none';
    const accPeel = document.getElementById('acc-peel');
    if (accPeel) accPeel.insertAdjacentElement('afterend', hopHost);
    else peelContainer.node().appendChild(hopHost); 
    const flowSlider = document.getElementById('fp-btc-slider');
    const edgeSlider = document.getElementById('fp-edge-slider');
    flowSlider.max = Math.max(1, Math.ceil(chart.maxFlowBtc || 500));
    edgeSlider.max = Math.max(1, Math.ceil(chart.maxMergedBtc || 500));

    // Minimum flow value: filters every single output before anything is merged.
    flowSlider.addEventListener('input', function() {
        document.getElementById('fp-btc-label').textContent = `${(+this.value).toFixed(0)} BTC`;
        fpApply(false);
    });
    // Minimum merged-edge volume: hides faint blue edges only.
    edgeSlider.addEventListener('input', function() {
        chart.btcThreshold = +this.value;
        document.getElementById('fp-edge-label').textContent = `${(+this.value).toFixed(0)} BTC`;
        chart.update(0, false);
    });
        chart.onModeChange = (single) => {
        edgeSlider.disabled = single;
        const sec = document.getElementById('fp-edge-section');
        sec.style.opacity = single ? 0.45 : 1;
        sec.title = single
            ? 'Not used in the Single TX Output View.'
            : 'Blue (merged) edges only. Has an effect only above the minimum single flow value.';
    };
    chart.onModeChange(chart.singleMode);
    document.getElementById('fp-hl-btn').addEventListener('click', () => fpAddTag('hl'));
    document.getElementById('fp-hl-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('hl'); });
const peelBtn  = document.getElementById('fp-detect-peel-btn');


   
  peelBtn.addEventListener('click', () => {
            chart.prepareSingleView();
        const retainPct = Math.min(1, Math.max(0.5, (+document.getElementById('fp-peel-retain-input').value || 90) / 100));
        const minLen     = Math.max(2, +document.getElementById('fp-peel-minlen-input').value || 5);
        const requireDecreasing = document.getElementById('fp-peel-decreasing').checked;
const results = chart._detectPeelingChainCandidates(minLen, retainPct, requireDecreasing);
chart._showSuspects(results);
    });
    // Auto-apply on every threshold control — no separate "Apply" button.
     ['fp-mingap-enabled','fp-mingap-input','fp-gap-enabled','fp-gap-input']
        .forEach(id => {
            const el = document.getElementById(id);
            const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
            el.addEventListener(evt, fpApply);
        });

    fpRenderTags('hl');
    document.getElementById('acc-explore').open = true;}
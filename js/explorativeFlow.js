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
        d3.selectAll(".ef-pinned-tip").remove();
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
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;white-space:nowrap">
<span title="One flow = one edge"><b style="color:#265F91">●</b> Individual edge</span>
<span title="2 or more flows merged between the same two windows"><b style="color:#2F9E44">●</b> Merged edge</span>
    <span title="The chain or edge you clicked"><b style="color:#EC4899">●</b> Selected flow </span>
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-weight:700;color:#222;font-size:12px">How to read this view</span>
        <button id="ef-legend-help-close" title="Close" style="background:none;border:none;cursor:pointer;font-size:14px;color:#555;line-height:1;padding:0">✕</button>
    </div>
    <details open>
        <summary>1 · The basics</summary>
        <ul>
<li>Each <b>node</b> is a time window (day, 12 h, 6 h or 1 h).  All times are UTC.</li>
<li>Each <b>edge</b> is BTC that moved from one window to a later one.</li>
<li><b style="color:#265F91">Blue</b> edge = one flow (one output that was later spent). <b style="color:#2F9E44">Green</b> edge = 2 or more flows merged between the same two windows (after pressing <b>Merge edges</b>).</li>
            <li>A <b>hop</b> is one link of a chain: an output spent as an input of the next transaction.</li>
            <li><b>Merge edges</b> (top right) joins all flows between the same two windows to reduce clutter. Window size (24 h / 12 h / 6 h / 1 h) is a separate control.</li>
        </ul>
        
    </details>

    <details>
        <summary>2 · Move around</summary>
        <ul>
            <li><b>Scroll</b>  to open or close all windows one step (day, 12 h, 6 h, 1 h).</li>
            <li><b>Click a node</b> to open only that window. <b>Click a box label</b> to close it. <b>Drag</b> to pan.</li>
<li>The <b>timeline overview</b> on top shows every day. Drag its orange box to move along the timeline. "Collapse all" goes back to days, "Expand all" opens everything to hours.</li>
<li><b>Long edges</b> (left panel): hide edges spanning &gt; N nodes, in both views. The hidden count is shown beside it. Display only; chain detection is not affected.</li></ul>
</details>

    <details>
        <summary>3 · Inspect an edge</summary>
        <ul>
            <li><b>Hover</b> an edge: amount, time, transaction, main output and how long it waited before being spent.</li>
<li><b>Click a green edge</b>: its whole chain turns <b style="color:#EC4899">pink</b>. The pink chain is always the full chain and ignores the left-panel filters. Click empty space to step back.</li>
            <li><b>Click a GREEN edge</b>: it turns pink. Press <b>Details</b> in the left panel for the flows in that edge.</li>
        </ul>
    </details>

    <details>
        <summary>4 · Suspicious chains</summary>
        <ul>
            <li>The longest chains are marked <b style="color:#F59E0B">amber</b>, <b>#1 = longest</b>. Use ◀ ▶ or click a start edge to open a chain. ✕ clears. <b>View all</b> (top bar) lists every chain</li>
            <li>In an open chain: <b>dashed ring</b> on a node = hops inside one hour (no arc; hover the dot for their amounts).</li>
            <li><b>Inspector Panel → Sparkline chart → Show</b>: one dot per hop. Hover to read, click or ◀ ▶ to step; the current hop is thicker on the graph.</li>
<li>The timeline overview shows an <b style="color:#F59E0B">amber underline</b> on the days where the shown chains start. For an open chain, it marks every day the chain passes through.</li>
            <li>Suspicious means "matches the system's peeling rules". It is a lead to check, not proof.</li>
        </ul>
    </details>

    <details>
        <summary>5 · Amounts, flags, search, filters</summary>
        <ul>
<li><b>Shade</b> = BTC of an edge: darker = more BTC, in 4 ranges on a log scale (each range is about 6× wider than the one before). The legend at the bottom lists each range. <b>Thickness</b> is used only while a chain is open: the thinnest edge has less BTC, the thickest has more BTC.</li>
<li><b>Top 5 edges</b> (left panel, merged mode only): numbered dots on the 5 edges with the largest BTC flow or the longest chain after it, in the current view. They follow the window level and filters. <b>Hover</b> an edge: the bar shows its flows (width = BTC; outlined = the flow that earned the dot). Press <b>P</b> to pin.</li>
<li><b>Details</b> (left panel, after clicking a merged edge) lists every flow, the marked one first. Each flow shows its amount, time, transaction, input and output address, and <b>Trace chain · N more hops</b> to open its full chain.<br>Badges: <b style="color:#A855F7">self-loop</b> = the spending transaction sends its largest output back to the same address; <b style="color:#EF4444">top 1%</b> = amount is in the top 1% of all flows in the data; <b style="color:#06B6D4">repeated</b> = the same input address appears in more than one flow of the edge.</li>
            <li><b>Search</b> an address (top): it gets its own colour on matching flows.</li>
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
        document.getElementById('ef-legend-help-close').addEventListener('click', (e) => {
            e.stopPropagation();
            legendHelpOpen = false;
            legendHelp.style.display = 'none';
        });
        // no click-outside closing: it also cleared the selected chain

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
                    .html(` ⚠ No edge found for this address.<br>
<span style="color:#f87171;font-size:10px;line-height:1.6">
It has no spent output that can be linked inside the loaded data. Possible reasons: it never spent money here, the transaction that sent it money is not loaded, or it received and spent within the same hour (no edge is drawn within one hour).
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
.fp-section { display:flex; flex-direction:column; gap:3px; padding:4px 0; }
            .fp-section + .fp-section { border-top:1px solid var(--border-inner); }
           .fp-lbl {
    font-size:11px; font-weight:600; color:var(--text-primary);
    display:flex; align-items:center; gap:6px;
}
.fp-val { margin-left:auto; color:var(--orange); font-weight:600; font-size:10px; white-space:nowrap; }
.fp-note { font-weight:400; font-size:9px; color:var(--text-hint); }
.fp-group { margin-top:6px; padding:6px 8px 4px; background:#f8fafc; border:1px solid var(--border-inner); border-radius:8px; }
.fp-group-head { font-size:9px; font-weight:700; color:var(--text-hint); letter-spacing:0.04em; margin-bottom:2px; }
.fp-group .fp-section + .fp-section { border-top:none; }
.fp-check-row select { height:26px; min-width:78px; }
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
                
        .fp-section { gap:2px; padding:2px 0; }
.fp-lbl { font-size:10px; }
.fp-val, .fp-mini, .fp-note { font-size:9px; }
.fp-group { margin-top:3px; padding:4px 6px 2px; }
.fp-group-head { font-size:8px; margin-bottom:1px; }
.fp-check-row { gap:5px; }
.fp-check-row input[type="number"] { padding:3px 5px; font-size:10px; }
.fp-check-row select { padding:2px 4px; font-size:9px; height:22px; min-width:70px; }
.fp-peel-box { padding:6px; }
.fp-retain-row { gap:4px; }
.fp-retain-row input[type="number"] { padding:3px 4px; font-size:10px; }
.fp-add { padding:4px 8px; }        
    `);

exploreContainer.html(`
<div class="fp-section">
    <div class="fp-lbl">Temporal gap (hours)</div>
    <div class="fp-check-row">
        <input type="checkbox" id="fp-mingap-enabled" />
        <input type="number" id="fp-mingap-input" placeholder="min e.g. 1" min="0" />
        <input type="checkbox" id="fp-gap-enabled" />
        <input type="number" id="fp-gap-input" placeholder="max e.g. 6" min="1" />
    </div>
</div>
<div class="fp-section">
    <div class="fp-lbl">Min single flow value (BTC)
        <span id="fp-btc-label" class="fp-val">0 BTC</span></div>
    <input type="range" id="fp-btc-slider" min="0" max="500" value="0" style="width:100%" />
</div>
<div class="fp-section" title="Display only: does not affect chain detection. Default N = number of nodes visible on screen.">
    <div class="fp-lbl">Long edges <i class="fp-note">(display only)</i>
        <span id="fp-long-count" class="fp-val"></span></div>
    <div class="fp-check-row" style="flex-wrap:nowrap;gap:5px">
        <select id="fp-long-mode"><option value="hide">Hide</option><option value="show">Show</option></select>
        <span class="fp-mini">edges &gt;</span>
        <input type="number" id="fp-long-input" min="2" max="200" style="flex:0 0 48px;width:48px;min-width:0" />
        <span class="fp-mini">nodes</span>
    </div>
</div>
<div class="fp-section" id="fp-mark-section">
    <div class="fp-check-row" style="flex-wrap:nowrap;justify-content:space-between">
        <span class="fp-lbl" title="Numbered dots on the 5 best merged edges in the current view">Top 5 edges</span>
        <select id="fp-mark">
            <option value="off">Off</option>
            <option value="btc">Largest BTC flow</option>
            <option value="hops">Longest chain</option>
        </select>
    </div>
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
    <div class="fp-check-row" style="margin-top:4px">
        <input type="checkbox" id="fp-peel-decreasing" checked />
        <label for="fp-peel-decreasing" style="font-size:10px;cursor:pointer">Decreasing amount per hop</label>
    </div>
    <div class="fp-check-row" style="margin-top:4px">
  <label class="fp-mini">Chain type</label>
  <select id="fp-peel-type">
    <option value="all">All</option>
    <option value="new">New address only</option>
    <option value="same">Same address only</option>
    <option value="mixed">Mixed</option>
  </select>
</div>
    <button id="fp-detect-peel-btn" class="fp-add" style="width:100%;padding:4px;font-size:10px;margin-top:4px">Suggest Suspicious Chains</button>
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
    flowSlider.max = Math.max(1, Math.ceil(chart.maxFlowBtc || 500));
        document.getElementById('fp-mark').addEventListener('change', function () { chart._setMarkMode(this.value); });
       

    // Minimum flow value: filters every single output before anything is merged.
    flowSlider.addEventListener('input', function() {
        document.getElementById('fp-btc-label').textContent = `${(+this.value).toFixed(0)} BTC`;
        fpApply(false);
    });
    
 chart.onModeChange = (single) => {
    document.getElementById('fp-mark').disabled = single;
    const s = document.getElementById('fp-mark-section');
    s.style.opacity = single ? 0.45 : 1;
    s.title = single ? 'Available only when edges are merged.' : '';
};
    chart.onModeChange(chart.singleMode);
    document.getElementById('fp-hl-btn').addEventListener('click', () => fpAddTag('hl'));
    document.getElementById('fp-hl-input').addEventListener('keydown', e => { if (e.key === 'Enter') fpAddTag('hl'); });
    const longIn = document.getElementById('fp-long-input');
    const longSel = document.getElementById('fp-long-mode');
    longIn.value = chart._longSlots || '';
    longSel.value = chart._longMode;
    longIn.addEventListener('change', function () {
        const v = Math.max(2, Math.min(200, +this.value || 8));
        this.value = v;
        chart._setLongMode(null, v);
    });
    longSel.addEventListener('change', function () { chart._setLongMode(this.value); });
        chart._updateHiddenChip();
    const peelBtn  = document.getElementById('fp-detect-peel-btn');


   
  peelBtn.addEventListener('click', () => {
            chart.prepareSingleView();
        const retainPct = Math.min(1, Math.max(0.5, (+document.getElementById('fp-peel-retain-input').value || 90) / 100));
        const minLen     = Math.max(2, +document.getElementById('fp-peel-minlen-input').value || 5);
        const requireDecreasing = document.getElementById('fp-peel-decreasing').checked;
const type = document.getElementById('fp-peel-type').value;
const results = chart._detectPeelingChainCandidates(minLen, retainPct, requireDecreasing)
                     .filter(c => type === 'all' || c.changeType === type);
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
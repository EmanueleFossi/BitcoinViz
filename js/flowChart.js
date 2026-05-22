// ─────────────────────────────────────────────────────────────────
//  flowChart.js  —  UTXO Arc Flow Diagram
//  CSV columns: transaction_hash, time, output_value_BTC,
//               output_address, transaction_inputs,
//               total_input_value_BTC, input_addresses
//
//  Logic: for each transaction, check if any of its input_addresses
//         appear as an output_address on a PREVIOUS day.
//         If yes → draw an arc from that previous day to this day.
//         Arc thickness = output_value_BTC of the original output tx.
// ─────────────────────────────────────────────────────────────────

const FLOW_CSV = "data_cleaned/bitcoin_filtered.csv";

const FLOW_PALETTE = [
    "#F7931A","#3B82F6","#10B981","#F43F5E","#A855F7",
    "#EAB308","#06B6D4","#FF6B35","#8B5CF6","#22D3EE",
    "#EC4899","#84CC16","#F97316","#14B8A6","#6366F1",
    "#FB7185","#34D399","#FBBF24","#60A5FA","#C084FC"
];

// ── called from main.js ───────────────────────────────────────────
async function initFlowChart() {
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.select("#dynamic-controls").selectAll("*").remove();
    d3.selectAll(".flow-tooltip").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p")
        .attr("class", "loading-text")
        .text("Loading UTXO flow data…");

    try {
        const raw = await d3.csv(FLOW_CSV, d => ({
            hash:        d.transaction_hash.trim(),
            time:        d.time.trim(),
            date:        d.time.trim().slice(0, 10),   // "YYYY-MM-DD"
            btc_out:     +d.output_value_BTC,
            out_address: d.output_address.trim(),
            tx_inputs:   +d.transaction_inputs,
            btc_in:      +d.total_input_value_BTC,
            in_addresses: d.input_addresses
                            .split(",")
                            .map(a => a.trim())
                            .filter(a => a.length > 0)
        }));

        if (!raw.length) throw new Error("CSV is empty or not found.");

        // ── build lookup: out_address → { date, btc_out, hash }
        const outputMap = new Map();
        raw.forEach(row => {
            if (!outputMap.has(row.out_address)) {
                outputMap.set(row.out_address, {
                    date:    row.date,
                    btc_out: row.btc_out,
                    hash:    row.hash,
                    addr:    row.out_address
                });
            }
        });

        // ── aggrega per coppia (date_from, date_to) — un solo arco per coppia
        const arcMap = new Map();

        raw.forEach(spendRow => {
            spendRow.in_addresses.forEach(inAddr => {
                const origin = outputMap.get(inAddr);
                if (!origin) return;                       // indirizzo non nei nostri output
                if (origin.date >= spendRow.date) return;  // deve essere un giorno precedente
            
                const key = `${origin.date}|${spendRow.date}`;
                if (!arcMap.has(key)) {
                    arcMap.set(key, {
                        date_from:   origin.date,
                        date_to:     spendRow.date,
                        btc:         0,
                        addresses:   [],
                        out_address: origin.addr,
                        hash_from:   origin.hash,
                        hash_to:     spendRow.hash
                    });
                }
                const entry = arcMap.get(key);
                entry.btc += origin.btc_out;
                entry.addresses.push({ addr: inAddr, btc: origin.btc_out });

            });
        });

        const arcs = Array.from(arcMap.values());

        chartArea.selectAll("*").remove();

        if (arcs.length === 0) {
            chartArea.append("p")
                .attr("class", "loading-text")
                .text("No cross-day UTXO flows found in this dataset.");
            return;
        }

        drawArcDiagram(chartArea, arcs);
        buildFlowSidebar(arcs, raw);

    } catch (err) {
        console.error("FlowChart error:", err);
        chartArea.html(`
            <div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;
                        border-radius:8px;margin:20px;background:rgba(244,63,94,0.06)">
                <b>Error loading UTXO flow data</b><br><br>${err.message}<br><br>
                <small style="opacity:0.7">
                    Expected: <code>data_cleaned/utxo_flow.csv</code><br>
                    Columns: transaction_hash, time, output_value_BTC, output_address,
                             transaction_inputs, total_input_value_BTC, input_addresses
                </small>
            </div>
        `);
    }
}

// ── sidebar filters ───────────────────────────────────────────────
function buildFlowSidebar(arcs, raw) {
    const container = d3.select("#filter-controls-container");
    container.selectAll("*").remove();

    const allDays     = [...new Set(arcs.flatMap(a => [a.date_from, a.date_to]))].sort();
    const btcValues   = arcs.map(a => a.btc);
    const minBtc      = Math.floor(d3.min(btcValues));
    const maxBtc      = Math.ceil(d3.max(btcValues));

    const lbl = txt => container.append("div")
        .style("font-size","10px").style("font-weight","600")
        .style("letter-spacing","0.08em").style("text-transform","uppercase")
        .style("color","var(--text-muted,#888)").style("margin","14px 0 5px")
        .text(txt);

    // address search
    lbl("Filter by address (input or output)");
    const addrInput = container.append("input")
        .attr("type","text").attr("placeholder","Input or output address…")
        .attr("class","filter-input")
        .style("width","100%").style("box-sizing","border-box");

    // exclude address
    lbl("Exclude address");
    const excludeInput = container.append("input")
        .attr("type","text").attr("placeholder","Address to exclude…")
        .attr("class","filter-input")
        .style("width","100%").style("box-sizing","border-box");

    // min BTC
    lbl("Min BTC (arc)");
    const minBtcInput = container.append("input")
        .attr("type","number").attr("value", minBtc)
        .attr("min", minBtc).attr("max", maxBtc)
        .attr("class","filter-input").style("width","100%");

    // max BTC
    lbl("Max BTC (arc)");
    const maxBtcInput = container.append("input")
        .attr("type","number").attr("value", maxBtc)
        .attr("min", minBtc).attr("max", maxBtc)
        .attr("class","filter-input").style("width","100%");

// stats box — defined FIRST so Apply can reference it
    const summaryDiv = container.append("div")
        .style("margin-top","20px").style("padding","10px")
        .style("background","rgba(247,147,26,0.07)")
        .style("border-radius","6px")
        .style("border","1px solid rgba(247,147,26,0.2)");

    summaryDiv.html(`
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;
                    letter-spacing:0.07em;color:#F7931A;margin-bottom:6px">Summary</div>
        <div style="font-size:11px;color:#333;line-height:1.9">
            Arcs found: <b style="color:#111">${arcs.length}</b><br>
            Unique addresses: <b style="color:#111">${new Set(arcs.flatMap(a => a.addresses.map(o => o.addr))).size}</b><br>
            Days spanned: <b style="color:#111">${allDays.length}</b><br>
            BTC range: <b style="color:#e07b00">${minBtc} – ${maxBtc}</b>
        </div>
    `);

    // apply button — comes AFTER summaryDiv so it can update it
    container.append("div").style("margin-top","16px")
        .append("button").attr("class","apply-btn")
        .style("width","100%").text("Apply")
        .on("click", () => {
            const query  = addrInput.property("value").trim().toLowerCase();
            const minB   = +minBtcInput.property("value");
            const maxB   = +maxBtcInput.property("value");

            const exclude = excludeInput.property("value").trim().toLowerCase();

            const filtered = arcs.map(a => {
                let addresses = a.addresses;

                if (exclude !== "") {
            if (a.out_address?.toLowerCase().includes(exclude)) return null;
            addresses = addresses.filter(o => !o.addr.toLowerCase().includes(exclude));
        }
                if (query !== "")
                    addresses = addresses.filter(o => o.addr.toLowerCase().includes(query));
            
                if (addresses.length === 0) return null;

                const btc = addresses.reduce((s, o) => s + o.btc, 0);
                if (btc < minB || btc > maxB) return null;

                return { ...a, addresses, btc };
            }).filter(Boolean);

            d3.selectAll(".flow-tooltip").remove();
            const chartArea = d3.select("#chart-area");
            chartArea.selectAll("*").remove();
            drawArcDiagram(chartArea, filtered);

            // update summary with filtered values
            const filteredMin  = filtered.length ? Math.floor(d3.min(filtered, a => a.btc)) : 0;
            const filteredMax  = filtered.length ? Math.ceil(d3.max(filtered, a => a.btc)) : 0;
            const filteredDays = [...new Set(filtered.flatMap(a => [a.date_from, a.date_to]))].length;

            summaryDiv.html(`
                <div style="font-size:10px;font-weight:600;text-transform:uppercase;
                            letter-spacing:0.07em;color:#F7931A;margin-bottom:6px">Summary</div>
                <div style="font-size:11px;color:#333;line-height:1.9">
                    Arcs found: <b style="color:#111">${filtered.length}</b><br>
                    Unique addresses: <b style="color:#111">${new Set(arcs.flatMap(a => a.addresses.map(o => o.addr))).size}</b><br>
                    Days spanned: <b style="color:#111">${filteredDays}</b><br>
                    BTC range: <b style="color:#e07b00">${filteredMin} – ${filteredMax}</b>
                </div>
            `);
        });
}

// ── helpers ───────────────────────────────────────────────────────
function fmtDay(dateStr) {
    // "2024-05-24" → "May 24"
    const [y, m, d] = dateStr.split("-").map(Number);
    const months = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[m-1]} ${d}`;
}

function daysBetween(a, b) {
    return Math.round(
        (new Date(b) - new Date(a)) / 86400000
    );
}

// ── draw arc diagram ──────────────────────────────────────────────
function drawArcDiagram(container, arcs) {
    if (!arcs.length) {
        container.append("p").attr("class","loading-text")
            .text("No arcs match current filters.");
        return;
    }

    // ── 1. collect all days that appear in arcs, sorted
    const daySet = [...new Set(
        arcs.flatMap(a => [a.date_from, a.date_to])
    )].sort();

    const dayIndex = new Map(daySet.map((d, i) => [d, i]));
    const n        = daySet.length;

    // ── 2. colour scale — one colour per day gap
    const gaps = [...new Set(arcs.map(a => daysBetween(a.date_from, a.date_to)))].sort((a,b) => a - b);
    const colorScale = d3.scaleOrdinal()
        .domain(gaps)
        .range(FLOW_PALETTE);
    // ── 3. thickness scale — based on BTC
    const btcExtent  = d3.extent(arcs, a => a.btc);
    const thickScale = d3.scaleLinear()
        .domain(btcExtent)
        .range([1.5, 12])
        .clamp(true);

    // ── 4. layout
    const containerW  = container.node()?.getBoundingClientRect().width || 900;
    const PAD_X       = 50;
    const nodeSpacing = Math.max(80, (containerW - PAD_X * 2) / Math.max(n - 1, 1));
    const svgW        = PAD_X * 2 + nodeSpacing * (n - 1);
    const svgH        = 380;
    const baselineY   = svgH - 90;   // nodes sit here
    const xPos        = i => PAD_X + i * nodeSpacing;

    // arc height proportional to day gap
    const maxGap     = d3.max(arcs, a => daysBetween(a.date_from, a.date_to)) || 1;
    const arcHScale  = d3.scaleLinear()
        .domain([1, Math.max(maxGap, 2)])
        .range([50, baselineY - 30])
        .clamp(true);

    // ── 5. SVG
    const svg = container.append("svg")
        .attr("width","100%")
        .attr("height", svgH)
        .attr("viewBox", `0 0 ${svgW} ${svgH}`)
        .style("overflow","visible")
        .style("display","block");

    const defs = svg.append("defs");

    // glow filter
    const glow = defs.append("filter").attr("id","fg-glow")
        .attr("x","-40%").attr("y","-40%")
        .attr("width","180%").attr("height","180%");
    glow.append("feGaussianBlur").attr("stdDeviation","4").attr("result","blur");
    const mg = glow.append("feMerge");
    mg.append("feMergeNode").attr("in","blur");
    mg.append("feMergeNode").attr("in","SourceGraphic");

    // ── 6. tooltip
    const tip = d3.select("body").append("div")
        .attr("class","flow-tooltip")
        .style("position","fixed").style("pointer-events","none")
        .style("opacity",0).style("z-index",9999)
        .style("background","rgba(8,8,14,0.95)")
        .style("border","1px solid rgba(255,255,255,0.12)")
        .style("border-radius","10px")
        .style("padding","12px 16px")
        .style("font-size","12px").style("color","#fff")
        .style("max-width","320px").style("word-break","break-all")
        .style("box-shadow","0 8px 32px rgba(0,0,0,0.6)");

    // ── 7. baseline
    svg.append("line")
        .attr("x1", xPos(0)).attr("x2", xPos(n - 1))
        .attr("y1", baselineY).attr("y2", baselineY)
        .attr("stroke","rgba(255,255,255,0.15)")
        .attr("stroke-width", 1.5);

    // ── 8. draw arcs
    let selectedKey = null;
    const arcGroup   = svg.append("g").attr("class","arc-group");

    const arcPaths = arcGroup.selectAll("path.flow-arc")
        .data(arcs)
        .enter()
        .append("path")
        .attr("class","flow-arc")
        .attr("d", a => {
            const x1 = xPos(dayIndex.get(a.date_from));
            const x2 = xPos(dayIndex.get(a.date_to));
            const h  = arcHScale(daysBetween(a.date_from, a.date_to));
            const cy = baselineY - h;
            // cubic bezier arc above the baseline
            return `M${x1},${baselineY} C${x1},${cy} ${x2},${cy} ${x2},${baselineY}`;
        })
        .attr("fill","none")
        .attr("stroke", a => colorScale(daysBetween(a.date_from, a.date_to)))
        .attr("stroke-width", a => thickScale(a.btc))
        .attr("stroke-linecap","round")
        .attr("opacity", 0.75)
        .style("cursor","pointer")
        // draw-on animation
        .each(function() {
            const len = this.getTotalLength();
            d3.select(this)
                .attr("stroke-dasharray", `${len} ${len}`)
                .attr("stroke-dashoffset", len)
                .transition().duration(900)
                .delay((_, i) => i * 50)
                .ease(d3.easeCubicOut)
                .attr("stroke-dashoffset", 0);
        })
        .on("mousemove", function(event, a) {
            d3.select(this).raise()
                .attr("opacity", 1)
                .attr("filter","url(#fg-glow)");
            tip.style("opacity", 1)
                .style("left", (event.clientX + 16) + "px")
                .style("top",  (event.clientY - 12) + "px")
                .html(`
                    <div style="color:${colorScale(daysBetween(a.date_from, a.date_to))};font-weight:700;
                                font-size:13px;margin-bottom:6px">
                        ${fmtDay(a.date_from)} → ${fmtDay(a.date_to)}
                    </div>
                    <div style="display:flex;gap:16px;align-items:baseline;margin-bottom:6px">
    <span style="font-size:15px;font-weight:800;color:#F7931A">
        ₿ ${a.btc.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}
    </span>
    <span style="opacity:0.5;font-size:11px">
        ${daysBetween(a.date_from, a.date_to)} day gap
    </span>
</div>
<div style="opacity:0.45;font-size:10px;font-family:monospace">
    ${a.addresses.length} address${a.addresses.length > 1 ? 'es' : ''} — ${a.addresses[0].addr.slice(0,16)}…${a.addresses.length > 1 ? ` +${a.addresses.length - 1} more` : ''}
</div>
                `);
        })
        .on("mouseleave", function(event, a) {
            tip.style("opacity", 0);
            if (selectedKey) {
            const key = `${a.date_from}|${a.date_to}`;
            d3.select(this)
                .attr("opacity", key === selectedKey ? 1 : 0.06)
                .attr("filter",  key === selectedKey ? "url(#fg-glow)" : null);
            } else {
                d3.select(this).attr("opacity", 0.75).attr("filter", null);
            }
        })
        .on("click", function(event, a) {
            event.stopPropagation();
            const key = `${a.date_from}|${a.date_to}`;
            if (selectedKey === key) {
                selectedKey = null;
                arcPaths.attr("opacity", 0.75).attr("filter", null);
            } else {
                selectedKey = key;
                arcPaths
                    .attr("opacity", d => `${d.date_from}|${d.date_to}` === key ? 1 : 0.06)
                    .attr("filter",  d => `${d.date_from}|${d.date_to}` === key ? "url(#fg-glow)" : null);
            }
        });

    // click empty space = deselect
    svg.on("click", () => {
        selectedKey = null;
        arcPaths.attr("opacity", 0.75).attr("filter", null);
    });



    // ── 10. day nodes
    const nodeR   = 18;
    const nodeGrp = svg.append("g").attr("class","node-group");

    daySet.forEach((day, i) => {
        const x        = xPos(i);
        const hasArcs  = arcs.some(a => a.date_from === day || a.date_to === day);
        const isSource = arcs.some(a => a.date_from === day);
        const isTarget = arcs.some(a => a.date_to   === day);

        // outer glow ring for active nodes
        if (hasArcs) {
            nodeGrp.append("circle")
                .attr("cx", x).attr("cy", baselineY).attr("r", nodeR + 7)
                .attr("fill","none")
                .attr("stroke","#F7931A").attr("stroke-width", 1)
                .attr("opacity", 0.20);
        }

        // main node circle
        nodeGrp.append("circle")
            .attr("cx", x).attr("cy", baselineY)
            .attr("r", 0)
            .attr("fill", hasArcs ? "rgba(247,147,26,0.12)" : "rgba(255,255,255,0.04)")
            .attr("stroke", hasArcs ? "#F7931A" : "rgba(255,255,255,0.2)")
            .attr("stroke-width", hasArcs ? 1.5 : 1)
            .transition().duration(300).delay(600 + i * 30)
            .attr("r", nodeR);

        // ₿ symbol
        nodeGrp.append("text")
            .attr("x", x).attr("y", baselineY)
            .attr("text-anchor","middle").attr("dominant-baseline","central")
            .attr("font-size","11px")
            .attr("fill", hasArcs ? "#F7931A" : "rgba(255,255,255,0.2)")
            .attr("opacity", 0)
            .text("₿")
            .transition().delay(750 + i * 30).duration(200)
            .attr("opacity", 1);

        // day label below
        nodeGrp.append("text")
            .attr("x", x).attr("y", baselineY + nodeR + 16)
            .attr("text-anchor","middle")
            .attr("font-size","10px").attr("font-weight","600")
            .attr("fill", hasArcs ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.3)")
            .text(fmtDay(day));

        // small role badge
        const role = isSource && isTarget ? "src+dst"
                   : isSource             ? "source"
                   : isTarget             ? "dest"
                   : "";
        if (role) {
            nodeGrp.append("text")
                .attr("x", x).attr("y", baselineY + nodeR + 28)
                .attr("text-anchor","middle")
                .attr("font-size","8px")
                .attr("fill","rgba(247,147,26,0.6)")
                .text(role);
        }

        nodeGrp.append("circle")
            .attr("cx", x).attr("cy", baselineY).attr("r", nodeR + 7)
            .attr("fill", "transparent")
            .attr("stroke", "none")
            .style("cursor", "pointer")
            .on("click", (event) => {
                event.stopPropagation();
                if (selectedKey === `node|${day}`) {
                    selectedKey = null;
                    arcPaths.attr("opacity", 0.75).attr("filter", null);
                } else {
                    selectedKey = `node|${day}`;
                    arcPaths
                        .attr("opacity", d => (d.date_from === day || d.date_to === day) ? 1 : 0.06)
                        .attr("filter",  d => (d.date_from === day || d.date_to === day) ? "url(#fg-glow)" : null);
                }
            });

    });

    // ── 11. legend — one entry per gap size
const legendG = svg.append("g").attr("transform",`translate(10, ${svgH - 20})`);

gaps.forEach((gap, i) => {
    const lg = legendG.append("g").attr("transform", `translate(${i * 120}, 0)`);
    if (i * 120 + 110 > svgW) return;
    lg.append("line")
        .attr("x1", 0).attr("x2", 22).attr("y1", 0).attr("y2", 0)
        .attr("stroke", colorScale(gap)).attr("stroke-width", 3)
        .attr("stroke-linecap","round");
    lg.append("text")
        .attr("x", 26).attr("y", 4)
        .attr("font-size","10px")
        .attr("fill","#333")
        .text(`${gap} day${gap > 1 ? 's' : ''} gap`);
});

   
}
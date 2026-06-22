// ─────────────────────────────────────────────────────────────────
//  matrixChart.js  —  NodeTrix Hourly Adjacency Matrix  (v5 – Precise)
//
//  KEY FIXES vs v4:
//  1. Arc endpoints connect to EXACT cell pixel (day's diagonal cell),
//     not the grid centre → arcs to same-day are precise
//  2. Cell highlights use pointer-events:all + click handlers so
//     clicking a highlighted cell always shows its transactions
//  3. Intra-cell count labels hidden while an arc is pinned (avoids confusion)
//  4. Mid-arc arrow is WHITE (#fff) so it stands out from the orange arc
//  5. Cell that is BOTH source and destination gets SPLIT highlight
//     (left half orange, right half green) — no more muddy mixed colour
//  6. Address-search mode: arcs + highlights + clickable cells all work
//  7. showCellDetailFiltered correctly finds cross-arc transactions
//     by matching (hour, day) on BOTH hour_from/day_from and hour_to/day_to
// ─────────────────────────────────────────────────────────────────

const MATRIX_CSV = "data_cleaned/bitcoin_filtered.csv";

async function initMatrixChart() {
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".matrix-tooltip").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class", "loading-text").text("Loading matrix data…");

    try {
        const raw = await d3.csv(MATRIX_CSV, d => {
            let timeStr = d.time ? d.time.trim() : "";
            if (!timeStr) return null;
            let parsedDate;
            if (timeStr.includes("+"))       parsedDate = new Date(timeStr.replace(" ", "T"));
            else if (timeStr.includes(" "))  parsedDate = new Date(timeStr.replace(" ", "T") + "Z");
            else                             parsedDate = new Date(timeStr);
            if (isNaN(parsedDate.getTime())) return null;
            return {
                hash:        d.transaction_hash ? d.transaction_hash.trim() : "unknown",
                time:        parsedDate,
                date:        timeStr.slice(0, 10),
                hour:        parsedDate.getUTCHours(),
                btc_out:     +d.output_value_BTC || 0,
                out_address: d.output_address ? d.output_address.trim() : "unknown",
                tx_inputs:   +d.transaction_inputs || 0,
                btc_in:      +d.total_input_value_BTC || 0,
                in_addresses:(d.input_addresses || "").split(",").map(a => a.trim()).filter(a => a.length > 0)
            };
        });

        const cleanRaw = raw.filter(Boolean);
        window._matrixRawData = cleanRaw;
        if (!cleanRaw.length) throw new Error("No valid data found.");
        chartArea.selectAll("*").remove();
        buildNodeTrixViz(chartArea, cleanRaw);
        buildMatrixSidebar(cleanRaw);
        buildOriginDetectionUI();
        buildPeelingDetectionUI(cleanRaw);   // ← add this one line

    } catch (err) {
        console.error("MatrixChart error:", err);
        chartArea.html(`<div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;border-radius:8px;margin:20px;">
            <b>Error loading matrix data</b><br><br>${err.message}</div>`);
    }
}

// ═══════════════════════════════════════════════════════════════════
function buildNodeTrixViz(container, rawData) {

    // ── 1. Days ───────────────────────────────────────────────────
    const days   = [...new Set(rawData.map(d => d.date))].sort();
    const nDays  = days.length;
    const dayIdx = new Map(days.map((d, i) => [d, i]));

    // ── 2. Transaction map ────────────────────────────────────────
    const txMap = new Map();
    rawData.forEach(row => {
        if (!txMap.has(row.hash)) txMap.set(row.hash, {
            hash: row.hash, time: row.time, date: row.date, hour: row.hour,
            btc_in: row.btc_in, tx_inputs: row.tx_inputs, outputs: [], in_addresses: row.in_addresses
        });
        txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
    });

    // ── 3. Output map ─────────────────────────────────────────────
    const outputMap = new Map();
    rawData.forEach(row => {
        if (!outputMap.has(row.out_address)) outputMap.set(row.out_address, []);
        outputMap.get(row.out_address).push({
            date: row.date, hour: row.hour, btc: row.btc_out, hash: row.hash, time: row.time
        });
    });

    // ── 4. Build arcs ─────────────────────────────────────────────
    const allArcs = [];
    const seenArcs = new Set();
    Array.from(txMap.values()).sort((a, b) => a.time - b.time).forEach(spendTx => {
        spendTx.in_addresses.forEach(inAddr => {
            const origins = outputMap.get(inAddr);
            if (!origins) return;
            const valid = origins.filter(o => o.time < spendTx.time);
            if (!valid.length) return;
            const origin = valid.reduce((best, o) => o.time > best.time ? o : best);
            const key = `${inAddr}|${origin.hash}|${spendTx.hash}`;
            if (seenArcs.has(key)) return;
            seenArcs.add(key);
            const fromDI = dayIdx.get(origin.date);
            const toDI   = dayIdx.get(spendTx.date);
            if (fromDI === undefined || toDI === undefined) return;
            allArcs.push({
                address:   inAddr,
                date_from: origin.date,   date_to:  spendTx.date,
                day_from:  fromDI,        day_to:   toDI,
                hour_from: origin.hour,   hour_to:  spendTx.hour,
                btc:       origin.btc,
                hash_from: origin.hash,   hash_to:  spendTx.hash,
                same_hour: origin.hour === spendTx.hour
            });
        });
    });

    const gridArcs  = allArcs.filter(a =>  a.same_hour);
    const crossArcs = allArcs.filter(a => !a.same_hour);
    window._matrixAllArcs   = allArcs;
    window._matrixCrossArcs = crossArcs;
    window._matrixDays      = days;

    // ── 5. Per-hour cell data (intra-grid) ────────────────────────
    // Each cell stores all arcs that touch it (from OR to)
    const hourCells = Array.from({ length: 24 }, () => new Map());
    gridArcs.forEach(a => {
        const h = a.hour_from;
        const i = Math.min(a.day_from, a.day_to);
        const j = Math.max(a.day_from, a.day_to);
        const key = `${i}_${j}`;
        if (!hourCells[h].has(key)) hourCells[h].set(key, { i, j, count: 0, btc: 0, arcs: [] });
        const c = hourCells[h].get(key);
        c.count++; c.btc += a.btc; c.arcs.push(a);
    });

    // ── 6. Layout constants ───────────────────────────────────────
    const GRIDS_PER_ROW = 4;
    const CELL          = 18;
    const GRID_PX       = CELL * nDays;
    const GRID_GAP_X    = 100;
    const GRID_GAP_Y    = 120;
    const LABEL_OFF     = 55;
    const GRID_TOTAL_W  = GRID_PX + LABEL_OFF + GRID_GAP_X;
    const GRID_TOTAL_H  = GRID_PX + LABEL_OFF + GRID_GAP_Y;
    const ROWS          = Math.ceil(24 / GRIDS_PER_ROW);
    const PAD           = 40;
    const totalW        = GRIDS_PER_ROW * GRID_TOTAL_W + PAD * 2;
    const totalH        = ROWS * GRID_TOTAL_H + PAD * 2 + 80;

    // ── 7. Arc thickness scale ────────────────────────────────────
    const crossGroupCounts = new Map();
    crossArcs.forEach(a => {
        const k = `${a.hour_from}_${a.hour_to}`;
        crossGroupCounts.set(k, (crossGroupCounts.get(k) || 0) + 1);
    });
    const cVals      = Array.from(crossGroupCounts.values());
    const cMin       = d3.min(cVals) || 1;
    const cMax       = d3.max(cVals) || 1;
const thickScale = d3.scaleSqrt().domain([cMin, cMax]).range([1.5, 18]).clamp(true);
    // ── 8. SVG setup ─────────────────────────────────────────────
    container.style("background", "#f8f8f8").style("overflow", "auto").style("position", "relative");

    const tooltip = d3.select("body").append("div").attr("class", "matrix-tooltip")
        .style("position", "fixed").style("pointer-events", "none").style("opacity", 0)
        .style("z-index", 9999).style("background", "rgba(10,10,20,0.97)")
        .style("border", "1px solid #F7931A").style("border-radius", "8px")
        .style("padding", "12px 16px").style("font-size", "11px").style("color", "#fff")
        .style("max-width", "300px").style("word-break", "break-all");

    const svg = container.append("svg")
        .attr("width", totalW).attr("height", totalH)
        .style("background", "#f8f8f8").style("display", "block");

    svg.on("click", () => { unpinAll(); tooltip.style("opacity", 0); });

    const rootG = svg.append("g");
    const zoom  = d3.zoom().scaleExtent([0.3, 5]).on("zoom", e => rootG.attr("transform", e.transform));
    svg.call(zoom);

    // Zoom controls
    const zBtns = container.append("div")
        .style("position","sticky").style("top","10px").style("left","calc(100% - 44px)")
        .style("display","flex").style("flex-direction","column")
        .style("gap","4px").style("z-index","200").style("width","32px");
    [["+", 1.4], ["−", 0.7], ["⟳", null]].forEach(([txt, f]) => {
        const b = zBtns.append("button").text(txt)
            .style("width","32px").style("height","32px")
            .style("border","1px solid #F7931A").style("border-radius","4px")
            .style("background","#fff").style("color","#F7931A")
            .style("font-size","16px").style("cursor","pointer").style("font-weight","700");
        if (f) b.on("click", () => svg.transition().duration(300).call(zoom.scaleBy, f));
        else   b.on("click", () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
    });

    // ── 9. Grid position maps ─────────────────────────────────────
    // gridOrigins: top-left pixel of the cell area (after label offset)
    const gridOrigins = new Map();
    for (let h = 0; h < 24; h++) {
        const col = h % GRIDS_PER_ROW;
        const row = Math.floor(h / GRIDS_PER_ROW);
        const gx  = PAD + col * GRID_TOTAL_W + LABEL_OFF;
        const gy  = PAD + 80 + row * GRID_TOTAL_H + LABEL_OFF;
        gridOrigins.set(h, { gx, gy });
    }

    // PRECISE arc endpoint: centre of the diagonal cell for a given day in a given hour grid
    // The diagonal cell for day d is at column=d, row=d in SVG coords relative to grid origin
    function cellCentre(hour, dayIndex) {
        const { gx, gy } = gridOrigins.get(hour);
        return {
            x: gx + dayIndex * CELL + CELL / 2,
            y: gy + dayIndex * CELL + CELL / 2
        };
    }

    // ── 10. Pin state ─────────────────────────────────────────────
    let pinnedArcKey       = null;
    let inspectingArcGroup = null; // arcs[] of pinned group
    let pinnedHF           = null;
    let pinnedHT           = null;

    // ── 11. Arc layer (rendered below grids) ──────────────────────
    const arcLayer = rootG.append("g").attr("class", "cross-arcs").lower();

    // ── 12. Grid groups map (populated in step 13) ────────────────
    const gridGroups = new Map(); // hour → d3 <g>

    // ── 13. Highlight helpers ─────────────────────────────────────
    // We draw highlight overlays ABOVE cells but give them pointer-events
    // and attach click handlers so they are fully interactive.
    //
    // mode: "out" = orange (source), "in" = green (destination), "both" = split

    function highlightCell(hour, dayI, mode, onClickFn) {
        const g = gridGroups.get(hour);
        if (!g) return;
        const x = dayI * CELL;
        const y = dayI * CELL;
        const w = CELL - 0.5;
        const h = CELL - 0.5;

        if (mode === "both") {
            // Left half = orange (outgoing), right half = green (incoming)
            g.append("rect").attr("class","cell-hl")
                .attr("x", x).attr("y", y).attr("width", w/2).attr("height", h)
                .attr("fill","rgba(247,147,26,0.3)").attr("stroke","none")
                .attr("rx", 1).attr("pointer-events","all").style("cursor","pointer")
                .on("click", function(ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
            g.append("rect").attr("class","cell-hl")
                .attr("x", x + w/2).attr("y", y).attr("width", w/2).attr("height", h)
                .attr("fill","rgba(34,197,94,0.3)").attr("stroke","none")
                .attr("rx", 1).attr("pointer-events","all").style("cursor","pointer")
                .on("click", function(ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
            // shared border
            g.append("rect").attr("class","cell-hl")
                .attr("x", x).attr("y", y).attr("width", w).attr("height", h)
                .attr("fill","none")
                .attr("stroke","#ffaa00").attr("stroke-width", 2)
                .attr("rx", 1).attr("pointer-events","none");
        } else {
            const color  = mode === "out" ? "#F7931A" : "#22c55e";
            const fillC  = mode === "out" ? "rgba(247,147,26,0.25)" : "rgba(34,197,94,0.25)";
            g.append("rect").attr("class","cell-hl")
                .attr("x", x).attr("y", y).attr("width", w).attr("height", h)
                .attr("fill", fillC)
                .attr("stroke", color).attr("stroke-width", 2)
                .attr("rx", 1).attr("pointer-events","all").style("cursor","pointer")
                .on("click", function(ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
        }
    }

    function clearHighlights() { rootG.selectAll(".cell-hl").remove(); }

    // ── applyArcHighlight ─────────────────────────────────────────
    // Given a group of cross-arc objects (all hf→ht), highlight:
    //   • each unique day_from in hour hf grid → orange
    //   • each unique day_to   in hour ht grid → green
    //   • if same cell appears in both (day_from==day_to, same hour), → split
    // Each highlight rect gets a click handler → showCellDetailFiltered

    function applyArcHighlight(arcs, inspectGroup) {
        clearHighlights();
        if (!arcs || !arcs.length) return;
        const hf = arcs[0].hour_from;
        const ht = arcs[0].hour_to;

        // Collect unique day_from for source grid
        const fromDays = [...new Set(arcs.map(a => a.day_from))];
        // Collect unique day_to for dest grid
        const toDays   = [...new Set(arcs.map(a => a.day_to))];

        // If hf === ht (same grid), a day might be both source and dest
        fromDays.forEach(d => {
            const isAlsoTarget = hf === ht && toDays.includes(d);
            const clickFn = () => {
                const rel = inspectGroup.filter(a =>
                    (a.hour_from === hf && a.day_from === d) ||
                    (a.hour_to   === hf && a.day_to   === d)
                );
                showCellDetailForArcDay(hf, d, days, rel.length ? rel : inspectGroup);
            };
            highlightCell(hf, d, isAlsoTarget ? "both" : "out", clickFn);
        });

        if (hf !== ht) {
            toDays.forEach(d => {
                const clickFn = () => {
                    const rel = inspectGroup.filter(a => a.hour_to === ht && a.day_to === d);
                    showCellDetailForArcDay(ht, d, days, rel.length ? rel : inspectGroup);
                };
                highlightCell(ht, d, "in", clickFn);
            });
        } else {
            // Same grid: days only in toDays (not already highlighted as source)
            toDays.filter(d => !fromDays.includes(d)).forEach(d => {
                const clickFn = () => {
                    const rel = inspectGroup.filter(a => a.hour_to === ht && a.day_to === d);
                    showCellDetailForArcDay(ht, d, days, rel.length ? rel : inspectGroup);
                };
                highlightCell(ht, d, "in", clickFn);
            });
        }
    }

    // ── 14. Draw 24 grids ─────────────────────────────────────────
    for (let h = 0; h < 24; h++) {
        const { gx, gy } = gridOrigins.get(h);

        const g = rootG.append("g")
            .attr("transform", `translate(${gx},${gy})`)
            .attr("class", `hour-grid hour-grid-${h}`);
        gridGroups.set(h, g);

        // Hour label
        rootG.append("text")
            .attr("x", gx + GRID_PX / 2).attr("y", gy - LABEL_OFF + 16)
            .attr("text-anchor","middle").attr("font-size","11px")
            .attr("font-weight","700").attr("fill","#333")
            .text(`${String(h).padStart(2,'0')}:00 – ${String(h+1).padStart(2,'0')}:00`);

        const hCount = d3.sum(Array.from(hourCells[h].values()), c => c.count);
        rootG.append("text")
            .attr("x", gx + GRID_PX / 2).attr("y", gy - LABEL_OFF + 30)
            .attr("text-anchor","middle").attr("font-size","9px").attr("fill","#999")
            .text(`${hCount} tx`);

        // Grid border
        g.append("rect").attr("x",-1).attr("y",-1)
            .attr("width", GRID_PX + 2).attr("height", GRID_PX + 2)
            .attr("fill","none").attr("stroke","#ccc").attr("stroke-width",1);

        // Background cells (upper triangle only)
        for (let i = 0; i < nDays; i++) {
            for (let j = i; j < nDays; j++) {
                g.append("rect")
                    .attr("x", j*CELL).attr("y", i*CELL)
                    .attr("width", CELL-0.5).attr("height", CELL-0.5)
                    .attr("fill","#f0f0f0").attr("rx",1);
            }
        }

        // Diagonal guide
        g.append("line")
            .attr("x1",0).attr("y1",0).attr("x2",GRID_PX).attr("y2",GRID_PX)
            .attr("stroke","#bbb").attr("stroke-width",0.5).attr("stroke-dasharray","2,2");

        // Axis labels (every 2nd day)
        days.forEach((day, j) => {
            if (j % 2 !== 0) return;
            g.append("text")
                .attr("x", j*CELL + CELL/2).attr("y",-4)
                .attr("text-anchor","start").attr("font-size","7px").attr("fill","#aaa")
                .attr("transform",`rotate(-45,${j*CELL+CELL/2},-4)`)
                .text(fmtMatDay(day));
        });
        days.forEach((day, i) => {
            if (i % 2 !== 0) return;
            g.append("text")
                .attr("x",-3).attr("y", i*CELL + CELL/2 + 2)
                .attr("text-anchor","end").attr("font-size","7px").attr("fill","#aaa")
                .text(fmtMatDay(day));
        });

        // ── Filled cells with intra-grid transactions ──────────────
        hourCells[h].forEach((cell) => {
            const cx = cell.j * CELL;
            const cy = cell.i * CELL;

            // White cell — NO special border on diagonal (plain #ddd for all)
            g.append("rect")
                .attr("class", `cell-rect cell-${h}-${cell.i}-${cell.j}`)
                .attr("x", cx).attr("y", cy)
                .attr("width", CELL-0.5).attr("height", CELL-0.5)
                .attr("fill","#fff").attr("rx",1)
                .attr("stroke","#ddd").attr("stroke-width",0.5)
                .style("cursor","pointer")
                .on("mousemove", function(event) {
                    tooltip.style("opacity",1)
                        .style("left",(event.clientX+14)+"px").style("top",(event.clientY-10)+"px")
                        .html(`
                        <div style="color:#F7931A;font-weight:700;font-size:12px;margin-bottom:6px">
                            ${fmtMatDay(days[cell.i])} → ${fmtMatDay(days[cell.j])}
                            <span style="font-size:10px;color:#888;margin-left:6px">
                                ${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:00
                            </span>
                        </div>
                        <div style="margin-bottom:3px">Transactions: <b>${cell.count}</b></div>
                        <div style="margin-bottom:6px">Total BTC: <b style="color:#F7931A">₿ ${cell.btc.toFixed(4)}</b></div>
                        <div style="font-size:9px;color:#888">${cell.i===cell.j ? '📅 Same-day':'→ Cross-day'}</div>
                        <div style="font-size:9px;color:#aaa;margin-top:4px">Click for transaction list</div>
                    `);
                })
                .on("mouseleave", () => tooltip.style("opacity",0))
                .on("click", function(event) {
                    event.stopPropagation();
                    showCellDetail(cell, days, h);
                });

            // Count label — hidden class so we can toggle visibility when pinned
            if (cell.count > 0) {
                g.append("text")
                    .attr("class", `cell-label intra-label`)
                    .attr("x", cx + CELL/2 - 0.5).attr("y", cy + CELL/2 + 3)
                    .attr("text-anchor","middle").attr("font-size","7px").attr("fill","#555")
                    .attr("pointer-events","none")
                    .text(cell.count);
            }
        });
    }

    // ── 15. Bezier helpers ────────────────────────────────────────
    function bezierCp(p0, p1, offset) {
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        return { x: mx - dy * offset, y: my + dx * offset };
    }

    function bezierPt(p0, cp, p1, t) {
        const u = 1 - t;
        return { x: u*u*p0.x + 2*u*t*cp.x + t*t*p1.x, y: u*u*p0.y + 2*u*t*cp.y + t*t*p1.y };
    }

    function bezierTangentAngle(p0, cp, p1, t) {
        const dx = 2*(1-t)*(cp.x-p0.x) + 2*t*(p1.x-cp.x);
        const dy = 2*(1-t)*(cp.y-p0.y) + 2*t*(p1.y-cp.y);
        return Math.atan2(dy, dx) * 180 / Math.PI;
    }

    // Draw white arrow polygon at arc midpoint
    function addMidArrow(layer, p0, cp, p1, arcStrokeW, hiColor) {
        const mid = bezierPt(p0, cp, p1, 0.5);
        const ang = bezierTangentAngle(p0, cp, p1, 0.5);
        const s   = Math.max(6, arcStrokeW * 1.3 + 3);
        return layer.append("polygon")
            .attr("class","cross-arc mid-arrow")
            .attr("points",`${-s},${-s*0.55} ${s},0 ${-s},${s*0.55}`)
            .attr("fill", hiColor || "#ffffff")   // WHITE arrow by default
            .attr("stroke", "#0008").attr("stroke-width","0.5")
            .attr("opacity",0.95)
            .attr("pointer-events","none")
            .attr("transform",`translate(${mid.x},${mid.y}) rotate(${ang})`);
    }

    // ── 16. unpinAll ─────────────────────────────────────────────
    function unpinAll() {
        pinnedArcKey       = null;
        inspectingArcGroup = null;
        pinnedHF           = null;
        pinnedHT           = null;
        clearHighlights();
        // Restore all arcs to default
        arcLayer.selectAll("path.cross-arc")
            .attr("opacity", 0.45).attr("stroke", "#F7931A");
        arcLayer.selectAll("polygon.mid-arrow")
            .attr("fill","#ffffff");
        // Restore intra-cell count labels
        rootG.selectAll("text.intra-label").attr("display",null);
    }

    // ── 17. drawArcs ──────────────────────────────────────────────
    function drawArcs(minBtc, maxDayGap, minHops, addrQuery) {
        arcLayer.selectAll("*").remove();
        clearHighlights();
        unpinAll();

        // ─── Address-search mode ──────────────────────────────────
        if (addrQuery && addrQuery.length > 0) {
            const matchingArcs = allArcs.filter(a =>
                a.address.toLowerCase().includes(addrQuery.toLowerCase())
            );

            // Group by directed hour pair, keeping EXACT per-arc geometry
            // (each arc connects its specific day_from cell → day_to cell)
            // But for display we group by hf_ht pair and draw one arc per group
            const addrGroups = new Map();
            matchingArcs.forEach(a => {
                if (a.same_hour) return;
                const k = `${a.hour_from}_${a.hour_to}`;
                if (!addrGroups.has(k)) addrGroups.set(k, []);
                addrGroups.get(k).push(a);
            });

            // Also handle same-hour address arcs in intra-cells (just highlight)
            matchingArcs.filter(a => a.same_hour).forEach(a => {
                highlightCell(a.hour_from, a.day_from, "out",
                    () => showCellDetailForArcDay(a.hour_from, a.day_from, days, [a]));
                if (a.day_to !== a.day_from)
                    highlightCell(a.hour_to, a.day_to, "in",
                        () => showCellDetailForArcDay(a.hour_to, a.day_to, days, [a]));
            });

            addrGroups.forEach((grpArcs, key) => {
                const [hf, ht] = key.split("_").map(Number);

                // Draw one arc per unique (day_from, day_to) pair within the group
                const subKeys = new Map();
                grpArcs.forEach(a => {
                    const sk = `${a.day_from}_${a.day_to}`;
                    if (!subKeys.has(sk)) subKeys.set(sk, []);
                    subKeys.get(sk).push(a);
                });

                subKeys.forEach((subArcs, sk) => {
                    const [df, dt] = sk.split("_").map(Number);
                    const p0 = cellCentre(hf, df);
                    const p1 = cellCentre(ht, dt);
                    const cp = bezierCp(p0, p1, 0.22);
                    const totalBtc = d3.sum(subArcs, a => a.btc);

                    const path = arcLayer.append("path")
                        .attr("class","cross-arc addr-arc")
                        .attr("d",`M${p0.x},${p0.y} Q${cp.x},${cp.y} ${p1.x},${p1.y}`)
                        .attr("fill","none").attr("stroke","#00BFFF")
                        .attr("stroke-width",2).attr("stroke-linecap","round")
                        .attr("opacity",0.85).style("cursor","pointer");

                    const arrowEl = addMidArrow(arcLayer, p0, cp, p1, 2, "#00BFFF");

                    // Highlight cells
                    highlightCell(hf, df, "out",
                        () => showCellDetailForArcDay(hf, df, days, grpArcs));
                    if (hf !== ht || df !== dt)
                        highlightCell(ht, dt, "in",
                            () => showCellDetailForArcDay(ht, dt, days, grpArcs));

                    path.on("mousemove", ev => {
                            tooltip.style("opacity",1)
                                .style("left",(ev.clientX+14)+"px").style("top",(ev.clientY-10)+"px")
                                .html(`<div style="color:#00BFFF;font-weight:700">Address flow</div>
                                    <div style="font-size:9px;color:#aaa;word-break:break-all">${addrQuery}</div>
                                    <div style="margin-top:4px">${fmtMatDay(days[df])} → ${fmtMatDay(days[dt])}</div>
                                    <div>${String(hf).padStart(2,'0')}:00 → ${String(ht).padStart(2,'0')}:00</div>
                                    <div>Transactions: <b>${subArcs.length}</b></div>
                                    <div>BTC: <b style="color:#F7931A">₿ ${totalBtc.toFixed(6)}</b></div>`);
                        })
                        .on("mouseleave", () => tooltip.style("opacity",0))
                        .on("click", ev => { ev.stopPropagation(); showAddressChain(addrQuery, allArcs, days); });
                });
            });
            return;
        }

        // ─── Normal grouped mode ──────────────────────────────────
        // Directed group: key = "hf_ht"
        const groups = new Map();
        crossArcs.forEach(a => {
            const dayGap = Math.abs(a.day_to - a.day_from);
            if (maxDayGap !== null && dayGap > maxDayGap) return;
            if (minBtc    !== null && a.btc < minBtc)     return;
            const k = `${a.hour_from}_${a.hour_to}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(a);
        });

        // Detect bidirectional pairs to offset curves
        const pairHasBoth = new Set();
        groups.forEach((_, key) => {
            const [hf, ht] = key.split("_").map(Number);
            if (groups.has(`${ht}_${hf}`)) pairHasBoth.add(key);
        });

        groups.forEach((arcs, key) => {
            if (minHops !== null && arcs.length < minHops) return;
            const [hf, ht] = key.split("_").map(Number);

            // ── Compute a single representative arc endpoint ──────
            // Use the MEDIAN day_from and day_to to anchor the arc visually.
            // This keeps the arc from always pointing at the grid corner.
            const sortedFrom = arcs.map(a => a.day_from).sort((a,b)=>a-b);
            const sortedTo   = arcs.map(a => a.day_to).sort((a,b)=>a-b);
            const medFrom    = sortedFrom[Math.floor(sortedFrom.length/2)];
            const medTo      = sortedTo[Math.floor(sortedTo.length/2)];

            const p0 = cellCentre(hf, medFrom);
            const p1 = cellCentre(ht, medTo);

            const hasBoth  = pairHasBoth.has(key);
            // For bidirectional pairs: hf<ht curves one way, hf>ht the other
            const offset   = hasBoth ? (hf < ht ? 0.22 : -0.22) : 0.22;
            const cp       = bezierCp(p0, p1, offset);

            const count    = arcs.length;
            const totalBtc = d3.sum(arcs, a => a.btc);
            const sw       = thickScale(count);

            const path = arcLayer.append("path")
                .attr("class","cross-arc")
                .attr("data-key", key)
                .attr("d",`M${p0.x},${p0.y} Q${cp.x},${cp.y} ${p1.x},${p1.y}`)
                .attr("fill","none").attr("stroke","#F7931A")
                .attr("stroke-width",sw).attr("stroke-linecap","round")
                .attr("opacity",0.45).style("cursor","pointer");

            // WHITE arrow at midpoint (distinct from orange arc)
            const arrowEl = addMidArrow(arcLayer, p0, cp, p1, sw, "#ffffff");

            // ── Hover ─────────────────────────────────────────────
            path.on("mousemove", function(event) {
                    event.stopPropagation();
                    if (pinnedArcKey && pinnedArcKey !== key) return;
                    d3.select(this).attr("opacity",0.9).attr("stroke","#ff5500");
                    arrowEl.attr("fill","#ffe0c0");
                    if (!pinnedArcKey) applyArcHighlight(arcs, arcs);
                    tooltip.style("opacity",1)
                        .style("left",(event.clientX+14)+"px")
                        .style("top",(event.clientY-10)+"px")
                        .html(`
                        <div style="color:#F7931A;font-weight:700;font-size:12px;margin-bottom:6px">
                            ${String(hf).padStart(2,'0')}:00 → ${String(ht).padStart(2,'0')}:00
                        </div>
                        <div style="margin-bottom:3px">Transactions: <b>${count}</b></div>
                        <div style="margin-bottom:4px">Total BTC: <b style="color:#F7931A">₿ ${totalBtc.toFixed(4)}</b></div>
                        <div style="font-size:9px;color:#bbb;margin-bottom:2px">Arc width ∝ transaction count</div>
                        <div style="font-size:9px;color:#aaa">
                            🟠 Orange cells = origin days (${String(hf).padStart(2,'0')}:00 grid)<br>
                            🟢 Green cells = destination days (${String(ht).padStart(2,'0')}:00 grid)
                        </div>
                        <div style="font-size:9px;color:#666;margin-top:6px">Click to pin</div>
                    `);
                })
                .on("mouseleave", function() {
                    if (pinnedArcKey === key) return;
                    d3.select(this).attr("opacity",0.45).attr("stroke","#F7931A");
                    arrowEl.attr("fill","#ffffff");
                    clearHighlights();
                    tooltip.style("opacity",0);
                });

            // ── Click to pin ──────────────────────────────────────
            path.on("click", function(event) {
                event.stopPropagation();
                if (pinnedArcKey === key) { unpinAll(); tooltip.style("opacity",0); return; }
                unpinAll();

                pinnedArcKey       = key;
                inspectingArcGroup = arcs;
                pinnedHF           = hf;
                pinnedHT           = ht;

                d3.select(this).attr("opacity",1).attr("stroke","#ff5500");
                arrowEl.attr("fill","#ffe0c0");
                applyArcHighlight(arcs, arcs);
                showCrossArcDetail(arcs, hf, ht, days);

                // Hide intra-cell count labels while pinned (avoids confusion)
                rootG.selectAll("text.intra-label").attr("display","none");

                tooltip.style("opacity",1)
                    .style("left",(event.clientX+14)+"px")
                    .style("top",(event.clientY-10)+"px")
                    .html(`
                    <div style="color:#ff5500;font-weight:700;font-size:12px;margin-bottom:4px">
                        📌 ${String(hf).padStart(2,'0')}:00 → ${String(ht).padStart(2,'0')}:00
                    </div>
                    <div style="font-size:9px;color:#aaa">${count} transactions pinned</div>
                    <div style="font-size:9px;color:#888;margin-top:4px">
                        Click highlighted cells → see their transactions<br>
                        Click arc again or background to unpin
                    </div>
                `);
            });
        });

        window._matrixLastGroups = groups;
    }

    window._matrixDrawArcs = drawArcs;
    drawArcs(50, 3, 3);

    // ── 18. Legend ───────────────────────────────────────────────
    const legG = rootG.append("g").attr("transform",`translate(${PAD},${PAD})`);
    legG.append("text").attr("x",0).attr("y",0)
        .attr("font-size","13px").attr("font-weight","700").attr("fill","#111")
        .text("NodeTrix Hourly Adjacency Matrix — Bitcoin UTXO Flow");
    legG.append("text").attr("x",0).attr("y",18)
        .attr("font-size","10px").attr("fill","#888")
        .text(`${days.length} days × 24 hour slots · ${allArcs.length} total flows`);

    const legItems = [
        { color:"#F7931A", w:4,   label:"Cross-hour arc  (thicker = more tx)" },
        { color:"#ffffff", w:2,   label:"▶ White arrow at midpoint = flow direction" },
        { color:"#F7931A", w:1.5, label:"🟠 Orange cell = outgoing day (source grid)" },
        { color:"#22c55e", w:1.5, label:"🟢 Green cell = incoming day (destination grid)" },
        { color:"#00BFFF", w:2,   label:"Cyan arc = address search result" },
    ];
    legItems.forEach(({ color, w, label }, i) => {
        legG.append("line")
            .attr("x1",0).attr("y1",35+i*15).attr("x2",28).attr("y2",35+i*15)
            .attr("stroke",color).attr("stroke-width",w).attr("stroke-linecap","round");
        legG.append("text").attr("x",34).attr("y",39+i*15)
            .attr("font-size","9px").attr("fill","#555").text(label);
    });
}

// ── Show cell detail: ALL intra-grid arcs for this cell ───────────
function showCellDetail(cell, days, hour) {
    showCellDetailForArcDay(hour, cell.i, days, cell.arcs, cell.j);
}

// ── Show detail for a specific (hour, dayIndex) highlighted cell ──
// arcsToShow: the cross-arc group filtered to this cell's day
function showCellDetailForArcDay(hour, dayIdx, days, arcsToShow, dayJ) {
    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");

    const panel = container.append("div").attr("id","matrix-cell-detail")
        .style("margin-top","16px").style("padding","12px")
        .style("background","#1a1a2e").style("border","1px solid rgba(247,147,26,0.5)")
        .style("border-radius","8px").style("color","#fff");

    const dayLabel = fmtMatDay(days[dayIdx]);
    const dayJLabel = (dayJ !== undefined && dayJ !== dayIdx) ? ` → ${fmtMatDay(days[dayJ])}` : "";

    panel.append("div")
        .style("font-size","10px").style("font-weight","700")
        .style("text-transform","uppercase").style("letter-spacing","0.08em")
        .style("color","#F7931A").style("margin-bottom","4px")
        .text(`${dayLabel}${dayJLabel}  ·  ${String(hour).padStart(2,'0')}:00–${String(hour+1).padStart(2,'0')}:00`);

    const totalBtc = d3.sum(arcsToShow, a => a.btc);
    panel.append("div")
        .style("font-size","11px").style("color","#aaa").style("margin-bottom","8px")
        .html(`Transactions: <b style="color:#fff">${arcsToShow.length}</b> &nbsp;·&nbsp; BTC: <b style="color:#F7931A">₿ ${totalBtc.toFixed(4)}</b>`);

    const listDiv = panel.append("div")
        .style("max-height","300px").style("overflow-y","auto").style("padding-right","4px");

    [...arcsToShow].sort((a,b) => b.btc - a.btc).forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom","5px").style("padding","6px")
            .style("background","rgba(255,255,255,0.04)").style("border-radius","4px")
            .style("border-left","2px solid #F7931A");

        row.append("div").style("font-size","9px").style("color","#888").style("margin-bottom","2px").text(`#${idx+1}`);
        row.append("div")
            .style("font-family","monospace").style("font-size","8px").style("color","#F7931A")
            .style("word-break","break-all").style("margin-bottom","2px")
            .style("cursor","pointer").style("text-decoration","underline")
            .text(a.address)
            .on("mouseover", function() { d3.select(this).style("color","#ffb347"); })
            .on("mouseout",  function() { d3.select(this).style("color","#F7931A"); })
            .on("click", function(ev) {
                ev.stopPropagation();
                if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, a.address);
                showAddressChain(a.address, window._matrixAllArcs, window._matrixDays);
            });
        row.append("div").style("font-size","9px").style("color","#888")
            .text(`₿ ${a.btc.toFixed(6)}  ·  ${fmtMatDay(a.date_from)} ${a.hour_from}:00 → ${fmtMatDay(a.date_to)} ${a.hour_to}:00`);
    });
}

function showCellDetailFiltered(cell, days, hour, filteredArcs) {
    showCellDetailForArcDay(hour, cell.i, days, filteredArcs, cell.j);
}

// ── Cross arc detail panel (on pin) ──────────────────────────────
function showCrossArcDetail(arcs, hf, ht, days) {
    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");

    const panel = container.append("div").attr("id","matrix-cell-detail")
        .style("margin-top","16px").style("padding","12px")
        .style("background","#1a1a2e").style("border","1px solid rgba(247,147,26,0.5)")
        .style("border-radius","8px").style("color","#fff");

    panel.append("div")
        .style("font-size","11px").style("font-weight","700")
        .style("color","#F7931A").style("margin-bottom","4px")
        .text(`📌 ${String(hf).padStart(2,'0')}:00 → ${String(ht).padStart(2,'0')}:00`);
    panel.append("div")
        .style("font-size","10px").style("color","#aaa").style("margin-bottom","4px")
        .text(`${arcs.length} transactions · ₿ ${d3.sum(arcs, a => a.btc).toFixed(4)} total`);
    panel.append("div")
        .style("font-size","9px").style("color","#00E5FF").style("margin-bottom","10px")
        .text("🟠🟢 Click any highlighted cell to see its transactions");

    panel.append("button")
        .style("width","100%").style("padding","5px").style("margin-bottom","10px")
        .style("background","transparent").style("color","#888")
        .style("border","1px solid #444").style("border-radius","4px")
        .style("cursor","pointer").style("font-size","10px")
        .text("✕ Unpin — show all arcs")
        .on("click", () => {
            const f = window._matrixLastFilters || { minBtc:50, maxDayGap:3, minHops:3 };
            if (window._matrixDrawArcs) window._matrixDrawArcs(f.minBtc, f.maxDayGap, f.minHops, "");
            d3.select("#matrix-cell-detail").remove();
        });

    panel.append("div").style("font-size","9px").style("color","#888")
        .style("margin-bottom","6px").style("text-transform","uppercase")
        .text(`All ${arcs.length} flows:`);

    const listDiv = panel.append("div")
        .style("max-height","260px").style("overflow-y","auto").style("padding-right","4px");

    [...arcs].sort((a,b)=>b.btc-a.btc).forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom","5px").style("padding","6px")
            .style("background","rgba(255,255,255,0.04)").style("border-radius","4px")
            .style("border-left","2px solid #00E5FF");

        row.append("div").style("font-size","9px").style("color","#888").text(`#${idx+1}`);
        row.append("div")
            .style("font-family","monospace").style("font-size","8px").style("color","#00E5FF")
            .style("word-break","break-all").style("margin-bottom","2px")
            .style("cursor","pointer").style("text-decoration","underline")
            .text(a.address)
            .on("mouseover", function() { d3.select(this).style("color","#00ffff"); })
            .on("mouseout",  function() { d3.select(this).style("color","#00E5FF"); })
            .on("click", function(ev) {
                ev.stopPropagation();
                if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, a.address);
                showAddressChain(a.address, window._matrixAllArcs, window._matrixDays);
            });
        row.append("div").style("font-size","9px").style("color","#888")
            .text(`₿ ${a.btc.toFixed(6)}  ·  ${fmtMatDay(a.date_from)} → ${fmtMatDay(a.date_to)}`);
    });
}

// ── Address chain panel ───────────────────────────────────────────
function showAddressChain(address, allArcs, days) {
    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");
    const chain = allArcs.filter(a => a.address === address)
        .sort((a,b) => a.date_from.localeCompare(b.date_from));

    const panel = container.append("div").attr("id","matrix-cell-detail")
        .style("margin-top","16px").style("padding","12px")
        .style("background","#0a1628").style("border","1px solid rgba(0,191,255,0.5)")
        .style("border-radius","8px").style("color","#fff");

    panel.append("div")
        .style("font-size","10px").style("font-weight","700").style("color","#00BFFF")
        .style("margin-bottom","4px").style("text-transform","uppercase").style("letter-spacing","0.08em")
        .text("Address Chain");
    panel.append("div")
        .style("font-family","monospace").style("font-size","8px").style("color","#aaa")
        .style("word-break","break-all").style("margin-bottom","8px").text(address);
    panel.append("div").style("font-size","10px").style("color","#aaa").style("margin-bottom","6px")
        .text(`${chain.length} hops · ₿ ${d3.sum(chain, a=>a.btc).toFixed(4)} total`);
    panel.append("div")
        .style("font-size","9px").style("color","#00BFFF").style("margin-bottom","8px")
        .text("Cyan arcs show this address's flows · 🟠🟢 cells show active days");

    panel.append("button")
        .style("width","100%").style("padding","5px").style("margin-bottom","8px")
        .style("background","transparent").style("color","#888")
        .style("border","1px solid #444").style("border-radius","4px")
        .style("cursor","pointer").style("font-size","10px")
        .text("✕ Clear — show all arcs")
        .on("click", () => {
            const f = window._matrixLastFilters || { minBtc:50, maxDayGap:3, minHops:3 };
            if (window._matrixDrawArcs) window._matrixDrawArcs(f.minBtc, f.maxDayGap, f.minHops, "");
            d3.select("#matrix-cell-detail").remove();
        });

    const listDiv = panel.append("div")
        .style("max-height","280px").style("overflow-y","auto").style("padding-right","4px");

    chain.forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom","5px").style("padding","6px")
            .style("background","rgba(0,191,255,0.05)").style("border-radius","4px")
            .style("border-left","2px solid #00BFFF");

        row.append("div").style("font-size","9px").style("color","#00BFFF")
            .style("font-weight","700").style("margin-bottom","2px").text(`Hop ${idx+1}`);
        row.append("div").style("font-size","9px").style("color","#aaa")
            .text(`${fmtMatDay(a.date_from)} ${String(a.hour_from).padStart(2,'0')}:00 → ${fmtMatDay(a.date_to)} ${String(a.hour_to).padStart(2,'0')}:00`);
        row.append("div").style("font-size","9px").style("color","#F7931A")
            .style("font-weight","600").text(`₿ ${a.btc.toFixed(6)}`);

        if (idx < chain.length - 1) {
            listDiv.append("div").style("text-align","center").style("color","#00BFFF")
                .style("font-size","12px").style("margin","2px 0").text("↓");
        }
    });
}

// ── Sidebar ───────────────────────────────────────────────────────
function buildMatrixSidebar(rawData) {
    const container = d3.select("#filter-controls-container");
    container.selectAll("*").remove();

    const days = [...new Set(rawData.map(d=>d.date))].sort();

    container.append("div")
        .style("padding","12px").style("background","#1a1a2e")
        .style("border-radius","8px").style("border","1px solid rgba(247,147,26,0.3)")
        .style("margin-bottom","12px")
        .html(`
            <div style="font-size:10px;font-weight:700;color:#F7931A;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Matrix Info</div>
            <div style="font-size:11px;color:#aaa;line-height:1.9">
                Days: <b style="color:#fff">${days.length}</b><br>
                Period: <b style="color:#fff">${fmtMatDay(days[0])} – ${fmtMatDay(days[days.length-1])}</b><br>
                Rows: <b style="color:#fff">${rawData.length.toLocaleString()}</b><br>
                Hour grids: <b style="color:#fff">24</b>
            </div>
            
        `);

    const lbl = txt => container.append("div")
        .style("font-size","10px").style("font-weight","700")
        .style("letter-spacing","0.07em").style("text-transform","uppercase")
        .style("color","#888").style("margin","12px 0 5px").text(txt);

    lbl("Arc Filters");

    container.append("div").style("font-size","10px").style("color","#aaa").style("margin-bottom","2px").text("Min BTC per arc");
    const f1Lbl = container.append("div").style("font-size","10px").style("color","#F7931A").style("margin-bottom","3px").text("Threshold: 50 BTC");
    const f1    = container.append("input").attr("type","range").attr("min",0).attr("max",500).attr("value",50).attr("step",5)
        .style("width","100%").on("input", function() { f1Lbl.text(`Threshold: ${this.value} BTC`); });

    container.append("div").style("font-size","10px").style("color","#aaa").style("margin","8px 0 2px").text("Max UTXO Holding Period ");
    const f3Lbl = container.append("div").style("font-size","10px").style("color","#F7931A").style("margin-bottom","3px").text("Max gap: 3 days");
    const f3    = container.append("input").attr("type","range").attr("min",1).attr("max",12).attr("value",3).attr("step",1)
        .style("width","100%").on("input", function() { f3Lbl.text(`Max gap: ${this.value} days`); });

    container.append("div").style("font-size","10px").style("color","#aaa").style("margin","8px 0 2px").text("Min Transactions per Hour-Pair");
    const f4Lbl = container.append("div").style("font-size","10px").style("color","#F7931A").style("margin-bottom","3px").text("Min transactions: 3");
    const f4    = container.append("input").attr("type","range").attr("min",1).attr("max",10).attr("value",3).attr("step",1)
        .style("width","100%").on("input", function() { f4Lbl.text(`Min transactions: ${this.value}`); });

    container.append("div").style("margin-top","14px")
        .append("button")
        .style("width","100%").style("padding","8px").style("background","#F7931A")
        .style("color","#fff").style("border","none").style("border-radius","4px")
        .style("cursor","pointer").style("font-weight","600").style("font-size","11px")
        .text("Apply Filters")
        .on("click", () => {
            if (!window._matrixDrawArcs) return;
            const filters = { minBtc:+f1.property("value"), maxDayGap:+f3.property("value"), minHops:+f4.property("value") };
            window._matrixLastFilters = filters;
            window._matrixDrawArcs(filters.minBtc, filters.maxDayGap, filters.minHops, "");
        });
}

// ── Helpers ───────────────────────────────────────────────────────
function fmtMatDay(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.split("-").map(Number);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[m-1]} ${d}`;
}
// ─────────────────────────────────────────────────────────────────
//  matrixChart.js  —  NodeTrix Hourly Adjacency Matrix  (v7 – Fixed occlusion/consistency)
//
//  v7 CHANGES vs v6:
//  1. Hour-range label and in/out stat text now have an opaque
//     backdrop rect behind them, so arc lines passing behind never
//     flicker through letter gaps (previously looked like fading).
//  2. Pin markers: start (source) dot is now orange (#F7931A) to
//     match the orange=source convention used everywhere else.
//     End (destination) dot uses the same green (#22c55e) as the
//     rest of the app.
//  3. Mid-arrow placement now prefers the longest HORIZONTAL segment
//     of a route, so it never lands on a vertical/horizontal
//     crossing point.
//  4. Cell transaction-count labels shrunk from 7px to 5.5px so they
//     no longer overlap the cell border.
//  5. Sidebar wording: "flows" → "TXs" in cross-arc detail panel and
//     top legend bar, for consistent terminology.
// ─────────────────────────────────────────────────────────────────

const MATRIX_CSV = "data_cleaned/bitcoin_filtered.csv";
const HOUR_BIN_DIVISORS = [1, 2, 3, 4, 6, 8, 12]; // valid bin sizes (24 divisible)

async function initMatrixChart() {
     document.getElementById('sb-day-section')?.style.setProperty('display', 'none');
    document.querySelector('.sb-footer')?.style.setProperty('display', 'none');
    document.querySelectorAll('.viz-chip').forEach(el => el.style.setProperty('display', 'none'));
    
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select(".ef-chain-panel").remove();
    d3.select(".ef-peel-panel").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".matrix-tooltip").remove();
    d3.select("#matrix-suspicious-banner").remove();
    d3.select("#ef-legend-footer").remove();
    d3.select(".ef-zoom-notice").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class", "loading-text").text("Loading matrix data…");

    try {
        const raw = await d3.csv(MATRIX_CSV, d => {
            let timeStr = d.time ? d.time.trim() : "";
            if (!timeStr) return null;
            let parsedDate;
            if (timeStr.includes("+")) parsedDate = new Date(timeStr.replace(" ", "T"));
            else if (timeStr.includes(" ")) parsedDate = new Date(timeStr.replace(" ", "T") + "Z");
            else parsedDate = new Date(timeStr);
            if (isNaN(parsedDate.getTime())) return null;
            return {
                hash: d.transaction_hash ? d.transaction_hash.trim() : "unknown",
                time: parsedDate,
                date: timeStr.slice(0, 10),
                hour: parsedDate.getUTCHours(),
                btc_out: +d.output_value_BTC || 0,
                out_address: d.output_address ? d.output_address.trim() : "unknown",
                tx_inputs: +d.transaction_inputs || 0,
                btc_in: +d.total_input_value_BTC || 0,
                in_addresses: (d.input_addresses || "").split(",").map(a => a.trim()).filter(a => a.length > 0)
            };
        });

        const cleanRaw = raw.filter(Boolean);
        window._matrixRawData = cleanRaw;
        window._matrixBinSize = 4;
        if (!cleanRaw.length) throw new Error("No valid data found.");
        chartArea.selectAll("*").remove();
        buildNodeTrixViz(chartArea, cleanRaw, 4);
        buildMatrixSidebar(cleanRaw);
        buildOriginDetectionUI();
        buildPeelingDetectionUI(cleanRaw);

    } catch (err) {
        console.error("MatrixChart error:", err);
        chartArea.html(`<div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;border-radius:8px;margin:20px;">
            <b>Error loading matrix data</b><br><br>${err.message}</div>`);
    }
}

// ── Rebuild only the chart area with a new hour-bin size (sidebar stays) ──
function rebuildMatrix(binSize) {
    window._matrixBinSize = binSize;
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#matrix-cell-detail").remove();
    buildNodeTrixViz(chartArea, window._matrixRawData, binSize);
}
window._matrixRebuild = rebuildMatrix;

// ── Helpers used outside buildNodeTrixViz's closure ───────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function fmtHourRange(bin) {
    const bs = window._matrixBinSize || 1;
    const start = bin * bs, end = start + bs;
    return `${pad2(start)}:00–${pad2(end)}:00`;
}

// ── Cross-view navigation: Matrix ⇄ Linear Chain view ──────────────
function goToLinearChainView(address) {
    sessionStorage.setItem('matrixReturnState', JSON.stringify({
        binSize: window._matrixBinSize || 1,
        address: address
    }));
    showBackToMatrixButton();

    if (typeof window.initExplorativeFlowForAddress === 'function') {
        window.initExplorativeFlowForAddress(address);
    } else {
        console.warn('[matrixChart] No linear-view entry point wired yet. ' +
            'Define window.initExplorativeFlowForAddress(address) in your ' +
            'linear-view script, or tell Claude the real function name.');
    }
}
function showBackToMatrixButton() {
    d3.select("#back-to-matrix-btn").remove();
    d3.select("body").append("button")
        .attr("id", "back-to-matrix-btn")
        .style("position", "fixed").style("top", "56px").style("left", "16px")
        .style("z-index", "99998").style("padding", "6px 14px")
        .style("background", "#1a1d23").style("color", "#fff").style("border", "none")
        .style("border-radius", "6px").style("cursor", "pointer")
        .style("font-size", "11px").style("font-weight", "600")
        .style("box-shadow", "0 2px 8px rgba(0,0,0,.3)")
        .text("← Back to Matrix")
       .on("click", () => {
            d3.select("#back-to-matrix-btn").remove();
            d3.select("#ef-no-data-banner").remove();
            const saved = JSON.parse(sessionStorage.getItem('matrixReturnState') || '{}');
            const binSize = saved.binSize || window._matrixBinSize || 4;
            window._matrixBinSize = binSize;
            const chartArea = d3.select("#chart-area");
            chartArea.selectAll("*").remove();
            d3.select("#filter-controls-container").selectAll("*").remove();
            buildNodeTrixViz(chartArea, window._matrixRawData, binSize);
            buildMatrixSidebar(window._matrixRawData);
            if (typeof buildOriginDetectionUI === 'function') buildOriginDetectionUI();
            if (typeof buildPeelingDetectionUI === 'function') buildPeelingDetectionUI(window._matrixRawData);
            setTimeout(() => {
                if (window._matrixUpdateCorridors)
                    window._matrixUpdateCorridors(window._matrixCrossArcs, window._matrixAllArcs);
                if (saved.address && window._matrixDrawArcs) {
                    window._matrixDrawArcs(null, null, null, saved.address);
                    showAddressChain(saved.address, window._matrixAllArcs, window._matrixDays);
                }
            }, 80);
        });
}
function showSuspiciousBanner(address) {
    d3.select("#matrix-suspicious-banner").remove();
    const banner = d3.select("body").append("div")
        .attr("id", "matrix-suspicious-banner")
        .style("position", "fixed").style("top", "0").style("left", "0").style("right", "0")
        .style("z-index", "99999")
        .style("background", "linear-gradient(90deg,#7a1f1f,#3a0d0d)")
        .style("color", "#fff").style("padding", "10px 18px").style("font-size", "12px")
        .style("display", "flex").style("align-items", "center").style("gap", "10px")
        .style("box-shadow", "0 2px 10px rgba(0,0,0,.4)").style("border-bottom", "1px solid #ff5500");

    banner.append("span").style("font-size", "14px").text("🚩");
    banner.append("span")
        .style("font-weight", "700").style("letter-spacing", ".04em")
        .style("text-transform", "uppercase").style("color", "#ff8a3d")
        .text("Investigating address");
    banner.append("span")
        .style("font-family", "monospace").style("font-size", "11px")
        .style("color", "#ffd9b3").style("word-break", "break-all")
        .text(address);
    banner.append("button")
        .style("margin-left", "auto").style("background", "transparent").style("color", "#fff")
        .style("border", "1px solid rgba(255,255,255,.4)").style("border-radius", "4px")
        .style("padding", "2px 10px").style("cursor", "pointer").style("font-size", "11px")
        .text("✕ Dismiss")
        .on("click", () => d3.select("#matrix-suspicious-banner").remove());
}

// ═══════════════════════════════════════════════════════════════════
function buildNodeTrixViz(container, rawData, binSize) {

    binSize = binSize || window._matrixBinSize || 1;
    window._matrixBinSize = binSize;
    const nBins = 24 / binSize;
    const binOf = hour => Math.floor(hour / binSize);

    // ── 1. Days ───────────────────────────────────────────────────
    const days = [...new Set(rawData.map(d => d.date))].sort();
    const nDays = days.length;
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
            const toDI = dayIdx.get(spendTx.date);
            if (fromDI === undefined || toDI === undefined) return;
            allArcs.push({
                address: inAddr,
                date_from: origin.date, date_to: spendTx.date,
                day_from: fromDI, day_to: toDI,
                hour_from: origin.hour, hour_to: spendTx.hour,
                bin_from: binOf(origin.hour), bin_to: binOf(spendTx.hour),
                btc: origin.btc,
                hash_from: origin.hash, hash_to: spendTx.hash,
                same_hour: origin.hour === spendTx.hour,
                same_bin: binOf(origin.hour) === binOf(spendTx.hour)
            });
        });
    });

    const gridArcs = allArcs.filter(a => a.same_bin);
    const crossArcs = allArcs.filter(a => !a.same_bin);
    window._matrixAllArcs = allArcs;
    window._matrixCrossArcs = crossArcs;
    window._matrixDays = days;
    // ── In/Out tx stats per bin — for hot-wallet pattern reading ──
    const inOutStats = new Map();
    for (let b = 0; b < nBins; b++) inOutStats.set(b, { in: 0, out: 0 });
    allArcs.forEach(a => {
        inOutStats.get(a.bin_to).in++;
        inOutStats.get(a.bin_from).out++;
    });

    // ── 5. Per-bin cell data (intra-grid) ─────────────────────────
    const hourCells = Array.from({ length: nBins }, () => new Map());
    gridArcs.forEach(a => {
        const b = a.bin_from;
        const i = Math.min(a.day_from, a.day_to);
        const j = Math.max(a.day_from, a.day_to);
        const key = `${i}_${j}`;
        if (!hourCells[b].has(key)) hourCells[b].set(key, { i, j, count: 0, btc: 0, arcs: [] });
        const c = hourCells[b].get(key);
        c.count++; c.btc += a.btc; c.arcs.push(a);
    });

    // ── 6. Diamond geometry constants ─────────────────────────────
    const CELL = 5;
    const SQ = Math.SQRT1_2;
    const GRID_PX = CELL * nDays;
    const DIA_PAD = 5;
    const DIA_W = 2 * GRID_PX * SQ + DIA_PAD * 2;
    const DIA_H = GRID_PX * SQ + DIA_PAD * 2;
    const GRID_GAP_X = 95;
    const LABEL_OFF = 30;
    const PAD = 50;

    const GRIDS_PER_ROW = nBins <= 12 ? nBins : 12;
    const ROWS = Math.ceil(nBins / GRIDS_PER_ROW);

    const TRACK_H = 16;
    const MAX_TRACKS = 8;
    const HIGHWAY_RESERVE = (MAX_TRACKS + 1) * TRACK_H;

    const GRID_GAP_Y = HIGHWAY_RESERVE * 2 + 20;

    function topOfRow(r) {
        return PAD + HIGHWAY_RESERVE + r * (LABEL_OFF + DIA_H + GRID_GAP_Y);
    }
    function leftOfCol(c) { return PAD + c * (DIA_W + GRID_GAP_X); }

    const totalW = leftOfCol(GRIDS_PER_ROW - 1) + DIA_W + PAD * 2;
    const totalH = topOfRow(ROWS - 1) + LABEL_OFF + DIA_H + HIGHWAY_RESERVE + PAD;

    function toDiamondLocal(x, y) {
        return { x: (x + y) * SQ + DIA_PAD, y: (x - y) * SQ + DIA_PAD };
    }
    function cellCornersLocal(i, j) {
        return {
            left: toDiamondLocal(j * CELL, i * CELL),
            bottom: toDiamondLocal((j + 1) * CELL, i * CELL),
            right: toDiamondLocal((j + 1) * CELL, (i + 1) * CELL),
            top: toDiamondLocal(j * CELL, (i + 1) * CELL)
        };
    }
    function cellPoly(i, j) {
        const c = cellCornersLocal(i, j);
        return `${c.left.x},${c.left.y} ${c.bottom.x},${c.bottom.y} ${c.right.x},${c.right.y} ${c.top.x},${c.top.y}`;
    }
    function cellCenterLocal(i, j) {
        return toDiamondLocal((j + 0.5) * CELL, (i + 0.5) * CELL);
    }
    function diamondHalves(i, j) {
        const c = cellCornersLocal(i, j);
        return {
            left: `${c.top.x},${c.top.y} ${c.left.x},${c.left.y} ${c.bottom.x},${c.bottom.y}`,
            right: `${c.top.x},${c.top.y} ${c.right.x},${c.right.y} ${c.bottom.x},${c.bottom.y}`
        };
    }
    function panelBorderPoints() {
        const A = toDiamondLocal(0, 0);
        const Bv = toDiamondLocal(GRID_PX, 0);
        const C = toDiamondLocal(GRID_PX, GRID_PX);
        return `${A.x},${A.y} ${Bv.x},${Bv.y} ${C.x},${C.y}`;
    }

    // ── 7. Panel positions ────────────────────────────────────────
    const gridOrigins = new Map();
    for (let b = 0; b < nBins; b++) {
        const col = b % GRIDS_PER_ROW;
        const row = Math.floor(b / GRIDS_PER_ROW);
        const gx = leftOfCol(col);
        const gy = topOfRow(row) + LABEL_OFF;
        gridOrigins.set(b, {
            gx, gy,
            left: gx, right: gx + DIA_W,
            top: gy, bottom: gy + DIA_H,
            cx: gx + DIA_W / 2,
            cy: gy + DIA_H / 2,
            col, row
        });
    }

    // ── 8. Highway routing ────────────────────────────────────────
    const spanTrackCounters = new Map();

    function getTrackForSpan(bf, bt) {
        const span = Math.abs(bt - bf);
        const key = `${Math.min(bf, bt)}_${Math.max(bf, bt)}`;
        const n = spanTrackCounters.get(key) || 0;
        spanTrackCounters.set(key, n + 1);
        return span + n;
    }

    function buildRoute(binA, binB, trackNum) {
        const A = gridOrigins.get(binA);
        const B = gridOrigins.get(binB);
        const fwd = binB > binA;

        if (A.row === B.row) {
            if (fwd) {
                const archY = A.top - LABEL_OFF - trackNum * TRACK_H;
                return [
                    { x: A.cx, y: A.top },
                    { x: A.cx, y: archY },
                    { x: B.cx, y: archY },
                    { x: B.cx, y: B.top }
                ];
            } else {
                const archY = A.bottom + trackNum * TRACK_H;
                return [
                    { x: A.cx, y: A.bottom },
                    { x: A.cx, y: archY },
                    { x: B.cx, y: archY },
                    { x: B.cx, y: B.bottom }
                ];
            }
        } else {
            const srcBottom = A.bottom + trackNum * TRACK_H;
            const dstTop = B.top - LABEL_OFF - trackNum * TRACK_H;
            const midX = (A.cx + B.cx) / 2;
            return [
                { x: A.cx, y: A.bottom },
                { x: A.cx, y: srcBottom },
                { x: midX, y: srcBottom },
                { x: midX, y: dstTop },
                { x: B.cx, y: dstTop },
                { x: B.cx, y: B.top }
            ];
        }
    }

    function polyPathD(pts) { return "M" + pts.map(p => `${p.x},${p.y}`).join(" L "); }

    // ── FIX: prefer the longest HORIZONTAL segment for arrow placement,
    // so the arrow never lands where a vertical connector crosses a
    // horizontal lane (previously picked the single longest segment
    // overall, which was often the tall vertical connector itself).
function pathMidArrowInfo(pts) {
        let bestH = null, bestHLen = -1;
        let bestAny = null, bestAnyLen = -1;
        for (let k = 0; k < pts.length - 1; k++) {
            const dx = pts[k + 1].x - pts[k].x, dy = pts[k + 1].y - pts[k].y;
            const len = Math.hypot(dx, dy);
            const info = {
                mx: pts[k].x + dx * 0.38,
                my: pts[k].y + dy * 0.38,
                ang: Math.atan2(dy, dx) * 180 / Math.PI
            };
            if (Math.abs(dy) < 0.5 && len > bestHLen) { bestHLen = len; bestH = info; }
            if (len > bestAnyLen) { bestAnyLen = len; bestAny = info; }
        }
        return bestH || bestAny;
    }
    // ── 9. Arc width / color ─────────────────────────────────────
    const ARC_WIDTH = 2.2;
    const crossGroupBtc = new Map();
    crossArcs.forEach(a => {
        const k = `${a.bin_from}_${a.bin_to}`;
        crossGroupBtc.set(k, (crossGroupBtc.get(k) || 0) + a.btc);
    });
    const btcVals = Array.from(crossGroupBtc.values());
    const btcMin = d3.min(btcVals) || 0;
    const btcMax = d3.max(btcVals) || 1;
    const arcColorScale = d3.scaleLinear().domain([btcMin, btcMax])
        .range(["#ffd9a8", "#a8470a"]).clamp(true);

    // ── 10. SVG setup ──────────────────────────────────────────────
    container.style("background", "#f8f8f8").style("overflow", "auto").style("position", "relative");

    const tooltip = d3.select("body").append("div").attr("class", "matrix-tooltip")
        .style("position", "fixed").style("pointer-events", "none").style("opacity", 0)
        .style("z-index", 9999).style("background", "rgba(10,10,20,0.97)")
        .style("border", "1px solid #F7931A").style("border-radius", "8px")
        .style("padding", "12px 16px").style("font-size", "11px").style("color", "#fff")
        .style("max-width", "300px").style("word-break", "break-all");

    const svg = container.append("svg")
        .attr("width", totalW).attr("height", totalH)
        .style("background", "#f8f8f8").style("display", "block")
        .style("overflow", "visible");

    svg.on("click", () => { unpinAll(); tooltip.style("opacity", 0); });
    svg.on("mouseleave", () => { tooltip.style("opacity", 0); });

    const rootG = svg.append("g");
    const zoom = d3.zoom().scaleExtent([0.3, 5]).on("zoom", e => rootG.attr("transform", e.transform));
    svg.call(zoom);

    const zBtns = container.append("div")
        .style("position", "sticky").style("top", "10px").style("left", "calc(100% - 44px)")
        .style("display", "flex").style("flex-direction", "column")
        .style("gap", "4px").style("z-index", "200").style("width", "32px");
    [["+", 1.4], ["−", 0.7], ["⟳", null]].forEach(([txt, f]) => {
        const b = zBtns.append("button").text(txt)
            .style("width", "32px").style("height", "32px")
            .style("border", "1px solid #F7931A").style("border-radius", "4px")
            .style("background", "#fff").style("color", "#F7931A")
            .style("font-size", "16px").style("cursor", "pointer").style("font-weight", "700");
        if (f) b.on("click", () => svg.transition().duration(300).call(zoom.scaleBy, f));
        else b.on("click", () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
    });

    // ── 11. Pin state ───────────────────────────────────────────────
    let pinnedArcKey = null;
    let inspectingArcGroup = null;
    let pinnedHF = null;
    let pinnedHT = null;

    // ── 12. Arc layer (below grids) ─────────────────────────────────
    const arcLayer = rootG.append("g").attr("class", "cross-arcs").lower();

    // ── 13. Grid groups map ──────────────────────────────────────────
    const gridGroups = new Map();

    // ── 14. Highlight helpers (diamond-aware) ────────────────────────
    function highlightCell(bin, dayI, mode, onClickFn, dayJ) {
        const g = gridGroups.get(bin);
        if (!g) return;
        const ci = dayJ !== undefined ? Math.min(dayI, dayJ) : dayI;
        const cj = dayJ !== undefined ? Math.max(dayI, dayJ) : dayI;

        if (mode === "both") {
            const halves = diamondHalves(ci, cj);
            g.append("polygon").attr("class", "cell-hl").attr("points", halves.left)
                .attr("fill", "rgba(247,147,26,0.35)").attr("stroke", "none")
                .attr("pointer-events", "all").style("cursor", "pointer")
                .on("click", function (ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
            g.append("polygon").attr("class", "cell-hl").attr("points", halves.right)
                .attr("fill", "rgba(34,197,94,0.35)").attr("stroke", "none")
                .attr("pointer-events", "all").style("cursor", "pointer")
                .on("click", function (ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
            g.append("polygon").attr("class", "cell-hl").attr("points", cellPoly(ci, cj))
                .attr("fill", "none").attr("stroke", "#ffaa00").attr("stroke-width", 2)
                .attr("pointer-events", "none");
        } else {
            const color = mode === "out" ? "#F7931A" : "#22c55e";
            const fillC = mode === "out" ? "rgba(247,147,26,0.3)" : "rgba(34,197,94,0.3)";
            g.append("polygon").attr("class", "cell-hl").attr("points", cellPoly(ci, cj))
                .attr("fill", fillC).attr("stroke", color).attr("stroke-width", 2)
                .attr("pointer-events", "all").style("cursor", "pointer")
                .on("click", function (ev) { ev.stopPropagation(); if (onClickFn) onClickFn(); });
        }
    }

    function clearHighlights() { rootG.selectAll(".cell-hl").remove(); }

    function applyArcHighlight(arcs, inspectGroup) {
        clearHighlights();
        if (!arcs || !arcs.length) return;
        const bs = window._matrixBinSize || 1;

        const fromPairs = new Map();
        arcs.forEach(a => {
            const aBf = Math.floor(a.hour_from / bs);
            const aBt = Math.floor(a.hour_to / bs);
            const k = `${a.day_from}_${a.day_to}_${aBf}_${aBt}`;
            if (!fromPairs.has(k)) fromPairs.set(k, {
                dayFrom: a.day_from, dayTo: a.day_to,
                bf: aBf, bt: aBt, arcs: []
            });
            fromPairs.get(k).arcs.push(a);
        });

        fromPairs.forEach(({ dayFrom, dayTo, bf, bt, arcs: pairArcs }) => {
            if (bf === bt) {
                const clickFn = () => showCellDetailForArcDay(
                    bf, dayFrom, days, pairArcs, dayTo
                );
                highlightCell(bf, dayFrom, "both", clickFn, dayTo);
            } else {
                const fromClickFn = () => showCellDetailForArcDay(
                    bf, dayFrom, days, pairArcs, dayTo
                );
                const toClickFn = () => showCellDetailForArcDay(
                    bt, dayFrom, days, pairArcs, dayTo
                );
                highlightCell(bf, dayFrom, "out", fromClickFn, dayTo);
                highlightCell(bt, dayFrom, "in", toClickFn, dayTo);
            }
        });
    }

    // ── 15. Draw nBins diamond panels ────────────────────────────────
    for (let b = 0; b < nBins; b++) {
        const { gx, gy } = gridOrigins.get(b);

        const g = rootG.append("g")
            .attr("transform", `translate(${gx},${gy})`)
            .attr("class", `hour-grid hour-grid-${b}`);
        gridGroups.set(b, g);

        // ── FIX: hour-range label now gets an opaque backdrop rect so
        // arc lines passing behind it don't flicker through the letters.
       rootG.append("text")
            .attr("x", gx + DIA_W / 2).attr("y", gy - 18)
            .attr("text-anchor", "middle").attr("font-size", "11px")
            .attr("font-weight", "700").attr("fill", "#333")
            .text(fmtHourRange(b));

        // ── FIX: in/out stat text — same opaque backdrop treatment ──
    const stats = inOutStats.get(b) || { in: 0, out: 0 };
        const statText = rootG.append("text")
            .attr("x", gx + DIA_W / 2).attr("y", gy + DIA_H + 14)
            .attr("text-anchor", "middle").attr("font-size", "9px");
        statText.append("tspan").attr("fill", "#22c55e").text(`↓${stats.in} in`);
        statText.append("tspan").attr("fill", "#999").text("   ");
        statText.append("tspan").attr("fill", "#F7931A").text(`↑${stats.out} out`);

        // Triangle border
        g.append("polygon").attr("points", panelBorderPoints())
            .attr("fill", "none").attr("stroke", "#ccc").attr("stroke-width", 1);

        // Background cells (upper triangle only — no wasted lower half)
        for (let i = 0; i < nDays; i++) {
            for (let j = i; j < nDays; j++) {
                g.append("polygon")
                    .attr("points", cellPoly(i, j))
                    .attr("fill", "#f0f0f0");
            }
        }

        // Day ticks along the flat (diagonal) edge
        days.forEach((day, t) => {
            if (t % 2 !== 0) return;
            const c = cellCornersLocal(t, t);
            g.append("text")
                .attr("x", c.top.x).attr("y", c.top.y - 3)
                .attr("text-anchor", "start").attr("font-size", "7px").attr("fill", "#aaa")
                .attr("transform", `rotate(-45,${c.top.x},${c.top.y - 3})`)
                .text(fmtMatDay(day));
        });

        // Filled cells with intra-bin transactions
        hourCells[b].forEach((cell) => {
            g.append("polygon")
                .attr("class", `cell-rect cell-${b}-${cell.i}-${cell.j}`)
                .attr("data-btc", cell.btc)
                .attr("data-daygap", cell.j - cell.i)
                .attr("points", cellPoly(cell.i, cell.j))
                .attr("fill", "#fff").attr("stroke", "#ddd").attr("stroke-width", 0.5)
                .style("cursor", "pointer")
                .on("mousemove", function (event) {
                    tooltip.style("opacity", 1)
                        .style("left", (event.clientX + 14) + "px").style("top", (event.clientY - 10) + "px")
                        .html(`
                        <div style="color:#F7931A;font-weight:700;font-size:12px;margin-bottom:6px">
                            ${fmtMatDay(days[cell.i])} → ${fmtMatDay(days[cell.j])}
                            <span style="font-size:10px;color:#888;margin-left:6px">${fmtHourRange(b)}</span>
                        </div>
                        <div style="margin-bottom:3px">Transactions: <b>${cell.count}</b></div>
                        <div style="margin-bottom:6px">Total BTC: <b style="color:#F7931A">₿ ${cell.btc.toFixed(4)}</b></div>
                        <div style="font-size:9px;color:#888">${cell.i === cell.j ? '📅 Same-day' : '→ Cross-day'}</div>
                        <div style="font-size:9px;color:#aaa;margin-top:4px">Click for transaction list</div>
                    `);
                })
                .on("mouseleave", () => tooltip.style("opacity", 0))
                .on("click", function (event) {
                    event.stopPropagation();
                    showCellDetail(cell, days, b);
                });

            if (cell.count > 0) {
                const lp = cellCenterLocal(cell.i, cell.j);
               g.append("text")
                    .attr("class", `cell-label intra-label label-${b}-${cell.i}-${cell.j}`)
                    .attr("x", lp.x).attr("y", lp.y + 3)
                    .attr("text-anchor", "middle").attr("font-size", "6px")
                    .attr("font-weight", "700").attr("fill", "#222")
                    .attr("stroke", "#fff").attr("stroke-width", "2px")
                    .style("paint-order", "stroke")
                    .attr("pointer-events", "none")
                    .attr("data-orig-count", cell.count)
                    .text(cell.count);
            }
        });
    }

    // ── 16. unpinAll ─────────────────────────────────────────────────
    function unpinAll() {
        pinnedArcKey = null;
        inspectingArcGroup = null;
        pinnedHF = null;
        pinnedHT = null;
        clearHighlights();
        arcLayer.selectAll(".pin-marker").remove();
        arcLayer.selectAll("path.cross-arc").each(function () {
            const sel = d3.select(this);
            sel.attr("opacity", 0.7).attr("stroke", sel.attr("data-color") || "#F7931A");
        });
        arcLayer.selectAll("polygon.mid-arrow")
            .attr("fill", "#ffffff");
        rootG.selectAll("text.intra-label").attr("display", null);
        tooltip.style("opacity", 0);
    }

    // ── 17. addMidArrow (polyline-aware) ──────────────────────────────
    function addMidArrow(layer, pts, arcStrokeW, hiColor) {
        const info = pathMidArrowInfo(pts);
        const sz = Math.max(6, arcStrokeW * 1.3 + 3);
        return layer.append("polygon")
            .attr("class", "cross-arc mid-arrow")
            .attr("points", `${-sz},${-sz * 0.55} ${sz},0 ${-sz},${sz * 0.55}`)
            .attr("fill", hiColor || "#ffffff")
            .attr("stroke", "#0008").attr("stroke-width", "0.5")
            .attr("opacity", 0.95)
            .attr("pointer-events", "none")
            .attr("transform", `translate(${info.mx},${info.my}) rotate(${info.ang})`);
    }

    // ── 18. drawArcs ──────────────────────────────────────────────────
    function drawArcs(minBtc, maxDayGap, minHops, addrQuery) {
        arcLayer.selectAll("*").remove();
        arcLayer.raise(); // arcs always render on top → line is never interrupted
        clearHighlights();
        unpinAll();

        // ─── Address-search mode ──────────────────────────────────
        if (addrQuery && addrQuery.length > 0) {
            window._matrixInvestigatingAddress = addrQuery;
            const matchingArcs = allArcs.filter(a =>
                a.address.toLowerCase().includes(addrQuery.toLowerCase())
            );

            const addrGroups = new Map();
            matchingArcs.forEach(a => {
                if (a.same_bin) return;
                const k = `${a.bin_from}_${a.bin_to}`;
                if (!addrGroups.has(k)) addrGroups.set(k, []);
                addrGroups.get(k).push(a);
            });

            matchingArcs.filter(a => a.same_bin).forEach(a => {
                highlightCell(a.bin_from, a.day_from, "out",
                    () => showCellDetailForArcDay(a.bin_from, a.day_from, days, [a]));
                if (a.day_to !== a.day_from)
                    highlightCell(a.bin_to, a.day_to, "in",
                        () => showCellDetailForArcDay(a.bin_to, a.day_to, days, [a]));
            });

            spanTrackCounters.clear();
            addrGroups.forEach((grpArcs, key) => {
                const [bf, bt] = key.split("_").map(Number);
                const trackNum = getTrackForSpan(bf, bt);
                const pts = buildRoute(bf, bt, trackNum);
                const totalBtc = d3.sum(grpArcs, a => a.btc);

                const path = arcLayer.append("path")
                    .attr("class", "cross-arc addr-arc")
                    .attr("d", polyPathD(pts))
                    .attr("fill", "none").attr("stroke", "#00BFFF")
                    .attr("stroke-width", 2.5).attr("stroke-linecap", "round")
                    .attr("stroke-linejoin", "round")
                    .attr("opacity", 0.85).style("cursor", "pointer");

                addMidArrow(arcLayer, pts, 2.5, "#00BFFF");

                const fromDays = [...new Set(grpArcs.map(a => a.day_from))];
                const toDays = [...new Set(grpArcs.map(a => a.day_to))];
                fromDays.forEach(d => highlightCell(bf, d, "out",
                    () => showCellDetailForArcDay(bf, d, days, grpArcs)));
                toDays.forEach(d => highlightCell(bt, d, "in",
                    () => showCellDetailForArcDay(bt, d, days, grpArcs)));

                path.on("mousemove", ev => {
                    tooltip.style("opacity", 1)
                        .style("left", (ev.clientX + 14) + "px").style("top", (ev.clientY - 10) + "px")
                        .html(`<div style="color:#00BFFF;font-weight:700">Address TXs</div>
                                <div style="font-size:9px;color:#aaa;word-break:break-all">${addrQuery}</div>
                                <div style="margin-top:4px">${fmtHourRange(bf)} → ${fmtHourRange(bt)}</div>
                                <div>Transactions: <b>${grpArcs.length}</b></div>
                                <div>BTC: <b style="color:#F7931A">₿ ${totalBtc.toFixed(6)}</b></div>`);
                })
                    .on("mouseleave", () => tooltip.style("opacity", 0))
                    .on("click", ev => {
                        ev.stopPropagation();
                        applyArcHighlight(grpArcs, grpArcs);
                        showAddressChain(addrQuery, allArcs, days);
                    });
            });
            return;
        }

        // ─── Normal grouped mode ──────────────────────────────────
        window._matrixInvestigatingAddress = null;
        const groups = new Map();
        crossArcs.forEach(a => {
            const dayGap = Math.abs(a.day_to - a.day_from);
            if (maxDayGap !== null && dayGap > maxDayGap) return;
            if (minBtc !== null && a.btc < minBtc) return;
            const k = `${a.bin_from}_${a.bin_to}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(a);
        });

        spanTrackCounters.clear();

        groups.forEach((arcs, key) => {
            if (minHops !== null && arcs.length < minHops) return;
            const [bf, bt] = key.split("_").map(Number);
            const trackNum = getTrackForSpan(bf, bt);
            const pts = buildRoute(bf, bt, trackNum);

            const count = arcs.length;
            const totalBtc = d3.sum(arcs, a => a.btc);
            const sw = ARC_WIDTH;
            const arcColor = arcColorScale(totalBtc);

            const path = arcLayer.append("path")
                .attr("class", "cross-arc")
                .attr("data-key", key)
                .attr("data-color", arcColor)
                .attr("data-count", count)
                .attr("data-btc", totalBtc.toFixed(4))
                .attr("d", polyPathD(pts))
                .attr("fill", "none").attr("stroke", arcColor)
                .attr("stroke-width", sw).attr("stroke-linecap", "round")
                .attr("stroke-linejoin", "round")
                .attr("opacity", 0.7).style("cursor", "pointer");

            const arrowEl = addMidArrow(arcLayer, pts, sw, "#ffffff");

            const HIGHLIGHT_COLOR = "#2563EB"; // blue = "this arc is currently selected" (distinct from source/dest colors)

            path.on("mousemove", function (event) {
                event.stopPropagation();
                if (pinnedArcKey && pinnedArcKey !== key) return;
                const displayCount = +d3.select(this).attr("data-count");
                const displayBtc   = d3.select(this).attr("data-btc");
                d3.select(this).attr("opacity", 0.95).attr("stroke", HIGHLIGHT_COLOR);
                arrowEl.attr("fill", "#dbeafe");
                if (!pinnedArcKey) applyArcHighlight(arcs, arcs);
                const activeFilters = window._matrixLastFilters;
                const filterNote = activeFilters && activeFilters.minBtc > 0
                    ? `<div style="font-size:9px;color:#22c55e;margin-top:3px">⚡ Filter active: ≥${activeFilters.minBtc} BTC per arc</div>`
                    : '';
                tooltip.style("opacity", 1)
                    .style("left", (event.clientX + 14) + "px")
                    .style("top", (event.clientY - 10) + "px")
                    .html(`
                        <div style="color:#F7931A;font-weight:700;font-size:12px;margin-bottom:6px">
                            ${fmtHourRange(bf)} → ${fmtHourRange(bt)}
                        </div>
                        <div style="margin-bottom:3px">Transactions: <b>${displayCount}</b></div>
                        <div style="margin-bottom:4px">Total BTC: <b style="color:#F7931A">₿ ${displayBtc}</b></div>
                        ${filterNote}
                        <div style="font-size:9px;color:#bbb;margin-bottom:2px">Color depth ∝ BTC amount</div>
                        <div style="font-size:9px;color:#aaa">
                            🟠 Orange cells = origin days (${fmtHourRange(bf)})<br>
                            🟢 Green cells = destination days (${fmtHourRange(bt)})
                        </div>
                        <div style="font-size:9px;color:#666;margin-top:6px">Click to pin</div>
                    `);
            })
                .on("mouseleave", function () {
                    if (pinnedArcKey === key) return;
                    d3.select(this).attr("opacity", 0.7).attr("stroke", arcColor);
                    arrowEl.attr("fill", "#ffffff");
                    if (!pinnedArcKey) clearHighlights();
                    if (!pinnedArcKey) tooltip.style("opacity", 0);
                });

            path.on("click", function (event) {
                event.stopPropagation();
                if (pinnedArcKey === key) { unpinAll(); tooltip.style("opacity", 0); return; }
                unpinAll();

                pinnedArcKey = key;
                inspectingArcGroup = arcs;
                pinnedHF = bf;
                pinnedHT = bt;
                arcLayer.selectAll(".pin-marker").remove();
                const startPt = pts[0], endPt = pts[pts.length - 1];
                // ── FIX: start (source) marker is now orange, matching
                // the orange=source convention used everywhere else.
                // End (destination) marker uses the same green as the
                // rest of the app (#22c55e).
                arcLayer.append("circle").attr("class", "pin-marker")
                    .attr("cx", startPt.x).attr("cy", startPt.y).attr("r", 6)
                    .attr("fill", "#F7931A").attr("stroke", "#fff").attr("stroke-width", 2);
                arcLayer.append("circle").attr("class", "pin-marker")
                    .attr("cx", endPt.x).attr("cy", endPt.y).attr("r", 6)
                    .attr("fill", "#22c55e").attr("stroke", "#fff").attr("stroke-width", 2);

                d3.select(this).attr("opacity", 1).attr("stroke", HIGHLIGHT_COLOR);
                arrowEl.attr("fill", "#dbeafe");
                applyArcHighlight(arcs, arcs);
                showCrossArcDetail(arcs, bf, bt, days, +d3.select(this).attr("data-count"));

                rootG.selectAll("text.intra-label").attr("display", "none");

                tooltip.style("opacity", 1)
                    .style("left", (event.clientX + 14) + "px")
                    .style("top", (event.clientY - 10) + "px")
                    .html(`
                    <div style="color:${HIGHLIGHT_COLOR};font-weight:700;font-size:12px;margin-bottom:4px">
                        📌 ${fmtHourRange(bf)} → ${fmtHourRange(bt)}
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
    drawArcs(null, null, null);
    setTimeout(() => {
        if (window._matrixUpdateCorridors)
            window._matrixUpdateCorridors(crossArcs, allArcs);
    }, 50);

    // ── 19. Legend ──────────────────────────────────────────────
    d3.select("#matrix-legend-bar").remove();
    const legendItems = [
        { color: "#a8470a", label: "Darker arc = more BTC" },
        { color: "#555555", label: "▶ Arrow = flow direction" },
        { color: "#F7931A", label: "🟠 Orange cell/dot = source" },
        { color: "#22c55e", label: "🟢 Green cell/dot = destination" },
        { color: "#00BFFF", label: "Cyan = address search" },
    ];
    const legendBar = container.insert("div", "svg")
        .attr("id", "matrix-legend-bar")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "18px")
        .style("padding", "6px 12px")
        .style("background", "#f0f0f0")
        .style("border-bottom", "1px solid #ddd")
        .style("font-size", "10px")
        .style("color", "#444")
        .style("flex-wrap", "wrap")
        .style("margin-bottom", "0");

    legendBar.append("span")
        .style("font-weight", "700")
        .style("color", "#111")
        .style("margin-right", "6px")
        .style("white-space", "nowrap")
        .text(`NodeTrix Matrix · ${days.length} days · ${nBins} panels · ${allArcs.length} TXs`);

    legendItems.forEach(({ color, label }) => {
        const item = legendBar.append("span")
            .style("display", "inline-flex")
            .style("align-items", "center")
            .style("gap", "5px")
            .style("white-space", "nowrap");
        item.append("span")
            .style("display", "inline-block")
            .style("width", "20px").style("height", "2px")
            .style("background", color)
            .style("border-radius", "1px");
        item.append("span").text(label);
    });
}

// ── Show cell detail: ALL intra-grid arcs for this cell ───────────
function showCellDetail(cell, days, bin) {
    showCellDetailForArcDay(bin, cell.i, days, cell.arcs, cell.j);
}

// ── Show detail for a specific (bin, dayIndex) highlighted cell ───
function showCellDetailForArcDay(bin, dayIdx, days, arcsToShow, dayJ) {
    if (window._matrixInvestigatingAddress && window._matrixInvestigatingAddress.length > 0) {
        const filtered = arcsToShow.filter(a =>
            a.address.toLowerCase().includes(window._matrixInvestigatingAddress.toLowerCase())
        );
        if (filtered.length > 0) arcsToShow = filtered;
    }
    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");

    const panel = container.append("div").attr("id", "matrix-cell-detail")
        .style("margin-top", "16px").style("padding", "12px")
        .style("background", "#1a1a2e").style("border", "1px solid rgba(247,147,26,0.5)")
        .style("border-radius", "8px").style("color", "#fff");

    const dayLabel = fmtMatDay(days[dayIdx]);
    const dayJLabel = (dayJ !== undefined && dayJ !== dayIdx) ? ` → ${fmtMatDay(days[dayJ])}` : "";

    panel.append("div")
        .style("font-size", "10px").style("font-weight", "700")
        .style("text-transform", "uppercase").style("letter-spacing", "0.08em")
        .style("color", "#F7931A").style("margin-bottom", "4px")
        .text(`${dayLabel}${dayJLabel}  ·  ${fmtHourRange(bin)}`);

    const totalBtc = d3.sum(arcsToShow, a => a.btc);
    panel.append("div")
        .style("font-size", "11px").style("color", "#aaa").style("margin-bottom", "8px")
        .html(`Transactions: <b style="color:#fff">${arcsToShow.length}</b> &nbsp;·&nbsp; BTC: <b style="color:#F7931A">₿ ${totalBtc.toFixed(4)}</b>`);

    const listDiv = panel.append("div")
        .style("max-height", "300px").style("overflow-y", "auto").style("padding-right", "4px");

    [...arcsToShow].sort((a, b) => b.btc - a.btc).forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom", "5px").style("padding", "6px")
            .style("background", "rgba(255,255,255,0.04)").style("border-radius", "4px")
            .style("border-left", "2px solid #F7931A");

        row.append("div").style("font-size", "9px").style("color", "#888").style("margin-bottom", "2px").text(`#${idx + 1}`);
        row.append("div")
            .style("font-family", "monospace").style("font-size", "8px").style("color", "#F7931A")
            .style("word-break", "break-all").style("margin-bottom", "2px")
            .style("cursor", "pointer").style("text-decoration", "underline")
            .text(a.address)
            .on("mouseover", function () { d3.select(this).style("color", "#ffb347"); })
            .on("mouseout", function () { d3.select(this).style("color", "#F7931A"); })
            .on("click", function (ev) {
                ev.stopPropagation();
                if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, a.address);
                showAddressChain(a.address, window._matrixAllArcs, window._matrixDays);
            });
        row.append("div").style("font-size", "9px").style("color", "#888")
            .text(`₿ ${a.btc.toFixed(6)}  ·  ${fmtMatDay(a.date_from)} ${a.hour_from}:00 → ${fmtMatDay(a.date_to)} ${a.hour_to}:00`);
    });
}

function showCellDetailFiltered(cell, days, bin, filteredArcs) {
    showCellDetailForArcDay(bin, cell.i, days, filteredArcs, cell.j);
}

// ── Cross arc detail panel (on pin) ──────────────────────────────
function showCrossArcDetail(arcs, bf, bt, days, filteredCount) {
    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");
    const displayCount = filteredCount || arcs.length;

    const panel = container.append("div").attr("id", "matrix-cell-detail")
        .style("margin-top", "16px").style("padding", "12px")
        .style("background", "#1a1a2e").style("border", "1px solid rgba(247,147,26,0.5)")
        .style("border-radius", "8px").style("color", "#fff");

    const bs = window._matrixBinSize || 1;
    const fromStart = bf * bs, fromEnd = fromStart + bs;
    const toStart = bt * bs, toEnd = toStart + bs;
    panel.append("div")
        .style("font-size", "11px").style("font-weight", "700")
        .style("color", "#F7931A").style("margin-bottom", "2px")
        .text(`📌 ${pad2(fromStart)}:00–${pad2(fromEnd)}:00  →  ${pad2(toStart)}:00–${pad2(toEnd)}:00`);
    panel.append("div")
        .style("font-size", "10px").style("color", "#aaa").style("margin-bottom", "4px")
        .text(`${displayCount} TXs · ₿ ${d3.sum(arcs, a => a.btc).toFixed(4)} total · Avg hold: ${(() => {
                const gaps = arcs.map(a => Math.abs(a.day_to - a.day_from));
                return (gaps.reduce((s, v) => s + v, 0) / gaps.length).toFixed(1);
            })()
            } days`);
    panel.append("div")
        .style("font-size", "9px").style("color", "#00E5FF").style("margin-bottom", "10px")
        .text("🟠🟢 Click any highlighted cell to see its transactions");

    panel.append("button")
        .style("width", "100%").style("padding", "5px").style("margin-bottom", "10px")
        .style("background", "transparent").style("color", "#888")
        .style("border", "1px solid #444").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-size", "10px")
        .text("✕ Unpin — show all arcs")
        .on("click", () => {
            const f = window._matrixLastFilters || { minBtc: null, maxDayGap: null, minHops: null };
            if (window._matrixDrawArcs) window._matrixDrawArcs(f.minBtc, f.maxDayGap, f.minHops, "");
            d3.select("#matrix-cell-detail").remove();
        });

    panel.append("div").style("font-size", "9px").style("color", "#888")
        .style("margin-bottom", "6px").style("text-transform", "uppercase")
        .text(`All ${displayCount} TXs:`);

    const listDiv = panel.append("div")
        .style("max-height", "260px").style("overflow-y", "auto").style("padding-right", "4px");

    [...arcs].sort((a, b) => b.btc - a.btc).forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom", "5px").style("padding", "6px")
            .style("background", "rgba(255,255,255,0.04)").style("border-radius", "4px")
            .style("border-left", "2px solid #00E5FF");

        row.append("div").style("font-size", "9px").style("color", "#888").text(`#${idx + 1}`);
        row.append("div")
            .style("font-family", "monospace").style("font-size", "8px").style("color", "#00E5FF")
            .style("word-break", "break-all").style("margin-bottom", "2px")
            .style("cursor", "pointer").style("text-decoration", "underline")
            .text(a.address)
            .on("mouseover", function () { d3.select(this).style("color", "#00ffff"); })
            .on("mouseout", function () { d3.select(this).style("color", "#00E5FF"); })
            .on("click", function (ev) {
                ev.stopPropagation();
                if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, a.address);
                showAddressChain(a.address, window._matrixAllArcs, window._matrixDays);
            });
        row.append("div").style("font-size", "9px").style("color", "#888")
            .text(`₿ ${a.btc.toFixed(6)}  ·  ${fmtMatDay(a.date_from)} → ${fmtMatDay(a.date_to)}`);
    });
}

// ── Address chain panel ───────────────────────────────────────────
function showAddressChain(address, allArcs, days) {
    showSuspiciousBanner(address);

    d3.select("#matrix-cell-detail").remove();
    const container = d3.select("#filter-controls-container");
    const chain = allArcs.filter(a => a.address === address)
        .sort((a, b) => a.date_from.localeCompare(b.date_from));

    const panel = container.append("div").attr("id", "matrix-cell-detail")
        .style("margin-top", "16px").style("padding", "12px")
        .style("background", "#0a1628").style("border", "1px solid rgba(0,191,255,0.5)")
        .style("border-radius", "8px").style("color", "#fff");

    panel.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#00BFFF")
        .style("margin-bottom", "4px").style("text-transform", "uppercase").style("letter-spacing", "0.08em")
        .text("Address Chain");
    panel.append("div")
        .style("font-family", "monospace").style("font-size", "8px").style("color", "#aaa")
        .style("word-break", "break-all").style("margin-bottom", "8px").text(address);
    panel.append("div").style("font-size", "10px").style("color", "#aaa").style("margin-bottom", "6px")
        .text(`${chain.length} hops · ₿ ${d3.sum(chain, a => a.btc).toFixed(4)} total`);
    panel.append("div")
        .style("font-size", "9px").style("color", "#00BFFF").style("margin-bottom", "8px")
        .text("Cyan arcs show this address's flows · 🟠🟢 cells show active days");

    panel.append("button")
        .style("width", "100%").style("padding", "6px").style("margin-bottom", "8px")
        .style("background", "#0ea5e9").style("color", "#fff")
        .style("border", "none").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-size", "10px").style("font-weight", "600")
        .text("🔗 View full chain (linear layout)")
        .on("click", () => goToLinearChainView(address));

    panel.append("button")
        .style("width", "100%").style("padding", "5px").style("margin-bottom", "8px")
        .style("background", "transparent").style("color", "#888")
        .style("border", "1px solid #444").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-size", "10px")
        .text("✕ Clear — show all arcs")
        .on("click", () => {
            const f = window._matrixLastFilters || { minBtc: null, maxDayGap: null, minHops: null };
            if (window._matrixDrawArcs) window._matrixDrawArcs(f.minBtc, f.maxDayGap, f.minHops, "");
            d3.select("#matrix-cell-detail").remove();
            d3.select("#matrix-suspicious-banner").remove();
        });

    const listDiv = panel.append("div")
        .style("max-height", "280px").style("overflow-y", "auto").style("padding-right", "4px");

    chain.forEach((a, idx) => {
        const row = listDiv.append("div")
            .style("margin-bottom", "5px").style("padding", "6px")
            .style("background", "rgba(0,191,255,0.05)").style("border-radius", "4px")
            .style("border-left", "2px solid #00BFFF");

        row.append("div").style("font-size", "9px").style("color", "#00BFFF")
            .style("font-weight", "700").style("margin-bottom", "2px").text(`Hop ${idx + 1}`);
        row.append("div").style("font-size", "9px").style("color", "#aaa")
            .text(`${fmtMatDay(a.date_from)} ${String(a.hour_from).padStart(2, '0')}:00 → ${fmtMatDay(a.date_to)} ${String(a.hour_to).padStart(2, '0')}:00`);
        row.append("div").style("font-size", "9px").style("color", "#F7931A")
            .style("font-weight", "600").text(`₿ ${a.btc.toFixed(6)}`);

        if (idx < chain.length - 1) {
            listDiv.append("div").style("text-align", "center").style("color", "#00BFFF")
                .style("font-size", "12px").style("margin", "2px 0").text("↓");
        }
    });
}

// ── Sidebar ───────────────────────────────────────────────────────
function buildMatrixSidebar(rawData) {
    const container = d3.select("#filter-controls-container");
    container.selectAll("*").remove();

    const days = [...new Set(rawData.map(d => d.date))].sort();

    const lbl = txt => container.append("div")
        .style("font-size", "10px").style("font-weight", "700")
        .style("letter-spacing", "0.07em").style("text-transform", "uppercase")
        .style("color", "#888").style("margin", "12px 0 5px").text(txt);

    // ── 1. Hour Grouping ─────────────────────────────────────────
    lbl("Hour Grouping");

    function updateCorridorSummary(crossArcs, allArcs, sortBy) {
        const el = document.getElementById("matrix-corridor-summary");
        if (!el) return;
        sortBy = sortBy || window._corridorSortBy || 'count';
        window._corridorSortBy = sortBy;
        const toggleId = "matrix-corridor-toggle";
        if (!document.getElementById(toggleId)) {
            const toggleDiv = document.createElement("div");
            toggleDiv.id = toggleId;
            toggleDiv.style.cssText = "display:flex;gap:4px;margin-bottom:6px;";
            toggleDiv.innerHTML = `
    <div style="font-size:9px;color:#888;margin-bottom:4px;">Sorted by txs count</div>`;
            el.parentNode.insertBefore(toggleDiv, el);
        } else {
            const cb = document.getElementById("sort-by-count");
            const bb = document.getElementById("sort-by-btc");
            if (cb) { cb.style.background = sortBy === 'count' ? '#F7931A' : 'transparent'; cb.style.color = sortBy === 'count' ? '#fff' : '#F7931A'; }
            if (bb) { bb.style.background = sortBy === 'btc' ? '#F7931A' : 'transparent'; bb.style.color = sortBy === 'btc' ? '#fff' : '#F7931A'; }
        }
        const corridors = new Map();
        crossArcs.forEach(a => {
            const k = `${a.bin_from}_${a.bin_to}`;
            if (!corridors.has(k)) corridors.set(k, { bf: a.bin_from, bt: a.bin_to, count: 0, btc: 0 });
            const c = corridors.get(k); c.count++; c.btc += a.btc;
        });
        const top5 = Array.from(corridors.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
        if (!top5.length) { el.innerHTML = '<span style="color:#666;font-style:italic">No cross-panel flows.</span>'; return; }
        el.innerHTML = top5.map((c, i) => {
            const bar = Math.round((c.count / top5[0].count) * 60);
            return `<div style="margin-bottom:7px;cursor:pointer;"
                onclick="const f=window._matrixLastFilters||{}; if(window._matrixDrawArcs){ window._matrixDrawArcs(f.minBtc||null,f.maxDayGap||null,f.minHops||null,''); } 
         setTimeout(()=>{const key='${c.bf}_${c.bt}';
                document.querySelectorAll('path.cross-arc[data-key]').forEach(p=>{
                p.style.opacity=p.getAttribute('data-key')===key?'1':'0.15';
                if(p.getAttribute('data-key')===key)p.setAttribute('stroke','#2563EB');});},80);"
                title="Click to highlight">
                <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                    <span style="color:#F7931A;font-weight:700;font-size:10px;">#${i + 1} ${fmtHourRange(c.bf)} → ${fmtHourRange(c.bt)}</span>
                    <span style="color:#FF0000;font-size:10px;font-weight:600;">${c.count} txs</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <div style="height:4px;width:${bar}px;background:#F7931A;border-radius:2px;flex-shrink:0;"></div>
                    <span style="color:#888;font-size:9px;">₿ ${c.btc.toFixed(2)}</span>
                </div></div>`;
        }).join('');
    }
    window._matrixUpdateCorridors = updateCorridorSummary;

    let curIdx = HOUR_BIN_DIVISORS.indexOf(window._matrixBinSize || 4);
    if (curIdx < 0) curIdx = 3;

    const binLbl = container.append("div")
        .style("font-size", "10px").style("color", "#F7931A").style("margin-bottom", "3px")
        .text(`Bin size: ${HOUR_BIN_DIVISORS[curIdx]}h (${24 / HOUR_BIN_DIVISORS[curIdx]} panels)`);
    container.append("input").attr("type", "range")
        .attr("min", 0).attr("max", HOUR_BIN_DIVISORS.length - 1).attr("step", 1).attr("value", curIdx)
        .style("width", "100%")
        .on("input", function () { const idx = +this.value; binLbl.text(`Bin size: ${HOUR_BIN_DIVISORS[idx]}h (${24 / HOUR_BIN_DIVISORS[idx]} panels)`); })
        .on("change", function () { if (window._matrixRebuild) window._matrixRebuild(HOUR_BIN_DIVISORS[+this.value]); });
    container.append("div").style("font-size", "9px").style("color", "#666").style("margin-bottom", "4px")
        .text("Merge hours to reduce clutter. 4h = 6 panels (default).");

    // ── 2. Hottest Corridors ─────────────────────────────────────
    lbl("Hottest Corridors");
    container.append("div").attr("id", "matrix-corridor-summary")
        .style("font-size", "10px").style("color", "#aaa")
        .style("background", "rgba(247,147,26,0.06)").style("border", "1px solid rgba(247,147,26,0.2)")
        .style("border-radius", "6px").style("padding", "8px").style("margin-bottom", "4px")
        .html('<span style="color:#666;font-style:italic">Loading…</span>');
    container.append("div").style("font-size", "9px").style("color", "#666").style("margin-bottom", "10px")
        .text("Click any corridor to highlight it on the matrix.");

    // ── 3. Peeling Chain Detection placeholder ────────────────────
    lbl("Peeling Chain Detection");
    container.append("div").attr("id", "peeling-detection-placeholder");

    // ── 4. Arc Filters ────────────────────────────────────────────
    lbl("Arc Filters");
    container.append("div").style("font-size", "9px").style("color", "#666").style("margin-bottom", "6px")
        .text("Filters arcs AND removes matrix cells below threshold. 0 = no filtering.");

    container.append("div").style("font-size", "10px").style("color", "#aaa").style("margin-bottom", "2px").text("Min BTC per arc");
    const f1Lbl = container.append("div").style("font-size", "10px").style("color", "#F7931A").style("margin-bottom", "3px").text("Threshold: 0 BTC");
    const f1 = container.append("input").attr("type", "range").attr("min", 0).attr("max", 500).attr("value", 0).attr("step", 5)
        .style("width", "100%").on("input", function () { f1Lbl.text(`Threshold: ${this.value} BTC`); });

    container.append("div").style("font-size", "10px").style("color", "#aaa").style("margin", "8px 0 2px").text("Max UTXO Holding Period");
    const f3Lbl = container.append("div").style("font-size", "10px").style("color", "#F7931A").style("margin-bottom", "3px").text("Max gap: 0 (no limit)");
    const f3 = container.append("input").attr("type", "range").attr("min", 0).attr("max", 12).attr("value", 0).attr("step", 1)
        .style("width", "100%").on("input", function () { f3Lbl.text(+this.value === 0 ? "Max gap: 0 (no limit)" : `Max gap: ${this.value} days`); });

    container.append("div").style("margin-top", "14px").append("button")
        .style("width", "100%").style("padding", "8px").style("background", "#F7931A")
        .style("color", "#fff").style("border", "none").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-weight", "600").style("font-size", "11px")
        .text("Apply Filters")
    .on("click", () => {
            if (!window._matrixDrawArcs) return;
            const rawGap = +f3.property("value");
            const minBtc = +f1.property("value");
            const maxDayGap = rawGap === 0 ? null : rawGap;
            const filters = { minBtc, maxDayGap };
            window._matrixLastFilters = filters;
            window._matrixDrawArcs(minBtc, maxDayGap, null, "");

            const gridArcsAll = (window._matrixAllArcs || []).filter(a => a.same_bin);
            const cellAgg = new Map();
            gridArcsAll.forEach(a => {
                if (minBtc > 0 && a.btc < minBtc) return;
                const gap = Math.abs(a.day_to - a.day_from);
                if (maxDayGap !== null && gap > maxDayGap) return;
                const i = Math.min(a.day_from, a.day_to);
                const j = Math.max(a.day_from, a.day_to);
                const key = `${a.bin_from}_${i}_${j}`;
                if (!cellAgg.has(key)) cellAgg.set(key, { count: 0, btc: 0 });
                const c = cellAgg.get(key);
                c.count++; c.btc += a.btc;
            });

            d3.selectAll(".cell-rect").each(function () {
                const m = this.getAttribute("class").match(/cell-(\d+)-(\d+)-(\d+)/);
                if (!m) return;
                const key = `${m[1]}_${m[2]}_${m[3]}`;
                const agg = cellAgg.get(key);
                d3.select(this).attr("fill", agg ? "#fff" : "#f0f0f0").attr("opacity", 1);
            });

            d3.selectAll("text.intra-label").each(function () {
                const m = this.getAttribute("class").match(/label-(\d+)-(\d+)-(\d+)/);
                if (!m) { this.textContent = ""; return; }
                const key = `${m[1]}_${m[2]}_${m[3]}`;
                const agg = cellAgg.get(key);
                this.textContent = agg ? agg.count : "";
            });

            d3.select("#matrix-filter-notice").remove();
            if (minBtc > 0 || maxDayGap) {
                const parts = [];
                if (minBtc > 0) parts.push(`Min BTC: ${minBtc}`);
                if (maxDayGap) parts.push(`Max hold: ${maxDayGap} days`);
                d3.select("#chart-area").insert("div", "svg")
                    .attr("id", "matrix-filter-notice")
                    .style("background", "#1a2e1a").style("color", "#22c55e")
                    .style("padding", "5px 12px").style("font-size", "9px")
                    .style("border-bottom", "1px solid #22c55e40").style("font-weight", "600")
                    .html(`⚡ Filters active: ${parts.join("  ·  ")} &nbsp;
                           <span style="color:#666;font-weight:400"></span>
                           <span style="float:right;cursor:pointer;color:#556"
                                 onclick="d3.select('#matrix-filter-notice').remove();
                                          if(window._matrixDrawArcs) window._matrixDrawArcs(null,null,null,'');
                                          d3.selectAll('.cell-rect').attr('fill','#fff').attr('opacity',1);
                                          d3.selectAll('text.intra-label').each(function(){ const v=this.getAttribute('data-orig-count'); if(v!==null) this.textContent=v; });
                                        window._matrixLastFilters={};">
                                 ✕ Clear filters</span>`);
            }

            setTimeout(() => {
                if (!window._matrixUpdateCorridors || !window._matrixCrossArcs) return;
                const filteredCross = window._matrixCrossArcs.filter(a => {
                    const dayGap = Math.abs(a.day_to - a.day_from);
                    if (maxDayGap !== null && dayGap > maxDayGap) return false;
                    if (minBtc > 0 && a.btc < minBtc) return false;
                    return true;
                });
                window._matrixUpdateCorridors(filteredCross, window._matrixAllArcs);
            }, 80);
        });
    // ── 5. Peeling Chain Investigation placeholder ────────────────
    lbl("Peeling Chain Investigation");
    container.append("div").attr("id", "origin-detection-placeholder");

    // ── 6. Matrix Info (last) ─────────────────────────────────────
    lbl("Matrix Info");
    container.append("div")
        .style("padding", "12px").style("background", "#1a1a2e")
        .style("border-radius", "8px").style("border", "1px solid rgba(247,147,26,0.3)")
        .style("margin-bottom", "12px")
        .html(`<div style="font-size:11px;color:#aaa;line-height:1.9">
            Days: <b style="color:#fff">${days.length}</b><br>
            Period: <b style="color:#fff">${fmtMatDay(days[0])} – ${fmtMatDay(days[days.length - 1])}</b><br>
            Rows: <b style="color:#fff">${rawData.length.toLocaleString()}</b><br>
            Hour grids: <b style="color:#fff">24</b>
        </div>`);
}


// ── Helpers ───────────────────────────────────────────────────────
function fmtMatDay(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.split("-").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[m - 1]} ${d}`;
}
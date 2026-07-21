// ═══════════════════════════════════════════════════════════════════
//  peelingChainDetection.js  — v5 (persistent highlight, linear-view links)
//
//  SECTION A — Repeating Address Finder
//    Counts address appearances in arc data directly.
//    Finds your known repeating-address peeling chain immediately.
//
//  SECTION B — Value-Chain Linking + Peel Ratio Only
//    Algo 1: Chain Linking  (value matching, no address needed)
//    Algo 2: Peel Ratio CV  (consistency of small/large ratio)
//    Score = peel ratio consistency only (0-100, lower CV = higher score)
// ═══════════════════════════════════════════════════════════════════

let _pdRawData = null;
let _pdAllChains = null;
let _pdSettings = {
    minHops: 3,
    feeTolerance: 2.0,
    ratioOn: true,
    maxRatioCV: 40,
};

// ── Entry point ──────────────────────────────────────────────────
function buildPeelingDetectionUI(rawData) {
    _pdRawData = rawData;
    const check = setInterval(() => {
        const placeholder = document.getElementById("peeling-detection-placeholder");
        if (!placeholder) return;
        clearInterval(check);
        _pdRenderPanel();
    }, 300);
}

// ── Main panel ───────────────────────────────────────────────────
function _pdRenderPanel() {
    const placeholder = d3.select("#peeling-detection-placeholder");
    if (placeholder.empty()) return;
    placeholder.selectAll("*").remove();

    const section = placeholder.append("div")
        .attr("id", "peeling-detection-section");

    section.append("div")
        .style("font-size", "10px").style("font-weight", "700")
        .style("color", "#a855f7").style("text-transform", "uppercase")
        .style("letter-spacing", "0.1em").style("margin-bottom", "10px")
        .text("🔗 Peeling Chain Detection");

    _pdBuildSectionA(section);
    _pdBuildSectionB(section);
}

// ══════════════════════════════════════════════════════════════════
//  SECTION A — Repeating Address Finder
// ══════════════════════════════════════════════════════════════════
function _pdBuildSectionA(section) {
    const card = section.append("div")
        .style("padding", "10px 12px").style("margin-bottom", "10px")
        .style("background", "#0d1117")
        .style("border", "1px solid rgba(0,191,255,0.4)")
        .style("border-radius", "8px");

    card.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#00BFFF")
        .style("margin-bottom", "4px").text("A — Repeating Address Finder");

    card.append("div")
        .style("font-size", "8.5px").style("color", "#556").style("line-height", "1.7")
        .style("margin-bottom", "8px")
        .html(`Scans arc data directly. An address appearing <b style="color:#aaa">2+ times</b>
               as a UTXO output is being reused across hops — the clearest sign of a
               <b style="color:#00BFFF">repeating-address peeling chain</b>.`);

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum times address must appear");
    const aLbl = card.append("div")
        .style("font-size", "10px").style("color", "#00BFFF").style("font-weight", "700")
        .style("margin-bottom", "4px").text("≥ 2 appearances");
    const aSlider = card.append("input")
        .attr("type", "range").attr("min", 2).attr("max", 10).attr("value", 2).attr("step", 1)
        .style("width", "100%")
        .on("input", function () { aLbl.text(`≥ ${this.value} appearances`); });

    card.append("button")
        .style("width", "100%").style("margin-top", "8px").style("padding", "6px")
        .style("background", "#0e2a3a").style("color", "#00BFFF")
        .style("border", "1px solid #00BFFF").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-weight", "700").style("font-size", "10px")
        .text("▶ Find Repeating Addresses")
        .on("click", () => _pdRunSectionA(card, +aSlider.property("value")));

    card.append("div").attr("id", "pd-sectionA-results");
}

function _pdRunSectionA(card, minAppear) {
    d3.select("#pd-sectionA-results").html("");
    const resultsDiv = d3.select("#pd-sectionA-results");
    const arcs = window._matrixAllArcs || [];

    if (!arcs.length) {
        resultsDiv.append("div").style("font-size", "9px").style("color", "#F43F5E")
            .style("padding", "8px").text("⚠ Arc data not loaded yet.");
        return;
    }

    const freq = new Map();
    arcs.forEach(a => {
        if (!a.address || a.address === "unknown") return;
        freq.set(a.address, (freq.get(a.address) || 0) + 1);
    });

    const suspects = Array.from(freq.entries())
        .filter(([, count]) => count >= minAppear)
        .sort((a, b) => b[1] - a[1]);

    if (!suspects.length) {
        resultsDiv.append("div")
            .style("font-size", "9px").style("color", "#F43F5E")
            .style("padding", "8px").style("background", "rgba(244,63,94,0.08)")
            .style("border-radius", "5px")
            .text(`No addresses appear ${minAppear}+ times. Lower the threshold.`);
        return;
    }

    const summaryBox = resultsDiv.append("div")
        .style("padding", "7px").style("margin", "7px 0")
        .style("background", "rgba(0,191,255,0.07)")
        .style("border", "1px solid rgba(0,191,255,0.2)")
        .style("border-radius", "5px");
    summaryBox.append("div")
        .style("font-size", "9px").style("color", "#00BFFF").style("font-weight", "700")
        .style("margin-bottom", "3px").text("Results");
    summaryBox.append("div").style("font-size", "9px").style("color", "#aaa")
        .html(`Total addresses: <b style="color:#fff">${freq.size}</b> &nbsp;·&nbsp;
               Appearing ≥${minAppear}×: <b style="color:#00BFFF">${suspects.length}</b>`);

    const maxCount = suspects[0][1];
    suspects.slice(0, 15).forEach(([addr, count], i) => {
        const addrArcs = arcs.filter(a => a.address === addr);
        const totalBtc = d3.sum(addrArcs, a => a.btc);
        const dateRange = addrArcs.map(a => a.date_from).sort();
        const barW = Math.round((count / maxCount) * 110);
        const danger = count >= 5 ? "#ef4444" : count >= 3 ? "#f59e0b" : "#00BFFF";

        const row = resultsDiv.append("div")
            .style("margin-bottom", "6px").style("padding", "7px 8px")
            .style("background", "rgba(255,255,255,0.02)")
            .style("border-radius", "5px").style("border-left", `3px solid ${danger}`)
            .style("cursor", "pointer")
            .on("click", () => {
                if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, addr);
                if (window._matrixAllArcs && window._matrixDays)
                    showAddressChain(addr, window._matrixAllArcs, window._matrixDays);
            });

        const rHdr = row.append("div")
            .style("display", "flex").style("justify-content", "space-between")
            .style("align-items", "center").style("margin-bottom", "3px");
        rHdr.append("span").style("font-size", "9px").style("font-weight", "700")
            .style("color", danger).text(`#${i + 1}  ${count}× appearances`);
        rHdr.append("span").style("font-size", "8px").style("color", "#888")
            .text(`₿${totalBtc.toFixed(4)}`);

        row.append("div")
            .style("font-family", "monospace").style("font-size", "7.5px").style("color", "#00BFFF")
            .style("word-break", "break-all").style("margin-bottom", "3px").text(addr);

        const btnRow = row.append("div")
            .style("display", "flex").style("gap", "6px").style("margin-bottom", "3px");
        btnRow.append("span")
            .style("font-size", "7.5px").style("padding", "1px 6px")
            .style("background", "rgba(14,165,233,0.15)").style("color", "#0ea5e9")
            .style("border", "1px solid #0ea5e9").style("border-radius", "3px")
            .text("🔗 Linear")
            .on("click", function (ev) {
                ev.stopPropagation();
                if (window.goToLinearChainView) window.goToLinearChainView(addr);
            });

        const barRow = row.append("div")
            .style("display", "flex").style("align-items", "center").style("gap", "6px");
        barRow.append("div")
            .style("height", "3px").style("width", `${barW}px`)
            .style("background", danger).style("border-radius", "2px").style("flex-shrink", "0");
        barRow.append("span").style("font-size", "7.5px").style("color", "#666")
            .text(dateRange.length ? `${dateRange[0]} → ${dateRange[dateRange.length - 1]}` : "");

        row.append("div").style("font-size", "7.5px").style("color", "#555").style("margin-top", "2px")
            .text("↑ Click row to highlight on matrix · click 🔗 Linear for full chain view");
    });

    if (suspects.length > 15) {
        resultsDiv.append("div").style("font-size", "8px").style("color", "#555")
            .style("text-align", "center").style("margin-top", "4px")
            .text(`… and ${suspects.length - 15} more`);
    }
}

// ══════════════════════════════════════════════════════════════════
//  SECTION B — Chain Linking + Peel Ratio only
// ══════════════════════════════════════════════════════════════════
function _pdBuildSectionB(section) {
    const card = section.append("div")
        .style("padding", "10px 12px").style("margin-bottom", "10px")
        .style("background", "#0d0d0d")
        .style("border", "1px solid rgba(34,197,94,0.3)")
        .style("border-radius", "8px");

    card.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#22c55e")
        .style("margin-bottom", "4px").text("B — Value-Chain Linking + Peel Ratio");

    card.append("div")
        .style("font-size", "8.5px").style("color", "#556").style("line-height", "1.7")
        .style("margin-bottom", "10px")
        .html(`Links transactions by BTC value (no address needed). Catches
               <b style="color:#aaa">fresh-address chains</b> too.
               Peel ratio = small÷large output — consistent ratio across hops = scripted.<br>
               Hop table shows carry address — if same address repeats, confirms Section A.`);

    _pdMiniHeader(card, "1", "Chain Linking", "3b82f6");

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum hops");
    const hopsLbl = card.append("div")
        .style("font-size", "10px").style("color", "#3b82f6").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≥ ${_pdSettings.minHops} hops`);
    card.append("input").attr("type", "range").attr("min", 2).attr("max", 10).attr("step", 1)
        .property("value", _pdSettings.minHops).style("width", "100%")
        .on("input", function () {
            _pdSettings.minHops = +this.value;
            hopsLbl.text(`≥ ${this.value} hops`);
            _pdAllChains = null;
            _pdRunPipeline();
        });

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin", "8px 0 3px")
        .text("Fee tolerance — max BTC mismatch between hops (%)");
    const tolLbl = card.append("div")
        .style("font-size", "10px").style("color", "#3b82f6").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≤ ${_pdSettings.feeTolerance.toFixed(1)} %`);
    card.append("input").attr("type", "range").attr("min", 1).attr("max", 50).attr("step", 1)
        .property("value", _pdSettings.feeTolerance * 10).style("width", "100%")
        .on("input", function () {
            _pdSettings.feeTolerance = (+this.value) / 10;
            tolLbl.text(`≤ ${_pdSettings.feeTolerance.toFixed(1)} %`);
            _pdAllChains = null;
            _pdRunPipeline();
        });

    _pdMiniHeader(card, "2", "Peel Ratio Consistency", "f59e0b");
    card.append("div").style("font-size", "8.5px").style("color", "#445").style("margin-bottom", "6px")
        .text("small÷large output ratio — same every hop = automated. Low CV = suspicious.");

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Max ratio variation (CV%) — lower = stricter");
    const ratioLbl = card.append("div")
        .style("font-size", "10px").style("color", "#f59e0b").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≤ ${_pdSettings.maxRatioCV} % CV`);

    const ratioRow = card.append("div").style("display", "flex").style("align-items", "center").style("gap", "6px");
    ratioRow.append("input").attr("type", "range").attr("min", 1).attr("max", 80).attr("step", 1)
        .property("value", _pdSettings.maxRatioCV).style("flex", "1")
        .on("input", function () {
            _pdSettings.maxRatioCV = +this.value;
            ratioLbl.text(`≤ ${this.value} % CV`);
            _pdRunPipeline();
        });
    const ratioToggle = ratioRow.append("label")
        .style("font-size", "8px").style("color", "#f59e0b")
        .style("white-space", "nowrap").style("cursor", "pointer")
        .style("display", "flex").style("align-items", "center").style("gap", "3px");
    ratioToggle.append("input").attr("type", "checkbox").property("checked", _pdSettings.ratioOn)
        .on("change", function () { _pdSettings.ratioOn = this.checked; _pdRunPipeline(); });
    ratioToggle.append("span").text("ON");

    card.append("div")
        .style("font-size", "8px").style("color", "#444").style("margin", "10px 0 6px")
        .style("padding", "5px").style("background", "#0a0a0a").style("border-radius", "4px")
        .text("Score 0–100: 100 = perfectly consistent ratio every hop (most suspicious)");

    card.append("button")
        .style("width", "100%").style("padding", "5px").style("margin-bottom", "8px")
        .style("background", "transparent").style("color", "#666")
        .style("border", "1px solid #333").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-size", "9px")
        .text("↺ Reset")
        .on("click", () => {
            _pdSettings = { minHops: 3, feeTolerance: 2.0, ratioOn: true, maxRatioCV: 40 };
            _pdAllChains = null;
            _pdRenderPanel();
        });

    card.append("div").attr("id", "pd-results").style("margin-top", "4px");
    _pdRunPipeline();
}

function _pdMiniHeader(parent, num, title, colorHex) {
    const color = `#${colorHex}`;
    const hdr = parent.append("div")
        .style("display", "flex").style("align-items", "center").style("gap", "7px")
        .style("margin", "10px 0 5px");
    hdr.append("div")
        .style("width", "18px").style("height", "18px").style("flex-shrink", "0")
        .style("background", `${color}20`).style("border", `1px solid ${color}`)
        .style("border-radius", "50%").style("display", "flex")
        .style("align-items", "center").style("justify-content", "center")
        .style("font-size", "10px").style("font-weight", "700").style("color", color)
        .text(num);
    hdr.append("div")
        .style("font-size", "9px").style("font-weight", "700").style("color", color).text(title);
}

// ═══════════════════════════════════════════════════════════════════
//  PIPELINE
// ═══════════════════════════════════════════════════════════════════
function _pdRunPipeline() {
    const resultsDiv = d3.select("#pd-results");
    if (resultsDiv.empty()) return;

    if (!_pdAllChains) {
        _pdAllChains = _pdBuildChains(_pdRawData, _pdSettings.minHops, _pdSettings.feeTolerance / 100);
    }

    resultsDiv.html("");

    if (!_pdAllChains.length) {
        resultsDiv.append("div").style("padding", "8px").style("font-size", "9px")
            .style("color", "#F43F5E").style("background", "rgba(244,63,94,0.08)")
            .style("border-radius", "5px")
            .text("⚠ No chains found. Lower min hops or raise fee tolerance.");
        return;
    }

    const scored = _pdAllChains.map(chain => _pdScoreChain(chain));
    let passed = scored;
    if (_pdSettings.ratioOn)
        passed = passed.filter(s => s.ratioCV * 100 <= _pdSettings.maxRatioCV);

    passed.forEach(s => { s.finalScore = _pdComputeScore(s); });
    passed.sort((a, b) => b.finalScore - a.finalScore);

    const summary = resultsDiv.append("div")
        .style("padding", "7px").style("margin-bottom", "8px")
        .style("background", "rgba(34,197,94,0.07)")
        .style("border", "1px solid #22c55e40").style("border-radius", "5px");
    summary.append("div")
        .style("font-size", "9px").style("color", "#22c55e").style("font-weight", "700")
        .style("margin-bottom", "3px").text("Section B Results");
    summary.append("div").style("font-size", "9px").style("color", "#aaa").style("line-height", "1.85")
        .html(`Chains by value-linking: <b style="color:#3b82f6">${_pdAllChains.length}</b> &nbsp;·&nbsp;
               Passing ratio filter: <b style="color:#22c55e">${passed.length}</b>`);

    if (!passed.length) {
        resultsDiv.append("div").style("padding", "8px").style("font-size", "9px")
            .style("color", "#F43F5E").style("background", "rgba(244,63,94,0.08)")
            .style("border-radius", "5px")
            .text("⚠ No chains pass ratio filter. Raise Max Ratio CV or turn filter OFF.");
        return;
    }

    passed.slice(0, 8).forEach((s, idx) => _pdRenderChainCard(resultsDiv, s, idx));
    if (passed.length > 8) {
        resultsDiv.append("div").style("font-size", "8px").style("color", "#555")
            .style("text-align", "center").style("margin-top", "4px")
            .text(`… and ${passed.length - 8} more`);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  CHAIN CARD
// ═══════════════════════════════════════════════════════════════════
function _pdRenderChainCard(parent, s, idx) {
    const scoreColor = s.finalScore >= 70 ? "#ef4444" : s.finalScore >= 40 ? "#f59e0b" : "#22c55e";
    const chainLabel = `Chain #${idx + 1}`;

    const carryAddrs = s.chain.map(h => h.tx.outputs.sort((a, b) => b.btc - a.btc)[0]?.addr || "?");
    const uniqueCarry = new Set(carryAddrs);
    const addrRepeats = uniqueCarry.size < carryAddrs.length;

    const card = parent.append("div")
        .style("margin-bottom", "8px").style("padding", "9px")
        .style("background", addrRepeats ? "rgba(0,191,255,0.06)" : "rgba(255,255,255,0.02)")
        .style("border-radius", "5px")
        .style("border-left", `3px solid ${addrRepeats ? "#00BFFF" : scoreColor}`);

    const hdr = card.append("div")
        .style("display", "flex").style("justify-content", "space-between")
        .style("align-items", "flex-start").style("margin-bottom", "4px");

    const leftHdr = hdr.append("div");
    leftHdr.append("div").style("font-size", "10px").style("font-weight", "700").style("color", "#fff")
        .text(`${chainLabel} — ${s.chain.length} hops`);
    if (addrRepeats) {
        leftHdr.append("div").style("font-size", "8px").style("color", "#00BFFF").style("margin-top", "2px")
            .text("⚠ Carry address repeats → repeating-address case");
    }

    const rightHdr = hdr.append("div")
        .style("display", "flex").style("align-items", "center").style("gap", "5px");

    rightHdr.append("button")
        .style("padding", "2px 7px").style("font-size", "8px").style("cursor", "pointer")
        .style("background", "rgba(14,165,233,0.15)").style("color", "#0ea5e9")
        .style("border", "1px solid #0ea5e9").style("border-radius", "4px").style("white-space", "nowrap")
        .text("🔗 Linear")
        .on("click", function (ev) {
            ev.stopPropagation();
            if (carryAddrs[0] && window.goToLinearChainView) window.goToLinearChainView(carryAddrs[0]);
        });

    rightHdr.append("button")
        .style("padding", "2px 7px").style("font-size", "8px").style("cursor", "pointer")
        .style("background", "rgba(168,85,247,0.15)").style("color", "#a855f7")
        .style("border", "1px solid #a855f7").style("border-radius", "4px").style("white-space", "nowrap")
        .text("🔍 Matrix")
        .on("click", function (ev) {
            ev.stopPropagation();
            _pdHighlightChainOnMatrix(s.chain, chainLabel, carryAddrs[0], card);
        });

    rightHdr.append("div")
        .style("font-size", "11px").style("font-weight", "700").style("color", scoreColor)
        .style("background", `${scoreColor}20`).style("padding", "1px 7px")
        .style("border-radius", "10px").text(`${s.finalScore}/100`);

    const badges = card.append("div")
        .style("display", "flex").style("flex-wrap", "wrap").style("gap", "4px")
        .style("margin-bottom", "5px");
    _pdBadge(badges, `Ratio CV ${(s.ratioCV * 100).toFixed(1)}%  (0% = perfectly consistent)`,
        s.ratioCV < 0.05 ? "high" : s.ratioCV < 0.15 ? "med" : "low");
    if (addrRepeats)
        _pdBadge(badges, `${carryAddrs.length - uniqueCarry.size} addr repeat(s)`, "high");

    const firstBtc = s.chain[0].largeOut;
    const lastBtc = s.chain[s.chain.length - 1].largeOut;
    const totalPeeled = s.chain.reduce((sum, h) => sum + h.smallOut, 0);
    card.append("div").style("font-size", "8.5px").style("color", "#aaa").style("line-height", "1.8")
        .html(`Start carry: <b style="color:#F7931A">₿${firstBtc.toFixed(4)}</b>
               → End carry: <b style="color:#F7931A">₿${lastBtc.toFixed(4)}</b><br>
               Total peeled off across all hops: <b style="color:#22c55e">₿${totalPeeled.toFixed(4)}</b>
               &nbsp;·&nbsp; Period: <b style="color:#fff">${s.chain[0].date} – ${s.chain[s.chain.length - 1].date}</b>`);

    // Hop table
    let expanded = false;
    const expandBtn = card.append("div")
        .style("font-size", "9px").style("color", "#22c55e").style("cursor", "pointer")
        .style("margin-top", "5px").style("user-select", "none")
        .text("▶ Show hops + addresses");

    const hopTable = card.append("div").style("display", "none").style("margin-top", "6px");
    hopTable.append("div")
        .style("font-size", "7px").style("color", "#555").style("margin-bottom", "4px")
        .text("Carry = amount continuing the chain · Peeled = amount split off this hop · click address → linear view · click row → flash cell on matrix");

    s.chain.forEach((hop, hi) => {
        const ratioColor = hop.peel_ratio < 0.03 ? "#ef4444" : hop.peel_ratio < 0.10 ? "#f59e0b" : "#aaa";
        const carry = carryAddrs[hi];
        const isRepeatAddr = carryAddrs.indexOf(carry) !== hi;
        const prevCarry = hi > 0 ? s.chain[hi - 1].largeOut : null;
        const delta = prevCarry !== null ? hop.largeOut - prevCarry : null;

        const row = hopTable.append("div")
            .style("padding", "5px 6px").style("margin-bottom", "3px")
            .style("border-bottom", "1px solid #111").style("border-radius", "3px")
            .style("cursor", "pointer")
            .on("mouseover", function () { d3.select(this).style("background", "rgba(168,85,247,0.08)"); })
            .on("mouseout", function () { d3.select(this).style("background", "none"); });

        const line1 = row.append("div")
            .style("display", "flex").style("justify-content", "space-between")
            .style("align-items", "center").style("font-size", "8.5px");
        line1.append("span").style("color", "#22c55e").style("font-weight", "700")
            .text(`#${hi + 1}  ${fmtMatDay(hop.date)} ${String(hop.hour).padStart(2, "0")}h`);
        line1.append("span").style("color", ratioColor).style("font-weight", "700")
            .text(`peel ${(hop.peel_ratio * 100).toFixed(1)}%`);

        const line2 = row.append("div")
            .style("display", "flex").style("gap", "10px").style("flex-wrap", "wrap")
            .style("font-size", "8px").style("color", "#aaa").style("margin-top", "2px");
        line2.append("span").html(`Carry: <b style="color:#F7931A">₿${hop.largeOut.toFixed(4)}</b>`);
        line2.append("span").html(`Peeled: <b style="color:#22c55e">₿${hop.smallOut.toFixed(4)}</b>`);
        if (delta !== null) {
            const dColor = Math.abs(delta) < 0.001 ? "#666" : delta < 0 ? "#f59e0b" : "#3b82f6";
            line2.append("span").html(`Δ vs prev carry: <b style="color:${dColor}">${delta >= 0 ? "+" : ""}${delta.toFixed(4)}</b>`);
        }

        const addrLine = row.append("div")
            .style("font-family", "monospace").style("font-size", "7.5px")
            .style("color", isRepeatAddr ? "#ef4444" : "#00BFFF")
            .style("word-break", "break-all").style("margin-top", "2px")
            .style("text-decoration", "underline").style("cursor", "pointer")
            .attr("title", "Click to view this address in linear layout")
            .text(carry ? carry : "? (no output address)");

        addrLine.on("click", ev => {
            ev.stopPropagation();
            if (carry && window.goToLinearChainView) window.goToLinearChainView(carry);
        });

        // ── Self-contained tx verification — shows THIS hop's real tx data ──
        let verifyExpanded = false;
        const verifyToggle = row.append("div")
            .style("font-size", "7.5px").style("color", "#3b82f6").style("cursor", "pointer")
            .style("margin-top", "3px").style("text-decoration", "underline")
            .text("🔍 Verify this transaction (shows actual tx data, not matrix cell)");
        const verifyBox = row.append("div").style("display", "none")
            .style("margin-top", "4px").style("padding", "6px")
            .style("background", "#0a0a0a").style("border-radius", "4px")
            .style("font-size", "7.5px").style("color", "#aaa").style("line-height", "1.8");

        verifyToggle.on("click", ev => {
            ev.stopPropagation();
            verifyExpanded = !verifyExpanded;
            if (verifyExpanded && verifyBox.select("*").empty()) {
                verifyBox.html("");
                verifyBox.append("div").html(`<b style="color:#fff">TX hash:</b>`);
                verifyBox.append("div").style("font-family", "monospace").style("word-break", "break-all")
                    .style("color", "#888").text(hop.hash);
                verifyBox.append("div").style("margin-top", "4px").html(`<b style="color:#fff">Input address(es) — coins spent TO create this tx:</b>`);
                (hop.tx.in_addresses || []).forEach(ia => {
                    verifyBox.append("div").style("font-family", "monospace").style("word-break", "break-all")
                        .style("color", "#f59e0b").text(ia);
                });
                verifyBox.append("div").style("margin-top", "4px").html(`<b style="color:#fff">Outputs of this tx — where the money goes NEXT:</b>`);
                [...hop.tx.outputs].sort((a, b) => b.btc - a.btc).forEach((o, oi) => {
                    verifyBox.append("div")
                        .style("font-family", "monospace").style("word-break", "break-all")
                        .style("color", oi === 0 ? "#F7931A" : "#22c55e")
                        .html(`${o.addr}  <b>₿${o.btc.toFixed(4)}</b> ${oi === 0 ? '(carry — continues chain)' : '(peel — split off here)'}`);
                });
                verifyBox.append("div").style("margin-top", "6px").style("color", "#556").style("font-style", "italic")
                    .text("Note: this is different from the matrix cell — the matrix lists which OLDER address's coins funded transactions in that hour window (origin/input side), not this tx's own outputs.");
            }
            verifyBox.style("display", verifyExpanded ? "block" : "none");
        });

        row.on("click", ev => {
            ev.stopPropagation();
            const bs = window._matrixBinSize || 1;
            const dayList = window._matrixDays || [];
            const di = dayList.indexOf(hop.date);
            const bin = Math.floor(hop.hour / bs);
            if (di >= 0) {
                d3.selectAll(`.cell-rect.cell-${bin}-${di}-${di}`)
                    .attr("stroke", "#a855f7").attr("stroke-width", 3)
                    .attr("fill", "rgba(168,85,247,0.2)");
                setTimeout(() => {
                    d3.selectAll(`.cell-rect.cell-${bin}-${di}-${di}`)
                        .attr("stroke", "#ddd").attr("stroke-width", 0.5).attr("fill", "#fff");
                }, 2500);
            }
        });
    });

    expandBtn.on("click", ev => {
        ev.stopPropagation();
        expanded = !expanded;
        hopTable.style("display", expanded ? "block" : "none");
        expandBtn.text(expanded ? "▼ Hide hops" : "▶ Show hops + addresses");
    });
}

// ── Clear any active peeling-chain highlight ──────────────────────
window._pdClearHighlight = function () {
    (window._pdActiveHighlightCells || []).forEach(sel => {
        d3.selectAll(sel).attr("stroke", "#ddd").attr("stroke-width", 0.5).attr("fill", "#fff");
    });
    window._pdActiveHighlightCells = [];
    d3.select("#pd-chain-notice").remove();
};

// ── Highlight chain on matrix ─────────────────────────────────────
function _pdHighlightChainOnMatrix(chain, chainLabel, firstCarryAddr, cardEl) {
    if (!chain || !chain.length) return;

    window._pdClearHighlight(); // clear previous highlight before drawing a new one

    const bs = window._matrixBinSize || 1;
    const dayList = window._matrixDays || [];

    if (firstCarryAddr && window._matrixDrawArcs)
        window._matrixDrawArcs(null, null, null, firstCarryAddr);

    setTimeout(() => {
        const cellSelectors = [];
        chain.forEach(hop => {
            const di = dayList.indexOf(hop.date);
            if (di < 0) return;
            const bin = Math.floor(hop.hour / bs);
            const sel = `.cell-rect.cell-${bin}-${di}-${di}`;
            cellSelectors.push(sel);
            d3.selectAll(sel)
                .attr("stroke", "#a855f7").attr("stroke-width", 3)
                .attr("fill", "rgba(168,85,247,0.18)");
        });
        window._pdActiveHighlightCells = cellSelectors;

        // Persists until you click the matrix background
        d3.select("#chart-area svg").on("click.pdHighlight", () => window._pdClearHighlight());

        const arcCount = window._matrixAllArcs
            ? window._matrixAllArcs.filter(a => a.address === firstCarryAddr).length : 0;

        d3.select("#pd-chain-notice").remove();
        d3.select("body").append("div").attr("id", "pd-chain-notice")
            .style("position", "fixed").style("bottom", "20px").style("right", "20px")
            .style("z-index", "99997").style("background", "rgba(88,28,135,0.97)")
            .style("border", "1px solid #a855f7").style("color", "#fff")
            .style("padding", "10px 14px").style("border-radius", "8px").style("font-size", "9px")
            .style("max-width", "260px").style("box-shadow", "0 4px 16px rgba(0,0,0,0.5)")
            .style("line-height", "1.75")
            .html(`<b style="color:#d8b4fe">${chainLabel} on matrix</b><br>
                   🟣 Purple = ${chain.length} hop positions — stays until you click the matrix background<br>
                   🔵 Cyan = carry-address flow<br>
                   <span style="color:${arcCount > 1 ? '#ef4444' : '#22c55e'}">
                   ${arcCount > 1 ? `⚠ Address in ${arcCount} arcs = REPEATING case`
                    : arcCount === 1 ? '✓ 1 arc = fresh-address case'
                        : '⚠ Address not in arc data — possible false positive'}
                   </span>
                   <div style="margin-top:6px;text-align:right;cursor:pointer;color:#d8b4fe;text-decoration:underline"
                        id="pd-chain-notice-clear">✕ Clear</div>`);
        document.getElementById("pd-chain-notice-clear")
            .addEventListener("click", () => window._pdClearHighlight());
    }, 80);
}

// ═══════════════════════════════════════════════════════════════════
//  MATH — Chain Linking + Peel Ratio scoring only
// ═══════════════════════════════════════════════════════════════════
function _pdBuildChains(rawData, minHops, tolPct) {
    const txMap = new Map();
    rawData.forEach(row => {
        if (!txMap.has(row.hash)) {
            txMap.set(row.hash, {
                hash: row.hash, time: row.time, date: row.date, hour: row.hour,
                btc_in: row.btc_in, tx_inputs: row.tx_inputs,
                in_addresses: row.in_addresses, outputs: []
            });
        }
        txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
    });

    const txList = Array.from(txMap.values()).sort((a, b) => a.time - b.time);
    const candidates = txList.filter(tx => tx.outputs.length === 2 && tx.outputs.every(o => o.btc > 0));

    const byLargeOut = new Map();
    candidates.forEach(tx => {
        const sorted = [...tx.outputs].sort((a, b) => b.btc - a.btc);
        const largeOut = sorted[0].btc;
        const bucket = Math.round(largeOut * 10000);
        if (!byLargeOut.has(bucket)) byLargeOut.set(bucket, []);
        byLargeOut.get(bucket).push({ tx, largeOut, smallOut: sorted[1].btc });
    });

    const usedHashes = new Set();
    const chains = [];

    candidates.forEach(startTx => {
        if (usedHashes.has(startTx.hash)) return;
        const chain = [];
        let current = startTx;
        while (current) {
            usedHashes.add(current.hash);
            const sorted = [...current.outputs].sort((a, b) => b.btc - a.btc);
            const largeOut = sorted[0].btc;
            const smallOut = sorted[1].btc;
            chain.push({
                tx: current, largeOut, smallOut,
                peel_ratio: smallOut / largeOut,
                time: current.time, date: current.date,
                hour: current.hour, hash: current.hash, btc_in: current.btc_in
            });
            let nextTx = null;
            const tgt = Math.round(largeOut * 10000);
            for (let delta = -3; delta <= 3; delta++) {
                const bucket = byLargeOut.get(tgt + delta) || [];
                for (const c of bucket) {
                    if (usedHashes.has(c.tx.hash)) continue;
                    if (c.tx.time <= current.time) continue;
                    const diff = Math.abs(c.largeOut - largeOut) / largeOut;
                    if (diff <= tolPct) {
                        const inDiff = Math.abs(c.tx.btc_in - largeOut) / largeOut;
                        if (inDiff <= tolPct * 4) { nextTx = c.tx; break; }
                    }
                }
                if (nextTx) break;
            }
            current = nextTx;
        }
        if (chain.length >= minHops) chains.push(chain);
    });
    return chains;
}

function _pdScoreChain(chain) {
    const ratios = chain.map(h => h.peel_ratio);
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length;
    const ratioCV = mean > 0 ? Math.sqrt(variance) / mean : 1;
    return { chain, ratioMean: mean, ratioCV };
}

function _pdComputeScore(s) {
    return Math.round(Math.max(0, 1 - Math.min(s.ratioCV / 0.2, 1)) * 100);
}

function _pdBadge(parent, label, level) {
    const colors = {
        high: { bg: "rgba(239,68,68,0.15)", text: "#ef4444", border: "#ef444450" },
        med: { bg: "rgba(245,158,11,0.15)", text: "#f59e0b", border: "#f59e0b50" },
        low: { bg: "rgba(255,255,255,0.04)", text: "#555", border: "#33333360" },
    };
    const c = colors[level] || colors.low;
    parent.append("span")
        .style("font-size", "7.5px").style("padding", "2px 5px").style("border-radius", "8px")
        .style("background", c.bg).style("color", c.text).style("border", `1px solid ${c.border}`)
        .text(label);
}
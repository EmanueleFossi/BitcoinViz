// ═══════════════════════════════════════════════════════════════════
//  peelingChainDetection.js  —  Peeling Chain Detection
//  All controls visible at once · toggle each check on/off ·
//  live transparent score breakdown · reset anytime
//
//  NOTE: Input CSV is already pre-filtered to 1 input / 2 output
//  transactions, so NO structural (fan-in/fan-out) filter is applied
//  here. Detection starts directly from value-based chain linking.
//
//  Algo 1 — Chain Linking          (connect txs by value across hops)
//  Algo 2 — Peel Ratio Consistency (CV threshold)
//  Algo 3 — Value Decay Confirmation (log-linear R²)
//  Bonus  — Timing Regularity (optional)
//  Final  — live composite score + chain cards
//
//  HOW TO ADD:
//  1. This file must load in your HTML BEFORE matrixChart.js, e.g.:
//       <script src="peelingChainDetection.js"></script>
//       <script src="matrixChart.js"></script>
//  2. Inside initMatrixChart(), after buildOriginDetectionUI();
//     add ONE line:
//       buildPeelingDetectionUI(cleanRaw);
// ═══════════════════════════════════════════════════════════════════

let _pdRawData   = null;
let _pdAllChains = null;   // every chain found by Algo 1 (cached until Algo-1 settings change)
let _pdSettings  = {
    minHops:      3,
    feeTolerance: 0.5,   // %
    ratioOn:      true,
    maxRatioCV:   15,    // %
    decayOn:      true,
    minR2:        70,    // %
    timingOn:     false,
    maxTimingCV:  25     // %
};

// ═══════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════════
function buildPeelingDetectionUI(rawData) {
    _pdRawData = rawData;
    const check = setInterval(() => {
        const c = d3.select("#filter-controls-container");
        if (c.empty() || c.html().trim() === "") return;
        clearInterval(check);
        _pdRenderPanel();
    }, 300);
}

function _pdRenderPanel() {
    const container = d3.select("#filter-controls-container");
    d3.select("#peeling-detection-section").remove();

    const section = container.append("div")
        .attr("id", "peeling-detection-section")
        .style("margin-top", "16px");

    // ── Header ───────────────────────────────────────────────────
    const header = section.append("div")
        .style("padding", "11px 12px")
        .style("background", "linear-gradient(135deg,#0d1a0d,#1a1a0d)")
        .style("border", "1px solid rgba(34,197,94,0.35)")
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    header.append("div")
        .style("font-size", "11px").style("font-weight", "700")
        .style("color", "#22c55e").style("text-transform", "uppercase")
        .style("letter-spacing", "0.1em").style("margin-bottom", "3px")
        .text("🔗 Peeling Chain Detection");

    header.append("div")
        .style("font-size", "9px").style("color", "#666").style("line-height", "1.7")
        .text("Data is already 1-input / 2-output. Switch any check on or off — results update live.");

    header.append("button")
        .style("width", "100%").style("margin-top", "8px").style("padding", "6px")
        .style("background", "transparent").style("color", "#888")
        .style("border", "1px solid #444").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-size", "9px").style("font-weight", "700")
        .text("↺ Reset All Settings")
        .on("click", () => {
            _pdSettings = {
                minHops: 3, feeTolerance: 0.5,
                ratioOn: true, maxRatioCV: 15,
                decayOn: true, minR2: 70,
                timingOn: false, maxTimingCV: 25
            };
            _pdAllChains = null;
            _pdRenderPanel();
        });

    // ── Algo 1 — Chain Linking (always on, not toggleable) ────────
    const algo1 = _pdAlgoCard(section, "1", "Chain Linking", "3b82f6",
        "Connects transactions across time by matching value", false);

    algo1.body.append("div")
        .style("font-size", "8.5px").style("color", "#778").style("line-height", "1.85")
        .style("margin-bottom", "10px").style("padding", "8px")
        .style("background", "rgba(59,130,246,0.06)").style("border-radius", "4px")
        .style("border-left", "2px solid #1e3a5f")
        .text("The large output of one transaction becomes the input of the next. No address lookup needed — pure value matching across hops.");

    algo1.body.append("div")
        .style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum chain length (hops)");
    const hopsLbl = algo1.body.append("div")
        .style("font-size", "10px").style("color", "#3b82f6").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≥ ${_pdSettings.minHops} hops`);
    algo1.body.append("input")
        .attr("type", "range").attr("min", 2).attr("max", 10).attr("step", 1)
        .property("value", _pdSettings.minHops)
        .style("width", "100%")
        .on("input", function () {
            _pdSettings.minHops = +this.value;
            hopsLbl.text(`≥ ${this.value} hops`);
            _pdAllChains = null;
            _pdRunPipeline();
        });

    algo1.body.append("div")
        .style("font-size", "9px").style("color", "#778").style("margin", "9px 0 3px")
        .text("Fee tolerance (allowed value mismatch between hops)");
    const tolLbl = algo1.body.append("div")
        .style("font-size", "10px").style("color", "#3b82f6").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≤ ${_pdSettings.feeTolerance.toFixed(1)} %`);
    algo1.body.append("input")
        .attr("type", "range").attr("min", 1).attr("max", 30).attr("step", 1)
        .property("value", _pdSettings.feeTolerance * 10)
        .style("width", "100%")
        .on("input", function () {
            _pdSettings.feeTolerance = (+this.value) / 10;
            tolLbl.text(`≤ ${_pdSettings.feeTolerance.toFixed(1)} %`);
            _pdAllChains = null;
            _pdRunPipeline();
        });

    // ── Algo 2 — Peel Ratio Consistency ─────────────────────────
    const algo2 = _pdAlgoCard(section, "2", "Peel Ratio Consistency", "f59e0b",
        "small ÷ large output — same ratio every hop = scripted",
        true, _pdSettings.ratioOn, on => { _pdSettings.ratioOn = on; _pdRunPipeline(); });

    algo2.body.append("div")
        .style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Maximum ratio variation (CV) allowed");
    const ratioLbl = algo2.body.append("div")
        .style("font-size", "10px").style("color", "#f59e0b").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≤ ${_pdSettings.maxRatioCV} % CV`);
    algo2.body.append("input")
        .attr("type", "range").attr("min", 1).attr("max", 50).attr("step", 1)
        .property("value", _pdSettings.maxRatioCV)
        .style("width", "100%")
        .on("input", function () {
            _pdSettings.maxRatioCV = +this.value;
            ratioLbl.text(`≤ ${this.value} % CV`);
            _pdRunPipeline();
        });

    // ── Algo 3 — Value Decay Confirmation ────────────────────────
    const algo3 = _pdAlgoCard(section, "3", "Value Decay Confirmation", "22c55e",
        "Large output shrinking in a straight line on log scale = formula",
        true, _pdSettings.decayOn, on => { _pdSettings.decayOn = on; _pdRunPipeline(); });

    algo3.body.append("div")
        .style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum log-decay fit (R²)");
    const r2Lbl = algo3.body.append("div")
        .style("font-size", "10px").style("color", "#22c55e").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≥ ${(_pdSettings.minR2/100).toFixed(2)} R²`);
    algo3.body.append("input")
        .attr("type", "range").attr("min", 20).attr("max", 99).attr("step", 1)
        .property("value", _pdSettings.minR2)
        .style("width", "100%")
        .on("input", function () {
            _pdSettings.minR2 = +this.value;
            r2Lbl.text(`≥ ${(this.value/100).toFixed(2)} R²`);
            _pdRunPipeline();
        });

    // ── Bonus — Timing Regularity ────────────────────────────────
    const algoT = _pdAlgoCard(section, "+", "Timing Regularity", "a78bfa",
        "Optional — flags chains with clockwork-regular time gaps",
        true, _pdSettings.timingOn, on => { _pdSettings.timingOn = on; _pdRunPipeline(); });

    algoT.body.append("div")
        .style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Maximum timing variation (CV) to flag as regular");
    const timeLbl = algoT.body.append("div")
        .style("font-size", "10px").style("color", "#a78bfa").style("font-weight", "700")
        .style("margin-bottom", "4px").text(`≤ ${_pdSettings.maxTimingCV} % CV`);
    algoT.body.append("input")
        .attr("type", "range").attr("min", 1).attr("max", 60).attr("step", 1)
        .property("value", _pdSettings.maxTimingCV)
        .style("width", "100%")
        .on("input", function () {
            _pdSettings.maxTimingCV = +this.value;
            timeLbl.text(`≤ ${this.value} % CV`);
            _pdRunPipeline();
        });

    // ── Transparent score weighting (read-only info) ─────────────
    const scoreInfo = section.append("div")
        .style("padding", "9px 12px").style("margin-bottom", "8px")
        .style("background", "#0a0a0a").style("border", "1px solid #2a2a2a")
        .style("border-radius", "8px");
    scoreInfo.append("div")
        .style("font-size", "9px").style("font-weight", "700").style("color", "#888")
        .style("text-transform", "uppercase").style("margin-bottom", "5px")
        .text("How the suspicion score is built");
    scoreInfo.append("div")
        .style("font-size", "7.5px").style("color", "#555").style("margin-bottom", "6px")
        .text("Only switched-on checks count toward the score, reweighted to 100.");
    _pdScoreRow(scoreInfo, "Peel ratio consistency", 40, "#f59e0b");
    _pdScoreRow(scoreInfo, "Value decay (log R²)",   35, "#22c55e");
    _pdScoreRow(scoreInfo, "Monotonic decrease",     15, "#3b82f6");
    _pdScoreRow(scoreInfo, "Timing regularity",      10, "#a78bfa");

    // ── Results container ─────────────────────────────────────────
    section.append("div").attr("id", "pd-results");

    _pdRunPipeline();
}

function _pdScoreRow(parent, label, pts, color) {
    const row = parent.append("div")
        .style("display", "flex").style("justify-content", "space-between")
        .style("align-items", "center").style("margin-bottom", "3px");
    row.append("span").style("font-size", "8.5px").style("color", "#999").text(label);
    row.append("span").style("font-size", "8.5px").style("font-weight", "700")
        .style("color", color).text(`${pts} pts`);
}

// ── Algo card shell with optional ON/OFF toggle ──────────────────
function _pdAlgoCard(section, num, title, colorHex, subtitle, toggleable, initialOn, onToggle) {
    const color = `#${colorHex}`;
    const card  = section.append("div")
        .style("padding", "11px 12px")
        .style("background", "#0d0d0d")
        .style("border", `1px solid ${color}40`)
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    const hdr = card.append("div")
        .style("display", "flex").style("align-items", "center")
        .style("justify-content", "space-between").style("margin-bottom", "7px");

    const left = hdr.append("div").style("display", "flex").style("align-items", "center").style("gap", "8px");
    left.append("div")
        .style("width", "24px").style("height", "24px").style("flex-shrink", "0")
        .style("background", `${color}20`).style("border", `1px solid ${color}`)
        .style("border-radius", "50%").style("display", "flex")
        .style("align-items", "center").style("justify-content", "center")
        .style("font-size", "11px").style("font-weight", "700").style("color", color)
        .text(num);

    const titleCol = left.append("div");
    titleCol.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", color)
        .text(num === "+" ? `Bonus — ${title}` : `Algo ${num} — ${title}`);
    titleCol.append("div")
        .style("font-size", "8px").style("color", "#556").text(subtitle);

    const body = card.append("div");

    if (toggleable) {
        const toggleWrap = hdr.append("label")
            .style("position", "relative").style("display", "inline-block")
            .style("width", "34px").style("height", "18px").style("flex-shrink", "0")
            .style("cursor", "pointer");

        const toggleInput = toggleWrap.append("input")
            .attr("type", "checkbox").property("checked", initialOn)
            .style("opacity", "0").style("width", "0").style("height", "0");

        const slider = toggleWrap.append("span")
            .style("position", "absolute").style("top", "0").style("left", "0")
            .style("right", "0").style("bottom", "0")
            .style("background", initialOn ? color : "#333")
            .style("border-radius", "18px").style("transition", "0.2s");

        slider.append("span")
            .style("position", "absolute").style("height", "14px").style("width", "14px")
            .style("left", initialOn ? "18px" : "2px").style("top", "2px")
            .style("background", "#fff").style("border-radius", "50%")
            .style("transition", "0.2s");

        toggleInput.on("change", function () {
            const on = this.checked;
            slider.style("background", on ? color : "#333");
            slider.select("span").style("left", on ? "18px" : "2px");
            body.style("opacity", on ? "1" : "0.35");
            body.style("pointer-events", on ? "auto" : "none");
            if (onToggle) onToggle(on);
        });

        if (!initialOn) body.style("opacity", "0.35").style("pointer-events", "none");
    }

    return { card, body };
}

// ═══════════════════════════════════════════════════════════════════
//  PIPELINE — Algo 1 builds chains (cached) → every chain scored on
//  every metric → active filters applied → final score recomputed
//  using only active components → rendered
// ═══════════════════════════════════════════════════════════════════
function _pdRunPipeline() {
    const resultsDiv = d3.select("#pd-results");
    if (resultsDiv.empty()) return;

    if (!_pdAllChains) {
        _pdAllChains = _pdBuildChains(_pdRawData, _pdSettings.minHops, _pdSettings.feeTolerance / 100);
    }

    resultsDiv.html("");

    if (!_pdAllChains.length) {
        resultsDiv.append("div")
            .style("padding", "10px").style("font-size", "9px").style("color", "#F43F5E")
            .style("background", "rgba(244,63,94,0.08)").style("border-radius", "6px")
            .text("⚠ No chains found by value linking. Try lowering minimum hops or raising fee tolerance.");
        return;
    }

    const scored = _pdAllChains.map(chain => _pdScoreChain(chain));

    let passed = scored;
    if (_pdSettings.ratioOn)
        passed = passed.filter(s => s.ratioCV * 100 <= _pdSettings.maxRatioCV);
    if (_pdSettings.decayOn)
        passed = passed.filter(s => s.r2 * 100 >= _pdSettings.minR2);
    if (_pdSettings.timingOn)
        passed = passed.filter(s => s.timingCV !== null && s.timingCV * 100 <= _pdSettings.maxTimingCV);

    passed.forEach(s => { s.finalScore = _pdComputeScore(s); });
    passed.sort((a, b) => b.finalScore - a.finalScore);

    const summary = resultsDiv.append("div")
        .style("padding", "10px").style("margin-bottom", "8px")
        .style("background", "rgba(34,197,94,0.07)")
        .style("border", "1px solid #22c55e40").style("border-radius", "6px");

    summary.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#22c55e")
        .style("margin-bottom", "4px").text("Live Results");

    summary.append("div")
        .style("font-size", "9px").style("color", "#aaa").style("line-height", "1.85")
        .html(`Chains found (Algo 1): <b style="color:#3b82f6">${_pdAllChains.length}</b><br>
               Passing active checks: <b style="color:#22c55e">${passed.length}</b><br>
               🔴 High (≥70): <b>${passed.filter(s=>s.finalScore>=70).length}</b> &nbsp;
               🟡 Med (40-69): <b>${passed.filter(s=>s.finalScore>=40 && s.finalScore<70).length}</b> &nbsp;
               🟢 Low (&lt;40): <b>${passed.filter(s=>s.finalScore<40).length}</b>`);

    if (!passed.length) {
        resultsDiv.append("div")
            .style("padding", "10px").style("font-size", "9px").style("color", "#F43F5E")
            .style("background", "rgba(244,63,94,0.08)").style("border-radius", "6px")
            .text("⚠ No chains pass the current checks. Turn one off or loosen its threshold.");
        return;
    }

    passed.slice(0, 10).forEach((s, idx) => _pdRenderChainCard(resultsDiv, s, idx));

    if (passed.length > 10) {
        resultsDiv.append("div")
            .style("font-size", "8px").style("color", "#555").style("text-align", "center")
            .style("margin-top", "4px")
            .text(`… and ${passed.length - 10} more chains not shown`);
    }
}

// ── Build chains purely from value-linking (Algo 1) ────────────────
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

    // Data is already 1-in/2-out, this is just a safety guard
    const candidates = txList.filter(tx => tx.outputs.length === 2 && tx.outputs.every(o => o.btc > 0));

    const byLargeOut = new Map();
    candidates.forEach(tx => {
        const sorted   = [...tx.outputs].sort((a, b) => b.btc - a.btc);
        const largeOut = sorted[0].btc;
        const bucket   = Math.round(largeOut * 10000);
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
            const sorted   = [...current.outputs].sort((a, b) => b.btc - a.btc);
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

// ── Score a chain on every metric (always computed, regardless of toggles) ──
function _pdScoreChain(chain) {
    const ratios   = chain.map(h => h.peel_ratio);
    const mean     = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length;
    const ratioCV  = mean > 0 ? Math.sqrt(variance) / mean : 1;

    const vals    = chain.map(h => h.largeOut);
    const logVals = vals.map(v => Math.log(Math.max(v, 1e-9)));
    const n       = logVals.length;
    const idxMean = (n - 1) / 2;
    const logMean = logVals.reduce((a, b) => a + b, 0) / n;
    const cov     = logVals.reduce((a, v, i) => a + (i - idxMean) * (v - logMean), 0);
    const varX    = logVals.reduce((a, _, i) => a + (i - idxMean) ** 2, 0);
    const slope   = varX > 0 ? cov / varX : 0;
    const ssTot   = logVals.reduce((a, v) => a + (v - logMean) ** 2, 0);
    const ssRes   = logVals.reduce((a, v, i) => a + (v - (logMean + slope * (i - idxMean))) ** 2, 0);
    const r2      = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    const decayScore = vals.slice(1).filter((v, i) => v < vals[i]).length / (n - 1);

    let timingCV = null;
    if (chain.length >= 3) {
        const times   = chain.map(h => h.time.getTime());
        const gaps    = times.slice(1).map((t, i) => t - times[i]);
        const gapMean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const gapSD   = Math.sqrt(gaps.reduce((s, g) => s + (g - gapMean) ** 2, 0) / gaps.length);
        timingCV = gapMean > 0 ? gapSD / gapMean : 1;
    }

    return { chain, ratioMean: mean, ratioCV, r2, slope, decayScore, timingCV };
}

// ── Compute final score using ONLY currently-active components ─────
// Weights: Ratio 40 · Decay R² 35 · Monotonic 15 · Timing 10 — reweighted
// to 100 based on which checks are switched on.
function _pdComputeScore(s) {
    let totalWeight = 0;
    let earned = 0;

    if (_pdSettings.ratioOn) {
        totalWeight += 40;
        earned += Math.max(0, 1 - Math.min(s.ratioCV / 0.2, 1)) * 40;
    }
    if (_pdSettings.decayOn) {
        totalWeight += 35;
        earned += s.r2 * 35;
        totalWeight += 15;
        earned += s.decayScore * 15;
    }
    if (_pdSettings.timingOn && s.timingCV !== null) {
        totalWeight += 10;
        earned += Math.max(0, 1 - Math.min(s.timingCV / 0.5, 1)) * 10;
    }

    if (totalWeight === 0) return 0;
    return Math.round((earned / totalWeight) * 100);
}

// ── Render one chain result card ────────────────────────────────────
function _pdRenderChainCard(parent, s, idx) {
    const scoreColor = s.finalScore >= 70 ? "#ef4444" : s.finalScore >= 40 ? "#f59e0b" : "#22c55e";
    const isTop = idx === 0;

    const card = parent.append("div")
        .style("margin-bottom", "8px").style("padding", "9px")
        .style("background", isTop ? "rgba(34,197,94,0.07)" : "rgba(255,255,255,0.02)")
        .style("border-radius", "5px")
        .style("border-left", `3px solid ${scoreColor}`)
        .style("cursor", "pointer");

    const hdr = card.append("div")
        .style("display", "flex").style("justify-content", "space-between")
        .style("align-items", "center").style("margin-bottom", "5px");

    hdr.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#fff")
        .text(`Chain #${idx + 1} — ${s.chain.length} hops`);

    hdr.append("div")
        .style("font-size", "11px").style("font-weight", "700").style("color", scoreColor)
        .style("background", `${scoreColor}20`).style("padding", "1px 7px")
        .style("border-radius", "10px")
        .text(`${s.finalScore}/100`);

    const badges = card.append("div")
        .style("display", "flex").style("flex-wrap", "wrap")
        .style("gap", "4px").style("margin-bottom", "6px");

    if (_pdSettings.ratioOn)
        _pdBadge(badges, `Ratio CV ${(s.ratioCV*100).toFixed(1)}%`,
            s.ratioCV < 0.05 ? "high" : s.ratioCV < 0.10 ? "med" : "low");
    if (_pdSettings.decayOn) {
        _pdBadge(badges, `Decay R² ${s.r2.toFixed(2)}`,
            s.r2 > 0.90 ? "high" : s.r2 > 0.70 ? "med" : "low");
        _pdBadge(badges, `Monotonic ${(s.decayScore*100).toFixed(0)}%`,
            s.decayScore > 0.9 ? "high" : s.decayScore > 0.7 ? "med" : "low");
    }
    if (_pdSettings.timingOn && s.timingCV !== null)
        _pdBadge(badges, `Timing CV ${(s.timingCV*100).toFixed(0)}%`,
            s.timingCV < 0.25 ? "high" : "low");

    const firstBtc    = s.chain[0].largeOut;
    const lastBtc     = s.chain[s.chain.length - 1].largeOut;
    const totalPeeled = s.chain.reduce((sum, h) => sum + h.smallOut, 0);

    card.append("div")
        .style("font-size", "8.5px").style("color", "#aaa").style("line-height", "1.8")
        .html(`Start: <b style="color:#F7931A">₿${firstBtc.toFixed(4)}</b>
               → End: <b style="color:#F7931A">₿${lastBtc.toFixed(4)}</b><br>
               Peeled off total: <b style="color:#22c55e">₿${totalPeeled.toFixed(4)}</b><br>
               Period: <b style="color:#fff">${s.chain[0].date} – ${s.chain[s.chain.length-1].date}</b>`);

    _pdSparkline(card, s.chain.map(h => h.largeOut), scoreColor);

    let expanded = false;
    const expandBtn = card.append("div")
        .style("font-size", "9px").style("color", "#22c55e")
        .style("cursor", "pointer").style("margin-top", "5px")
        .style("user-select", "none").text("▶ Show hops");

    const hopTable = card.append("div").style("display", "none").style("margin-top", "6px");

    const tblHdr = hopTable.append("div")
        .style("display", "grid").style("grid-template-columns", "20px 70px 1fr 55px 42px")
        .style("gap", "2px").style("padding", "3px 4px")
        .style("font-size", "7px").style("color", "#555").style("text-transform", "uppercase");
    ["#","Date/Hr","Large Out","Small Out","Ratio"].forEach(h => tblHdr.append("div").text(h));

    s.chain.forEach((hop, hi) => {
        const ratioColor = hop.peel_ratio < 0.03 ? "#ef4444" : hop.peel_ratio < 0.10 ? "#f59e0b" : "#aaa";
        const row = hopTable.append("div")
            .style("display", "grid").style("grid-template-columns", "20px 70px 1fr 55px 42px")
            .style("gap", "2px").style("padding", "3px 4px").style("border-bottom", "1px solid #111")
            .style("font-size", "8px").style("color", "#888")
            .style("cursor", "pointer").style("align-items", "center");

        row.append("div").style("color", "#22c55e").style("font-weight", "700").text(`${hi+1}`);
        row.append("div").text(`${fmtMatDay(hop.date)} ${String(hop.hour).padStart(2,"0")}h`);
        row.append("div").style("color", "#F7931A").text(`₿${hop.largeOut.toFixed(4)}`);
        row.append("div").style("color", "#22c55e").text(`₿${hop.smallOut.toFixed(4)}`);
        row.append("div").style("color", ratioColor).text(`${(hop.peel_ratio*100).toFixed(1)}%`);

        row.on("click", ev => {
            ev.stopPropagation();
            const dayList = window._matrixDays || [];
            const di = dayList.indexOf(hop.date);
            if (di >= 0) {
                d3.selectAll(`.cell-rect.cell-${hop.hour}-${di}-${di}`)
                    .attr("stroke", "#22c55e").attr("stroke-width", 2.5);
                setTimeout(() => {
                    d3.selectAll(`.cell-rect.cell-${hop.hour}-${di}-${di}`)
                        .attr("stroke", "#ddd").attr("stroke-width", 0.5);
                }, 2500);
            }
        });
    });

    expandBtn.on("click", ev => {
        ev.stopPropagation();
        expanded = !expanded;
        hopTable.style("display", expanded ? "block" : "none");
        expandBtn.text(expanded ? "▼ Hide hops" : "▶ Show hops");
    });

    card.on("click", () => {
        const firstAddr = s.chain[0].tx.outputs.sort((a,b) => b.btc - a.btc)[0]?.addr;
        if (firstAddr && window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, firstAddr);
    });
}

function _pdBadge(parent, label, level) {
    const colors = {
        high: { bg: "rgba(239,68,68,0.15)",   text: "#ef4444", border: "#ef444450" },
        med:  { bg: "rgba(245,158,11,0.15)",  text: "#f59e0b", border: "#f59e0b50" },
        low:  { bg: "rgba(255,255,255,0.04)", text: "#555",    border: "#33333360" },
    };
    const c = colors[level] || colors.low;
    parent.append("span")
        .style("font-size", "7.5px").style("padding", "2px 5px").style("border-radius", "8px")
        .style("background", c.bg).style("color", c.text).style("border", `1px solid ${c.border}`)
        .text(label);
}

function _pdSparkline(parent, values, color) {
    const W = 180, H = 28;
    const mn = d3.min(values), mx = d3.max(values);
    const xSc = d3.scaleLinear().domain([0, values.length - 1]).range([2, W - 2]);
    const ySc = d3.scaleLinear().domain([mn, mx]).range([H - 2, 2]);

    const svg = parent.append("svg").attr("width", W).attr("height", H)
        .style("background", "#00000030").style("border-radius", "3px")
        .style("display", "block").style("margin-top", "5px");

    svg.append("polyline")
        .attr("points", values.map((v, i) => `${xSc(i)},${ySc(v)}`).join(" "))
        .attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.5);

    svg.append("text").attr("x", 3).attr("y", 8)
        .attr("font-size", "6px").attr("fill", "#444").text("₿ decay →");
}
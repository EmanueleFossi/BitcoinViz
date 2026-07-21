// ═══════════════════════════════════════════════════════════════════
//  peelingChainOrigin.js  —  Peeling Chain Investigation Workflow
//  3-Step Analyst-Guided Detection
//  Step 1: High-Frequency Engine  (Transaction Frequency)
//  Step 2: Fast Spend Behaviour   (Spend Velocity)
//  Step 3: Bilateral Loop Confirm (Bilateral Dominance)
// ═══════════════════════════════════════════════════════════════════

// ── Core: build address profiles from raw data ────────────────────
function _buildProfiles(rawData) {
    const profiles = new Map();

    function get(addr) {
        if (!profiles.has(addr)) profiles.set(addr, {
            address: addr,
            receiveTimes: [],
            spendTimes: [],
            totalBTC: 0,
        });
        return profiles.get(addr);
    }

    rawData.forEach(row => {
        const p = get(row.out_address);
        p.receiveTimes.push(row.time.getTime());
        p.totalBTC += row.btc_out;
    });

    rawData.forEach(row => {
        row.in_addresses.forEach(ia => {
            if (ia) get(ia).spendTimes.push(row.time.getTime());
        });
    });

    const allTimes = rawData.map(r => r.time.getTime());
    const windowDays = Math.max(1, (d3.max(allTimes) - d3.min(allTimes)) / 86400000);

    const result = [];
    profiles.forEach((p, addr) => {
        const inCount = p.spendTimes.length;
        const outCount = p.receiveTimes.length;
        const totalTx = inCount + outCount;
        if (totalTx < 2) return;

        const freq = totalTx / windowDays;

        const recvSorted = [...p.receiveTimes].sort((a, b) => a - b);
        const spendSorted = [...p.spendTimes].sort((a, b) => a - b);
        let gapSum = 0, gapCount = 0;
        spendSorted.forEach(st => {
            const prior = recvSorted.filter(rt => rt <= st);
            if (!prior.length) return;
            gapSum += (st - prior[prior.length - 1]);
            gapCount++;
        });
        const avgGapHours = gapCount > 0 ? (gapSum / gapCount) / 3600000 : Infinity;
        const bilateral = (inCount > 0 && outCount > 0)
            ? Math.min(inCount, outCount) / Math.max(inCount, outCount) : 0;

        result.push({ addr, p, freq, avgGapHours, bilateral, inCount, outCount, totalTx, windowDays });
    });

    return { profiles: result, windowDays };
}

// ── State shared across steps ─────────────────────────────────────
let _step1Candidates = null;   // after step 1 filter
let _step2Candidates = null;   // after step 2 filter
let _allProfiles = null;   // full profile list
let _windowDays = null;

// ═══════════════════════════════════════════════════════════════════
//  UI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════
function buildOriginDetectionUI() {
    const check = setInterval(() => {
        const placeholder = document.getElementById("origin-detection-placeholder");
        if (!placeholder) return;
        clearInterval(check);
        _injectWorkflow(d3.select("#filter-controls-container"));
    }, 300);
}

function _injectWorkflow(container) {
    d3.select("#origin-detection-section").remove();

    const placeholder = d3.select("#origin-detection-placeholder");
    if (placeholder.empty()) return;
    placeholder.selectAll("*").remove();
    const section = placeholder.append("div")
        .attr("id", "origin-detection-section")
        .style("margin-bottom", "14px");

    // ── Header card ───────────────────────────────────────────────
    const header = section.append("div")
        .style("padding", "11px 12px")
        .style("background", "linear-gradient(135deg,#0d1b2a,#1a0d2e)")
        .style("border", "1px solid rgba(147,112,219,0.4)")
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    header.append("div")
        .style("font-size", "11px").style("font-weight", "700")
        .style("color", "#9370DB").style("text-transform", "uppercase")
        .style("letter-spacing", "0.1em").style("margin-bottom", "3px")
        .text("🔍 Peeling Chain Investigation");

    header.append("div")
        .style("font-size", "9px").style("color", "#666").style("line-height", "1.7")
        .text("Follow the 3 steps below to identify suspicious layering behaviour. Each step narrows the suspect pool.");

    // ── Step containers ───────────────────────────────────────────
    _buildStep1(section);
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 1 — High-Frequency Engine
// ═══════════════════════════════════════════════════════════════════
function _buildStep1(section) {
    const card = section.append("div")
        .attr("id", "step1-card")
        .style("padding", "11px 12px")
        .style("background", "#111820")
        .style("border", "1px solid #1e3a5f")
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    // Step label
    const stepHdr = card.append("div")
        .style("display", "flex").style("align-items", "center")
        .style("gap", "8px").style("margin-bottom", "6px");

    stepHdr.append("div")
        .style("width", "22px").style("height", "22px")
        .style("background", "#1e3a5f").style("border-radius", "50%")
        .style("display", "flex").style("align-items", "center").style("justify-content", "center")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#4da6ff")
        .style("flex-shrink", "0")
        .text("1");

    const stepTitleCol = stepHdr.append("div");
    stepTitleCol.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#4da6ff")
        .text("High-Frequency Engine");
    stepTitleCol.append("div")
        .style("font-size", "8px").style("color", "#556")
        .text("Peeling hubs transact every day — normal addresses do not");

    // Explanation
    card.append("div")
        .style("font-size", "8.5px").style("color", "#778").style("line-height", "1.8")
        .style("margin-bottom", "9px").style("padding", "7px")
        .style("background", "rgba(77,166,255,0.05)").style("border-radius", "4px")
        .style("border-left", "2px solid #1e3a5f")
        .html(`<b style="color:#4da6ff">What to look for:</b> An address running a peeling chain must 
               transact repeatedly — it cannot hide. Set the minimum transactions-per-day threshold. 
               Anything below is eliminated from suspicion.`);

    // Slider
    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum transactions per day");
    const s1ValLbl = card.append("div")
        .style("font-size", "10px").style("color", "#4da6ff").style("font-weight", "700")
        .style("margin-bottom", "4px").text("≥ 5 tx / day");
    const s1Slider = card.append("input")
        .attr("type", "range").attr("min", 1).attr("max", 30).attr("value", 5).attr("step", 1)
        .style("width", "100%")
        .on("input", function () { s1ValLbl.text(`≥ ${this.value} tx / day`); });

    // Run button
    card.append("div").style("margin-top", "9px")
        .append("button")
        .style("width", "100%").style("padding", "7px")
        .style("background", "#1e3a5f").style("color", "#4da6ff")
        .style("border", "1px solid #4da6ff").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-weight", "700").style("font-size", "10px")
        .text("▶  Apply Frequency Filter")
        .on("click", function () {
            const rawData = window._matrixRawData;
            if (!rawData) { alert("window._matrixRawData not set."); return; }
            const minFreq = +s1Slider.property("value");

            const { profiles, windowDays } = _buildProfiles(rawData);
            _allProfiles = profiles;
            _windowDays = windowDays;

            _step1Candidates = profiles.filter(p => p.freq >= minFreq);
            _step2Candidates = null;

            // Remove old results
            d3.select("#step1-result").remove();
            d3.select("#step2-card").remove();
            d3.select("#step3-card").remove();

            // Show result summary
            const res = card.append("div").attr("id", "step1-result")
                .style("margin-top", "9px").style("padding", "8px")
                .style("background", "rgba(77,166,255,0.06)").style("border-radius", "5px")
                .style("border", "1px solid #1e3a5f");

            const eliminated = profiles.length - _step1Candidates.length;
            res.append("div")
                .style("font-size", "9px").style("color", "#4da6ff").style("font-weight", "700")
                .style("margin-bottom", "4px")
                .text(`✓ Step 1 Complete`);
            res.append("div")
                .style("font-size", "9px").style("color", "#aaa").style("line-height", "1.9")
                .html(`Total addresses: <b style="color:#fff">${profiles.length}</b><br>
                       Eliminated (low freq): <b style="color:#F43F5E">${eliminated}</b><br>
                       Suspects remaining: <b style="color:#4da6ff">${_step1Candidates.length}</b>`);

            if (_step1Candidates.length === 0) {
                res.append("div").style("font-size", "9px").style("color", "#F43F5E")
                    .style("margin-top", "5px").text("⚠ No addresses passed. Lower the threshold.");
                return;
            }

            res.append("div").style("font-size", "8px").style("color", "#556")
                .style("margin-top", "5px")
                .text(`Top by frequency: ${_step1Candidates.sort((a, b) => b.freq - a.freq).slice(0, 3).map(p => `${p.freq.toFixed(1)} tx/day`).join(" · ")}`);

            // Unlock step 2
            _buildStep2(d3.select("#origin-detection-section"));
        });
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 2 — Fast Spend Behaviour
// ═══════════════════════════════════════════════════════════════════
function _buildStep2(section) {
    d3.select("#step2-card").remove();

    const card = section.append("div")
        .attr("id", "step2-card")
        .style("padding", "11px 12px")
        .style("background", "#111820")
        .style("border", "1px solid #1e5f3a")
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    const stepHdr = card.append("div")
        .style("display", "flex").style("align-items", "center")
        .style("gap", "8px").style("margin-bottom", "6px");

    stepHdr.append("div")
        .style("width", "22px").style("height", "22px")
        .style("background", "#1e5f3a").style("border-radius", "50%")
        .style("display", "flex").style("align-items", "center").style("justify-content", "center")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#22c55e")
        .style("flex-shrink", "0")
        .text("2");

    const stepTitleCol = stepHdr.append("div");
    stepTitleCol.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#22c55e")
        .text("Fast Spend Behaviour");
    stepTitleCol.append("div")
        .style("font-size", "8px").style("color", "#556")
        .text("A layering hub re-spends within hours — never sits idle for days");

    card.append("div")
        .style("font-size", "8.5px").style("color", "#778").style("line-height", "1.8")
        .style("margin-bottom", "9px").style("padding", "7px")
        .style("background", "rgba(34,197,94,0.05)").style("border-radius", "4px")
        .style("border-left", "2px solid #1e5f3a")
        .html(`<b style="color:#22c55e">What to look for:</b> After receiving Bitcoin, 
               a peeling hub immediately re-spends it — usually within a few hours. 
               A legitimate address may hold funds for days or weeks. 
               Set the maximum allowed delay between receiving and spending.`);

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Maximum average hours between receive → spend");
    const s2ValLbl = card.append("div")
        .style("font-size", "10px").style("color", "#22c55e").style("font-weight", "700")
        .style("margin-bottom", "4px").text("≤ 12 hours");
    const s2Slider = card.append("input")
        .attr("type", "range").attr("min", 1).attr("max", 72).attr("value", 12).attr("step", 1)
        .style("width", "100%")
        .on("input", function () { s2ValLbl.text(`≤ ${this.value} hours`); });

    card.append("div").style("margin-top", "9px")
        .append("button")
        .style("width", "100%").style("padding", "7px")
        .style("background", "#1e5f3a").style("color", "#22c55e")
        .style("border", "1px solid #22c55e").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-weight", "700").style("font-size", "10px")
        .text("▶  Apply Velocity Filter")
        .on("click", function () {
            if (!_step1Candidates) return;
            const maxHours = +s2Slider.property("value");

            _step2Candidates = _step1Candidates.filter(p =>
                p.avgGapHours !== Infinity && p.avgGapHours <= maxHours
            );

            d3.select("#step2-result").remove();
            d3.select("#step3-card").remove();

            const res = card.append("div").attr("id", "step2-result")
                .style("margin-top", "9px").style("padding", "8px")
                .style("background", "rgba(34,197,94,0.06)").style("border-radius", "5px")
                .style("border", "1px solid #1e5f3a");

            const eliminated = _step1Candidates.length - _step2Candidates.length;
            res.append("div")
                .style("font-size", "9px").style("color", "#22c55e").style("font-weight", "700")
                .style("margin-bottom", "4px").text(`✓ Step 2 Complete`);
            res.append("div")
                .style("font-size", "9px").style("color", "#aaa").style("line-height", "1.9")
                .html(`From step 1: <b style="color:#fff">${_step1Candidates.length}</b><br>
                       Too slow (hold > ${maxHours}h): <b style="color:#F43F5E">${eliminated}</b><br>
                       Suspects remaining: <b style="color:#22c55e">${_step2Candidates.length}</b>`);

            if (_step2Candidates.length === 0) {
                res.append("div").style("font-size", "9px").style("color", "#F43F5E")
                    .style("margin-top", "5px").text("⚠ No addresses passed. Raise the hours limit.");
                return;
            }

            res.append("div").style("font-size", "8px").style("color", "#556")
                .style("margin-top", "5px")
                .text(`Fastest spenders: ${_step2Candidates.sort((a, b) => a.avgGapHours - b.avgGapHours).slice(0, 3).map(p => `${p.avgGapHours.toFixed(1)}h`).join(" · ")}`);

            _buildStep3(d3.select("#origin-detection-section"));
        });
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 3 — Bilateral Loop Confirmation
// ═══════════════════════════════════════════════════════════════════
function _buildStep3(section) {
    d3.select("#step3-card").remove();

    const card = section.append("div")
        .attr("id", "step3-card")
        .style("padding", "11px 12px")
        .style("background", "#111820")
        .style("border", "1px solid #4a1e5f")
        .style("border-radius", "8px")
        .style("margin-bottom", "8px");

    const stepHdr = card.append("div")
        .style("display", "flex").style("align-items", "center")
        .style("gap", "8px").style("margin-bottom", "6px");

    stepHdr.append("div")
        .style("width", "22px").style("height", "22px")
        .style("background", "#4a1e5f").style("border-radius", "50%")
        .style("display", "flex").style("align-items", "center").style("justify-content", "center")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#a78bfa")
        .style("flex-shrink", "0")
        .text("3");

    const stepTitleCol = stepHdr.append("div");
    stepTitleCol.append("div")
        .style("font-size", "10px").style("font-weight", "700").style("color", "#a78bfa")
        .text("Bilateral Loop Confirmation");
    stepTitleCol.append("div")
        .style("font-size", "8px").style("color", "#556")
        .text("Only a hub appears equally as both sender and receiver");

    card.append("div")
        .style("font-size", "8.5px").style("color", "#778").style("line-height", "1.8")
        .style("margin-bottom", "9px").style("padding", "7px")
        .style("background", "rgba(167,139,250,0.05)").style("border-radius", "4px")
        .style("border-left", "2px solid #4a1e5f")
        .html(`<b style="color:#a78bfa">What to look for:</b> A peeling hub sits in the 
               middle of a loop — it receives change back and immediately re-spends it. 
               This means it appears almost equally as an input address AND an output address. 
               A ratio near <b style="color:#fff">1.0 = perfect hub</b>. 
               Normal addresses lean heavily one way.`);

    card.append("div").style("font-size", "9px").style("color", "#778").style("margin-bottom", "3px")
        .text("Minimum bilateral ratio (0 = one-sided · 1.0 = perfect loop)");
    const s3ValLbl = card.append("div")
        .style("font-size", "10px").style("color", "#a78bfa").style("font-weight", "700")
        .style("margin-bottom", "4px").text("≥ 0.50 ratio");
    const s3Slider = card.append("input")
        .attr("type", "range").attr("min", 10).attr("max", 100).attr("value", 50).attr("step", 5)
        .style("width", "100%")
        .on("input", function () { s3ValLbl.text(`≥ ${(this.value / 100).toFixed(2)} ratio`); });

    card.append("div").style("margin-top", "9px")
        .append("button")
        .style("width", "100%").style("padding", "7px")
        .style("background", "#4a1e5f").style("color", "#a78bfa")
        .style("border", "1px solid #a78bfa").style("border-radius", "4px")
        .style("cursor", "pointer").style("font-weight", "700").style("font-size", "10px")
        .text("▶  Confirm & Reveal Suspects")
        .on("click", function () {
            if (!_step2Candidates) return;
            const minBilateral = +s3Slider.property("value") / 100;

            const final = _step2Candidates
                .filter(p => p.bilateral >= minBilateral)
                .map(p => {
                    const maxFreq = d3.max(_allProfiles, x => x.freq) || 1;
                    const maxGap = d3.max(_allProfiles.filter(x => x.avgGapHours !== Infinity), x => x.avgGapHours) || 1;
                    const maxBilat = d3.max(_allProfiles, x => x.bilateral) || 1;
                    const s1 = p.freq / maxFreq;
                    const s2 = p.avgGapHours === Infinity ? 0 : 1 - (p.avgGapHours / maxGap);
                    const s3 = p.bilateral / maxBilat;
                    const score = s1 * 0.40 + s2 * 0.35 + s3 * 0.25;
                    return { ...p, s1, s2, s3, score };
                })
                .sort((a, b) => b.score - a.score);

            d3.select("#step3-result").remove();

            const res = card.append("div").attr("id", "step3-result")
                .style("margin-top", "9px");

            if (!final.length) {
                res.append("div").style("font-size", "9px").style("color", "#F43F5E")
                    .style("padding", "8px").style("background", "rgba(244,63,94,0.08)")
                    .style("border-radius", "5px")
                    .text("⚠ No addresses passed all 3 filters. Try lowering the bilateral ratio.");
                return;
            }

            // ── Verdict panel ─────────────────────────────────────
            const verdict = res.append("div")
                .style("padding", "10px").style("margin-bottom", "8px")
                .style("background", "rgba(147,112,219,0.1)")
                .style("border", "1px solid #9370DB").style("border-radius", "6px");

            verdict.append("div")
                .style("font-size", "10px").style("font-weight", "700")
                .style("color", "#9370DB").style("margin-bottom", "3px")
                .text("🏆 Investigation Complete");

            verdict.append("div")
                .style("font-size", "9px").style("color", "#aaa").style("line-height", "1.9")
                .html(`Started with: <b style="color:#fff">${_allProfiles.length}</b> addresses<br>
                       After Step 1 (Frequency): <b style="color:#4da6ff">${_step1Candidates.length}</b><br>
                       After Step 2 (Velocity): <b style="color:#22c55e">${_step2Candidates.length}</b><br>
                       After Step 3 (Bilateral): <b style="color:#a78bfa">${final.length}</b><br>
                       <span style="color:#9370DB;font-weight:700">Confirmed suspects: ${final.length}</span>`);

            // ── Ranked suspect cards ──────────────────────────────
            const sigLabels = ["Tx Frequency", "Spend Velocity", "Bilateral Loop"];
            const sigColors = ["#4da6ff", "#22c55e", "#a78bfa"];
            const sigKeys = ["s1", "s2", "s3"];

            final.slice(0, 5).forEach((c, i) => {
                const isTop = i === 0;
                const sc = res.append("div")
                    .style("margin-bottom", "8px").style("padding", "9px")
                    .style("background", isTop ? "rgba(147,112,219,0.1)" : "rgba(255,255,255,0.02)")
                    .style("border", "1px solid " + (isTop ? "#9370DB" : "#2a2a3a"))
                    .style("border-radius", "6px").style("cursor", "pointer")
                    .on("click", () => {
                        if (window._matrixDrawArcs) window._matrixDrawArcs(null, null, null, c.addr);
                        if (window._matrixAllArcs && window._matrixDays)
                            showAddressChain(c.addr, window._matrixAllArcs, window._matrixDays);
                    });

                const hdr = sc.append("div")
                    .style("display", "flex").style("justify-content", "space-between")
                    .style("align-items", "center").style("margin-bottom", "4px");
                hdr.append("span").style("font-size", "9px").style("font-weight", "700")
                    .style("color", isTop ? "#9370DB" : "#555")
                    .text(isTop ? "🔴 #1 Primary Suspect" : `#${i + 1} Suspect`);
                hdr.append("span").style("font-size", "11px").style("font-weight", "700")
                    .style("color", isTop ? "#9370DB" : "#555")
                    .text(`${(c.score * 100).toFixed(0)}/100`);

                sc.append("div")
                    .style("font-family", "monospace").style("font-size", "8px")
                    .style("color", "#00E5FF").style("word-break", "break-all")
                    .style("margin-bottom", "5px").text(c.addr);

                sc.append("div")
                    .style("font-size", "8px").style("color", "#888").style("line-height", "1.9")
                    .style("margin-bottom", isTop ? "6px" : "0")
                    .html(`${c.freq.toFixed(1)} tx/day &nbsp;·&nbsp;
                           Spend delay: <b style="color:#22c55e">${c.avgGapHours.toFixed(1)}h</b> &nbsp;·&nbsp;
                           Bilateral: <b style="color:#a78bfa">${(c.bilateral * 100).toFixed(0)}%</b><br>
                           In: <b style="color:#fff">${c.inCount}</b> &nbsp;·&nbsp;
                           Out: <b style="color:#fff">${c.outCount}</b> &nbsp;·&nbsp;
                           ₿ <b style="color:#F7931A">${c.p.totalBTC.toFixed(2)}</b>`);

                if (isTop) {
                    sigKeys.forEach((k, idx) => {
                        const val = c[k];
                        const row = sc.append("div").style("margin-bottom", "3px");
                        const lr = row.append("div")
                            .style("display", "flex").style("justify-content", "space-between");
                        lr.append("span").style("font-size", "7px").style("color", "#aaa")
                            .text(sigLabels[idx]);
                        lr.append("span").style("font-size", "7px").style("color", sigColors[idx])
                            .text(`${(val * 100).toFixed(0)}%`);
                        row.append("div")
                            .style("background", "rgba(255,255,255,0.06)")
                            .style("border-radius", "2px").style("height", "4px")
                            .append("div")
                            .style("width", `${val * 100}%`).style("height", "100%")
                            .style("background", sigColors[idx]).style("border-radius", "2px");
                    });

                    sc.append("div")
                        .style("font-size", "8px").style("color", "#9370DB")
                        .style("margin-top", "6px").style("text-align", "center")
                        .text("↑ Click to highlight this address in the matrix");
                }
            });

            // Research footnote
            res.append("div")
                .style("font-size", "7px").style("color", "#333").style("margin-top", "4px")
                .style("line-height", "1.7")
                .text("MSPCO · S1 Frequency ×0.40 · S2 Velocity ×0.35 · S3 Bilateral ×0.25");
        });
}
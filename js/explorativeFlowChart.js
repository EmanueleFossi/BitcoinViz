class ExplorativeFlowChart {
    constructor(container, rawData) {
        this.container = container;
        this.rawData = rawData;
        this.selectedArc = null;
        this.hlColorMap = new Map();
        this.activeQueries = []; // currently highlighted/searched addresses (lowercased)

        this.margin = { top: 8, right: 20, bottom: 20, left: 20 };

      let containerH = this.container.node().getBoundingClientRect().height;
        if (containerH < 100) {
            const parentNode = this.container.node().parentNode;
            const parentH = parentNode ? parentNode.getBoundingClientRect().height : 0;
            containerH = parentH > 100 ? parentH : window.innerHeight * 0.7;
            this.container.style("height", `${containerH}px`);
        }
        this.svgH = containerH;

        this.THRESHOLD_HOUR = 3.0;
        this.btcThreshold = 0;
        this.NODE_R = 5;
        this.forceHourly = false;
        // Controls whether the chain panel draws the sparkline plot.
        // Only true when the panel was opened from a detected peeling-chain
        // candidate (Run Detection), never from a plain arc click.
        this._chainPanelShowSparkline = false;
        // Holds whatever was last passed to applyFilters(). Starts at "no restriction"
        // defaults, so before the analyst touches any filter, everything passes through
        // unchanged — and _detectPeelingChainCandidates() always reads from this same
        // object, so it automatically inherits whatever filters are currently active.
        this.activeFilters = {
            queries: [], excludes: [], minB: 0, maxB: Infinity,
            minGapH: 0, maxGapH: Infinity, minHops: 0,
            maxAddrTx: Infinity, minAddrTx: 0
        };

        this._processTimeWindow();
        this._resolveChainLinks();
        this._computeHopCounts();
        this._precomputeAllLevels();
        this._buildSVG();
        this._buildScales();
        this._buildZoom();
        this._buildTooltip();

        this.update(1, true);

        const self = this;
        window.addEventListener('resize', () => {
            let newH = self.container.node().getBoundingClientRect().height;
            if (newH < 100) newH = window.innerHeight * 0.75;
            const newW = self.container.node().getBoundingClientRect().width;
            if (newW !== self.svgW || newH !== self.svgH) {
                self.svgEl.selectAll("*").remove();
                self.svgH = newH;
                self._buildSVG();
                self._buildScales();
                self.update(d3.zoomTransform(self.svgEl.node()).k, true);
            }
        });
    }

    get _axisY() { return Math.round(this.svgH / 2); }
    get _halfH() { return this._axisY - this.margin.top - this.NODE_R - 10; }

    _processTimeWindow() {
        const times = this.rawData.map(d => d.time.getTime());
        this.tMin = new Date(d3.min(times));
        this.tMax = new Date(d3.max(times));
        this.domainFull = [
            new Date(this.tMin.getTime() - 30 * 60 * 1000),
            new Date(this.tMax.getTime() + 30 * 60 * 1000)
        ];
    }

    _computeHopCounts() {
        const txMap = new Map();
        this.rawData.forEach(row => {
            if (!txMap.has(row.hash)) {
                txMap.set(row.hash, {
                    hash: row.hash, time: row.time,
                    in_addresses: row.in_addresses, outputs: []
                });
            }
            txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
        });

        const sortedTx = Array.from(txMap.values()).sort((a, b) => a.time - b.time);
        this.txMap = txMap;
        this.sortedTx = sortedTx;

        // ── Count how many times each address appears as input (address reuse) ──
        this.addrTxCount = new Map();
        sortedTx.forEach(tx => {
            tx.in_addresses.forEach(addr => {
                this.addrTxCount.set(addr, (this.addrTxCount.get(addr) || 0) + 1);
            });
        });

        const hopCount = new Map();
        const countHops = (hash, visited = new Set()) => {
            if (hopCount.has(hash)) return hopCount.get(hash);
            if (visited.has(hash)) return 0;
            visited.add(hash);
            const next = this.nextHopMap.get(hash);
            if (!next) { hopCount.set(hash, 0); return 0; }
            const hops = 1 + countHops(next.spendHash, new Set(visited));
            hopCount.set(hash, hops);
            return hops;
        };
        sortedTx.forEach(tx => countHops(tx.hash));
        this.txHopMap = hopCount;

        this.txChainMap = new Map();
        const buildChain = (hash, visited = new Set()) => {
            if (this.txChainMap.has(hash)) return this.txChainMap.get(hash);
            if (visited.has(hash)) return [hash];
            visited.add(hash);
            const next = this.nextHopMap.get(hash);
            if (!next) { this.txChainMap.set(hash, [hash]); return [hash]; }
            const chain = [hash, ...buildChain(next.spendHash, new Set(visited))];
            this.txChainMap.set(hash, chain);
            return chain;
        };
        sortedTx.forEach(tx => buildChain(tx.hash));

        const isNextHop = new Set();
        this.nextHopMap.forEach(next => isNextHop.add(next.spendHash));
        this.chainRootMap = new Map();
        sortedTx.forEach(tx => {
            if (!isNextHop.has(tx.hash)) {
                const chain = this.txChainMap.get(tx.hash) || [tx.hash];
                chain.forEach(h => this.chainRootMap.set(h, tx.hash));
            }
        });

        this.hashToRoot = new Map(this.chainRootMap);
        this.txChainMap.forEach((chain, rootHash) => {
            if (this.chainRootMap.get(rootHash) !== rootHash) return;
            chain.forEach(h => {
                if (!this.hashToRoot.has(h)) this.hashToRoot.set(h, rootHash);
            });
        });

        this.globalChainNextMap = new Map();
        this.txChainMap.forEach((chain, rootHash) => {
            if (this.chainRootMap.get(rootHash) !== rootHash) return;
            for (let i = 0; i < chain.length - 1; i++) {
                this.globalChainNextMap.set(chain[i], chain[i + 1]);
            }
            this.globalChainNextMap.set(chain[chain.length - 1], null);
        });
    }
    _resolveChainLinks() {
        const txMap = new Map();
        this.rawData.forEach(row => {
            if (!txMap.has(row.hash)) {
                txMap.set(row.hash, {
                    hash: row.hash, time: row.time,
                    in_addresses: row.in_addresses,
                    tx_inputs: row.tx_inputs, btc_in: row.btc_in,
                    outputs: []
                });
            }
            txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out, hash: row.hash });
        });

        const sortedTx = Array.from(txMap.values()).sort((a, b) => a.time - b.time);

        const outputsByAddress = new Map();
        sortedTx.forEach(tx => {
            tx.outputs.forEach(out => {
                if (!outputsByAddress.has(out.addr)) outputsByAddress.set(out.addr, []);
                outputsByAddress.get(out.addr).push({ time: tx.time, hash: tx.hash, btc: out.btc });
            });
        });

        const spentOutputs = new Set();
        this.linkMap = new Map();  // "spendHash|inAddr" -> origin {hash,time,btc,uncertain}
        this.nextHopMap = new Map();  // originHash -> {spendHash, addr}

        sortedTx.forEach(tx => {
            tx.in_addresses.forEach(inAddr => {
                const candidates = outputsByAddress.get(inAddr);
                if (!candidates) return;
                const valid = candidates.filter(o =>
                    o.time <= tx.time && o.hash !== tx.hash &&
                    !spentOutputs.has(`${inAddr}_${o.hash}`)
                );
                if (!valid.length) return;

                let origin, uncertain;
                if (tx.tx_inputs === 1 && valid.length > 1) {
                    // single-input tx: total_input_value_BTC IS this deposit's amount
                    const sorted = [...valid].sort((a, b) =>
                        Math.abs(a.btc - tx.btc_in) - Math.abs(b.btc - tx.btc_in));
                    origin = sorted[0];
                    uncertain = Math.abs(origin.btc - tx.btc_in) > Math.max(0.001, tx.btc_in * 0.01);
                } else {
                    // multi-input tx: can't isolate this address's share, fall back to earliest
                    origin = [...valid].sort((a, b) => a.time - b.time)[0];
                    uncertain = valid.length > 1;
                }

                spentOutputs.add(`${inAddr}_${origin.hash}`);
                this.linkMap.set(`${tx.hash}|${inAddr}`, { ...origin, uncertain });

                // FIX: a single origin tx can have multiple outputs, each spent by a
                // different future tx (that's the whole mechanic of a peel: one output
                // leaves the chain, one continues). Previously this .set() just kept
                // whichever spend was processed last in time — arbitrary, not meaningful.
                // Now we deliberately keep the branch with the LARGEST spent output,
                // matching "biggest output continues the chain" used everywhere else in the UI.
                const existingNext = this.nextHopMap.get(origin.hash);
                if (!existingNext || origin.btc > existingNext.btc) {
                    this.nextHopMap.set(origin.hash, { spendHash: tx.hash, addr: inAddr, btc: origin.btc });
                }
            });
        });
        this.txInputMap = txMap; // NEW — has tx_inputs, btc_in, outputs per hash

    }
    _precomputeAllLevels() {
        this.levels = {
            day: this._aggregateData("day"),
            hour: this._aggregateData("hour")
        };
        this.filteredLevels = {
            day: [...this.levels.day],
            hour: [...this.levels.hour]
        };
        this._assignLayers(this.levels.day);
        this._assignLayers(this.levels.hour);
        this.hourArcByKey = new Map(this.levels.hour.map(a => [a.key, a]));

    }

    _aggregateData(granularity) {
        const arcMap = new Map();
        const txMap = new Map();
        this.rawData.forEach(row => {
            if (!txMap.has(row.hash)) {
                txMap.set(row.hash, { hash: row.hash, time: row.time, in_addresses: row.in_addresses, outputs: [] });
            }
            txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
        });

        const sortedTransactions = Array.from(txMap.values()).sort((a, b) => a.time - b.time);
        const outputsByAddress = new Map();
        sortedTransactions.forEach(tx => {
            tx.outputs.forEach(out => {
                if (!outputsByAddress.has(out.addr)) outputsByAddress.set(out.addr, []);
                outputsByAddress.get(out.addr).push({ time: tx.time, hash: tx.hash, btc: out.btc });
            });
        });
        outputsByAddress.forEach(list => list.sort((a, b) => a.time - b.time));

        const spentOutputs = new Set();

        const getBucketInfo = (dateObj) => {
            const y = dateObj.getUTCFullYear();
            const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getUTCDate()).padStart(2, '0');
            const H = dateObj.getUTCHours();
            if (granularity === "day") {
                return {
                    key: `${y}-${m}-${d}`,
                    centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), 12, 0, 0))
                };
            } else {
                return {
                    key: `${y}-${m}-${d}-${String(H).padStart(2, '0')}`,
                    centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), H, 0, 0))
                };
            }
        };

        sortedTransactions.forEach(tx => {
            tx.in_addresses.forEach(inAddr => {
                const origin = this.linkMap.get(`${tx.hash}|${inAddr}`);
                if (!origin) return;

                const originBucket = getBucketInfo(origin.time);
                const spendBucket = getBucketInfo(tx.time);
                if (originBucket.key === spendBucket.key) return;

                const arcKey = granularity === "day"
                    ? `${originBucket.key}|${spendBucket.key}`
                    : `${origin.hash}|${tx.hash}|${inAddr}`;
                const changeOutput = tx.outputs.find(o => o.addr === inAddr);
                const volumeBtc = changeOutput ? changeOutput.btc : origin.btc;
                const hops = this.txHopMap.get(origin.hash) || 0;
                const root = this.chainRootMap.get(origin.hash) || origin.hash;
                const chainLen = (this.txChainMap.get(root) || []).length;

                if (!arcMap.has(arcKey)) {
                    arcMap.set(arcKey, {
                        key: arcKey, fromKey: originBucket.key, toKey: spendBucket.key,
                        fromCenterTime: originBucket.centerTime, toCenterTime: spendBucket.centerTime,
                        time_from: originBucket.centerTime, time_to: spendBucket.centerTime,
                        btc: volumeBtc, count: 1, hops, chainLen,
                        chainRoot: root, hashFrom: origin.hash, hashTo: tx.hash,
                        inAddr: inAddr, uncertain: origin.uncertain,
                        addresses: [{ addr: inAddr, btc: volumeBtc, hops }]
                    });
                } else {
                    const e = arcMap.get(arcKey);
                    e.btc += volumeBtc; e.count += 1;
                    e.hops = Math.max(e.hops, hops);
                    e.chainLen = Math.max(e.chainLen, chainLen);
                    e.uncertain = e.uncertain || origin.uncertain;
                    e.addresses.push({ addr: inAddr, btc: volumeBtc, hops });
                }
            });
        });

        return Array.from(arcMap.values());
    }

    _assignLayers(arcs) {
        const chainSideMap = new Map();
        let nextChainSide = 1;
        arcs.forEach(arc => {
            const root = arc.chainRoot || null;
            if (root && arc.chainLen > 1) {
                if (!chainSideMap.has(root)) { chainSideMap.set(root, nextChainSide); nextChainSide *= -1; }
                arc._side = chainSideMap.get(root);
            } else {
                arc._side = (arc.time_to - arc.time_from) >= 7 * 24 * 3600 * 1000 ? 1 : -1;
            }
        });
    }

    _getArcHlColor(arc) {
        if (!this.hlColorMap || this.hlColorMap.size === 0) return null;
        for (const [query, color] of this.hlColorMap) {
            if (arc.addresses.some(a => a.addr.toLowerCase().includes(query))) {
                return color;
            }
        }
        return null;
    }

    // Matched sub-total for the currently highlighted/searched addresses only
    // (fixes the "43 flows" confusion — this is the real per-address share).
    _getMatchedStats(arc) {
        if (!this.activeQueries || !this.activeQueries.length) return null;
        const matched = arc.addresses.filter(a =>
            this.activeQueries.some(q => a.addr.toLowerCase().includes(q))
        );
        if (!matched.length) return null;
        return {
            btc: matched.reduce((s, a) => s + a.btc, 0),
            count: matched.length
        };
    }
_buildSVG() {
        this.container.style("position","relative").style("width","100%").style("height","100%");
        // Absolutely positioned overlay — must NOT consume layout space,
        // otherwise it pushes the SVG down by its own height while the SVG
        // was already sized before this div existed, causing a gap + overflow.
        this.hintBar = this.container.append("div")
            .attr("class","ef-hint")
            .style("position","absolute")
            .style("top","8px")
            .style("left","16px")
            .style("z-index","5")
            .style("font-size","13px")
            .style("color","var(--text-primary)")
            .style("pointer-events","none");

        this.svgW = this.container.node().getBoundingClientRect().width || window.innerWidth - 300;
        this.innerW = this.svgW - this.margin.left - this.margin.right;

        this.svgEl = this.container.append("svg")
            .attr("width", "100%").attr("height", this.svgH).style("display", "block");

        const defs = this.svgEl.append("defs");

        defs.append("clipPath").attr("id", "ef-clip-top").append("rect")
            .attr("x", this.margin.left).attr("y", 0)
            .attr("width", this.innerW).attr("height", this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id", "ef-clip-bot").append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 2)
            .attr("width", this.innerW).attr("height", this.svgH - this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id", "ef-clip-nodes").append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 20)
            .attr("width", this.innerW).attr("height", this.NODE_R * 2 + 40);

        defs.append("marker").attr("id", "ef-arrow")
            .attr("viewBox", "0 0 6 6").attr("refX", 5).attr("refY", 3)
            .attr("markerWidth", 6).attr("markerHeight", 6)
            .attr("markerUnits", "userSpaceOnUse").attr("orient", "auto")
            .append("path").attr("d", "M 0 0 L 6 3 L 0 6 z").attr("fill", "context-stroke");

        defs.append("marker").attr("id", "ef-arrow-hl")
            .attr("viewBox", "0 0 6 6").attr("refX", 5).attr("refY", 3)
            .attr("markerWidth", 6).attr("markerHeight", 6)
            .attr("markerUnits", "userSpaceOnUse").attr("orient", "auto")
            .append("path").attr("d", "M 0 0 L 6 3 L 0 6 z").attr("fill", "#EC4899");

        this.gArcTop = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-top)").attr("pointer-events", "none");
        this.gArcBot = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-bot)").attr("pointer-events", "none");
        this.gChain = this.svgEl.append("g");
        this.gNode = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-nodes)").attr("pointer-events", "none");

        this.gHitTop = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-top)");
        this.gHitBot = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-bot)");

        this.svgEl.append("line").attr("class", "ef-axis-line")
            .attr("x1", 0).attr("x2", this.svgW)
            .attr("y1", this._axisY).attr("y2", this._axisY)
            .attr("stroke", "rgba(255,255,255,0.12)").attr("stroke-width", 1)
            .attr("pointer-events", "none");

        this.gGrid = this.svgEl.append("g").attr("class", "ef-grid").attr("pointer-events", "none");
        this.gAxis = this.svgEl.append("g").attr("class", "ef-axis").attr("transform", `translate(0,${this._axisY})`);
        this.gArc = this.svgEl.append("g").style("display", "none");

        const self = this;
        this.svgEl.on("click.deselect", function () {
            if (!self.selectedArc) return;
            if (self._suppressDeselect) { self._suppressDeselect = false; return; }
            self.selectedArc = null;
            self._highlightChain(null);
        });
    }
    _buildBucketColorScale(min, max, colors) {
        const n = colors.length;
        const logMin = Math.log(Math.max(min, 1e-6));
        const logMax = Math.log(Math.max(max, min * 1.000001));
        const thresholds = d3.range(1, n).map(i => Math.exp(logMin + (logMax - logMin) * i / n));
        const scale = d3.scaleThreshold().domain(thresholds).range(colors);
        scale.bucketEdges = [min, ...thresholds, max]; // used by the legend
        return scale;
    }
    _buildScales() {
        this.xScale = d3.scaleUtc()
            .domain(this.domainFull)
            .range([this.margin.left, this.svgW - this.margin.right]);
        this.currentX = this.xScale;

        const allArcs = [...this.levels.day, ...this.levels.hour];
        const btcExt = d3.extent(allArcs, a => a.btc);
        const btcMin = Math.max(btcExt[0], 0.0001);
        const btcMax = btcExt[1];

        this.thickScale = d3.scaleLog().domain([btcMin, btcMax]).range([1.5, 7]).clamp(true);

        // ── Discrete, log-spaced buckets. Same BTC domain for both, different
        // hue family so day-aggregated vs hour-individual arcs read apart
        // at a glance, while volume tiers stay comparable across views. ──
        const DAY_BUCKET_COLORS = ["#DCEEFF", "#7FB8EA", "#265F91", "#0B2C4D"];
        const HOUR_BUCKET_COLORS = ["#D3F7F0", "#63CFC0", "#1B7A70", "#0A3F3A"];
        this.dayColorScale = this._buildBucketColorScale(btcMin, btcMax, DAY_BUCKET_COLORS);
        this.hourColorScale = this._buildBucketColorScale(btcMin, btcMax, HOUR_BUCKET_COLORS);
    }

    _buildZoom() {
        const self = this;
        this.zoom = d3.zoom()
            .scaleExtent([1, 18])
            .translateExtent([[this.margin.left - 500, 0], [this.svgW - this.margin.right + 500, this.svgH]])
            .on("zoom", function (event) {
                const k = event.transform.k;
                self.currentX = event.transform.rescaleX(self.xScale);
                self._renderAxis(self.currentX, k);
                self.update(k, false);
            });
        this.svgEl.call(this.zoom);
    }

    _renderAxis(x, k) {
        let fmt = d3.utcFormat("%d %b");
        if (k > 15) fmt = d3.utcFormat("%H:%M");
        else if (k > this.THRESHOLD_HOUR) fmt = d3.utcFormat("%d %b %H:00");

        const tickCount = k > 15 ? Math.floor(this.innerW / 60) : Math.floor(this.innerW / 90);

        this.gAxis.call(d3.axisBottom(x).ticks(tickCount).tickFormat(fmt).tickSize(6))
            .call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,0.15)"))
            .call(g => g.selectAll(".tick line").attr("stroke", "rgba(255,255,255,0.2)"))
            .call(g => g.selectAll(".tick text").attr("fill", "#888").attr("font-size", "10px").attr("dy", "1.2em"));

        this.gGrid.selectAll("line.vgrid").data(x.ticks(tickCount)).join("line")
            .attr("class", "vgrid")
            .attr("x1", t => x(t)).attr("x2", t => x(t))
            .attr("y1", this.margin.top).attr("y2", this.svgH - this.margin.bottom)
            .attr("stroke", "rgba(255,255,255,0.03)").attr("stroke-width", 1);
    }
    _zoomWindowLabel(k) {
    if (k <= this.THRESHOLD_HOUR) return "24 hour";
    if (k <= 8)  return "6 hour";
    if (k <= 15) return "3 hour";
    return "1 hour";
}

    _visibleArcs(arcs) {
        const [domStart, domEnd] = this.currentX.domain();
        return arcs.filter(a =>
            (a.time_from >= domStart && a.time_from <= domEnd) ||
            (a.time_to >= domStart && a.time_to <= domEnd)
        );
    }
    update(k, forceRebuildNodes = false) {
        this._lastK = k;
        const x = this.currentX;
        let currentGranularity, opDay = 0, opHour = 0;

        // Aggregation mode (blue/aggregated vs teal/individual) is controlled
        // ONLY by the "One transaction per edge" checkbox (this.forceHourly).
        // Zoom (k) no longer switches mode — it only affects axis tick format
        // (see _renderAxis) and how much of the individual-tx set gets rendered
        // below. This makes the mode sticky across zooming, and makes both
        // modes available at any zoom level.
      const windowLabel = this._zoomWindowLabel(k);
       const atMaxZoom = k >= 17.5;
        if (this.forceHourly) {
            currentGranularity = "hour"; opHour = 0.85;
            this.hintBar.text(`Resolution: Individual transactions — ${windowLabel} window` +
                (atMaxZoom ? " (maximum — data has no finer time resolution)" : ""));
        } else {
            currentGranularity = "day"; opDay = 0.85;
            this.hintBar.text(`Resolution: Daily — flows aggregated by day (${windowLabel} zoom level)`);
        }

        const thr = this.btcThreshold || 0;
        const byThr = arcs => thr > 0 ? arcs.filter(a => a.btc >= thr) : arcs;

        const dayArcs = byThr(this.filteredLevels.day);
        // Only build individual-tx arcs when that mode is actually active.
        // _visibleArcs restricts to the current viewport for performance —
        // harmless at k=1 since the visible domain is already the full range there.
        const hourArcs = this.forceHourly
            ? this._visibleArcs(byThr(this.filteredLevels.hour))
            : [];

        this._renderArcLayer("day-arcs", dayArcs, opDay, x);
        this._renderArcLayer("hour-arcs", hourArcs, opHour, x);

        const activeArcs = byThr(this.filteredLevels[currentGranularity]);
        if (this.lastGranularity !== currentGranularity || forceRebuildNodes) {
            this.lastGranularity = currentGranularity;
            this._rebuildNodes(activeArcs, currentGranularity);
        }

        this._syncNodePositions(x);
        this._drawLegend(activeArcs, currentGranularity);





        if (this.selectedArc) {
            const self = this, axisY = this._axisY;
            this.gChain.selectAll("path.chain-arc").attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2, self._hashOffset(d.key)), axisY, d._side || 1);
            });
        }
    }

   _arcHeight(x1, x2, offset = 0) {
    const distance = Math.abs(x2 - x1);
    const maxH = this._halfH;
    const distanceH = distance * 0.55;
    // Closely-spaced (hourly) arcs would otherwise stay tiny even in a tall
    // container, since height was driven almost entirely by x-distance.
    // This floor guarantees every arc uses a healthy share of the vertical
    // room actually available, so the chart fills its container instead of
    // leaving empty space above/below regardless of zoom/node spacing.
    const floorH = maxH * 0.35;
    const baseH = Math.max(floorH, Math.min(distanceH, maxH * 0.92));
    return Math.max(32, Math.min(baseH + offset, maxH));
}
    _hashOffset(key, maxOffset = 18) {
        let hash = 0;
        for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
        return Math.abs(hash) % maxOffset;
    }
    _arcPath(x1, x2, h, axisY, side = 1) {
        const startY = axisY - this.NODE_R * side;
        const cy = axisY - h * side;
        return `M${x1},${startY} C${x1},${cy} ${x2},${cy} ${x2},${startY}`;
    }

    _highlightChain(arc) {
        this.gChain.selectAll("*").remove();

        this.gHitTop.style("pointer-events", arc ? "none" : null);
        this.gHitBot.style("pointer-events", arc ? "none" : null);

        const self = this;
        this.gArcTop.selectAll("path[data-key]").each(function () {
            const el = d3.select(this), d = el.datum();
            const baseOp = +el.attr("data-op");
            const hlColor = self._getArcHlColor(d);
            const scale = el.classed('day-arcs') ? self.dayColorScale : self.hourColorScale; // NEW
            el.attr("stroke", hlColor || scale(d.btc))
                .attr("opacity", baseOp)
                .attr("marker-end", baseOp > 0 ? "url(#ef-arrow)" : null);
        });
        this.gArcBot.selectAll("path[data-key]").each(function () {
            const el = d3.select(this), d = el.datum();
            const baseOp = +el.attr("data-op");
            const hlColor = self._getArcHlColor(d);
            const scale = el.classed('day-arcs') ? self.dayColorScale : self.hourColorScale; // NEW
            el.attr("stroke", hlColor || scale(d.btc))
                .attr("opacity", baseOp)
                .attr("marker-end", baseOp > 0 ? "url(#ef-arrow)" : null);
        });

        if (!arc) return;

        let root = arc.chainRoot || this.hashToRoot.get(arc.hashFrom) || arc.hashFrom;
        const trueRoot = this.chainRootMap.get(root);
        if (trueRoot && trueRoot !== root) root = trueRoot;
        let chain = this.txChainMap.get(root);
        if (!chain) {
            const fallbackRoot = this.chainRootMap.get(arc.hashFrom) || arc.hashFrom;
            chain = this.txChainMap.get(fallbackRoot) || [arc.hashFrom];
            root = fallbackRoot;
        }
        const chainIdx = new Map();
        chain.forEach((h, i) => chainIdx.set(h, i));

        this.gArcTop.selectAll("path[data-key]").attr("opacity", 0.05).attr("marker-end", null);
        this.gArcBot.selectAll("path[data-key]").attr("opacity", 0.05).attr("marker-end", null);

        const granularity = this.lastGranularity || 'day';
        const allArcs = this.levels[granularity];
        const chainArcs = allArcs.filter(a => {
            if (!chainIdx.has(a.hashFrom) || !chainIdx.has(a.hashTo)) return false;
            return chainIdx.get(a.hashTo) === chainIdx.get(a.hashFrom) + 1;
        }).sort((a, b) => chainIdx.get(a.hashFrom) - chainIdx.get(b.hashFrom));
        this._activeChainArcs = chainArcs;
        this._chainTrueTotal = chain.length; // real chain length — may exceed drawable arcs
        this._ensureChainNodes(chainArcs);
        this._centerOnArc(chainArcs[0]);
        const x = this.currentX, axisY = this._axisY;

        this.gChain.selectAll("path.chain-arc")
            .data(chainArcs, d => d.key)
            .enter().append("path")
            .attr("class", "chain-arc")
            .attr("fill", "none")
            .attr("stroke", "#EC4899")
            .attr("stroke-linecap", "round")
            .attr("marker-end", "url(#ef-arrow-hl)")
            .attr("stroke-width", 3.5)
            .attr("opacity", 0)
            .attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2, self._hashOffset(d.key)), axisY, d._side || 1);
            })
            .style("cursor", "pointer")
            .on("mouseenter", function (event, d) { self._showTooltip(event, d); })
            .on("mousemove", function (event) {
                self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
            })
            .on("mouseleave", function () { self.tip.style("opacity", 0); })
            .on("click", function (event, d) {
                event.stopPropagation();
                self._suppressDeselect = true;
                self.selectedArc = d;
                const tx = self.txMap ? self.txMap.get(d.hashFrom) : null;
                const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
            })
            .transition().duration(300).attr("opacity", 1);
    }
    _drawChainArcsOnly(chainArcs) {
        this.gChain.selectAll("*").remove();
        this.gHitTop.style("pointer-events", "none");
        this.gHitBot.style("pointer-events", "none");

        const self = this;

        // Dim every normal arc — only this candidate's own hops stay visible
        this.gArcTop.selectAll("path[data-key]").attr("opacity", 0.05).attr("marker-end", null);
        this.gArcBot.selectAll("path[data-key]").attr("opacity", 0.05).attr("marker-end", null);

        if (!chainArcs || !chainArcs.length) return;

        this._activeChainArcs = chainArcs;
        this._ensureChainNodes(chainArcs);
        this._centerOnArc(chainArcs[0]);

        const x = this.currentX, axisY = this._axisY;

        this.gChain.selectAll("path.chain-arc")
            .data(chainArcs, d => d.key)
            .enter().append("path")
            .attr("class", "chain-arc")
            .attr("fill", "none")
            .attr("stroke", "#F59E0B")   // amber — visually distinct from the purple full-chain trace
            .attr("stroke-linecap", "round")
            .attr("marker-end", "url(#ef-arrow-hl)")
            .attr("stroke-width", 3.5)
            .attr("opacity", 0)
            .attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2, self._hashOffset(d.key)), axisY, d._side || 1);
            })
            .style("cursor", "pointer")
            .on("mouseenter", function (event, d) { self._showTooltip(event, d); })
            .on("mousemove", function (event) {
                self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
            })
            .on("mouseleave", function () { self.tip.style("opacity", 0); })
            .on("click", function (event, d) {
                event.stopPropagation();
                self._suppressDeselect = true;
                self.selectedArc = d;
                const tx = self.txMap ? self.txMap.get(d.hashFrom) : null;
                const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                self._showChainPanel(d.hashFrom, destAddr, d.btc, d, true);
            })
            .transition().duration(300).attr("opacity", 1);
    }

    _renderArcLayer(className, arcs, opacity, x) {
        const self = this, axisY = this._axisY;
        const scale = className === "day-arcs" ? this.dayColorScale : this.hourColorScale; // NEW
        const arcsTop = arcs.filter(a => (a._side || 1) === 1);
        const arcsBot = arcs.filter(a => (a._side || 1) === -1);

        const renderGroup = (gVis, gHit, subArcs, subClass) => {
            const selVis = gVis.selectAll(`path.${className}.${subClass}`)
                .data(subArcs, d => d.key);
            selVis.exit().remove();

            const enterVis = selVis.enter().append("path")
                .attr("class", `${className} ${subClass}`)
                .attr("data-key", d => d.key)
                .attr("fill", "none")
                .attr("stroke-linecap", "round");

            enterVis.merge(selVis)
                .attr("data-op", opacity)
                .attr("d", d => {
                    const x1 = x(d.time_from), x2 = x(d.time_to);
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2, self._hashOffset(d.key)), axisY, d._side || 1);
                })
                .attr("stroke", d => self._getArcHlColor(d) || scale(d.btc))          // CHANGED

                .attr("stroke-width", d => self._getArcHlColor(d) ? 4 : 2.5)

                .attr("marker-end", opacity > 0 ? "url(#ef-arrow)" : null)
                .attr("opacity", self.selectedArc ? 0.05 : opacity);

            const selHit = gHit.selectAll(`path.hit-${className}.${subClass}`)
                .data(subArcs, d => d.key);
            selHit.exit().remove();

            const enterHit = selHit.enter().append("path")
                .attr("class", `hit-${className} ${subClass}`)
                .attr("fill", "none")
                .attr("stroke", "transparent")
                .attr("stroke-linecap", "round");

            const mergedHit = enterHit.merge(selHit);

            mergedHit
                .attr("d", d => {
                    const x1 = x(d.time_from), x2 = x(d.time_to);
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2, self._hashOffset(d.key)), axisY, d._side || 1);
                })
                .attr("stroke-width", 18)
                .style("cursor", opacity > 0 ? "pointer" : "default")
                .style("pointer-events", opacity > 0 ? "stroke" : "none");

            if (opacity > 0) {
                const getVisEl = (d) => gVis.select(`path[data-key="${d.key}"]`);

                mergedHit
                    .on("mouseenter", function (event, d) {
                        if (self.selectedArc) return;
                        const hoverColor = self._getArcHlColor(d) || "#EC4899";
                        getVisEl(d).attr("stroke", hoverColor).attr("marker-end", "url(#ef-arrow-hl)");
                        self._showTooltip(event, d);
                    })
                    .on("mousemove", function (event) {
                        self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
                    })
                    .on("mouseleave", function (event, d) {
                        if (self.selectedArc) return;
                        getVisEl(d)
                            .attr("stroke", self._getArcHlColor(d) || scale(d.btc))    // CHANGED
                            .attr("marker-end", "url(#ef-arrow)");
                        self.tip.style("opacity", 0);
                    })
                    .on("click", function (event, d) {
                        event.stopPropagation();
                        getVisEl(d)
                            .attr("stroke", self._getArcHlColor(d) || scale(d.btc))    // CHANGED

                            .attr("marker-end", "url(#ef-arrow)");
                        self.tip.style("opacity", 0);

                        if (self.selectedArc) {
                            const currentRoot = d.chainRoot || self.hashToRoot.get(d.hashFrom) || d.hashFrom;
                            const selectedRoot = self.selectedArc.chainRoot || self.hashToRoot.get(self.selectedArc.hashFrom) || self.selectedArc.hashFrom;

                            if (currentRoot === selectedRoot) {
                                self._suppressDeselect = true;
                                self.selectedArc = d;
                                const tx = self.txMap ? self.txMap.get(d.hashFrom) : null;
                                const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                                self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                                self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
                            } else {
                                self.selectedArc = null;
                                self._highlightChain(null);
                            }
                            return;
                        }

                        self._suppressDeselect = true;
                        self.selectedArc = d;
                        self._highlightChain(d);
                        const tx = self.txMap ? self.txMap.get(d.hashFrom) : null;
                        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                        const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                        self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                        self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
                    });
            } else {
                mergedHit
                    .on("mouseenter", null).on("mousemove", null).on("mouseleave", null).on("click", null)
                    .style("pointer-events", "none");
            }
        };

        renderGroup(this.gArcTop, this.gHitTop, arcsTop, "arc-top");
        renderGroup(this.gArcBot, this.gHitBot, arcsBot, "arc-bot");
    }

    _showTooltip(event, d) {
        const isDay = (this.lastGranularity || 'day') === 'day';
        this.tip.style("opacity", 1)
            .style("left", (event.clientX + 15) + "px")
            .style("top", (event.clientY - 15) + "px")
            .html(isDay ? this._tooltipDay(d) : this._tooltipHour(d));
    }

    _tooltipDay(d) {
        const dateFrom = d.fromKey;
        const dateTo = d.toKey;
        const [yf, mf, df] = dateFrom.split("-").map(Number);
        const [yt, mt, dt] = dateTo.split("-").map(Number);
        const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const labelFrom = `${df} ${M[mf - 1]} ${yf}`;
        const labelTo = `${dt} ${M[mt - 1]} ${yt}`;
        const hlColor = this._getArcHlColor(d);
        const matched = this._getMatchedStats(d);
        return `
            <div style="font-weight:700;color:${hlColor || '#EC4899'};margin-bottom:6px">
                Daily flow
                <span style="font-size:9px;color:#888;font-weight:400;margin-left:6px">(click to trace chain)</span>
            </div>
            <div style="margin-bottom:2px;font-size:10px;color:#aaa">${labelFrom} → ${labelTo}</div>
            <div style="margin-bottom:2px">Combined volume: <b style="color:#fff">₿ ${d.btc.toFixed(4)}</b></div>
            <div style="margin-bottom:2px">Individual flows combined here: <b style="color:#3B82F6">${d.count}</b></div>
            ${matched ? `
            <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1)">
                <div style="color:${hlColor};font-size:10px">Your searched address's share:</div>
                <div>₿ ${matched.btc.toFixed(4)} across ${matched.count} of the ${d.count} flows above</div>
            </div>` : ''}
        `;
    }

    _tooltipHour(d) {
        const hlColor = this._getArcHlColor(d);
        const tx = this.txMap ? this.txMap.get(d.hashFrom) : null;
        const timeStr = tx ? d3.timeFormat("%d %b %Y, %H:%M UTC")(tx.time) : '—';
        return `
            <div style="font-weight:700;color:${hlColor || '#EC4899'};margin-bottom:6px">
                Single transaction flow
                <span style="font-size:9px;color:#888;font-weight:400;margin-left:6px">(click to trace chain)</span>
            </div>
            <div style="margin-bottom:2px;font-size:10px;color:#aaa">${timeStr}</div>
            <div style="margin-bottom:2px">Volume: <b style="color:#fff">₿ ${d.btc.toFixed(4)}</b></div>
            <div style="margin-bottom:2px">
                Position: <b style="color:#3B82F6">TX ${d.chainLen - d.hops} of ${d.chainLen}</b>
                <span style="color:#555;font-size:9px">(in this chain)</span>
            </div>
            <div style="margin-bottom:2px">
                Hops remaining: <b style="color:#A855F7">${d.hops}</b>
            </div>
        `;
    }

    _rebuildNodes(activeArcs, granularity) {
        this.gNode.selectAll("*").remove();
        const nodeMap = new Map();
        activeArcs.forEach(a => {
            if (!nodeMap.has(a.fromKey)) nodeMap.set(a.fromKey, { key: a.fromKey, time: a.fromCenterTime });
            if (!nodeMap.has(a.toKey)) nodeMap.set(a.toKey, { key: a.toKey, time: a.toCenterTime });
        });

        const entered = this.gNode.selectAll("g.ef-node")
            .data(Array.from(nodeMap.values()), d => d.key)
            .enter().append("g").attr("class", "ef-node");

        // Plain ring — no ₿ glyph inside (was visually noisy/confusing).
        entered.append("circle")
            .attr("r", this.NODE_R)
            .attr("fill", "rgba(247,147,26,0.12)")
            .attr("stroke", "#F7931A").attr("stroke-width", 1.2);

        entered.append("text")
            .attr("class", "node-label")
            .attr("y", -(this.NODE_R + 6))
            .attr("text-anchor", "middle")
            .attr("font-size", "10px").attr("fill", "#ddd")
            .text(d => granularity === "day" ? efFmtDay(d.key) : efFmtHour(d.key));
    }
    _ensureChainNodes(chainArcs) {
        const existing = new Set();
        this.gNode.selectAll("g.ef-node").each(function (d) { existing.add(d.key); });

        const toAdd = new Map();
        chainArcs.forEach(a => {
            if (!existing.has(a.fromKey)) toAdd.set(a.fromKey, { key: a.fromKey, time: a.fromCenterTime });
            if (!existing.has(a.toKey)) toAdd.set(a.toKey, { key: a.toKey, time: a.toCenterTime });
        });
        if (!toAdd.size) return;

        const granularity = this.lastGranularity || 'day';
        const entered = this.gNode.selectAll("g.ef-node")
            .data(Array.from(toAdd.values()), d => d.key)
            .enter().append("g").attr("class", "ef-node");

        entered.append("circle")
            .attr("r", this.NODE_R)
            .attr("fill", "rgba(247,147,26,0.12)")
            .attr("stroke", "#F7931A").attr("stroke-width", 1.2);

        entered.append("text")
            .attr("class", "node-label")
            .attr("y", -(this.NODE_R + 6))
            .attr("text-anchor", "middle")
            .attr("font-size", "10px").attr("fill", "#ddd")
            .text(d => granularity === "day" ? efFmtDay(d.key) : efFmtHour(d.key));

        this._syncNodePositions(this.currentX);
    }

    _syncNodePositions(x) {
        this.gNode.selectAll("g.ef-node")
            .attr("transform", d => `translate(${x(d.time)},${this._axisY})`);
    }
    _centerOnArc(arc) {
    if (!arc || !this.zoom) return;
    const xPix = this.xScale(arc.time_from); // coordinate in the UNZOOMED scale
    this.svgEl.transition().duration(500)
        .call(this.zoom.translateTo, xPix, this._axisY);
}

    _buildTooltip() {
        this.tip = d3.select("body").append("div")
            .attr("class", "ef-tooltip")
            .style("position", "fixed").style("pointer-events", "none").style("opacity", 0)
            .style("background", "rgba(10,10,15,0.95)").style("padding", "10px 14px")
            .style("border", "1px solid rgba(255,255,255,0.1)").style("border-radius", "6px")
            .style("color", "#fff").style("font-size", "11px").style("z-index", "1000");
    }
_makeDraggable(panelSel) {
    const node = panelSel.node();
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

    node.addEventListener('mousedown', (e) => {
        const header = e.target.closest('.ef-panel-drag-handle');
        if (!header) return;
        if (e.target.closest('button')) return;
        dragging = true;
        const rect = node.getBoundingClientRect();
        origLeft = rect.left;
        origTop  = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        let newLeft = origLeft + (e.clientX - startX);
        let newTop  = origTop  + (e.clientY - startY);
        // Clamp against the real browser viewport, not the chart container —
        // keeps at least 60px of the header always reachable, but otherwise
        // lets the panel go anywhere on screen, including over the sidebar/header.
        newLeft = Math.max(-node.offsetWidth + 60, Math.min(newLeft, window.innerWidth - 60));
        newTop  = Math.max(0, Math.min(newTop, window.innerHeight - 40));
        node.style.left = `${newLeft}px`;
        node.style.top  = `${newTop}px`;
        node.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => { dragging = false; });
}
    _showZoomHourlyNotice(show) {
        if (!this._zoomNotice) {
            this._zoomNotice = this.container.append("div")
                .attr("class", "ef-zoom-notice")
                .style("position", "absolute")
                .style("top", "34px")
                .style("left", "50%")
                .style("transform", "translateX(-50%)")
                .style("background", "#1e293b")
                .style("border", "1px solid #F59E0B")
                .style("color", "#fcd34d")
                .style("font-size", "10px")
                .style("padding", "5px 12px")
                .style("border-radius", "6px")
                .style("z-index", "50")
                .style("pointer-events", "none")
                .style("display", "none")
                .text(`For Viewing individual transactions (zoomed in) — enable "One transaction per edge" in the sidebar.`);
        }
        this._zoomNotice.style("display", show ? "block" : "none");
    }
_buildChainPanel() {
    if (this._chainPanel) return;
    this._chainPanel = d3.select(document.body)
        .append("div").attr("class", "ef-chain-panel")
        .style("position", "fixed")            // fixed to viewport, not clipped by any container
        .style("top", "12px")
        .style("left", `${Math.max(12, window.innerWidth - 332)}px`)
        .style("width", "320px").style("min-width", "220px").style("max-width", "600px")
        .style("height", "420px").style("min-height", "180px").style("max-height", "85vh")
        .style("resize", "both").style("overflow-y", "auto")
        .style("background", "rgba(10,12,18,0.97)")
        .style("border", "1px solid #EC4899").style("border-radius", "8px")
        .style("padding", "14px 16px").style("color", "#fff").style("font-size", "11px")
        .style("z-index", "9999").style("display", "none").style("pointer-events", "all");
    this._makeDraggable(this._chainPanel);
}
    _showUnplottableHopsNotice(missingCount) {
        if (!this._chainPanel) return;
        this._chainPanel.append("div")
            .style("margin-top", "8px")
            .style("padding", "6px 8px")
            .style("background", "rgba(245,158,11,0.08)")
            .style("border", "1px solid rgba(245,158,11,0.3)")
            .style("border-radius", "4px")
            .style("font-size", "9px")
            .style("color", "#fcd34d")
            .text(`${missingCount} of ${missingCount + this._activeChainArcs.length} hops happened within the same clock hour as their prior hop, so they have no separate arc to plot — they're still counted in the chain, just not drawn individually.`);
    }
    _showChainPanel(txHash, destAddr, btc, arc, isPeelView = null) {
        if (isPeelView !== null) this._chainPanelShowSparkline = isPeelView;
        if (!this._chainPanel) this._buildChainPanel();
        const isDay = (this.lastGranularity || 'day') === 'day';

        // Panel color follows which chain is on screen: amber for a Run Detection
        // candidate, pink for a plain arc click — never hardcoded, so it never
        // clashes with the arc color it's describing.
        const baseColor = this._chainPanelShowSparkline ? '#F59E0B' : '#EC4899';
        const hlColor = arc ? (this._getArcHlColor(arc) || baseColor) : baseColor;

        // Position/total always come from the arcs actually navigable via
        // Prev/Next — never from chain metadata that may count hops with no
        // drawable arc. That mismatch was why "TX 2/3" couldn't advance.
        const navArcs = this._activeChainArcs || [];
        const pos = this._activeChainIdx + 1;
        const total = navArcs.length;

        const matched = arc ? this._getMatchedStats(arc) : null;

        const copyBtn = (val, color) =>
            `<button onclick="navigator.clipboard.writeText('${val}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='copy',1200)})"
            style="flex-shrink:0;background:transparent;border:1px solid ${color};
                   color:${color};font-size:9px;padding:2px 8px;border-radius:3px;
                   cursor:pointer;white-space:nowrap">copy</button>`;

        let body;
        if (isDay && arc) {
            const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const [yf, mf, df] = arc.fromKey.split("-").map(Number);
            const [yt, mt, dt] = arc.toKey.split("-").map(Number);
            const labelFrom = `${df} ${M[mf - 1]} ${yf}`;
            const labelTo = `${dt} ${M[mt - 1]} ${yt}`;
            body = `
            <div style="color:#888;font-size:9px;margin-bottom:6px">${labelFrom} → ${labelTo}</div>
            <div style="margin-bottom:4px;font-size:10px;color:#aaa">
                Combined volume: <b style="color:#fff">₿ ${btc.toFixed(4)}</b>
            </div>
            <div style="margin-bottom:8px;font-size:9px;color:#777">
                This one arc merges <b style="color:#3B82F6">${arc.count}</b> separate money movements
                (possibly from different addresses/transactions) that all went from
                ${labelFrom} to ${labelTo}. Zoom in past the daily view to see each one separately.
            </div>
            ${matched ? `
            <div style="margin-bottom:10px;padding:6px 8px;background:${hlColor}14;border:1px solid ${hlColor}55;border-radius:4px;font-size:10px">
                <span style="color:${hlColor}">Your searched address's share:</span>
                ₿ ${matched.btc.toFixed(4)} (${matched.count} of ${arc.count})
            </div>` : ''}
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">First transaction hash in this chain</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                <span style="font-family:monospace;font-size:8.5px;color:#ddd;word-break:break-all;flex:1">${txHash}</span>
                ${copyBtn(txHash, hlColor)}
            </div>
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Main destination address</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">
                <span style="font-family:monospace;font-size:8.5px;color:#F7931A;word-break:break-all;flex:1">${destAddr}</span>
                ${copyBtn(destAddr, '#F7931A')}
            </div>`;
        } else {
            const tx = this.txMap ? this.txMap.get(txHash) : null;
            const timeStr = tx ? d3.timeFormat("%d %b %Y, %H:%M:%S UTC")(tx.time) : '—';
            body = `
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Exact time</div>
            <div style="margin-bottom:10px;font-size:10px;color:#ddd">${timeStr}</div>
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">TX hash</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                <span style="font-family:monospace;font-size:8.5px;color:#ddd;word-break:break-all;flex:1">${txHash}</span>
                ${copyBtn(txHash, hlColor)}
            </div>
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Largest output → address</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:12px">
                <span style="font-family:monospace;font-size:8.5px;color:#F7931A;word-break:break-all;flex:1">${destAddr}</span>
                ${copyBtn(destAddr, '#F7931A')}
            </div>
            <div style="color:#aaa;font-size:10px;margin-bottom:8px">
                Volume: <b style="color:#fff">₿ ${btc.toFixed(4)}</b>
            </div>
            <div style="background:${hlColor}12;border:1px solid ${hlColor}40;
                 border-radius:4px;padding:6px 8px;font-size:10px">
                <div style="color:${hlColor};font-weight:700;margin-bottom:4px">Chain summary</div>
                <div style="color:#aaa">Plotted length: <b style="color:#fff">${total}</b>${this._chainTrueTotal && this._chainTrueTotal > total
                    ? ` <span style="color:#777">(of ${this._chainTrueTotal} total)</span>` : ''
                }</div>
                <div style="color:#aaa">This transaction is: <b style="color:#fff">number ${pos} of ${total}</b></div>
                ${this._chainPanelShowSparkline ? this._buildSparkline(navArcs, this._activeChainIdx) : ''}
                <div style="color:#aaa;margin-top:4px;font-size:9px">
                    Each hop = the biggest output of one transaction gets spent again in the next one.
                    The smaller output at each step is the "peeled" amount.
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:8px">
                    <button onclick="window._efChart._gotoHop(-1)" style="flex:1;margin-right:4px;padding:5px;background:transparent;border:1px solid ${hlColor};color:${hlColor};border-radius:4px;cursor:pointer;font-size:10px">◀ Prev hop</button>
                    <button onclick="window._efChart._gotoHop(1)" style="flex:1;margin-left:4px;padding:5px;background:transparent;border:1px solid ${hlColor};color:${hlColor};border-radius:4px;cursor:pointer;font-size:10px">Next hop ▶</button>
                </div>
            </div>`;
        }

        this._chainPanel.style("border-color", hlColor);
        this._chainPanel.style("display", "block").html(`
        <div class="ef-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move">
            <span style="font-weight:700;color:${hlColor};font-size:12px">${isDay ? 'Daily flow' : 'Single transaction'}</span>
            ${!isDay ? `<span style="font-size:10px;color:#555">TX ${pos} / ${total}</span>` : ''}
            <button onclick="this.closest('.ef-chain-panel').style.display='none'"
                style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0;line-height:1">✕</button>
        </div>
        ${body}
    `);

        // If some hops in the true chain have no drawable arc (they landed in
        // the same time bucket as their prior hop), say so plainly.
        if (!isDay && this._chainTrueTotal && total < this._chainTrueTotal) {
            this._showUnplottableHopsNotice(this._chainTrueTotal - total);
        }
    }
    _gotoHop(delta) {
        if (!this._activeChainArcs || this._activeChainIdx < 0) return;
        const newIdx = this._activeChainIdx + delta;
        if (newIdx < 0 || newIdx >= this._activeChainArcs.length) return;
        this._activeChainIdx = newIdx;
        const d = this._activeChainArcs[newIdx];
        this.selectedArc = d;
        const tx = this.txMap.get(d.hashFrom);
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
        const destAddr = maxOut ? maxOut.addr : (d.addresses[0]?.addr || "—");
        this._showChainPanel(d.hashFrom, destAddr, d.btc, d); // isPeelView omitted → keeps current mode
    }

    _buildSparkline(chainArcs, currentIdx) {
        if (!chainArcs || chainArcs.length < 2) return '';
        const w = 286, h = 70, pad = 10, padTop = 14;
        const vals = chainArcs.map(a => a.btc);
        const min = Math.min(...vals), max = Math.max(...vals);

        // Peeling chains often shrink across orders of magnitude (e.g. 287 ₿ → 50 ₿
        // → ... → 0.4 ₿). A linear y-scale squashes every later, smaller hop
        // against the bottom edge, hiding real differences between them. Log
        // scale keeps every step visible regardless of how big the first hop
        // was — same approach already used for arc coloring in this file.
        const safeMin = Math.max(min, 1e-6);
        const safeMax = Math.max(max, safeMin * 1.000001);
        const logMin = Math.log(safeMin), logMax = Math.log(safeMax);

        const x = i => pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = v => {
            const lv = Math.log(Math.max(v, safeMin));
            return h - pad - ((lv - logMin) / (logMax - logMin || 1)) * (h - pad * 2 - padTop);
        };

        const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');

        const dots = vals.map((v, i) => {
            const isCurrent = i === currentIdx;
            return `<circle cx="${x(i)}" cy="${y(v)}" r="${isCurrent ? 4.5 : 2.5}"
            fill="${isCurrent ? '#ffffff' : '#F59E0B'}"
            stroke="${isCurrent ? '#F59E0B' : 'none'}" stroke-width="${isCurrent ? 1.5 : 0}" />`;
        }).join('');

        const fmtB = v => v >= 1 ? v.toFixed(v >= 100 ? 0 : 2) : v.toFixed(4);

     return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"
                 preserveAspectRatio="xMidYMid meet"
                 style="display:block;margin:8px 0;max-width:100%">
        <text x="${pad}" y="10" font-size="8" fill="#666">₿${fmtB(max)}</text>
        <text x="${pad}" y="${h - 1}" font-size="8" fill="#666">₿${fmtB(min)}</text>
        <polyline points="${pts}" fill="none" stroke="rgba(245,158,11,0.35)" stroke-width="1"/>${dots}
    </svg>`;
    }
    _drawLegend(arcs, granularity) {
        this.svgEl.selectAll(".ef-legend").remove(); // no more SVG-drawn legend

        const footer = d3.select("#ef-legend-footer");
        if (footer.empty()) return;

        let scaleRow = footer.select(".ef-legend-scale");
        if (scaleRow.empty()) {
            scaleRow = footer.append("div").attr("class", "ef-legend-scale")
                .style("display", "flex").style("flex-wrap", "wrap")
                .style("align-items", "center").style("gap", "8px")
                .style("margin-top", "4px");
        }

        if (!arcs.length) { scaleRow.html(''); return; }

        const scale = granularity === "day" ? this.dayColorScale : this.hourColorScale;
        const edges = scale.bucketEdges;
        const colors = scale.range();
        const fmtB = v => {
            if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
            if (v >= 1) return v.toFixed(v >= 100 ? 0 : 1);
            return v.toFixed(v >= 0.01 ? 2 : 4);
        };
        const stepRatio = edges.length > 2 ? edges[1] / Math.max(edges[0], 1e-6) : 1;

        const swatches = colors.map((c, i) => {
            const lo = edges[i], hi = edges[i + 1];
            const rangeLabel = i === colors.length - 1 ? `>${fmtB(lo)}₿` : `${fmtB(lo)}–${fmtB(hi)}₿`;
            const title = `${fmtB(lo)} to ${i === colors.length - 1 ? '∞' : fmtB(hi)} BTC`;
            return `<span title="${title}" style="display:inline-flex;align-items:center;gap:4px;font-size:9px;color:#aaa;white-space:nowrap">
            <span style="width:9px;height:9px;border-radius:2px;background:${c};display:inline-block;flex-shrink:0"></span>${rangeLabel}
        </span>`;
        }).join('');

        scaleRow.html(`
        ${swatches}
        <span style="font-size:9px;color:#666;white-space:nowrap"
              title="Colors fit this file's actual range (₿${fmtB(edges[0])}–₿${fmtB(edges[edges.length - 1])}). Log scale keeps small and huge transfers both visible.">
            log scale · ×${stepRatio.toFixed(1)}/step 
        </span>
    `);
    }
    _arcPassesFilters(a, f = this.activeFilters) {
        const gapHours = (a.toCenterTime - a.fromCenterTime) / 3600000;
        if (f.minGapH > 0 && gapHours < f.minGapH) return false;
        if (f.maxGapH !== Infinity && gapHours > f.maxGapH) return false;
        if (f.minHops > 0 && a.chainLen < f.minHops) return false;

        if ((f.maxAddrTx !== Infinity || f.minAddrTx > 0) && a.inAddr) {
            const count = this.addrTxCount.get(a.inAddr) || 1;
            if (f.maxAddrTx !== Infinity && count > f.maxAddrTx) return false;
            if (f.minAddrTx > 0 && count < f.minAddrTx) return false;
        }

        let addresses = a.addresses;
        if (f.excludes.length > 0)
            addresses = addresses.filter(o => !f.excludes.some(ex => o.addr.toLowerCase().includes(ex)));
        if (f.queries.length > 0)
            addresses = addresses.filter(o => f.queries.some(q => o.addr.toLowerCase().includes(q)));

        if (!addresses.length) return false;
        const totalBtc = addresses.reduce((s, o) => s + o.btc, 0);
        return totalBtc >= f.minB && totalBtc <= f.maxB;
    }
    applyFilters({
        queries = [], excludes = [], hlColorMap = new Map(), minB = 0, maxB = Infinity,
        minGapH = 0, maxGapH = Infinity, minHops = 0,
        maxAddrTx = Infinity, minAddrTx = 0
    }) {
        this.hlColorMap = hlColorMap;
        this.activeQueries = queries;

        this.activeFilters = { queries, excludes, minB, maxB, minGapH, maxGapH, minHops, maxAddrTx, minAddrTx };

        const filterFn = a => this._arcPassesFilters(a, this.activeFilters);

        this.filteredLevels.day = this.levels.day.filter(filterFn);
        this.filteredLevels.hour = this.levels.hour.filter(filterFn);
        this.selectedArc = null;
        this.gChain.selectAll("*").remove();
        this.update(d3.zoomTransform(this.svgEl.node()).k, true);
    }
    _hopPassesFilters(originHash, spendHash, addr, btc, f = this.activeFilters) {
        const originTx = this.txInputMap.get(originHash);
        const spendTx = this.txInputMap.get(spendHash);
        if (!originTx || !spendTx) return true; // can't evaluate — don't block

        const gapHours = (spendTx.time - originTx.time) / 3600000;
        if (f.minGapH > 0 && gapHours < f.minGapH) return false;
        if (f.maxGapH !== Infinity && gapHours > f.maxGapH) return false;

        if (f.minHops > 0) {
            const root = this.chainRootMap.get(originHash) || originHash;
            const chainLen = (this.txChainMap.get(root) || []).length;
            if (chainLen < f.minHops) return false;
        }

        if ((f.maxAddrTx !== Infinity || f.minAddrTx > 0) && addr) {
            const count = this.addrTxCount.get(addr) || 1;
            if (f.maxAddrTx !== Infinity && count > f.maxAddrTx) return false;
            if (f.minAddrTx > 0 && count < f.minAddrTx) return false;
        }

        const a = addr ? addr.toLowerCase() : "";
        if (f.excludes.length > 0 && f.excludes.some(ex => a.includes(ex))) return false;
        if (f.queries.length > 0 && !f.queries.some(q => a.includes(q))) return false;

        if (btc < f.minB || btc > f.maxB) return false;
        return true;
    }

    // Only absorbs float/fee noise now — a REAL increase always breaks the run.

    _detectPeelingChainCandidates(minLength = 3, minRetainPct = 0.9) {
        const thr = this.btcThreshold || 0;
        const roots = new Set();
        this.filteredLevels.hour
            .filter(a => a.btc >= thr)
            .forEach(a => roots.add(a.chainRoot || a.hashFrom));

        const candidates = [];

        roots.forEach(root => {
            const chainHashes = this.txChainMap.get(root);
            if (!chainHashes || chainHashes.length < 2) return;

            const seq = [];
            for (let i = 0; i < chainHashes.length - 1; i++) {
                const next = this.nextHopMap.get(chainHashes[i]);
                if (!next || next.spendHash !== chainHashes[i + 1]) continue;

                const originTx = this.txInputMap.get(chainHashes[i]);
                if (!originTx || !originTx.btc_in) continue;

                // Checks the hop's actual transaction times directly — works even when
                // origin and spend land in the same clock hour and have no drawable arc.
                const passesActiveFilters = this._hopPassesFilters(
                    chainHashes[i], next.spendHash, next.addr, next.btc, this.activeFilters
                );

                const retainPct = next.btc / originTx.btc_in;
                seq.push({
                    hashFrom: chainHashes[i], hashTo: chainHashes[i + 1],
                    btc: next.btc, retainPct, addr: next.addr,   // NEW — addr added
                    isCleanPeel: retainPct >= minRetainPct && passesActiveFilters
                });
            }
            if (seq.length < minLength) return;


            // Slice into runs: clean peel AND amount decreasing vs prior hop
            let runStart = 0;
            for (let i = 1; i <= seq.length; i++) {
                const broke = i === seq.length ||
                    !seq[i].isCleanPeel ||
                    seq[i].btc > seq[i - 1].btc; // must keep shrinking

                if (broke) {
                    let start = runStart;
                    while (start < i && !seq[start].isCleanPeel) start++;
                    const runLen = i - start;
                    if (runLen >= minLength) {
                        const run = seq.slice(start, i);
                        candidates.push({
                            root, arcs: run,
                            startBtc: run[0].btc, endBtc: run[run.length - 1].btc,
                            length: run.length,
                            declinePct: run[0].btc ? (run[0].btc - run[run.length - 1].btc) / run[0].btc : 0,
                            avgRetainPct: run.reduce((s, a) => s + a.retainPct, 0) / run.length
                        });
                    }
                    runStart = i;
                }
            }
        });

        return candidates.sort((a, b) => b.length - a.length || b.declinePct - a.declinePct);
    }
_buildPeelPanel() {
    if (this._peelPanel) return;
    this._peelPanel = d3.select(document.body)
        .append("div").attr("class", "ef-peel-panel")
        .style("position", "fixed")
        .style("top", "12px").style("left", "12px")
        .style("width", "300px").style("min-width", "200px").style("max-width", "550px")
        .style("height", "400px").style("min-height", "150px").style("max-height", "85vh")
        .style("resize", "both").style("overflow-y", "auto")
        .style("background", "rgba(10,12,18,0.97)")
        .style("border", "1px solid #F59E0B").style("border-radius", "8px")
        .style("padding", "14px 16px").style("color", "#fff").style("font-size", "11px")
        .style("z-index", "9999").style("display", "none").style("pointer-events", "all");
    this._makeDraggable(this._peelPanel);
}
    _showPeelResults(candidates) {
        if (!this._peelPanel) this._buildPeelPanel();
        this._peelCandidates = candidates;

        const header = `
            <div class="ef-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move">
                <span style="font-weight:700;color:#F59E0B;font-size:12px">
                    Detected Candidates (${candidates.length})
                </span>
                <button onclick="this.closest('.ef-peel-panel').style.display='none'"
                    style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0;line-height:1">✕</button>
            </div>`;

        if (!candidates.length) {
            this._peelPanel.style("display", "block").html(header + `
                <div style="color:#888;font-size:10px">
                    No chains matched this tolerance / minimum length. Try raising the noise
                    tolerance slightly or lowering min length in the sidebar.
                </div>`);
            return;
        }

        const rows = candidates.map((c, i) => `
            <div class="ef-peel-row" data-idx="${i}" style="
                padding:8px 10px;margin-bottom:6px;border:1px solid rgba(245,158,11,0.3);
                border-radius:5px;cursor:pointer;background:rgba(245,158,11,0.05)">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:#ddd">
                    <span><b style="color:#F59E0B">${c.length}</b> hops</span>
                    <span>${c.startBtc.toFixed(3)} ₿ → ${c.endBtc.toFixed(3)} ₿</span>
                </div>
               <div style="font-size:9px;color:#888;margin-top:2px">
                    ${(c.declinePct * 100).toFixed(1)}% total decline
                    · avg retain ~${(c.avgRetainPct * 100).toFixed(1)}%
                    · root ${c.root.slice(0, 10)}…
                </div>
            </div>`).join('');

        this._peelPanel.style("display", "block").html(header + `
            <div style="font-size:9px;color:#777;margin-bottom:8px">Click a candidate to highlight it on the graph.</div>
            ${rows}
        `);

        this._peelPanel.selectAll(".ef-peel-row").on("click", (event) => {
            const idx = +event.currentTarget.getAttribute("data-idx");
            this._highlightPeelCandidate(this._peelCandidates[idx]);
        });
    }

    _highlightPeelCandidate(candidate) {
        if (!candidate || !candidate.arcs.length) return;

        const runArcs = candidate.arcs
            .map(hop => this.hourArcByKey.get(`${hop.hashFrom}|${hop.hashTo}|${hop.addr}`))
            .filter(Boolean);

        const totalHops = candidate.arcs.length;
        if (!runArcs.length) return;

        this._suppressDeselect = true;
        this.selectedArc = runArcs[0];
        this._activeChainIdx = 0;
        this._chainTrueTotal = totalHops;

        this._drawChainArcsOnly(runArcs);
        this._centerOnArc(runArcs[0]); 

        const first = runArcs[0];
        const tx = this.txMap ? this.txMap.get(first.hashFrom) : null;
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
        const destAddr = maxOut ? maxOut.addr : (first.addresses?.[0]?.addr || "—");

        this._showChainPanel(first.hashFrom, destAddr, first.btc, first, true);
    }
}
function efFmtDay(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${M[m - 1]}`;
}

function efFmtHour(hourStr) {
    const parts = hourStr.split("-");
    const d = parts[2], m = Number(parts[1]), h = parts[3];
    const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${M[m - 1]} ${h}:00`;
}
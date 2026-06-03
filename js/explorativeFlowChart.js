class ExplorativeFlowChart {
    constructor(container, rawData) {
        this.container   = container;
        this.rawData     = rawData;
        this.selectedArc = null;
        this.hlColorMap  = new Map();

        this.margin = { top: 8, right: 20, bottom: 8, left: 20 };

        let containerH = this.container.node().getBoundingClientRect().height;
        if (containerH < 100) {
            containerH = window.innerHeight * 0.75;
            this.container.style("height", `${containerH}px`);
        }
        this.svgH = containerH;

        this.THRESHOLD_HOUR = 3.0;
        this.btcThreshold   = 0;
        this.NODE_R         = 14;

        this._processTimeWindow();
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
    get _halfH()  { return this._axisY - this.margin.top - this.NODE_R - 10; }

    _processTimeWindow() {
        const times     = this.rawData.map(d => d.time.getTime());
        this.tMin       = new Date(d3.min(times));
        this.tMax       = new Date(d3.max(times));
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
        this.txMap    = txMap;
        this.sortedTx = sortedTx;

        // ── Count how many times each address appears as input ──────
        this.addrTxCount = new Map();
        sortedTx.forEach(tx => {
            tx.in_addresses.forEach(addr => {
                this.addrTxCount.set(addr, (this.addrTxCount.get(addr) || 0) + 1);
            });
        });

        const hopCount  = new Map();
        const countHops = (hash, visited = new Set()) => {
            if (hopCount.has(hash)) return hopCount.get(hash);
            if (visited.has(hash))  return 0;
            visited.add(hash);
            const tx = txMap.get(hash);
            if (!tx || !tx.outputs.length) { hopCount.set(hash, 0); return 0; }
            const maxOut = tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a);
            const nextTx = sortedTx.find(t => t.time > tx.time && t.in_addresses.includes(maxOut.addr));
            if (!nextTx) { hopCount.set(hash, 0); return 0; }
            const hops = 1 + countHops(nextTx.hash, new Set(visited));
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
            const tx = txMap.get(hash);
            if (!tx || !tx.outputs.length) { this.txChainMap.set(hash, [hash]); return [hash]; }
            const maxOut = tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a);
            const nextTx = sortedTx.find(t => t.time > tx.time && t.in_addresses.includes(maxOut.addr));
            if (!nextTx) { this.txChainMap.set(hash, [hash]); return [hash]; }
            const chain = [hash, ...buildChain(nextTx.hash, new Set(visited))];
            this.txChainMap.set(hash, chain);
            return chain;
        };
        sortedTx.forEach(tx => buildChain(tx.hash));

        const isNextHop = new Set();
        sortedTx.forEach(tx => {
            if (!tx.outputs.length) return;
            const maxOut = tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a);
            const next   = sortedTx.find(n => n.time > tx.time && n.in_addresses.includes(maxOut.addr));
            if (next) isNextHop.add(next.hash);
        });
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

    _precomputeAllLevels() {
        this.levels = {
            day:  this._aggregateData("day"),
            hour: this._aggregateData("hour")
        };
        this.filteredLevels = {
            day:  [...this.levels.day],
            hour: [...this.levels.hour]
        };
        this._assignLayers(this.levels.day);
        this._assignLayers(this.levels.hour);
    }

    _aggregateData(granularity) {
        const arcMap = new Map();
        const txMap  = new Map();
        this.rawData.forEach(row => {
            if (!txMap.has(row.hash)) {
                txMap.set(row.hash, { hash: row.hash, time: row.time, in_addresses: row.in_addresses, outputs: [] });
            }
            txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
        });

        const sortedTransactions = Array.from(txMap.values()).sort((a, b) => a.time - b.time);
        const outputsByAddress   = new Map();
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
                    key:        `${y}-${m}-${d}`,
                    centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), 12, 0, 0))
                };
            } else {
                return {
                    key:        `${y}-${m}-${d}-${String(H).padStart(2,'0')}`,
                    centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), H, 0, 0))
                };
            }
        };

        sortedTransactions.forEach(tx => {
            tx.in_addresses.forEach(inAddr => {
                const potentialOrigins = outputsByAddress.get(inAddr);
                if (!potentialOrigins) return;
                let origin = null;
                for (let i = 0; i < potentialOrigins.length; i++) {
                    const out          = potentialOrigins[i];
                    const outUniqueKey = `${inAddr}_${out.hash}`;
                    if (out.time <= tx.time && out.hash !== tx.hash && !spentOutputs.has(outUniqueKey)) {
                        origin = out;
                        spentOutputs.add(outUniqueKey);
                        break;
                    }
                }
                if (!origin) return;

                const originBucket = getBucketInfo(origin.time);
                const spendBucket  = getBucketInfo(tx.time);
                if (originBucket.key === spendBucket.key) return;

                const arcKey    = granularity === "day"
                    ? `${originBucket.key}|${spendBucket.key}`
                    : `${origin.hash}|${tx.hash}|${inAddr}`;
                const changeOutput = tx.outputs.find(o => o.addr === inAddr);
                const volumeBtc    = changeOutput ? changeOutput.btc : origin.btc;
                const hops         = this.txHopMap.get(origin.hash) || 0;
                const root         = this.chainRootMap.get(origin.hash) || origin.hash;
                const chainLen     = (this.txChainMap.get(root) || []).length;

                if (!arcMap.has(arcKey)) {
                    arcMap.set(arcKey, {
                        key: arcKey, fromKey: originBucket.key, toKey: spendBucket.key,
                        fromCenterTime: originBucket.centerTime, toCenterTime: spendBucket.centerTime,
                        time_from: originBucket.centerTime, time_to: spendBucket.centerTime,
                        btc: volumeBtc, count: 1, hops, chainLen,
                        chainRoot: root, hashFrom: origin.hash, hashTo: tx.hash,
                        // ── Salva l'inAddr principale dell'arco ──
                        inAddr: inAddr,
                        addresses: [{ addr: inAddr, btc: volumeBtc, hops }]
                    });
                } else {
                    const e = arcMap.get(arcKey);
                    e.btc     += volumeBtc; e.count += 1;
                    e.hops     = Math.max(e.hops, hops);
                    e.chainLen = Math.max(e.chainLen, chainLen);
                    e.addresses.push({ addr: inAddr, btc: volumeBtc, hops });
                }
            });
        });

        return Array.from(arcMap.values());
    }

    _assignLayers(arcs) {
        const chainSideMap = new Map();
        let nextChainSide  = 1;
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

    _buildSVG() {
        this.container.style("position","relative").style("width","100%").style("height","100%");
        this.hintBar = this.container.append("div").attr("class","ef-hint");

        this.svgW   = this.container.node().getBoundingClientRect().width || window.innerWidth - 300;
        this.innerW = this.svgW - this.margin.left - this.margin.right;

        this.svgEl = this.container.append("svg")
            .attr("width","100%").attr("height", this.svgH).style("display","block");

        const defs = this.svgEl.append("defs");

        defs.append("clipPath").attr("id","ef-clip-top").append("rect")
            .attr("x", this.margin.left).attr("y", 0)
            .attr("width", this.innerW).attr("height", this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id","ef-clip-bot").append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 2)
            .attr("width", this.innerW).attr("height", this.svgH - this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id","ef-clip-nodes").append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 20)
            .attr("width", this.innerW).attr("height", this.NODE_R * 2 + 40);

        defs.append("marker").attr("id","ef-arrow")
            .attr("viewBox","0 0 6 6").attr("refX",5).attr("refY",3)
            .attr("markerWidth",6).attr("markerHeight",6)
            .attr("markerUnits","userSpaceOnUse").attr("orient","auto")
            .append("path").attr("d","M 0 0 L 6 3 L 0 6 z").attr("fill","context-stroke");

        defs.append("marker").attr("id","ef-arrow-hl")
            .attr("viewBox","0 0 6 6").attr("refX",5).attr("refY",3)
            .attr("markerWidth",6).attr("markerHeight",6)
            .attr("markerUnits","userSpaceOnUse").attr("orient","auto")
            .append("path").attr("d","M 0 0 L 6 3 L 0 6 z").attr("fill","#00FFCC");

        this.gArcTop = this.svgEl.append("g").attr("clip-path","url(#ef-clip-top)").attr("pointer-events","none");
        this.gArcBot = this.svgEl.append("g").attr("clip-path","url(#ef-clip-bot)").attr("pointer-events","none");
        this.gChain  = this.svgEl.append("g");
        this.gNode   = this.svgEl.append("g").attr("clip-path","url(#ef-clip-nodes)").attr("pointer-events","none");

        this.gHitTop = this.svgEl.append("g").attr("clip-path","url(#ef-clip-top)");
        this.gHitBot = this.svgEl.append("g").attr("clip-path","url(#ef-clip-bot)");

        this.svgEl.append("line").attr("class","ef-axis-line")
            .attr("x1",0).attr("x2",this.svgW)
            .attr("y1",this._axisY).attr("y2",this._axisY)
            .attr("stroke","rgba(255,255,255,0.12)").attr("stroke-width",1)
            .attr("pointer-events","none");

        this.gGrid = this.svgEl.append("g").attr("class","ef-grid").attr("pointer-events","none");
        this.gAxis = this.svgEl.append("g").attr("class","ef-axis").attr("transform",`translate(0,${this._axisY})`);
        this.gArc  = this.svgEl.append("g").style("display","none");

        const self = this;
        this.svgEl.on("click.deselect", function() {
            if (!self.selectedArc) return;
            if (self._suppressDeselect) { self._suppressDeselect = false; return; }
            self.selectedArc = null;
            self._highlightChain(null);
        });
    }

    _buildScales() {
        this.xScale = d3.scaleTime()
            .domain(this.domainFull)
            .range([this.margin.left, this.svgW - this.margin.right]);
        this.currentX = this.xScale;

        const allArcs = [...this.levels.day, ...this.levels.hour];
        const btcExt  = d3.extent(allArcs, a => a.btc);
        const btcMin  = Math.max(btcExt[0], 0.0001);
        const btcMax  = btcExt[1];

        this.thickScale = d3.scaleLog().domain([btcMin, btcMax]).range([1.5, 7]).clamp(true);
        this.colorScale = d3.scaleSequential().domain([btcMin, btcMax]).interpolator(d3.interpolateWarm);
    }

    _buildZoom() {
        const self = this;
        this.zoom = d3.zoom()
            .scaleExtent([1, 120])
            .translateExtent([[this.margin.left - 500, 0],[this.svgW - this.margin.right + 500, this.svgH]])
            .on("zoom", function(event) {
                const k = event.transform.k;
                self.currentX = event.transform.rescaleX(self.xScale);
                self._renderAxis(self.currentX, k);
                self.update(k, false);
            });
        this.svgEl.call(this.zoom);
    }

    _renderAxis(x, k) {
        let fmt = d3.timeFormat("%d %b");
        if (k > 15) fmt = d3.timeFormat("%H:%M");
        else if (k > this.THRESHOLD_HOUR) fmt = d3.timeFormat("%d %b %H:00");

        const tickCount = k > 15 ? Math.floor(this.innerW / 60) : Math.floor(this.innerW / 90);

        this.gAxis.call(d3.axisBottom(x).ticks(tickCount).tickFormat(fmt).tickSize(6))
            .call(g => g.select(".domain").attr("stroke","rgba(255,255,255,0.15)"))
            .call(g => g.selectAll(".tick line").attr("stroke","rgba(255,255,255,0.2)"))
            .call(g => g.selectAll(".tick text").attr("fill","#888").attr("font-size","10px").attr("dy","1.2em"));

        this.gGrid.selectAll("line.vgrid").data(x.ticks(tickCount)).join("line")
            .attr("class","vgrid")
            .attr("x1", t => x(t)).attr("x2", t => x(t))
            .attr("y1", this.margin.top).attr("y2", this.svgH - this.margin.bottom)
            .attr("stroke","rgba(255,255,255,0.03)").attr("stroke-width",1);
    }

    _visibleArcs(arcs) {
        const [domStart, domEnd] = this.currentX.domain();
        return arcs.filter(a =>
            (a.time_from >= domStart && a.time_from <= domEnd) ||
            (a.time_to   >= domStart && a.time_to   <= domEnd)
        );
    }

    update(k, forceRebuildNodes = false) {
        const x = this.currentX;
        let currentGranularity, opDay = 0, opHour = 0;

        if (k <= this.THRESHOLD_HOUR) {
            currentGranularity = "day"; opDay = 0.85;
            this.hintBar.text("Resolution: Daily — flows aggregated by day");
        } else {
            currentGranularity = "hour"; opHour = 0.85;
            this.hintBar.text(k > 15
                ? `Resolution: Hourly — each flow separate — Zoom ${k.toFixed(0)}x`
                : "Resolution: Hourly — each flow separate");
        }

        const thr   = this.btcThreshold || 0;
        const byThr = arcs => thr > 0 ? arcs.filter(a => a.btc >= thr) : arcs;

        const dayArcs  = byThr(this.filteredLevels.day);
        const hourArcs = k > this.THRESHOLD_HOUR
            ? this._visibleArcs(byThr(this.filteredLevels.hour))
            : byThr(this.filteredLevels.hour);

        this._renderArcLayer("day-arcs",  dayArcs,  opDay,  x);
        this._renderArcLayer("hour-arcs", hourArcs, opHour, x);

        const activeArcs = byThr(this.filteredLevels[currentGranularity]);
        if (this.lastGranularity !== currentGranularity || forceRebuildNodes) {
            this.lastGranularity = currentGranularity;
            this._rebuildNodes(activeArcs, currentGranularity);
        }

        this._syncNodePositions(x);
        this._drawLegend(activeArcs);

        if (this.selectedArc) {
            const self = this, axisY = this._axisY;
            this.gChain.selectAll("path.chain-arc").attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
            });
        }
    }

    _arcHeight(x1, x2) {
        const distance = Math.abs(x2 - x1);
        const maxH = this._halfH;
        const baseH = Math.min(distance * 0.55, maxH * 0.92);
        return Math.max(32, Math.min(baseH, maxH));
    }

    _arcPath(x1, x2, h, axisY, side = 1) {
        const startY = axisY - this.NODE_R * side;
        const cy     = axisY - h * side;
        return `M${x1},${startY} C${x1},${cy} ${x2},${cy} ${x2},${startY}`;
    }

    _highlightChain(arc) {
        this.gChain.selectAll("*").remove();

        this.gHitTop.style("pointer-events", arc ? "none" : null);
        this.gHitBot.style("pointer-events", arc ? "none" : null);

        const self = this;
        this.gArcTop.selectAll("path[data-key]").each(function() {
            const el = d3.select(this), d = el.datum();
            const baseOp  = +el.attr("data-op");
            const hlColor = self._getArcHlColor(d);
            el.attr("stroke", hlColor || self.colorScale(d.btc))
              .attr("opacity", baseOp)
              .attr("marker-end", baseOp > 0 ? "url(#ef-arrow)" : null);
        });
        this.gArcBot.selectAll("path[data-key]").each(function() {
            const el = d3.select(this), d = el.datum();
            const baseOp  = +el.attr("data-op");
            const hlColor = self._getArcHlColor(d);
            el.attr("stroke", hlColor || self.colorScale(d.btc))
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
        const allArcs   = this.levels[granularity];
        const chainArcs = allArcs.filter(a => {
            if (!chainIdx.has(a.hashFrom) || !chainIdx.has(a.hashTo)) return false;
            return chainIdx.get(a.hashTo) === chainIdx.get(a.hashFrom) + 1;
        }).sort((a, b) => chainIdx.get(a.hashFrom) - chainIdx.get(b.hashFrom));

        const x = this.currentX, axisY = this._axisY;

        this.gChain.selectAll("path.chain-arc")
            .data(chainArcs, d => d.key)
            .enter().append("path")
            .attr("class","chain-arc")
            .attr("fill","none")
            .attr("stroke","#00FFCC")
            .attr("stroke-linecap","round")
            .attr("marker-end","url(#ef-arrow-hl)")
            .attr("stroke-width", d => self.thickScale(d.btc) + 1)
            .attr("opacity", 0)
            .attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
            })
            .style("cursor", "pointer")
            .on("mouseenter", function(event, d) { self._showTooltip(event, d); })
            .on("mousemove",  function(event) {
                self.tip.style("left",(event.clientX+15)+"px").style("top",(event.clientY-15)+"px");
            })
            .on("mouseleave", function() { self.tip.style("opacity", 0); })
            .on("click", function(event, d) {
                event.stopPropagation();
                self._suppressDeselect = true;
                self.selectedArc = d;
                const tx       = self.txMap ? self.txMap.get(d.hashFrom) : null;
                const maxOut   = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                self._showChainPanel(d.hashFrom, destAddr, d.btc, d.chainLen - d.hops, d.chainLen, d);
            })
            .transition().duration(300).attr("opacity", 1);
    }

    _renderArcLayer(className, arcs, opacity, x) {
        const self = this, axisY = this._axisY;
        const arcsTop = arcs.filter(a => (a._side || 1) ===  1);
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
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
                })
                .attr("stroke", d => self._getArcHlColor(d) || self.colorScale(d.btc))
                .attr("stroke-width", d => {
                    const base = self.thickScale(d.btc);
                    return self._getArcHlColor(d) ? base + 1.5 : base;
                })
                .attr("marker-end",   opacity > 0 ? "url(#ef-arrow)" : null)
                .attr("opacity",      self.selectedArc ? 0.05 : opacity);

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
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
                })
                .attr("stroke-width", d => Math.max(self.thickScale(d.btc) + 10, 16))
                .style("cursor",         opacity > 0 ? "pointer" : "default")
                .style("pointer-events", opacity > 0 ? "stroke"  : "none");

            if (opacity > 0) {
                const getVisEl = (d) => gVis.select(`path[data-key="${d.key}"]`);

                mergedHit
                    .on("mouseenter", function(event, d) {
                        if (self.selectedArc) return;
                        const hoverColor = self._getArcHlColor(d) || "#00FFCC";
                        getVisEl(d).attr("stroke", hoverColor).attr("marker-end", "url(#ef-arrow-hl)");
                        self._showTooltip(event, d);
                    })
                    .on("mousemove", function(event) {
                        self.tip.style("left",(event.clientX+15)+"px").style("top",(event.clientY-15)+"px");
                    })
                    .on("mouseleave", function(event, d) {
                        if (self.selectedArc) return;
                        getVisEl(d)
                            .attr("stroke", self._getArcHlColor(d) || self.colorScale(d.btc))
                            .attr("marker-end", "url(#ef-arrow)");
                        self.tip.style("opacity", 0);
                    })
                    .on("click", function(event, d) {
                        event.stopPropagation();
                        getVisEl(d)
                            .attr("stroke", self._getArcHlColor(d) || self.colorScale(d.btc))
                            .attr("marker-end", "url(#ef-arrow)");
                        self.tip.style("opacity", 0);

                        if (self.selectedArc) {
                            const currentRoot  = d.chainRoot || self.hashToRoot.get(d.hashFrom) || d.hashFrom;
                            const selectedRoot = self.selectedArc.chainRoot || self.hashToRoot.get(self.selectedArc.hashFrom) || self.selectedArc.hashFrom;

                            if (currentRoot === selectedRoot) {
                                self._suppressDeselect = true;
                                self.selectedArc = d;
                                const tx       = self.txMap ? self.txMap.get(d.hashFrom) : null;
                                const maxOut   = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                                self._showChainPanel(d.hashFrom, destAddr, d.btc, d.chainLen - d.hops, d.chainLen, d);
                            } else {
                                self.selectedArc = null;
                                self._highlightChain(null);
                            }
                            return;
                        }

                        self._suppressDeselect = true;
                        self.selectedArc = d;
                        self._highlightChain(d);
                        const tx       = self.txMap ? self.txMap.get(d.hashFrom) : null;
                        const maxOut   = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                        const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                        self._showChainPanel(d.hashFrom, destAddr, d.btc, d.chainLen - d.hops, d.chainLen, d);
                    });
            } else {
                mergedHit
                    .on("mouseenter",null).on("mousemove",null).on("mouseleave",null).on("click",null)
                    .style("pointer-events","none");
            }
        };

        renderGroup(this.gArcTop, this.gHitTop, arcsTop, "arc-top");
        renderGroup(this.gArcBot, this.gHitBot, arcsBot, "arc-bot");
    }

    _showTooltip(event, d) {
        const isDay = (this.lastGranularity || 'day') === 'day';
        this.tip.style("opacity", 1)
            .style("left", (event.clientX+15)+"px")
            .style("top",  (event.clientY-15)+"px")
            .html(isDay ? this._tooltipDay(d) : this._tooltipHour(d));
    }

    _tooltipDay(d) {
        const dateFrom = d.fromKey;
        const dateTo   = d.toKey;
        const [yf,mf,df] = dateFrom.split("-").map(Number);
        const [yt,mt,dt] = dateTo.split("-").map(Number);
        const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const labelFrom = `${df} ${M[mf-1]} ${yf}`;
        const labelTo   = `${dt} ${M[mt-1]} ${yt}`;
        const hlColor = this._getArcHlColor(d);
        // Mostra il conteggio transazioni dell'inAddr nel tooltip
        const txCount = d.inAddr ? (this.addrTxCount.get(d.inAddr) || 1) : '—';
        return `
            <div style="font-weight:700;color:${hlColor||'#00FFCC'};margin-bottom:6px">
                Daily aggregated flow
                <span style="font-size:9px;color:#888;font-weight:400;margin-left:6px">(click to trace chain)</span>
            </div>
            <div style="margin-bottom:2px;font-size:10px;color:#aaa">${labelFrom} → ${labelTo}</div>
            <div style="margin-bottom:2px">Total volume: <b style="color:#fff">₿ ${d.btc.toFixed(4)}</b></div>
            <div style="margin-bottom:2px">Aggregated flows: <b style="color:#3B82F6">${d.count}</b></div>
            <div style="margin-bottom:2px">Chain length: <b style="color:#A855F7">${d.chainLen}</b> hop</div>
            <div style="margin-bottom:2px">Address TX in dataset: <b style="color:#F7931A">${txCount}</b></div>
        `;
    }

    _tooltipHour(d) {
        const hlColor = this._getArcHlColor(d);
        const txCount = d.inAddr ? (this.addrTxCount.get(d.inAddr) || 1) : '—';
        const topAddrs = [...d.addresses]
            .sort((a, b) => b.btc - a.btc).slice(0, 3)
            .map(a => `<div style="font-family:monospace;font-size:9px;color:#aaa;margin-top:2px">
                ${a.addr.slice(0,20)}…
                <span style="color:#F7931A">${a.btc.toFixed(4)} ₿</span>
            </div>`).join('');
        return `
            <div style="font-weight:700;color:${hlColor||'#00FFCC'};margin-bottom:6px">
                Peeling Chain Segment
                <span style="font-size:9px;color:#888;font-weight:400;margin-left:6px">(click to trace chain)</span>
            </div>
            <div style="margin-bottom:2px">Volume: <b style="color:#fff">₿ ${d.btc.toFixed(4)}</b></div>
            <div style="margin-bottom:2px">
                Position: <b style="color:#3B82F6">TX ${d.chainLen - d.hops} / ${d.chainLen}</b>
                <span style="color:#555;font-size:9px">(from root)</span>
            </div>
            <div style="margin-bottom:2px">
                Remaining hops: <b style="color:#A855F7">${d.hops}</b>
                <span style="color:#555;font-size:9px">(largest output respent ${d.hops} times)</span>
            </div>
            <div style="margin-bottom:6px">
                Address TX in dataset: <b style="color:#F7931A">${txCount}</b>
            </div>
            <div style="color:#888;font-size:9px;margin-bottom:2px">TOP BY VOLUME:</div>
            ${topAddrs}
        `;
    }

    _rebuildNodes(activeArcs, granularity) {
        this.gNode.selectAll("*").remove();
        const nodeMap = new Map();
        activeArcs.forEach(a => {
            if (!nodeMap.has(a.fromKey)) nodeMap.set(a.fromKey, { key: a.fromKey, time: a.fromCenterTime });
            if (!nodeMap.has(a.toKey))   nodeMap.set(a.toKey,   { key: a.toKey,   time: a.toCenterTime   });
        });

        const entered = this.gNode.selectAll("g.ef-node")
            .data(Array.from(nodeMap.values()), d => d.key)
            .enter().append("g").attr("class","ef-node");

        entered.append("circle")
            .attr("r", this.NODE_R)
            .attr("fill","rgba(247,147,26,0.12)")
            .attr("stroke","#F7931A").attr("stroke-width", 1.2);

        entered.append("text")
            .attr("text-anchor","middle").attr("dominant-baseline","central")
            .attr("font-size","9px").attr("fill","#F7931A").text("₿");

        entered.append("text")
            .attr("class","node-label")
            .attr("y", -(this.NODE_R + 6))
            .attr("text-anchor","middle")
            .attr("font-size","10px").attr("fill","#ddd")
            .text(d => granularity === "day" ? efFmtDay(d.key) : efFmtHour(d.key));
    }

    _syncNodePositions(x) {
        this.gNode.selectAll("g.ef-node")
            .attr("transform", d => `translate(${x(d.time)},${this._axisY})`);
    }

    _buildTooltip() {
        this.tip = d3.select("body").append("div")
            .attr("class","ef-tooltip")
            .style("position","fixed").style("pointer-events","none").style("opacity",0)
            .style("background","rgba(10,10,15,0.95)").style("padding","10px 14px")
            .style("border","1px solid rgba(255,255,255,0.1)").style("border-radius","6px")
            .style("color","#fff").style("font-size","11px").style("z-index","1000");
    }

    _buildChainPanel() {
        if (this._chainPanel) return;
        this._chainPanel = d3.select(this.container.node().parentNode || document.body)
            .append("div").attr("class","ef-chain-panel")
            .style("position","absolute").style("top","12px").style("right","12px")
            .style("width","300px").style("background","rgba(10,12,18,0.97)")
            .style("border","1px solid #00FFCC").style("border-radius","8px")
            .style("padding","14px 16px").style("color","#fff").style("font-size","11px")
            .style("z-index","500").style("display","none").style("pointer-events","all");
    }

    _showChainPanel(txHash, destAddr, btc, pos, total, arc) {
        if (!this._chainPanel) this._buildChainPanel();
        const isDay = (this.lastGranularity || 'day') === 'day';
        const hlColor = arc ? (this._getArcHlColor(arc) || '#00FFCC') : '#00FFCC';
        const txCount = arc && arc.inAddr ? (this.addrTxCount.get(arc.inAddr) || 1) : '—';

        const copyBtn = (val, color) =>
            `<button onclick="navigator.clipboard.writeText('${val}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='copy',1200)})"
                style="flex-shrink:0;background:transparent;border:1px solid ${color};
                       color:${color};font-size:9px;padding:2px 8px;border-radius:3px;
                       cursor:pointer;white-space:nowrap">copy</button>`;

        let body;
        if (isDay && arc) {
            const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            const [yf,mf,df] = arc.fromKey.split("-").map(Number);
            const [yt,mt,dt] = arc.toKey.split("-").map(Number);
            const labelFrom = `${df} ${M[mf-1]} ${yf}`;
            const labelTo   = `${dt} ${M[mt-1]} ${yt}`;
            body = `
                <div style="color:#888;font-size:9px;margin-bottom:6px">${labelFrom} → ${labelTo}</div>
                <div style="margin-bottom:8px;font-size:10px;color:#aaa">
                    Aggregated volume: <b style="color:#fff">₿ ${btc.toFixed(4)}</b>
                    &nbsp;·&nbsp; <b style="color:#3B82F6">${arc.count}</b> flows
                    &nbsp;·&nbsp; TX addr: <b style="color:#F7931A">${txCount}</b>
                </div>
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Chain root TX hash</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                    <span style="font-family:monospace;font-size:8.5px;color:#ddd;word-break:break-all;flex:1">${txHash}</span>
                    ${copyBtn(txHash, hlColor)}
                </div>
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Main destination address</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">
                    <span style="font-family:monospace;font-size:8.5px;color:#F7931A;word-break:break-all;flex:1">${destAddr}</span>
                    ${copyBtn(destAddr,'#F7931A')}
                </div>`;
        } else {
            body = `
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">TX hash</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                    <span style="font-family:monospace;font-size:8.5px;color:#ddd;word-break:break-all;flex:1">${txHash}</span>
                    ${copyBtn(txHash, hlColor)}
                </div>
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Largest output → address</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:12px">
                    <span style="font-family:monospace;font-size:8.5px;color:#F7931A;word-break:break-all;flex:1">${destAddr}</span>
                    ${copyBtn(destAddr,'#F7931A')}
                </div>
                <div style="color:#aaa;font-size:10px">
                    Volume: <b style="color:#fff">₿ ${btc.toFixed(4)}</b>
                    &nbsp;·&nbsp; TX addr: <b style="color:#F7931A">${txCount}</b>
                </div>`;
        }

        this._chainPanel.style("border-color", hlColor);
        this._chainPanel.style("display","block").html(`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span style="font-weight:700;color:${hlColor};font-size:12px">${isDay ? 'Daily flow' : 'Chain segment'}</span>
                ${!isDay ? `<span style="font-size:10px;color:#555">TX ${pos} / ${total}</span>` : ''}
                <button onclick="this.closest('.ef-chain-panel').style.display='none'"
                    style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0;line-height:1">✕</button>
            </div>
            ${body}
        `);
    }

    _drawLegend(arcs) {
        this.svgEl.selectAll(".ef-legend").remove();
        if (!arcs.length) return;
        const btcExt = d3.extent(arcs, a => a.btc);
        this.svgEl.append("g").attr("class","ef-legend")
            .attr("transform",`translate(${this.margin.left},${this.svgH - 8})`)
            .append("text").attr("font-size","10px").attr("fill","#555")
            .text(`Thickness: ${btcExt[0]?.toFixed(1)||0} – ${btcExt[1]?.toFixed(1)||0} BTC (log)  ·  Click on arc to trace peeling chain`);
    }

    applyFilters({ queries = [], excludes = [], hlColorMap = new Map(), minB, maxB, maxGapH = Infinity, minHops = 0, maxAddrTx = Infinity }) {
        this.hlColorMap = hlColorMap;

        const filterFn = a => {
            if (maxGapH !== Infinity && (a.toCenterTime - a.fromCenterTime) / 3600000 > maxGapH) return false;
            if (minHops > 0 && a.chainLen < minHops) return false;

            // ── Filter by max TX count of the input address ──
            if (maxAddrTx !== Infinity && a.inAddr) {
                const count = this.addrTxCount.get(a.inAddr) || 1;
                if (count > maxAddrTx) return false;
            }

            let addresses = a.addresses;

            if (excludes.length > 0)
                addresses = addresses.filter(o => !excludes.some(ex => o.addr.toLowerCase().includes(ex)));

            if (queries.length > 0)
                addresses = addresses.filter(o => queries.some(q => o.addr.toLowerCase().includes(q)));

            if (!addresses.length) return false;
            const totalBtc = addresses.reduce((s, o) => s + o.btc, 0);
            return totalBtc >= minB && totalBtc <= maxB;
        };

        this.filteredLevels.day  = this.levels.day.filter(filterFn);
        this.filteredLevels.hour = this.levels.hour.filter(filterFn);
        this.selectedArc = null;
        this.gChain.selectAll("*").remove();
        this.update(d3.zoomTransform(this.svgEl.node()).k, true);
    }
}

function efFmtDay(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d} ${M[m-1]}`;
}

function efFmtHour(hourStr) {
    const parts = hourStr.split("-");
    const d = parts[2], m = Number(parts[1]), h = parts[3];
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d} ${M[m-1]} ${h}:00`;
}
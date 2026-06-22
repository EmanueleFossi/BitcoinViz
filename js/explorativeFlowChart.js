class ExplorativeFlowChart {
    constructor(container, rawData) {
        this.container   = container;
        this.rawData     = rawData;
        this.selectedArc = null;

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

    // ── Time window ──────────────────────────────────────────────
    _processTimeWindow() {
        const times     = this.rawData.map(d => d.time.getTime());
        this.tMin       = new Date(d3.min(times));
        this.tMax       = new Date(d3.max(times));
        this.domainFull = [
            new Date(this.tMin.getTime() - 30 * 60 * 1000),
            new Date(this.tMax.getTime() + 30 * 60 * 1000)
        ];
    }

    // ── Hop counts + chain map + root map ────────────────────────
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

        // 1. txHopMap
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

        // 2. txChainMap: hash → sequenza completa dalla radice
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

        // 3. chainRootMap: ogni hash → hash della radice
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

        // 4. hashToRoot: mappa COMPLETA ogni hash → radice della sua catena.
        // chainRootMap copre solo le tx nel dataset; hashToRoot copre
        // anche tx di mezzo catena che potrebbero non essere in chainRootMap.
        this.hashToRoot = new Map(this.chainRootMap); // copia base
        this.txChainMap.forEach((chain, rootHash) => {
            if (this.chainRootMap.get(rootHash) !== rootHash) return; // solo radici
            chain.forEach(h => {
                if (!this.hashToRoot.has(h)) this.hashToRoot.set(h, rootHash);
            });
        });

        // 5. chainNextMap globale: per ogni hash della catena,
        //    qual è il successore diretto. Usato da _highlightChain.
        this.globalChainNextMap = new Map();
        this.txChainMap.forEach((chain, rootHash) => {
            // solo le radici hanno la catena completa
            if (this.chainRootMap.get(rootHash) !== rootHash) return;
            for (let i = 0; i < chain.length - 1; i++) {
                this.globalChainNextMap.set(chain[i], chain[i + 1]);
            }
            this.globalChainNextMap.set(chain[chain.length - 1], null);
        });
    }

    // ── Pre-aggregazione ─────────────────────────────────────────
    _precomputeAllLevels() {
        this.levels = {
            day:  this._aggregateData("day"),
            hour: this._aggregateData("hour")
        };
        this.filteredLevels = {
            day:  [...this.levels.day],
            hour: [...this.levels.hour]
        };
        // Assegna lati una sola volta — catene stessa parte, lunghi sopra
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
                    centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), H, 30, 0))
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

                const arcKey       = granularity === "day"
                    ? `${originBucket.key}|${spendBucket.key}`
                    : `${originBucket.key}|${spendBucket.key}|${inAddr}`;
                const changeOutput = tx.outputs.find(o => o.addr === inAddr);
                const volumeBtc    = changeOutput ? changeOutput.btc : origin.btc;
                const hops         = this.txHopMap.get(origin.hash) || 0;
                const root         = this.chainRootMap.get(origin.hash) || origin.hash;
                const chainLen     = (this.txChainMap.get(root) || []).length;

                if (!arcMap.has(arcKey)) {
                    arcMap.set(arcKey, {
                        key:            arcKey,
                        fromKey:        originBucket.key,
                        toKey:          spendBucket.key,
                        fromCenterTime: originBucket.centerTime,
                        toCenterTime:   spendBucket.centerTime,
                        time_from:      originBucket.centerTime,
                        time_to:        spendBucket.centerTime,
                        btc:            volumeBtc,
                        count:          1,
                        hops,
                        chainLen,
                        chainRoot: root,
                        hashFrom:  origin.hash,
                        hashTo:    tx.hash,
                        addresses: [{ addr: inAddr, btc: volumeBtc, hops }]
                    });
                } else {
                    const e = arcMap.get(arcKey);
                    e.btc     += volumeBtc;
                    e.count   += 1;
                    e.hops     = Math.max(e.hops, hops);
                    e.chainLen = Math.max(e.chainLen, chainLen);
                    e.addresses.push({ addr: inAddr, btc: volumeBtc, hops });
                }
            });
        });

        return Array.from(arcMap.values());
    }

    // ── Assegna lato sopra/sotto ──────────────────────────────────
    // Regole (in ordine di priorità):
    // 1. Archi della stessa catena (stesso chainRoot) → stesso lato
    // 2. Catene distinte si alternano tra sopra e sotto
    // 3. Archi senza catena (chainLen=1): lunghi sopra, corti sotto
    _assignLayers(arcs) {
        // Mappa chainRoot → lato assegnato alla catena
        const chainSideMap = new Map();
        let nextChainSide  = 1; // alterna 1/-1 per catene distinte

        arcs.forEach(arc => {
            const root = arc.chainRoot || null;

            if (root && arc.chainLen > 1) {
                // Arco fa parte di una catena
                if (!chainSideMap.has(root)) {
                    chainSideMap.set(root, nextChainSide);
                    nextChainSide *= -1;
                }
                arc._side = chainSideMap.get(root);
            } else {
                // Arco isolato: lunghi sopra, corti sotto
                const span = arc.time_to - arc.time_from;
                const maxSpan = 7 * 24 * 3600 * 1000; // 7 giorni come soglia
                arc._side = span >= maxSpan ? 1 : -1;
            }
        });
    }

    // ── SVG ──────────────────────────────────────────────────────
    _buildSVG() {
        this.container.style("position","relative").style("width","100%").style("height","100%");
        this.hintBar = this.container.append("div").attr("class","ef-hint");

        this.svgW   = this.container.node().getBoundingClientRect().width || window.innerWidth - 300;
        this.innerW = this.svgW - this.margin.left - this.margin.right;

        this.svgEl = this.container.append("svg")
            .attr("width","100%").attr("height", this.svgH).style("display","block");

        const defs = this.svgEl.append("defs");

        defs.append("clipPath").attr("id","ef-clip-top")
            .append("rect")
            .attr("x", this.margin.left).attr("y", 0)
            .attr("width", this.innerW)
            .attr("height", this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id","ef-clip-bot")
            .append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 2)
            .attr("width", this.innerW)
            .attr("height", this.svgH - this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id","ef-clip-nodes")
            .append("rect")
            .attr("x", this.margin.left).attr("y", this._axisY - this.NODE_R - 20)
            .attr("width", this.innerW)
            .attr("height", this.NODE_R * 2 + 40);

        defs.append("marker").attr("id","ef-arrow")
            .attr("viewBox","0 0 6 6").attr("refX",5).attr("refY",3)
            .attr("markerWidth",6).attr("markerHeight",6)
            .attr("markerUnits","userSpaceOnUse")
            .attr("orient","auto")
            .append("path").attr("d","M 0 0 L 6 3 L 0 6 z").attr("fill","context-stroke");

        defs.append("marker").attr("id","ef-arrow-hl")
            .attr("viewBox","0 0 6 6").attr("refX",5).attr("refY",3)
            .attr("markerWidth",6).attr("markerHeight",6)
            .attr("markerUnits","userSpaceOnUse")
            .attr("orient","auto")
            .append("path").attr("d","M 0 0 L 6 3 L 0 6 z").attr("fill","#00FFCC");

        this.gArcTop = this.svgEl.append("g").attr("clip-path","url(#ef-clip-top)");
        this.gArcBot = this.svgEl.append("g").attr("clip-path","url(#ef-clip-bot)");
        this.gChain  = this.svgEl.append("g");
        this.gNode   = this.svgEl.append("g").attr("clip-path","url(#ef-clip-nodes)");

        this.svgEl.append("line").attr("class","ef-axis-line")
            .attr("x1", 0).attr("x2", this.svgW)
            .attr("y1", this._axisY).attr("y2", this._axisY)
            .attr("stroke","rgba(255,255,255,0.12)").attr("stroke-width",1)
            .attr("pointer-events","none");

        this.gGrid = this.svgEl.append("g").attr("class","ef-grid")
            .attr("pointer-events","none");

        this.gAxis = this.svgEl.append("g")
            .attr("class","ef-axis")
            .attr("transform",`translate(0,${this._axisY})`);

        this.gArc = this.svgEl.append("g").style("display","none"); // dummy retrocompatibilità
    }

    // ── Scale ────────────────────────────────────────────────────
    _buildScales() {
        this.xScale = d3.scaleTime()
            .domain(this.domainFull)
            .range([this.margin.left, this.svgW - this.margin.right]);
        this.currentX = this.xScale;

        const allArcs = [...this.levels.day, ...this.levels.hour];
        const btcExt  = d3.extent(allArcs, a => a.btc);

        // Scala logaritmica con range ampio: differenze BTC ben visibili
        const btcMin = Math.max(btcExt[0], 0.0001); // evita log(0)
        const btcMax = btcExt[1];
        this.thickScale = d3.scaleLog()
            .domain([btcMin, btcMax])
            .range([1.5, 7])
            .clamp(true);

        this.colorScale = d3.scaleSequential()
            .domain([btcMin, btcMax])
            .interpolator(d3.interpolateWarm);
    }

    // ── Zoom ─────────────────────────────────────────────────────
    _buildZoom() {
        const self = this;
        this.zoom = d3.zoom()
            .scaleExtent([1, 120])
            .translateExtent([
                [this.margin.left - 500, 0],
                [this.svgW - this.margin.right + 500, this.svgH]
            ])
            .on("zoom", function(event) {
                const k = event.transform.k;
                self.currentX = event.transform.rescaleX(self.xScale);
                self._renderAxis(self.currentX, k);
                self.update(k, false);
            });
        this.svgEl.call(this.zoom);
    }

    // ── Asse + griglia (join D3, zero leak) ──────────────────────
    _renderAxis(x, k) {
        let fmt = d3.timeFormat("%d %b");
        if (k > 15)                       fmt = d3.timeFormat("%H:%M");
        else if (k > this.THRESHOLD_HOUR) fmt = d3.timeFormat("%d %b %H:00");

        const tickCount = k > 15
            ? Math.floor(this.innerW / 60)
            : Math.floor(this.innerW / 90);

        this.gAxis.call(
            d3.axisBottom(x).ticks(tickCount).tickFormat(fmt).tickSize(6)
        )
        .call(g => g.select(".domain").attr("stroke","rgba(255,255,255,0.15)"))
        .call(g => g.selectAll(".tick line").attr("stroke","rgba(255,255,255,0.2)"))
        .call(g => g.selectAll(".tick text").attr("fill","#888").attr("font-size","10px").attr("dy","1.2em"));

        this.gGrid.selectAll("line.vgrid")
            .data(x.ticks(tickCount))
            .join("line")
            .attr("class","vgrid")
            .attr("x1", t => x(t)).attr("x2", t => x(t))
            .attr("y1", this.margin.top)
            .attr("y2", this.svgH - this.margin.bottom)
            .attr("stroke","rgba(255,255,255,0.03)")
            .attr("stroke-width", 1);
    }

    // ── Culling visivo layer orario ───────────────────────────────
    _visibleArcs(arcs) {
        const [domStart, domEnd] = this.currentX.domain();
        return arcs.filter(a =>
            (a.time_from >= domStart && a.time_from <= domEnd) ||
            (a.time_to   >= domStart && a.time_to   <= domEnd)
        );
    }

    // ── Update principale ────────────────────────────────────────
    update(k, forceRebuildNodes = false) {
        const x = this.currentX;
        let currentGranularity;
        let opDay = 0, opHour = 0;

        if (k <= this.THRESHOLD_HOUR) {
            currentGranularity = "day";
            opDay  = 0.85;
           this.hintBar.text("Resolution: Daily – Aggregated flows per day");

        } else {
            currentGranularity = "hour";
            opHour = 0.85;
            this.hintBar.text(k > 15
    ? `Resolution: Hourly – Each flow separated – Zoom ${k.toFixed(0)}x`
    : "Resolution: Hourly – Each flow separated");

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
            const self  = this;
            const axisY = this._axisY;
            this.gChain.selectAll("path.chain-arc")
                .attr("d", d => {
                    const x1 = x(d.time_from), x2 = x(d.time_to);
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
                });
        }
    }

    // ── Altezza arco ─────────────────────────────────────────────
    _arcHeight(x1, x2) {
        const distance = Math.abs(x2 - x1);
        const maxH     = this._halfH;
        const baseH    = Math.min(distance * 0.35, maxH * 0.75);
        return Math.max(28, Math.min(baseH, maxH));
    }

    // ── Path arco ────────────────────────────────────────────────
    _arcPath(x1, x2, h, axisY, side = 1) {
        const startY = axisY - this.NODE_R * side;
        const cy     = axisY - h * side;
        return `M${x1},${startY} C${x1},${cy} ${x2},${cy} ${x2},${startY}`;
    }

    // ── Highlight catena ─────────────────────────────────────────
    // Usa globalChainNextMap (costruito a monte su tutte le catene)
    // per trovare solo link diretti tra tx consecutive.
    // FIX: risolve il caso aggregazione giornaliera dove più tx
    // condividono lo stesso arco — cerca tutti gli archi il cui
    // hashFrom appartiene alla catena E il cui hashTo è il successore
    // atteso, oppure qualsiasi hashFrom della catena se l'arco
    // attraversa più bucket (chainLen differente).
    _highlightChain(arc) {
        this.gChain.selectAll("*").remove();

        if (!arc) {
            [this.gArcTop, this.gArcBot].forEach(g => {
                g.selectAll("path").each(function() {
                    const el = d3.select(this);
                    el.style("opacity",  +el.attr("data-opacity"))
                      .attr("stroke",     el.attr("data-stroke"))
                      .attr("marker-end", +el.attr("data-opacity") > 0 ? "url(#ef-arrow)" : null);
                });
            });
            return;
        }

        // Risale alla radice assoluta usando hashToRoot che copre
        // tutti gli hash compresi quelli di mezzo catena.
        const root = this.hashToRoot.get(arc.hashFrom)
                  || this.hashToRoot.get(arc.hashTo)
                  || arc.hashFrom;

        const chain    = this.txChainMap.get(root) || [root];
        const chainSet = new Set(chain);

        // Sfuma tutti gli archi normali
        [this.gArcTop, this.gArcBot].forEach(g => {
            g.selectAll("path").style("opacity", 0.05).attr("marker-end","url(#ef-arrow)");
        });

        // Filtra SOLO archi il cui hashFrom è nella chainSet
        // E il cui hashTo è il successore diretto O è anch'esso nella chainSet.
        // Questo esclude archi che per coincidenza hanno chainRoot uguale
        // ma non appartengono alla sequenza temporale della catena.
        const allArcs = [...this.levels.day, ...this.levels.hour];

        // Mappa posizione nella catena: hash → indice
        const chainIdx = new Map();
        chain.forEach((h, i) => chainIdx.set(h, i));

        const chainArcs = allArcs.filter(a => {
            // hashFrom deve essere nella catena
            if (!chainIdx.has(a.hashFrom)) return false;
            // hashTo deve essere nella catena con indice >= hashFrom
            // (niente archi che vanno indietro)
            if (!chainIdx.has(a.hashTo)) return false;
            return chainIdx.get(a.hashTo) > chainIdx.get(a.hashFrom);
        });

        // Ordina per posizione nella catena
        chainArcs.sort((a, b) => chainIdx.get(a.hashFrom) - chainIdx.get(b.hashFrom));

        const x     = this.currentX;
        const axisY = this._axisY;
        const self  = this;

        this.gChain.selectAll("path.chain-arc")
            .data(chainArcs, d => d.key)
            .enter().append("path")
            .attr("class","chain-arc")
            .attr("fill","none")
            .attr("stroke","#00FFCC")
            .attr("stroke-linecap","round")
            .attr("marker-end","url(#ef-arrow-hl)")
            .attr("stroke-width", d => self.thickScale(d.btc) + 1)
            .style("opacity", 0)
            .attr("d", d => {
                const x1 = x(d.time_from), x2 = x(d.time_to);
                return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
            })
            .on("click", function(event, d) {
                event.stopPropagation();
                // Mostra pannello fisso copiabile
                const tx      = self.txMap ? self.txMap.get(d.hashFrom) : null;
                const maxOut  = tx && tx.outputs.length
                    ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a)
                    : null;
                const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");
                self._showChainPanel(d.hashFrom, destAddr, d.btc, d.chainLen - d.hops, d.chainLen);
            })
            .transition().duration(300).style("opacity", 1);
    }

    // ── Render layer archi ───────────────────────────────────────
    _renderArcLayer(className, arcs, opacity, x) {
        const self  = this;
        const axisY = this._axisY;

        const arcsTop = arcs.filter(a => (a._side || 1) ===  1);
        const arcsBot = arcs.filter(a => (a._side || 1) === -1);

        const renderGroup = (gEl, subArcs, subClass) => {
            const sel = gEl.selectAll(`path.${className}.${subClass}`)
                .data(subArcs, d => d.key);

            sel.exit().remove();

            const merged = sel.enter().append("path")
                .attr("class", `${className} ${subClass}`)
                .attr("fill", "none")
                .attr("stroke-linecap", "round")
                .style("cursor", "pointer")
                .merge(sel);

            merged
                .attr("d", d => {
                    const x1 = x(d.time_from), x2 = x(d.time_to);
                    return self._arcPath(x1, x2, self._arcHeight(x1, x2), axisY, d._side || 1);
                })
                .attr("stroke",       d => self.colorScale(d.btc))
                .attr("stroke-width", d => self.thickScale(d.btc))
                .attr("marker-end",   opacity > 0 ? "url(#ef-arrow)" : null)
                .each(function(d) {
                    d3.select(this)
                        .attr("data-opacity", opacity)
                        .attr("data-stroke",  self.colorScale(d.btc));
                })
                .style("opacity", this.selectedArc ? 0.05 : opacity)
                .style("display", null);

            if (opacity > 0) {
                merged
                    .on("mouseenter", function() {
                        if (self.selectedArc) return;
                        d3.select(this).style("opacity", 1)
                            .attr("stroke", "#00FFCC")
                            .attr("marker-end", "url(#ef-arrow-hl)");
                    })
                    .on("mouseleave", function() {
                        if (self.selectedArc) return;
                        const el = d3.select(this);
                        el.style("opacity", +el.attr("data-opacity"))
                          .attr("stroke",     el.attr("data-stroke"))
                          .attr("marker-end", "url(#ef-arrow)");
                    })
                    .on("click", function(event, d) {
                        event.stopPropagation();
                        if (self.selectedArc && self.selectedArc.key === d.key) {
                            self.selectedArc = null;
                            self._highlightChain(null);
                        } else {
                            self.selectedArc = d;
                            self._highlightChain(d);
                        }
                    });
                self._setupTooltipEvents(merged);
            } else {
                merged
                    .on("mouseenter", null).on("mouseleave", null)
                    .on("click", null).on("mouseover", null).on("mousemove", null)
                    .attr("marker-end", null);
            }
        };

        renderGroup.call(this, this.gArcTop, arcsTop, "arc-top");
        renderGroup.call(this, this.gArcBot, arcsBot, "arc-bot");

        this.svgEl.on("click.chain", () => {
            self.selectedArc = null;
            self._highlightChain(null);
        });
    }

    // ── Nodi ─────────────────────────────────────────────────────
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
            .attr("font-size","9px").attr("fill","#F7931A")
            .text("₿");

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

    // ── Tooltip ──────────────────────────────────────────────────
    _buildTooltip() {
        this.tip = d3.select("body").append("div")
            .attr("class","ef-tooltip")
            .style("position","fixed").style("pointer-events","none").style("opacity",0)
            .style("background","rgba(10,10,15,0.95)").style("padding","10px 14px")
            .style("border","1px solid rgba(255,255,255,0.1)").style("border-radius","6px")
            .style("color","#fff").style("font-size","11px").style("z-index","1000");
    }

    // ── Pannello fisso dettagli arco catena ──────────────────────
    // Appare in alto a destra, rimane fermo, ha bottoni copia funzionanti.
    _buildChainPanel() {
        if (this._chainPanel) return;
        this._chainPanel = d3.select(this.container.node().parentNode || document.body)
            .append("div")
            .attr("class","ef-chain-panel")
            .style("position","absolute")
            .style("top","12px")
            .style("right","12px")
            .style("width","300px")
            .style("background","rgba(10,12,18,0.97)")
            .style("border","1px solid #00FFCC")
            .style("border-radius","8px")
            .style("padding","14px 16px")
            .style("color","#fff")
            .style("font-size","11px")
            .style("z-index","500")
            .style("display","none")
            .style("pointer-events","all");
    }

    _showChainPanel(txHash, destAddr, btc, pos, total) {
        if (!this._chainPanel) this._buildChainPanel();

        const copyBtn = (val, color) =>
            `<button onclick="navigator.clipboard.writeText('${val}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='copia',1200)})"
                style="flex-shrink:0;background:transparent;border:1px solid ${color};
                       color:${color};font-size:9px;padding:2px 8px;border-radius:3px;
                       cursor:pointer;white-space:nowrap">copia</button>`;

        this._chainPanel
            .style("display","block")
            .html(`
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <span style="font-weight:700;color:#00FFCC;font-size:12px">Chain segment</span>
                    <span style="font-size:10px;color:#555">TX ${pos} / ${total}</span>
                    <button onclick="this.closest('.ef-chain-panel').style.display='none'"
                        style="background:none;border:none;color:#555;font-size:14px;
                               cursor:pointer;padding:0;line-height:1">✕</button>
                </div>
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Hash TX</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                    <span style="font-family:monospace;font-size:8.5px;color:#ddd;word-break:break-all;flex:1">${txHash}</span>
                    ${copyBtn(txHash, '#00FFCC')}
                </div>
                <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Larger output → address</div>
                <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:12px">
                    <span style="font-family:monospace;font-size:8.5px;color:#F7931A;word-break:break-all;flex:1">${destAddr}</span>
                    ${copyBtn(destAddr, '#F7931A')}
                </div>
                <div style="color:#aaa;font-size:10px">
                    Volume: <b style="color:#fff">₿ ${btc.toFixed(4)}</b>
                </div>
            `);
    }

    _setupTooltipEvents(selection) {
        const tip = this.tip;
        selection
            .on("mouseover", function(event, d) {
                const topAddrs = [...d.addresses]
                    .sort((a, b) => b.btc - a.btc).slice(0, 3)
                    .map(a => `<div style="font-family:monospace;font-size:9px;color:#aaa;margin-top:2px">
                        ${a.addr.slice(0,20)}…
                        <span style="color:#F7931A">${a.btc.toFixed(4)} ₿</span>
                    </div>`).join('');

                const posInChain = d.chainLen - d.hops;
                tip.style("opacity", 1).html(`
                    <div style="font-weight:700;color:#00FFCC;margin-bottom:6px">
                        Peeling Chain Segment
                        <span style="font-size:9px;color:#888;font-weight:400;margin-left:6px">(click per tracciare catena)</span>
                    </div>
                    <div style="margin-bottom:2px">Volume: <b style="color:#fff">₿ ${d.btc.toFixed(4)}</b></div>
                    <div style="margin-bottom:2px">
                        Posizione: <b style="color:#3B82F6">TX ${posInChain} / ${d.chainLen}</b>
                        <span style="color:#555;font-size:9px">(dalla radice)</span>
                    </div>
                    <div style="margin-bottom:6px">
                        Hop residui: <b style="color:#A855F7">${d.hops}</b>
                        <span style="color:#555;font-size:9px">(output maggiore rispeso ancora ${d.hops} volte)</span>
                    </div>
                    <div style="color:#888;font-size:9px;margin-bottom:2px">TOP PER VOLUME:</div>
                    ${topAddrs}
                `);
            })
            .on("mousemove", function(event) {
                tip.style("left",(event.clientX+15)+"px").style("top",(event.clientY-15)+"px");
            })
            .on("mouseleave", function() { tip.style("opacity", 0); });
    }

    // ── Legenda ──────────────────────────────────────────────────
    _drawLegend(arcs) {
        this.svgEl.selectAll(".ef-legend").remove();
        if (!arcs.length) return;
        const btcExt = d3.extent(arcs, a => a.btc);
        this.svgEl.append("g").attr("class","ef-legend")
            .attr("transform",`translate(${this.margin.left},${this.svgH - 8})`)
            .append("text").attr("font-size","10px").attr("fill","#555")
            .text(`Spessore: ${btcExt[0]?.toFixed(1)||0} – ${btcExt[1]?.toFixed(1)||0} BTC (log)  ·  Click su arco per tracciare peeling chain`);
    }

    // ── Filtri pubblici ──────────────────────────────────────────
    applyFilters({ query, exclude, minB, maxB, maxGapH = Infinity, minHops = 0 }) {
        const filterFn = a => {
            if (maxGapH !== Infinity) {
                const gapH = (a.toCenterTime - a.fromCenterTime) / 3600000;
                if (gapH > maxGapH) return false;
            }
            if (minHops > 0 && a.chainLen < minHops) return false;
            let addresses = a.addresses;
            if (exclude) addresses = addresses.filter(o => !o.addr.toLowerCase().includes(exclude));
            if (query)   addresses = addresses.filter(o =>  o.addr.toLowerCase().includes(query));
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

// ── Helpers ──────────────────────────────────────────────────────
function efFmtDay(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const M = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
    return `${d} ${M[m-1]}`;
}
function efFmtHour(hourStr) {
    const parts = hourStr.split("-");
    const d = parts[2], m = Number(parts[1]), h = parts[3];
    const M = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
    return `${d} ${M[m-1]} ${h}:00`;
}
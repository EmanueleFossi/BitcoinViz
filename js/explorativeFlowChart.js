// explorativeFlowChart.js
// Hierarchical temporal flow graph.
//   Nodes  = time windows. Start as days; click a node to split it into 6-hour windows,
//            click again to split a 6-hour window into hours. Click a box label to collapse.
//   Edges  = BTC flowing from one window to a later window.
//            Blue  = several flows merged (at least one end is a day or 6-hour window).
//            Green  = one single TX output (both ends are hour nodes).
// Layout is ordinal (one slot per visible node, chronological) so an expanded day gets
// the room it needs and pushes its neighbours aside instead of overlapping them.

const EF_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const efP2 = n => String(n).padStart(2, "0");
const EF_DAY_MS = 86400000;
const EF_HOUR_MS = 3600000;

class ExplorativeFlowChart {
    constructor(container, rawData) {
        this.container = container;
        this.rawData = rawData;
        this.selectedArc = null;
        this.hlColorMap = new Map();
        this.activeQueries = []; // currently highlighted/searched addresses (lowercased)

        this.margin = { top: 62, right: 20, bottom: 20, left: 20 };   // room for the overview strip
        let containerH = this.container.node().getBoundingClientRect().height;
        if (containerH < 100) {
            const parentNode = this.container.node().parentNode;
            const parentH = parentNode ? parentNode.getBoundingClientRect().height : 0;
            containerH = parentH > 100 ? parentH : window.innerHeight * 0.7;
            this.container.style("height", `${containerH}px`);
        }
        this.svgH = containerH;

        this.NODE_R = 5;
        this.btcThreshold = 0;
        this.forceHourly = false;       // legacy flag, no longer used (kept so old callers don't crash)
        this.lastGranularity = "hour";  // legacy
        this.ANIM_MS = 450;

        // ── Expansion state: day keys and 6-hour keys the user has opened ──
        this.expanded = new Set();
                this.overrides = new Map();   // keys the user opened/closed by hand (true = open, false = closed)
        this.autoLevel = 0;           // set by the mouse wheel: 0 = days, 1 = 6-hour windows, 2 = hours
        this._nodeCache = new Map();
        this._nodePx = new Map();       // node key -> screen x at last draw (used for enter/exit animation)
        this.zoomT = d3.zoomIdentity;
        this._zoomSilent = false;
        this._overlay = null;           // {kind, color, arcs} highlight drawn on top of the graph
                this._preOverlayState = null;   // the view to return to when a chain highlight is closed
        this._activeChainArcs = [];
        this._activeChainIdx = -1;
        this.visibleEdges = [];
        this._focusKey = null;          // node the view is focused on (null = no focus)
        this._focusRel = null;
        this.visibleNodes = [];
        this.boxes = [];
        this.contentW = 0;
        this._longMode = 'show';        // 'show' | 'hide'
            this._longSlots = 8;            // an edge is "long" above this many windows
        this._arcHeightMap = new Map();
        // Chain panel sparkline state
        this._chainPanelShowSparkline = false;
        this._sparklineDayView = false;

        // Holds whatever was last passed to applyFilters(). Starts at "no restriction".
        this.activeFilters = {
            queries: [], excludes: [], minB: 0, maxB: Infinity,
            minGapH: 0, maxGapH: Infinity, minHops: 0,
            maxAddrTx: Infinity, minAddrTx: 0
        };

        this._processTimeWindow();
        this._resolveChainLinks();
        this._computeHopCounts();
        this._precomputeAllLevels();
                        this._initKeyIndex();
        this._applyAutoLevel(3);   // start fully opened: 1-hour single TX output view
        this._computeGlobalStats();
        this._tagOutlierArcs();
        this._buildSVG();
        this._buildScales();
        this._initSlotWidth();
        this._buildZoom();
        this._buildTooltip();

        this._refresh(false);

        this._onResize = () => {
            if (!document.body.contains(this.container.node())) {
                window.removeEventListener('resize', this._onResize);
                return;
            }
            let newH = this.container.node().getBoundingClientRect().height;
            if (newH < 100) newH = window.innerHeight * 0.75;
            const newW = this.container.node().getBoundingClientRect().width;
            if (newW !== this.svgW || newH !== this.svgH) {
this.container.selectAll("svg, .ef-hint, .ef-reset, .ef-focus, .ef-long, .ef-topbar, .ef-overview").remove();                this.svgH = newH;
                this.zoomT = d3.zoomIdentity;
                this._nodePx = new Map();
                this._buildSVG();
                this._initSlotWidth();
                this._buildZoom();
                this._refresh(false);
            }
        };
        window.addEventListener('resize', this._onResize);

        this._onKey = e => {
            if (!document.body.contains(this.container.node())) {
                window.removeEventListener('keydown', this._onKey);
                return;
            }
            if (e.key === 'Escape') { this._unpinTip(); if (this._focusKey) this._clearFocus(); }
            const tg = (e.target && e.target.tagName) || '';
            if (/INPUT|TEXTAREA|SELECT/.test(tg) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key.toLowerCase() === 'p') this._pinTip();
                };
        window.addEventListener('keydown', this._onKey);    }

    get _axisY() { return Math.round((this.margin.top + this.svgH) / 2); }
        get _halfH() { return this._axisY - this.margin.top - this.NODE_R - 10; }

    // ════════════════════════════════════════════════════════════════
    //  DATA PREPARATION (unchanged logic)
    // ════════════════════════════════════════════════════════════════
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
        this.linkMap = new Map();     // "spendHash|inAddr" -> origin {hash,time,btc,uncertain}
        this.nextHopMap = new Map();  // originHash -> {spendHash, addr}

        sortedTx.forEach(tx => {
            tx.in_addresses.forEach(inAddr => {
                const candidates = outputsByAddress.get(inAddr);
                if (!candidates) return;
let valid = candidates.filter(o =>
                        o.time <= tx.time && o.hash !== tx.hash &&
                    !spentOutputs.has(`${inAddr}_${o.hash}`)
                );
// One input: the output it spends must have exactly the amount that goes in.
                let bridged = false;
                if (tx.tx_inputs === 1 && tx.btc_in > 0) {
                    const tol = Math.max(1e-6, tx.btc_in * 1e-6);
                    const exact = valid.filter(o => Math.abs(o.btc - tx.btc_in) <= tol);
                    if (exact.length) valid = exact;
                    else {
                        // No exact match: a small transaction in between may not be in the loaded data.
                        // Accept the latest earlier output on this address that is bigger, but by at most 10%.
                        const near = valid.filter(o => o.btc > tx.btc_in && tx.btc_in >= o.btc * 0.9);
                        near.sort((a, b) => b.time - a.time);
                        valid = near.length ? [near[0]] : [];
                        bridged = near.length > 0;
                    }
                }
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
this.linkMap.set(`${tx.hash}|${inAddr}`, { ...origin, uncertain, bridged, gapBtc: bridged ? origin.btc - tx.btc_in : 0 });

                // A single origin tx can have several outputs spent later. Keep the branch
                // with the LARGEST spent output ("biggest output continues the chain").
                const existingNext = this.nextHopMap.get(origin.hash);
                if (!existingNext || origin.btc > existingNext.btc) {
                    this.nextHopMap.set(origin.hash, { spendHash: tx.hash, addr: inAddr, btc: origin.btc });
                }
            });
        });
        this.txInputMap = txMap; // has tx_inputs, btc_in, outputs per hash
    }

    _computeGlobalStats() {
        // Single flows = one entry per real individual transaction output, so this is the
        // true per-flow amount distribution across the whole loaded dataset.
        const amounts = this.levels.hour.map(a => a.btc).sort((a, b) => a - b);
        this.globalOutlierThreshold = amounts.length >= 20
            ? d3.quantile(amounts, 0.99)
            : null;
    }

    _tagOutlierArcs() {
        this.levels.hour.forEach(arc => {
            const f = this._computeArcOutlierFlags(arc);
            arc._hasOutlier = !!(f.dominant || f.selfLoops.length || f.globalOutliers.length || f.repeatedAddrFlows.length);
        });
    }

    _precomputeAllLevels() {
        // Only the finest level is stored: every single address-link flow. Coarser edges
        // (day / 6-hour) are merged from these on the fly, depending on which nodes are open.
        this.levels = { hour: this._aggregateData() };
        this.filteredLevels = { hour: [...this.levels.hour] };
        this.filteredLevels.day = this.filteredLevels.hour; // legacy alias for old callers
        this._assignLayers(this.levels.hour);
        this.hourArcByKey = new Map(this.levels.hour.map(a => [a.key, a]));
    }

    _aggregateData() {
        const arcMap = new Map();
        const txMap = new Map();
        this.rawData.forEach(row => {
            if (!txMap.has(row.hash)) {
                txMap.set(row.hash, { hash: row.hash, time: row.time, in_addresses: row.in_addresses, outputs: [] });
            }
            txMap.get(row.hash).outputs.push({ addr: row.out_address, btc: row.btc_out });
        });

        const sortedTransactions = Array.from(txMap.values()).sort((a, b) => a.time - b.time);

        const getBucketInfo = (dateObj) => {
            const y = dateObj.getUTCFullYear();
            const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getUTCDate()).padStart(2, '0');
            const H = dateObj.getUTCHours();
            return {
                key: `${y}-${m}-${d}-${String(H).padStart(2, '0')}`,
                centerTime: new Date(Date.UTC(y, dateObj.getUTCMonth(), dateObj.getUTCDate(), H, 0, 0))
            };
        };

        sortedTransactions.forEach(tx => {
            tx.in_addresses.forEach(inAddr => {
                const origin = this.linkMap.get(`${tx.hash}|${inAddr}`);
                if (!origin) return;

                const originBucket = getBucketInfo(origin.time);
                const spendBucket = getBucketInfo(tx.time);
                if (originBucket.key === spendBucket.key) return;

                const arcKey = `${origin.hash}|${tx.hash}|${inAddr}`;
               const volumeBtc = origin.btc;
                const hops = this.txHopMap.get(origin.hash) || 0;
                const root = this.chainRootMap.get(origin.hash) || origin.hash;
                const chainLen = (this.txChainMap.get(root) || []).length;
                const entry = { addr: inAddr, btc: volumeBtc, hops, chainLen, hashFrom: origin.hash, hashTo: tx.hash, timeFrom: origin.time, timeTo: tx.time };

                if (!arcMap.has(arcKey)) {
                    arcMap.set(arcKey, {
                        key: arcKey, fromKey: originBucket.key, toKey: spendBucket.key,
                        fromCenterTime: originBucket.centerTime, toCenterTime: spendBucket.centerTime,
                        time_from: originBucket.centerTime, time_to: spendBucket.centerTime,
                        btc: volumeBtc, count: 1, hops, chainLen,
                        chainRoot: root, hashFrom: origin.hash, hashTo: tx.hash,
inAddr: inAddr, uncertain: origin.uncertain, bridged: !!origin.bridged, gapBtc: origin.gapBtc || 0,                        isAggregated: false, isSingle: true,
                        addresses: [entry]
                    });
                } else {
                    const e = arcMap.get(arcKey);
                    e.btc += volumeBtc; e.count += 1;
                    e.hops = Math.max(e.hops, hops);
                    e.chainLen = Math.max(e.chainLen, chainLen);
                    e.uncertain = e.uncertain || origin.uncertain;
                    e.addresses.push(entry);
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

    _matchColorFor(obj) {
        if (obj.addresses) return this._getArcHlColor(obj);
        if (!this.hlColorMap || this.hlColorMap.size === 0) return null;
        const addr = (obj.addr || obj.inAddr || '').toLowerCase();
        if (!addr) return null;
        for (const [query, color] of this.hlColorMap) {
            if (addr.includes(query)) return color;
        }
        return null;
    }

    _computeArcOutlierFlags(arc) {
        const flows = arc.addresses;
        const total = arc.btc;

        // 1. Dominant transaction — one flow eating most of the arc's volume
        let dominant = null;
        if (flows.length > 1) {
            flows.forEach(f => {
                const pct = total > 0 ? f.btc / total : 0;
                if (pct >= 0.7 && (!dominant || pct > dominant.pct)) dominant = { flow: f, pct };
            });
        }

        // 2. Self-loop — money went right back to the same address it came from
        const selfLoops = flows.filter(f => {
            const tx = this.txMap ? this.txMap.get(f.hashTo) : null;
            const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
            const destAddr = maxOut ? maxOut.addr : null;
            return destAddr && f.addr && destAddr.toLowerCase() === f.addr.toLowerCase();
        });

        // 3. Global statistical outlier — top 1% of amounts dataset-wide
        const globalOutliers = this.globalOutlierThreshold != null
            ? flows.filter(f => f.btc >= this.globalOutlierThreshold)
            : [];

        // 4. Repeated address — same input address used more than once in this arc
        const addrCounts = new Map();
        flows.forEach(f => addrCounts.set(f.addr, (addrCounts.get(f.addr) || 0) + 1));
        const repeatedAddrFlows = flows.filter(f => addrCounts.get(f.addr) > 1);

        return { dominant, selfLoops, globalOutliers, repeatedAddrFlows };
    }

    // Matched sub-total for the currently highlighted/searched addresses only.
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

    // ════════════════════════════════════════════════════════════════
    //  TIME WINDOW NODES  (day → 6h → hour)
    // ════════════════════════════════════════════════════════════════
    _dayKeyOf(t) {
        return `${t.getUTCFullYear()}-${efP2(t.getUTCMonth() + 1)}-${efP2(t.getUTCDate())}`;
    }

    _getNode(level, y, mo, d, H) {
        const dayKey = `${y}-${efP2(mo + 1)}-${efP2(d)}`;
        const twH = Math.floor(H / 12) * 12;
        const twKey = `${dayKey}|12h${efP2(twH)}`;
        const sixH = Math.floor(H / 6) * 6;
        const sixKey = `${dayKey}|6h${efP2(sixH)}`;
        const key = level === 'day' ? dayKey : level === '12h' ? twKey : level === '6h' ? sixKey : `${dayKey}|h${efP2(H)}`;
        let n = this._nodeCache.get(key);
        if (n) return n;

        const dayStart = Date.UTC(y, mo, d);
        if (level === 'day') {
            n = { key, level, dayKey, twKey: null, sixKey: null, y, mo, d, H: 0,
                  start: dayStart, end: dayStart + EF_DAY_MS, label: `${d} ${EF_MONTHS[mo]}` };
        } else if (level === '12h') {
            n = { key, level, dayKey, twKey, sixKey: null, y, mo, d, H: twH,
                  start: dayStart + twH * EF_HOUR_MS, end: dayStart + (twH + 12) * EF_HOUR_MS,
                  label: `${efP2(twH)}–${efP2(twH + 12)}` };
        } else if (level === '6h') {
            n = { key, level, dayKey, twKey, sixKey, y, mo, d, H: sixH,
                  start: dayStart + sixH * EF_HOUR_MS, end: dayStart + (sixH + 6) * EF_HOUR_MS,
                  label: `${efP2(sixH)}–${efP2(sixH + 6)}` };
        } else {
            n = { key, level, dayKey, twKey, sixKey, y, mo, d, H,
                  start: dayStart + H * EF_HOUR_MS, end: dayStart + (H + 1) * EF_HOUR_MS,
                  label: `${efP2(H)}:00` };
        }
        n.center = new Date((n.start + n.end) / 2);
        n.flows = 0;
        this._nodeCache.set(key, n);
        return n;
    }

    // Which visible node a moment in time currently belongs to (depends on what is expanded).
    _nodeFor(time) {
        const y = time.getUTCFullYear(), mo = time.getUTCMonth(), d = time.getUTCDate(), H = time.getUTCHours();
        const dayKey = `${y}-${efP2(mo + 1)}-${efP2(d)}`;
        if (!this.expanded.has(dayKey)) return this._getNode('day', y, mo, d, 0);
        const twKey = `${dayKey}|12h${efP2(Math.floor(H / 12) * 12)}`;
        if (!this.expanded.has(twKey)) return this._getNode('12h', y, mo, d, H);
        const sixKey = `${dayKey}|6h${efP2(Math.floor(H / 6) * 6)}`;
        if (!this.expanded.has(sixKey)) return this._getNode('6h', y, mo, d, H);
        return this._getNode('hour', y, mo, d, H);
    }
    
        _slotWidthOf(level) {
        return this.slotW * (level === 'day' ? 1 : level === '12h' ? 0.9 : level === '6h' ? 0.8 : 0.55);
    }
    _nodeLabelFull(n) {
        if (!n) return '—';
        const dd = `${n.d} ${EF_MONTHS[n.mo]} ${n.y}`;
        if (n.level === 'day') return dd;
        if (n.level === '12h') return `${dd}, ${efP2(n.H)}:00–${efP2(n.H + 12)}:00 UTC`;
        if (n.level === '6h') return `${dd}, ${efP2(n.H)}:00–${efP2(n.H + 6)}:00 UTC`;
        return `${dd}, ${efP2(n.H)}:00 UTC`;
    }

    // ════════════════════════════════════════════════════════════════
    //  SVG, SCALES, ZOOM
    // ════════════════════════════════════════════════════════════════
    _buildSVG() {
        this.container.style("position", "relative").style("width", "100%").style("height", "100%");
        // Absolutely positioned overlays — must NOT consume layout space.
        this.hintBar = this.container.append("div")
            .attr("class", "ef-hint")
            .style("position", "absolute")
            .style("top", "8px")
            .style("left", "16px")
            .style("z-index", "5")
            .style("font-size", "13px")
            .style("color", "var(--text-primary)")
            .style("pointer-events", "none");

              const self = this;
        // One row at the top right: [focus chip] [long-edges control] [Collapse all]
        const bar = this.container.append("div")
            .attr("class", "ef-topbar")
            .style("position", "absolute").style("top", "6px").style("right", "16px")
            .style("z-index", "6")
            .style("display", "flex").style("align-items", "center").style("gap", "6px");

        this.focusChip = bar.append("div")
            .attr("class", "ef-focus")
            .style("font-size", "10px").style("padding", "3px 9px")
            .style("border", "1px solid #EC4899").style("border-radius", "5px")
            .style("background", "#ffffff").style("color", "#be185d").style("cursor", "pointer")
            .style("white-space", "nowrap").style("display", "none")
            .on("click", () => self._clearFocus());

        // suspicious-chain chip: sits in the free space of the title row (before the Long edges control)
        this.suspectChip = bar.append("div").attr("class", "ef-suspect")
            .style("display", "none").style("align-items", "center").style("gap", "5px")
            .style("font-size", "10px").style("padding", "3px 9px").style("border", "1px solid #F59E0B")
            .style("border-radius", "5px").style("background", "#FFFBEB").style("color", "#92610a")
            .style("white-space", "nowrap");
        // the "Amounts per hop" button lives in the legend footer (see explorativeFlow.js)
        this.sparkBtn = d3.select("#ef-spark-btn").on("click", () => self._toggleSparkPanel());


        const lc = bar.append("div")
                    .attr("class", "ef-long")
            .style("font-size", "10px")
            .style("display", "flex").style("align-items", "center").style("gap", "6px")
            .style("padding", "3px 8px").style("background", "#ffffff")
            .style("border", "1px solid var(--border)").style("border-radius", "5px")
            .style("color", "#555").style("white-space", "nowrap");
        lc.append("span").text("Long edges");
        const lsel = lc.append("select")
            .style("font-size", "10px").style("padding", "1px 2px")
            .on("change", function () { self._setLongMode(this.value); });
        [["show", "Show"], ["hide", "Hide"]].forEach(([v, t]) =>
            lsel.append("option").attr("value", v).text(t));
        lsel.property("value", this._longMode);
        lc.append("span").text(">").attr("title", "longer than N nodes");
        lc.append("input").attr("type", "number").attr("min", 2).attr("max", 60)
            .property("value", this._longSlots)
            .style("width", "40px").style("font-size", "10px")
            .on("change", function () {
                const v = Math.max(2, Math.min(60, +this.value || 8));
                this.value = v;
                self._setLongMode(null, v);
            });
        lc.attr("title", "Long edges: show or hide edges that span more than N nodes");

        this.resetBtn = bar.append("button")
            .attr("class", "ef-reset")
            .text("Collapse all")
            .style("font-size", "10px").style("padding", "3px 9px")
            .style("border", "1px solid var(--border)").style("border-radius", "5px")
            .style("background", "#ffffff").style("color", "#555").style("cursor", "pointer")
            .style("white-space", "nowrap").style("display", "none")
            .on("click", () => self._collapseAll());
       
                this.svgW = this.container.node().getBoundingClientRect().width || window.innerWidth - 300;
        this.innerW = this.svgW - this.margin.left - this.margin.right;

        this.svgEl = this.container.append("svg")
            .attr("width", "100%").attr("height", this.svgH).style("display", "block");

        const defs = this.svgEl.append("defs");

        defs.append("clipPath").attr("id", "ef-clip-top").append("rect")
            .attr("x", 0).attr("y", 0)
            .attr("width", this.svgW).attr("height", this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id", "ef-clip-bot").append("rect")
            .attr("x", 0).attr("y", this._axisY - this.NODE_R - 2)
            .attr("width", this.svgW).attr("height", this.svgH - this._axisY + this.NODE_R + 2);

        defs.append("clipPath").attr("id", "ef-clip-nodes").append("rect")
            .attr("x", 0).attr("y", this._axisY - this.NODE_R - 20)
            .attr("width", this.svgW).attr("height", this.NODE_R * 2 + 40);

        defs.append("marker").attr("id", "ef-arrow")
            .attr("viewBox", "0 0 6 6").attr("refX", 5).attr("refY", 3)
            .attr("markerWidth", 6).attr("markerHeight", 6)
            .attr("markerUnits", "userSpaceOnUse").attr("orient", "auto")
            .append("path").attr("d", "M 0 0 L 6 3 L 0 6 z").attr("fill", "context-stroke");

        defs.append("marker").attr("id", "ef-arrow-hl")
            .attr("viewBox", "0 0 6 6").attr("refX", 5).attr("refY", 3)
            .attr("markerWidth", 6).attr("markerHeight", 6)
            .attr("markerUnits", "userSpaceOnUse").attr("orient", "auto")
.append("path").attr("d", "M 0 0 L 6 3 L 0 6 z").attr("fill", "none");
        // Layer order (bottom → top): boxes, arcs, highlight, hit areas, nodes, box labels
        this.gBox = this.svgEl.append("g").attr("pointer-events", "none");
        this.gArcTop = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-top)").attr("pointer-events", "none");
        this.gArcBot = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-bot)").attr("pointer-events", "none");
        this.gChain = this.svgEl.append("g");
        this.gHitTop = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-top)");
        this.gHitBot = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-bot)");
this.gChainHit = this.svgEl.append("g");   // hover/click paths of a highlighted chain: above the normal edges
        this.gNode = this.svgEl.append("g").attr("clip-path", "url(#ef-clip-nodes)");
                this.gBoxLabel = this.svgEl.append("g");
        this._buildOverview();
        this._updateSuspectChip();
                this.svgEl.on("click.deselect", function () {
            if (!self.selectedArc) { if (self._focusKey) self._clearFocus(); return; }
self._suppressDeselect = false;
            if (self._overlay && self._suspects) {                                  // suspicious-chain views
                if (self._overlay.kind === 'peel') self._showSuspectMarks(false);   // back to the start-edge view
                return;                                                             // (clear them with ✕ in the chip)
            }            self._clearSelection();
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
        const flows = this.levels.hour;
        // Largest possible merged edge = a day-to-day total, so shades stay comparable
        // between every zoom level and every combination of open nodes.
        const dayTotals = new Map();
        flows.forEach(f => {
            const a = this._dayKeyOf(f.time_from), b = this._dayKeyOf(f.time_to);
            if (a === b) return;
            const k = `${a}>${b}`;
            dayTotals.set(k, (dayTotals.get(k) || 0) + f.btc);
        });
        const minFlow = flows.length ? d3.min(flows, a => a.btc) : 0.0001;
        const maxFlow = flows.length ? d3.max(flows, a => a.btc) : 1;
        const maxAgg = dayTotals.size ? d3.max([...dayTotals.values()]) : 0;
        const btcMin = Math.max(minFlow, 0.0001);
        const btcMax = Math.max(maxFlow, maxAgg, btcMin * 2);
                this.maxFlowBtc = maxFlow;      // used by the sidebar to size the sliders
        this.maxMergedBtc = maxAgg;

        // Same BTC brackets for both; blue family = merged edges, teal family = single TX output.
        const DAY_BUCKET_COLORS = ["#DCEEFF", "#7FB8EA", "#265F91", "#0B2C4D"];
        const HOUR_BUCKET_COLORS = ["#DDF3D6", "#8ED17C", "#2F9E44", "#0F5A24"];
                this.dayColorScale = this._buildBucketColorScale(btcMin, btcMax, DAY_BUCKET_COLORS);
        this.hourColorScale = this._buildBucketColorScale(btcMin, btcMax, HOUR_BUCKET_COLORS);
// Edge thickness grows with BTC (log scale, same range as the colour shades)
this.widthScale = d3.scaleLog().domain([btcMin, btcMax]).range([1.2, 6]).clamp(true);
    }

    // Width of one collapsed day slot, fixed from the fully-collapsed state so the layout
    // does not rescale every time a node is opened.
    _initSlotWidth() {
        const days = new Set();
        this.levels.hour.forEach(a => {
            days.add(this._dayKeyOf(a.time_from));
            days.add(this._dayKeyOf(a.time_to));
        });
        const n0 = Math.max(1, days.size);
        this.slotW = Math.max(44, Math.min(140, this.innerW / n0));
    }

    _buildZoom() {
        const self = this;
this.zoom = d3.zoom().clickDistance(4)
                        .scaleExtent([1, 1])
            .extent([[0, 0], [this.svgW, this.svgH]])
            .translateExtent([[0, 0], [Math.max(this.contentW || 0, this.svgW), this.svgH]])
            .filter(event => event.type !== 'wheel' && !event.button)
            .on("zoom", function (event) {
                self.zoomT = event.transform;
                if (self._zoomSilent) return;
                self._draw(false);
            });
                    this.svgEl.call(this.zoom).on("dblclick.zoom", null);
        this.svgEl.on("wheel.level", function (event) { self._onWheel(event); }, { passive: false });
    }

    _updateZoomExtent() {
        this.zoom.translateExtent([[0, 0], [Math.max(this.contentW, this.svgW), this.svgH]]);
    }

    // Apply this.zoomT to the d3 zoom behaviour without triggering a redraw.
    _syncZoom() {
        this._zoomSilent = true;
        this.svgEl.call(this.zoom.transform, this.zoomT);
        this._zoomSilent = false;
        this.zoomT = d3.zoomTransform(this.svgEl.node());
    }
    _initKeyIndex() {
        this._allDayKeys = new Set();
        this._allTwKeys = new Set();
        this._allSixKeys = new Set();
        this.levels.hour.forEach(a => [a.time_from, a.time_to].forEach(t => {
            const dk = this._dayKeyOf(t);
            const H = t.getUTCHours();
            this._allDayKeys.add(dk);
            this._allTwKeys.add(`${dk}|12h${efP2(Math.floor(H / 12) * 12)}`);
            this._allSixKeys.add(`${dk}|6h${efP2(Math.floor(H / 6) * 6)}`);
        }));
    }
    // Open nodes = wheel level, except where the user chose by hand.
    // Levels: 0 = days, 1 = 12-hour, 2 = 6-hour, 3 = hours (except where the user chose by hand).
    _applyAutoLevel(level) {
        this.autoLevel = level;
        const next = new Set();
        this._allDayKeys.forEach(k => {
            const o = this.overrides.get(k);
            if (o === undefined ? level >= 1 : o) next.add(k);
        });
        this._allTwKeys.forEach(k => {
            const o = this.overrides.get(k);
            if (o === undefined ? level >= 2 : o) next.add(k);
        });
        this._allSixKeys.forEach(k => {
            const o = this.overrides.get(k);
            if (o === undefined ? level >= 3 : o) next.add(k);
        });
        this.expanded = next;
    }
    // Wheel = master switch: up opens every day, then every 6-hour window; down closes them.
    _onWheel(event) {
        event.preventDefault();
        const now = Date.now();
        if (now - (this._lastWheel || 0) > 300) this._wheelAcc = 0;
        this._lastWheel = now;
        if (now - (this._lastLevelChange || 0) < 450) return;
        this._wheelAcc = (this._wheelAcc || 0) + event.deltaY;
        if (Math.abs(this._wheelAcc) < 40) return;
        const dir = this._wheelAcc < 0 ? 1 : -1;
        this._wheelAcc = 0;
        const lvl = Math.max(0, Math.min(3, this.autoLevel + dir));
        if (lvl === this.autoLevel) return;
        this._lastLevelChange = now;
        this._switchAutoLevel(lvl, d3.pointer(event, this.svgEl.node())[0]);
    }

    _switchAutoLevel(lvl, sx) {
        let focus = null, best = Infinity;
        this.visibleNodes.forEach(n => {
            const d = Math.abs(n.px - sx);
            if (d < best) { best = d; focus = n; }
        });
                this.overrides.clear();      // wheel = master switch: forget hand-made choices
        this._applyAutoLevel(lvl);
        this._dropSelectionState();
        if (this.tip) this.tip.style("opacity", 0);
        this._refresh(true, focus ? { screenX: focus.px, focusMs: (focus.start + focus.end) / 2 } : null);
    }
    // ════════════════════════════════════════════════════════════════
    //  GRAPH: edges from flows + current node state, then ordinal layout
    // ════════════════════════════════════════════════════════════════
    _computeGraph() {
        this._nodeCache.forEach(n => { n.flows = 0; });
        const thr = this.btcThreshold || 0;
        const agg = new Map();
        const single = [];

                // One edge style at a time: individual (green) edges only when EVERY node is an hour
        // node; in any mixed state all edges are merged (blue).
const singleMode = this._chainOverlayActive() || this.filteredLevels.hour.length > 0 && this.filteredLevels.hour.every(f =>
                this._nodeFor(f.time_from).level === 'hour' && this._nodeFor(f.time_to).level === 'hour');
        this.singleMode = singleMode;

        this.filteredLevels.hour.forEach(f => {
            const from = this._nodeFor(f.time_from);
            const to = this._nodeFor(f.time_to);
            if (from.key === to.key) return; // happens entirely inside one open window

            if (singleMode) {
                f.fromNode = from; f.toNode = to;
                single.push(f);
                return;
            }
            const key = `${from.key}>${to.key}`;
            let e = agg.get(key);
            if (!e) {
                e = {
                    key, isAggregated: true, isSingle: false,
                    fromNode: from, toNode: to, fromKey: from.key, toKey: to.key,
                    fromCenterTime: from.center, toCenterTime: to.center,
                    time_from: from.center, time_to: to.center,
                    btc: 0, count: 0, hops: 0, chainLen: 0,
                    chainRoot: f.chainRoot, hashFrom: f.hashFrom, hashTo: f.hashTo,
                    inAddr: f.inAddr, uncertain: false, addresses: []
                };
                agg.set(key, e);
            }
            e.btc += f.btc; e.count += 1;
            e.hops = Math.max(e.hops, f.hops);
            e.chainLen = Math.max(e.chainLen, f.chainLen);
            e.uncertain = e.uncertain || f.uncertain;
            e.addresses.push(...f.addresses);
        });

        let edges = [...agg.values(), ...single];
        // Minimum merged-edge volume applies to merged (blue) edges only.
        if (thr > 0) edges = edges.filter(e => !e.isAggregated || e.btc >= thr);
                edges.forEach(e => {
            const c = e.count || 1;
            e.fromNode.flows += c;
            e.toNode.flows += c;
        });

                // A selected merged (blue) edge survives collapsing/expanding as long as both its nodes still exist.
        if (this._overlay && this._overlay.kind === 'single') {
            const keep = edges.find(e => e.key === this._overlay.arcs[0].key);
            if (keep) {
                this._overlay.arcs = [keep];
                this.selectedArc = keep;
                this._activeChainArcs = [keep];
            } else {
                this._dropSelectionState();
                if (this._chainPanel) this._chainPanel.style("display", "none");
            }
        }

        const nodes = this._collectNodes(edges);
        this._layout(nodes);

        // Focus mode: the layout stays as it is, but only edges touching the focused node are kept.
        if (this._focusKey && !nodes.some(n => n.key === this._focusKey)) this._focusKey = null;
        if (this._focusKey) {
            const fk = this._focusKey;
            edges = edges.filter(e => e.fromNode.key === fk || e.toNode.key === fk);
            this._focusRel = new Set([fk]);
            edges.forEach(e => { this._focusRel.add(e.fromNode.key); this._focusRel.add(e.toNode.key); });
              } else {
            this._focusRel = null;
        }

        edges = this._applyLongEdges(edges, nodes);
        this._assignSides(edges);
                this._smax = Math.min(this.svgW * 1.5,
            Math.max(1, d3.max(edges, e => Math.abs(e.toNode.bx - e.fromNode.bx)) || 1));
        this._assignHeights(edges, nodes);
        this._assignPorts(edges);
        this.visibleEdges = edges;
        this.visibleNodes = nodes;
    }

    _collectNodes(edges) {
        const map = new Map();
        const add = n => { if (n && !map.has(n.key)) map.set(n.key, n); };
        edges.forEach(e => { add(e.fromNode); add(e.toNode); });
        if (this._overlay) {
            this._overlay.arcs.forEach(a => {
                const [f, t] = this._arcEnds(a);
                add(f); add(t);
            });
        }
        return [...map.values()].sort((a, b) => a.start - b.start);
    }

    // Ordinal layout: one slot per node, chronological. Open groups get padding so their
    // box fits around them and neighbouring days are pushed aside.
    _layout(nodes) {
        const S = this.slotW;
        const PADD = S * 0.26, PAD12 = S * 0.2, PAD6 = S * 0.14, SEP = S * 0.1;
        const groupsOf = n => {
            const g = [];
            if (n.level !== 'day') g.push({ id: n.dayKey, type: 'day', pad: PADD });
            if (n.level === '6h' || n.level === 'hour') g.push({ id: n.twKey, type: '12h', pad: PAD12 });
            if (n.level === 'hour') g.push({ id: n.sixKey, type: '6h', pad: PAD6 });
            return g;
        };
        const sumPad = arr => arr.reduce((s, x) => s + x.pad, 0);

        let cursor = this.margin.left;
        let prevGroups = [];
        nodes.forEach((n, i) => {
            const g = groupsOf(n);
            const closing = prevGroups.filter(p => !g.some(q => q.id === p.id));
            const opening = g.filter(q => !prevGroups.some(p => p.id === q.id));
            if (i === 0) cursor += sumPad(opening);
            else if (closing.length || opening.length) cursor += SEP + sumPad(closing) + sumPad(opening);
            n.idx = i;
            n.left = cursor;
            n.right = cursor + this._slotWidthOf(n.level);
            n.bx = (n.left + n.right) / 2;
            cursor = n.right;
            prevGroups = g;
        });
        this.contentW = nodes.length ? cursor + sumPad(prevGroups) + this.margin.right : this.svgW;

        // Boxes around open groups: day > 12h > 6h
        const boxMap = new Map();
        nodes.forEach(n => groupsOf(n).forEach(g => {
            let b = boxMap.get(g.id);
            if (!b) {
                const sixH = Math.floor(n.H / 6) * 6, twH = Math.floor(n.H / 12) * 12;
                b = {
                    id: g.id, type: g.type, pad: g.pad, dayKey: n.dayKey, twKey: n.twKey,
                    label: g.type === 'day' ? `${n.d} ${EF_MONTHS[n.mo]}`
                         : g.type === '12h' ? `${efP2(twH)}–${efP2(twH + 12)}`
                         : `${efP2(sixH)}–${efP2(sixH + 6)}`,
                    parity: Math.floor(Date.UTC(n.y, n.mo, n.d) / EF_DAY_MS) % 2,
                    lo: Infinity, hi: -Infinity
                };
                boxMap.set(g.id, b);
            }
            b.lo = Math.min(b.lo, n.left);
            b.hi = Math.max(b.hi, n.right);
        }));
        const boxes = [...boxMap.values()];
        boxes.filter(b => b.type === '6h').forEach(b => { b.x0 = b.lo - b.pad; b.x1 = b.hi + b.pad; });
        boxes.filter(b => b.type === '12h').forEach(b => {
            let lo = b.lo, hi = b.hi;
            boxes.forEach(s => {
                if (s.type === '6h' && s.twKey === b.id) { lo = Math.min(lo, s.x0); hi = Math.max(hi, s.x1); }
            });
            b.x0 = lo - b.pad; b.x1 = hi + b.pad;
        });
        boxes.filter(b => b.type === 'day').forEach(b => {
            let lo = b.lo, hi = b.hi;
            boxes.forEach(s => {
                if ((s.type === '6h' || s.type === '12h') && s.dayKey === b.dayKey) { lo = Math.min(lo, s.x0); hi = Math.max(hi, s.x1); }
            });
            b.x0 = lo - b.pad; b.x1 = hi + b.pad;
        });
        const rank = { day: 0, '12h': 1, '6h': 2 };
        this.boxes = boxes.sort((a, b) => a.type === b.type ? a.x0 - b.x0 : rank[a.type] - rank[b.type]);
    }
    // Recompute graph + layout, optionally keep an anchor in place on screen, then draw.
    _refresh(animate, anchor) {
        this._computeGraph();
        this._updateZoomExtent();
        if (anchor && anchor.reset) {
            this.zoomT = d3.zoomIdentity;
                    } else if (anchor && anchor.focusMs != null) {
            let nn = this.visibleNodes.find(n => n.start <= anchor.focusMs && anchor.focusMs < n.end);
            if (!nn && this.visibleNodes.length) {
                nn = this.visibleNodes.reduce((a, b) =>
                    Math.abs((b.start + b.end) / 2 - anchor.focusMs) < Math.abs((a.start + a.end) / 2 - anchor.focusMs) ? b : a);
            }
            if (nn) this.zoomT = d3.zoomIdentity.translate(anchor.screenX - nn.bx, this.zoomT.y).scale(this.zoomT.k);
        } else if (anchor && anchor.test) {
            const m = this.visibleNodes.filter(anchor.test);
            if (m.length) {
                const lo = d3.min(m, n => n.left), hi = d3.max(m, n => n.right);
                const k = this.zoomT.k;
                let tx = anchor.screenX - k * ((lo + hi) / 2);
                const L = this.margin.left, R = this.svgW - this.margin.right;
                if (k * hi + tx > R) tx -= (k * hi + tx - R);
                if (k * lo + tx < L) tx = L - k * lo;
                this.zoomT = d3.zoomIdentity.translate(tx, this.zoomT.y).scale(k);
            }
        }
        this._syncZoom();
        this._draw(animate);
    }

    // Public entry used by the sidebar (slider / filters). First argument kept for old callers.
    update(k, animate = false) {
        this._refresh(!!animate);
    }

    // ════════════════════════════════════════════════════════════════
    //  DRAWING
    // ════════════════════════════════════════════════════════════════
    _draw(animate) {
        const ms = animate ? this.ANIM_MS : 0;
        const px = bx => this.zoomT.applyX(bx);
        const nodes = this.visibleNodes, edges = this.visibleEdges;
        nodes.forEach(n => { n.px = px(n.bx); });
                this._classifyEdges(edges);
        const vis = edges.filter(e => !isNaN(e._x1));
        
                this._renderArcLayer("day-arcs", vis.filter(e => !e.isSingle), 0.85, ms);
        this._renderArcLayer("hour-arcs", vis.filter(e => e.isSingle), 0.85, ms);
        this._renderBoxes(ms);
        this._renderNodes(nodes, ms);
        this._renderOverlay(ms);
        this._updateFocusChip();
        this._renderOverview();
                        this._drawLegend();

                       const lv = ['day', '12h', '6h', 'hour'].filter(k => nodes.some(n => n.level === k));
const NAMES = { day: '24-hour', '12h': '12-hour', '6h': '6-hour', hour: '1-hour' };
        const windows = lv.length === 1 ? `${NAMES[lv[0]]} windows` : 'mixed windows';
               this.hintBar.html(
            `${this.singleMode ? 'Single TX Output View' : 'TAF-Graph View'}` +
            `<span style="font-size:12px;color:#555;margin-left:8px">· ${windows}</span>`);
                this.resetBtn.style("display", (this.expanded.size || this.overrides.size || this.autoLevel) ? null : "none");
        this._fitTitle();
        if (this._lastSingleMode !== this.singleMode) {
            this._lastSingleMode = this.singleMode;
            if (this.onModeChange) this.onModeChange(this.singleMode);
        }
                    this._nodePx = new Map(nodes.map(n => [n.key, n.px]));
    }


        // Edges that stay inside one open day (dashed or solid box) hang BELOW the axis, under their
    // box. All other edges go to whichever side gives fewer crossings. Two arcs on the same side
    // cross only when they partly overlap (a < c < b < d), so choosing the side is what matters.
    _assignSides(edges) {
        const sameDay = e => e.fromNode.dayKey === e.toNode.dayKey;
        const info = edges.map(e => {
            const a = e.fromNode.idx, b = e.toNode.idx;
            return { e, lo: Math.min(a, b), hi: Math.max(a, b) };
        });
        if (edges.length > 4000) {   // too many for exact counting: simple fallback
            info.forEach(p => { p.e._side = sameDay(p.e) ? -1 : (((p.lo + p.hi) % 2) ? 1 : -1); });
            return;
        }
        const placed = { '1': new Set(), '-1': new Set() };
        const crosses = (p, q) => (p.lo < q.lo && q.lo < p.hi && p.hi < q.hi) ||
                                  (q.lo < p.lo && p.lo < q.hi && q.hi < p.hi);
        const countOn = (side, p) => {
            let c = 0;
            for (const q of placed[side]) if (q !== p && crosses(p, q)) c++;
            return c;
        };
                const parallelOn = (side, p) => {     // arcs between exactly the same two nodes
            let c = 0;
            for (const q of placed[side]) if (q !== p && q.lo === p.lo && q.hi === p.hi) c++;
            return c;
        };
        info.filter(p => sameDay(p.e)).forEach(p => { p.e._side = -1; placed['-1'].add(p); });
        const far = info.filter(p => !sameDay(p.e));
        far.sort((x, y) => (x.hi - x.lo) - (y.hi - y.lo))        // short arcs first: most constrained
            .forEach(p => {
                const t = countOn(1, p), b = countOn(-1, p);
                const side = t !== b ? (t < b ? 1 : -1) : (parallelOn(1, p) <= parallelOn(-1, p) ? 1 : -1);                p.e._side = side;
                placed[String(side)].add(p);
            });
        // Improvement passes: move an edge to the other side whenever that removes crossings.
        for (let pass = 0; pass < 4; pass++) {
            let moved = 0;
            far.forEach(p => {
                const cur = p.e._side, other = -cur;
                if (countOn(other, p) < countOn(cur, p)) {
                    placed[String(cur)].delete(p);
                    placed[String(other)].add(p);
                    p.e._side = other;
                    moved++;
                }
            });
            if (!moved) break;
        }
    }

    // Height grows with span (a longer arc is always taller than any arc it contains), so nested
    // arcs do not cross. Exponent 0.7 keeps short arcs readable and long arcs inside the view.
    _heightForSpan(span) {
        const maxH = this._halfH, GAMMA = 0.7, FLOOR = 14;
        return Math.max(FLOOR, maxH * Math.pow(Math.min(1, span / (this._smax || 1)), GAMMA));
    }




        // Lane assignment. Arcs on one side are processed short -> long inside three zones
    // (0 = inside a 6h box, 1 = inside a day box, 2 = everything else). Each arc sits
    // above every arc nested under it ("skyline"), so nested arcs never cross and a short
    // arc is NOT pushed up by arcs elsewhere. Parallel edges (same two nodes) form a fan.
    _assignHeights(edges, nodes) {
        this._arcHeightMap = new Map();
        const maxH = this._halfH;
               const FOCUS = !!this._focusKey;
        // Long edges hidden -> the freed height goes to the remaining edges.
        const ROOMY = !FOCUS && this._longMode === 'hide';
        const ASPECT = ROOMY ? 0.6 : 0.45, GAP = FOCUS ? 8 : ROOMY ? 6 : 4, FLOOR = 14, LOCAL_FLOOR = 8;
        const CAP = FOCUS ? [40, 50, 60] : ROOMY ? [30, 40, 50] : [22, 28, 34];
                        const smax = this._smax || 1;
        const nGaps = Math.max(1, nodes.length);

        [1, -1].forEach(side => {
            const groups = new Map();
            edges.forEach(e => {
                if ((e._side || 1) !== side) return;
                const k = e.fromNode.idx + '>' + e.toNode.idx;
                let g = groups.get(k);
                if (!g) { g = { edges: [] }; groups.set(k, g); }
                g.edges.push(e);
            });
            if (!groups.size) return;
            const list = [...groups.values()];

            list.forEach(g => {
                const a = g.edges[0].fromNode, b = g.edges[0].toNode;
                g.lo = Math.min(a.idx, b.idx);
                g.hi = Math.max(a.idx, b.idx);
                g.span = Math.abs(b.bx - a.bx);
                g.zone = (a.sixKey && a.sixKey === b.sixKey) ? 0
                       : (a.twKey && a.twKey === b.twKey) ? 1
                       : (a.dayKey === b.dayKey ? 2 : 3);   // 6h box, 12h box, day box, everything else              
                         g.edges.sort((x, y) => x.btc - y.btc || (x.key < y.key ? -1 : 1)); // biggest = outermost
                const n = g.edges.length;
                g.step = Math.max(1.5, Math.min(FOCUS ? 8 : ROOMY ? 6 : 4, 0.35 * maxH / n));                                g.thick = (n - 1) * g.step;
            });
            list.sort((x, y) => x.zone - y.zone || x.span - y.span || x.lo - y.lo);

            let sky = new Array(nGaps).fill(0);

            [0, 1, 2, 3].forEach(z => {
                                const zs = list.filter(g => g.zone === z);
                if (!zs.length) return;
                const snap = sky.slice();           // skyline before this zone

                // Long arcs: spread lanes evenly over the free height (shortest span lowest).
               
                zs.forEach(g => {
                    let s = 0, s0 = 0;
                    for (let i = g.lo; i < g.hi; i++) {
                        if (sky[i] > s) s = sky[i];
                        if (snap[i] > s0) s0 = snap[i];
                    }
                    const base = z < 3
                        ? Math.min(CAP[z], Math.max(LOCAL_FLOOR, ASPECT * g.span))
                        : Math.max(FLOOR, Math.min(maxH * Math.pow(Math.min(1, g.span / smax), 0.7), ASPECT * g.span));
                                                                    g.s0 = s0;
                    g.h0 = Math.max(base, s > 0 ? s + GAP : 0);
                    for (let i = g.lo; i < g.hi; i++) sky[i] = g.h0 + g.thick;
                });

                // If the zone got too tall, squeeze it (only the part above what is beneath it).
                let limit = maxH;
                                if (z < 3) {
                    const HARD = FOCUS ? [80, 95, 110] : ROOMY ? [0.4 * maxH, 0.55 * maxH, 0.8 * maxH] : [56, 70, 84];
                                        const need = d3.max(zs, g => g.h0 + g.thick) || 0;
                    limit = Math.min(HARD[z], Math.max(CAP[z], need));   // grows with the number of edges
                }
                                let k = 1;
                zs.forEach(g => {
                    const t = g.h0 + g.thick;
                    if (t > limit) k = Math.min(k, Math.max(0.15, (limit - g.s0) / (t - g.s0)));
                });
                if (k < 1) {
                    sky = snap;
                    zs.forEach(g => {
                        g.h0 = g.s0 + (g.h0 - g.s0) * k;
                        g.thick *= k;
                        g.step *= k;
                        for (let i = g.lo; i < g.hi; i++) sky[i] = Math.max(sky[i], g.h0 + g.thick);
                    });
                }
            });

                       list.forEach(g => g.edges.forEach((e, i) => {
                e._fan = i;
                e._h0 = g.h0;
                e._step = g.step;
                this._arcHeightMap.set(e.key, g.h0 + i * g.step);
            }));
        });
    }

    // Attach points on a node. Order left -> right: incoming (near first, far last), then
    // outgoing (far first, near last). That keeps nested arcs from crossing at the node.
    _assignPorts(edges) {
        const R = this.NODE_R, BIG = 1e6;
        const ends = new Map();
        const add = (node, side, item) => {
            const k = node.key + '|' + side;
            let a = ends.get(k);
            if (!a) { a = []; ends.set(k, a); }
            a.push(item);
        };
        edges.forEach(e => {
            e._pf = 0; e._pt = 0;
            const side = e._side || 1;
            const d = Math.abs(e.toNode.idx - e.fromNode.idx);
            const fan = e._fan || 0;
            add(e.fromNode, side, { e, out: true, k: BIG - d, fan });
            add(e.toNode, side, { e, out: false, k: d, fan });
        });
        const FOCUS = !!this._focusKey;
        const spread = FOCUS ? Math.min(this.slotW * 0.5, 30) : R * 1.6;
                ends.forEach(arr => {
            arr.sort((a, b) => a.k - b.k || (a.out ? b.fan - a.fan : a.fan - b.fan));
            const m = arr.length;
            const step = m > 1 ? Math.min(FOCUS ? 4 : 2.2, spread / (m - 1)) : 0;
                        arr.forEach((p, i) => { p.e[p.out ? '_pf' : '_pt'] = (i - (m - 1) / 2) * step; });
        });
    }
    

  
           // Marks each edge visible or not. Edges with both ends off screen are skipped (_x1 = NaN).
    _classifyEdges(edges) {
        edges.forEach(e => {
            const v = this._virtualEnds(e.fromNode.px, e.toNode.px);
            e._x1 = v ? v[0] : NaN;
            e._x2 = v ? v[1] : NaN;
        });
    }

   

 

    _nodeLabelShort(n) {
        if (!n) return '—';
        const dd = `${n.d} ${EF_MONTHS[n.mo]}`;
        if (n.level === 'day') return dd;
        if (n.level === '12h') return `${dd} ${efP2(n.H)}–${efP2(n.H + 12)}h`;
        if (n.level === '6h') return `${dd} ${efP2(n.H)}–${efP2(n.H + 6)}h`;
        return `${dd} ${efP2(n.H)}:00`;
    }

// ── Long edges: show or hide ──
    _setLongMode(mode, slots) {
        if (mode) this._longMode = mode;
        if (slots) this._longSlots = slots;
        this._dropSelectionState();
        if (this.tip) this.tip.style("opacity", 0);
        this._refresh(true);
    }
        // ── Overview strip ──
    _buildOverview() {
        const self = this;
        this.overviewDiv = this.container.append("div")
            .attr("class", "ef-overview")
            .style("position", "absolute").style("top", "34px").style("left", "16px").style("right", "16px")
            .style("height", "24px").style("z-index", "5").style("background", "#f8fafc")
            .style("border", "1px solid var(--border)").style("border-radius", "5px")
            .style("cursor", "pointer").style("overflow", "hidden");
        this.overviewSvg = this.overviewDiv.append("svg")
            .attr("width", "100%").attr("height", 24).style("display", "block");
        this.ovSeg = this.overviewSvg.append("g");
        this.ovView = this.overviewSvg.append("rect")
            .attr("y", 0).attr("height", 24).attr("rx", 3)
            .attr("fill", "rgba(247,147,26,0.18)").attr("stroke", "#F7931A").attr("stroke-width", 1.5);
        this.overviewSvg.call(d3.drag().on("start drag", event => self._overviewSeek(event.x)));
    }

    _renderOverview() {
        if (!this.overviewSvg) return;
        const W = this.overviewSvg.node().getBoundingClientRect().width || (this.svgW - 34);
        const total = Math.max(this.contentW, this.svgW);
        const sc = W / total;
        this._ovScale = sc; this._ovTotal = total;

        const m = new Map();
        this.visibleNodes.forEach(n => {
            let s = m.get(n.dayKey);
            if (!s) { s = { key: n.dayKey, d: n.d, mo: n.mo, x0: Infinity, x1: -Infinity, flows: 0 }; m.set(n.dayKey, s); }
            s.x0 = Math.min(s.x0, n.left); s.x1 = Math.max(s.x1, n.right); s.flows += n.flows || 0;
        });
        const segs = [...m.values()];
        segs.forEach((s, i) => { s.i = i; if (i < segs.length - 1) s.x1 = segs[i + 1].x0; });
        const maxF = d3.max(segs, s => s.flows) || 1;
              // Label a day only if there is room after the previous label
        let lastLabelEnd = -Infinity;
        const labelled = segs.filter(s => {
            const x = s.x0 * sc + 3;
            if (x < lastLabelEnd) return false;
            lastLabelEnd = x + 38;
            return true;
        });

        const rects = this.ovSeg.selectAll("rect.ov-bg").data(segs, d => d.key);
        rects.exit().remove();
        rects.enter().append("rect").attr("class", "ov-bg").merge(rects)
            .attr("x", d => d.x0 * sc).attr("width", d => Math.max(1, (d.x1 - d.x0) * sc))
            .attr("y", 0).attr("height", 24)
.attr("fill", "rgba(100,116,139,0.07)").attr("stroke", "#ffffff").attr("stroke-width", 1);
       

// amber tick on the days where a suspicious chain starts
        const susDays = new Map();
const openChain = this._overlay && this._overlay.kind === 'peel' && this._suspectSel ? this._suspectSel : null;
        if (openChain) {      // a chain is open: tick every day it passes through
            openChain.runArcs.forEach(a => [a.time_from, a.time_to].forEach(t => {
                const k = this._dayKeyOf(t);
                susDays.set(k, (susDays.get(k) || 0) + 1);
            }));
        } else if (this._suspectView) this._suspectView.forEach(s => {
                            const k = this._dayKeyOf(s.startArc.time_from);
            susDays.set(k, (susDays.get(k) || 0) + 1);
        });
        const sus = this.ovSeg.selectAll("rect.ov-sus").data(segs.filter(s => susDays.has(s.key)), d => d.key);
        sus.exit().remove();
        sus.enter().append("rect").attr("class", "ov-sus").attr("fill", "#F59E0B")
            .attr("pointer-events", "none").merge(sus)
            .attr("x", d => d.x0 * sc + 1).attr("width", d => Math.max(3, (d.x1 - d.x0) * sc - 2))
.attr("y", 18).attr("height", 5);
        const labs = this.ovSeg.selectAll("text.ov-lbl").data(labelled, d => d.key);
                labs.exit().remove();
        labs.enter().append("text").attr("class", "ov-lbl")
.attr("font-size", 9).attr("font-weight", 600).attr("fill", "#475569").attr("pointer-events", "none").attr("y", 14)
            .merge(labs).attr("x", d => d.x0 * sc + 3).text(d => `${d.d} ${EF_MONTHS[d.mo]}`);

        const k = this.zoomT.k || 1;
        const vx0 = Math.max(0, -this.zoomT.x / k), vx1 = Math.min(total, (this.svgW - this.zoomT.x) / k);
        this.ovView.attr("x", vx0 * sc).attr("width", Math.max(4, (vx1 - vx0) * sc));
    }

    // Centre the main view on the layout position under the pointer.
    _overviewSeek(px) {
        const sc = this._ovScale || 1, total = this._ovTotal || this.svgW, k = this.zoomT.k || 1;
        let tx = this.svgW / 2 - k * (px / sc);
        tx = Math.min(0, Math.max(this.svgW - total * k, tx));
        this.svgEl.call(this.zoom.transform, d3.zoomIdentity.translate(tx, this.zoomT.y).scale(k));
    }

    // Marks each edge with its length in windows and whether it counts as long.
    // In "hidden" mode long edges are removed (not while a node is focused, and never
    // for edges that match a searched address). Nodes remember how many they lost.
    _applyLongEdges(edges, nodes) {
        const L = this._longSlots;
        nodes.forEach(n => { n._hid = 0; });
        edges.forEach(e => {
            e._dist = Math.abs(e.toNode.idx - e.fromNode.idx);
            e._long = e._dist > L && e.fromNode.dayKey !== e.toNode.dayKey;
        });
        if (this._focusKey || this._longMode !== 'hide') return edges;
        // A highlighted chain / candidate keeps all its own edges, even long ones.
        const ovKeys = new Set(this._overlay ? this._overlay.arcs.map(a => a.key) : []);
        const keep = [];
        edges.forEach(e => {
            if (!e._long || ovKeys.has(e.key) || this._getArcHlColor(e)) keep.push(e);
            else { e.fromNode._hid++; e.toNode._hid++; }
        });
        return keep;
    }
        // ── Focus mode ──
    _focusOnNode(node) {
        if (!node) return;
        if (this._focusKey === node.key) { this._clearFocus(); return; }
        this._dropSelectionState();
        if (this.tip) this.tip.style("opacity", 0);
        this._focusKey = node.key;
        this._refresh(true);
    }

    _clearFocus() {
        if (!this._focusKey) return;
        this._focusKey = null;
        if (this.tip) this.tip.style("opacity", 0);
        this._refresh(true);
    }

    _updateFocusChip() {
        if (!this.focusChip) return;
        const fn = this._focusKey ? this._nodeCache.get(this._focusKey) : null;
        if (!fn) { this.focusChip.style("display", "none"); return; }
        const n = this.visibleEdges.length;
        this.focusChip.style("display", null)
            .text(`Focus: ${this._nodeLabelShort(fn)} · ${n} edge${n === 1 ? '' : 's'} · click to exit`);
    }
        // Monotone squash of off-screen x: keeps the order of far nodes, never goes much past the edge.
    _squashX(x) {
        const W = this.svgW, C = Math.max(120, W * 0.3);
        if (x > W) return W + C * (1 - Math.exp(-(x - W) / C));
        if (x < 0) return -C * (1 - Math.exp(x / C));
        return x;
    }
        // Semi-elliptical arc with port offsets. Off-screen edges become flat stubs.
    _edgePath(d, fromPx, toPx) {
        const R = this.NODE_R, axisY = this._axisY, side = d._side || 1;
        const MINSPAN = 100;
        let xa = this._squashX(fromPx), xb = this._squashX(toPx);
        const aCut = xa !== fromPx, bCut = xb !== toPx;
        const clipped = aCut || bCut;
        if (clipped && Math.abs(xb - xa) < MINSPAN) {
            const dir = toPx >= fromPx ? 1 : -1;
            if (bCut) xb = xa + dir * MINSPAN; else xa = xb - dir * MINSPAN;
        }
        const o1 = aCut ? 0 : (d._pf || 0), o2 = bCut ? 0 : (d._pt || 0);
        xa += o1; xb += o2;
        const span = Math.abs(xb - xa);

        let h;
        if (clipped && d._h0 != null) {
            // keep lane + fan; only soften heights that would be too tall for the shortened span
            const cap = Math.max(40, 0.9 * span);
            const base = d._h0 <= cap ? d._h0 : cap + (d._h0 - cap) * 0.5;
                                    h = base + (d._fan || 0) * (d._step || 0);
        } else {
            const mapped = this._arcHeightMap && this._arcHeightMap.get(d.key);
            h = mapped != null ? mapped : Math.min(this._heightForSpan(span / (this.zoomT.k || 1)), 0.45 * span);
            if (clipped) h = Math.min(h, Math.max(12, 0.45 * span));
        }

        const dy = o => Math.sqrt(Math.max(0, R * R - o * o));
        const ya = axisY - side * dy(o1), yb = axisY - side * dy(o2);
        const rx = Math.max(1, span / 2);
        const sweep = ((xb > xa) === (side === 1)) ? 1 : 0;
d._apex = [(xa + xb) / 2, (ya + yb) / 2 - side * h];   // top of the arch (used by the hop-count badge)
        return `M${xa},${ya} A${rx},${h} 0 0 ${sweep} ${xb},${yb}`;
        }       
         // Arcs with an end outside the screen are redrawn as arches that reach their full height at the
    // screen edge, instead of long flat lines whose peak is off-screen. Hover an edge to see its real ends.
    _virtualEnds(x1, x2) {
        const W = this.svgW, MIN = 90;
        const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
        if (hi < 0 || lo > W) return null;                       // entirely off-screen
        if (lo >= 0 && hi <= W) return [x1, x2];                 // fully visible: unchanged
        if (lo < 0 && hi > W) return [-30, W + 30];              // passes through the screen
        if (lo < 0) return [Math.min(-hi, hi - MIN), hi];        // comes in from the left
        return [lo, Math.max(2 * W - lo, lo + MIN)];             // leaves to the right
    }

    _arcEnds(arc) {
        if (arc.isAggregated) return [arc.fromNode, arc.toNode];
        return [this._nodeFor(arc.time_from), this._nodeFor(arc.time_to)];
    }

    _renderArcLayer(className, arcs, opacity, ms) {
        const self = this, axisY = this._axisY;
        const scale = className === "day-arcs" ? this.dayColorScale : this.hourColorScale;
        const arcsTop = arcs.filter(a => (a._side || 1) === 1);
        const arcsBot = arcs.filter(a => (a._side || 1) === -1);
        const pathOf = d => self._edgePath(d, d.fromNode.px, d.toNode.px, true);
                const rangeCols = scale.range();
       
        // In focus mode every remaining edge touches the focused node, so it is drawn pink.
        const strokeOf = d => self._getArcHlColor(d) ||
            (self._focusKey && (d.fromNode.key === self._focusKey || d.toNode.key === self._focusKey) ? "#EC4899" : scale(d.btc));

        const baseOp = d => opacity * (0.6 + 0.4 * rangeCols.indexOf(scale(d.btc)) / (rangeCols.length - 1));
                const opOf = d => this.selectedArc ? 0.05 : baseOp(d);
        const nEdges = this.visibleEdges.length;
                       const baseW = nEdges > 250 ? 1.4 : nEdges > 100 ? 1.9 : 2.5;
        const widthOf = d => self._getArcHlColor(d) ? 4 : baseW;
                        const renderGroup = (gVis, gHit, subArcs, subClass) => {
            const selVis = gVis.selectAll(`path.${className}.${subClass}`).data(subArcs, d => d.key);
            if (ms) selVis.exit().transition().duration(ms * 0.6).attr("opacity", 0).remove();
            else selVis.exit().remove();

            const enterVis = selVis.enter().append("path")
                .attr("class", `${className} ${subClass}`)
                .attr("data-key", d => d.key)
                .attr("fill", "none")
                .attr("stroke-linecap", "round")
                .attr("d", pathOf);

            const mergedVis = enterVis.merge(selVis);
            mergedVis
.attr("data-op", baseOp)
                .attr("stroke", strokeOf)
                                .attr("stroke-width", widthOf)
                                                .attr("marker-end", nEdges > 120 ? null : "url(#ef-arrow)");
            if (ms) {
                enterVis.attr("opacity", 0).transition().duration(ms).delay(ms * 0.5).attr("opacity", opOf);
                selVis.transition().duration(ms).attr("d", pathOf).attr("opacity", opOf);
            } else {
                selVis.interrupt();
                selVis.attr("d", pathOf);
                mergedVis.attr("opacity", opOf);
            }

            const selHit = gHit.selectAll(`path.hit-${className}.${subClass}`).data(subArcs, d => d.key);
            selHit.exit().remove();
            const enterHit = selHit.enter().append("path")
                .attr("class", `hit-${className} ${subClass}`)
                .attr("fill", "none")
                .attr("stroke", "transparent")
                .attr("stroke-linecap", "round");
            const mergedHit = enterHit.merge(selHit);

            mergedHit
                .attr("d", pathOf)
                .attr("stroke-width", 18)
                .style("cursor", "pointer")
.style("pointer-events", "stroke");
            const getVisEl = (d) => gVis.select(`path[data-key="${d.key}"]`);

            mergedHit
                .on("mouseenter", function (event, d) {
                    if (self.selectedArc) return;
                    const hoverColor = self._getArcHlColor(d) || "#EC4899";
                    getVisEl(d).attr("stroke", hoverColor).attr("marker-end", "url(#ef-arrow-hl)")
                        .attr("opacity", 1).attr("stroke-width", widthOf(d) + 1.5);
                                            self._showTooltip(event, d);
                })
                .on("mousemove", function (event) {
                    self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
                })
                .on("mouseleave", function (event, d) {
                    if (self.selectedArc) return;
                    getVisEl(d)
                                                .attr("stroke", strokeOf(d))
.attr("marker-end", self.visibleEdges.length > 120 ? null : "url(#ef-arrow)")
                        .attr("opacity", baseOp(d)).attr("stroke-width", widthOf(d));
                                            self.tip.style("opacity", 0);
                })
                .on("click", function (event, d) {
                    event.stopPropagation();
                                       getVisEl(d)
                        .attr("stroke", strokeOf(d))
                        .attr("marker-end", "url(#ef-arrow)");
                    self.tip.style("opacity", 0);

                    const tx = self.txMap ? self.txMap.get(d.hashFrom) : null;
                    const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                    const destAddr = maxOut ? maxOut.addr : (d.addresses[0] ? d.addresses[0].addr : "—");

if (self._overlay && (self._overlay.kind === 'suspects' || self._overlay.kind === 'peel')) return;
                    // Merged (blue) edge: highlight just this edge and list its flows.
                                        if (!d.isSingle) {
                        self._suppressDeselect = true;
                        self.selectedArc = d;
                        self._highlightSingleArc(d);
                        self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
                        return;
                    }

// Single (green) edge: trace the whole chain it belongs to.
                    if (self.selectedArc && !self._overlay) self.selectedArc = null;   // stale selection: ignore it                 
                       if (self.selectedArc) {
                        const currentRoot = d.chainRoot || self.hashToRoot.get(d.hashFrom) || d.hashFrom;
                        const selectedRoot = self.selectedArc.chainRoot || self.hashToRoot.get(self.selectedArc.hashFrom) || self.selectedArc.hashFrom;
                        if (currentRoot === selectedRoot) {
                            self._suppressDeselect = true;
                            self.selectedArc = d;
                            self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                            self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
                        } else {
                            self._clearSelection();
                        }
                        return;
                    }

                    self._suppressDeselect = true;
                    self.selectedArc = d;
                    self._highlightChain(d);
                    self._activeChainIdx = (self._activeChainArcs || []).findIndex(a => a.key === d.key);
                    self._showChainPanel(d.hashFrom, destAddr, d.btc, d, false);
                });
        };

        renderGroup(this.gArcTop, this.gHitTop, arcsTop, "arc-top");
        renderGroup(this.gArcBot, this.gHitBot, arcsBot, "arc-bot");
    }

    _renderNodes(nodes, ms) {
        const self = this, axisY = this._axisY, k = this.zoomT.k;
        const newMap = new Map(nodes.map(n => [n.key, n]));
        const prev = this._nodePx;
        const translate = x => `translate(${x},${axisY})`;
const MIN_LABEL = { day: 34, '12h': 32, '6h': 30, hour: 26 };
        const sel = this.gNode.selectAll("g.ef-node").data(nodes, d => d.key);

        // Nodes that disappear (a group was collapsed) slide into their parent and fade.
        sel.exit().each(function (d) {
            const g = d3.select(this);
            const anc = [d.sixKey, d.twKey, d.dayKey].find(key => key && key !== d.key && newMap.has(key));
            if (ms && anc) g.transition().duration(ms).attr("transform", translate(newMap.get(anc).px)).attr("opacity", 0).remove();
            else if (ms) g.transition().duration(ms * 0.6).attr("opacity", 0).remove();
            else g.remove();
        });

        // New nodes (a node was opened) start at their parent's old position and spread out.
        const enter = sel.enter().append("g")
            .attr("class", "ef-node")
            .attr("opacity", ms ? 0 : 1)
            .attr("transform", d => {
                const anc = [d.sixKey, d.twKey, d.dayKey].find(key => key && key !== d.key && prev.has(key));
                return translate(anc ? prev.get(anc) : d.px);
            });
        
        
        enter.append("circle").attr("class", "ef-dot")
                    .attr("r", this.NODE_R).attr("fill", "#78716c")
            .attr("stroke", "#44403c").attr("stroke-width", 1.2);
        enter.append("text").attr("class", "node-date-label")
            .attr("text-anchor", "middle").attr("font-weight", "700").attr("fill", "#57534e")
            .attr("stroke", "#ffffff").attr("stroke-width", 3).attr("paint-order", "stroke")
            .style("pointer-events", "none");

        const merged = enter.merge(sel);

        merged
            .style("cursor", "pointer")
                        .style("pointer-events", "all");
        merged.select("circle.ef-dot")
                    .attr("fill", d => !this._focusKey ? "#78716c"
                : d.key === this._focusKey ? "#EC4899"
                : (this._focusRel && this._focusRel.has(d.key) ? "#78716c" : "#d6d3d1"))
            .attr("stroke", d => d.key === this._focusKey ? "#9d174d" : "#44403c")
            .attr("stroke-width", d => d.key === this._focusKey ? 2 : 1.2);
        merged.select("text.node-date-label")
                    .attr("y", this.NODE_R + 15)
            .attr("font-size", d => d.level === 'day' ? "10px" : "9px")
            .style("display", d => k * this._slotWidthOf(d.level) >= MIN_LABEL[d.level] ? null : "none")
            .text(d => d.label);

        if (ms) {
            merged.transition().duration(ms).attr("transform", d => translate(d.px)).attr("opacity", 1);
        } else {
            merged.interrupt();
            merged.attr("transform", d => translate(d.px)).attr("opacity", 1);
        }

        merged
            .on("click", function (event, d) {
                event.stopPropagation();
                if (d.level === 'hour' || event.shiftKey) self._focusOnNode(d);
                else self._expandNode(d);
                        })
            .on("mouseenter", function (event, d) {
                if (d.level !== 'hour') d3.select(this).select(".ef-dot").attr("r", self.NODE_R + 2);
                                self._showNodeTip(event, d);
                                self._focusNode(d);
            })
            .on("mousemove", function (event) {
                self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
            })
            .on("mouseleave", function () {
                d3.select(this).select(".ef-dot").attr("r", self.NODE_R);
                self._unfocusNode();
                                self.tip.style("opacity", 0);
            });
    }
    // Hovering a node fades every edge that does not start or end there.
    _focusNode(node) {
        if (this.selectedArc) return;
        const keep = d => d.fromNode === node || d.toNode === node;
        [this.gArcTop, this.gArcBot].forEach(g =>
            g.selectAll("path[data-key]").attr("opacity", d => keep(d) ? 1 : 0.07));
    }

    _unfocusNode() {
        if (this.selectedArc) return;
        [this.gArcTop, this.gArcBot].forEach(g =>
            g.selectAll("path[data-key]").attr("opacity", function () { return this.getAttribute("data-op"); }));
    }
    _renderBoxes(ms) {
        const self = this, axisY = this._axisY;
        const px = bx => this.zoomT.applyX(bx);
        const DIMS = { day: { top: -50, bottom: 46 }, '12h': { top: -38, bottom: 36 }, '6h': { top: -26, bottom: 28 } };
                const data = this.boxes.map(b => ({ ...b, p0: px(b.x0), p1: px(b.x1) }));
        const tint = d => d.parity === 0
            ? { fill: "rgba(100,116,139,0.07)", stroke: "rgba(100,116,139,0.50)", text: "#475569" }
            : { fill: "rgba(168,152,128,0.12)", stroke: "rgba(168,152,128,0.70)", text: "#78624a" };

        // Rectangles
        const sel = this.gBox.selectAll("rect.ef-box").data(data, d => d.id);
        if (ms) sel.exit().transition().duration(ms * 0.6).attr("opacity", 0).remove();
        else sel.exit().remove();
        const enter = sel.enter().append("rect")
            .attr("class", "ef-box").attr("rx", 6)
            .attr("x", d => d.p0).attr("width", d => Math.max(0, d.p1 - d.p0))
            .attr("opacity", ms ? 0 : 1);
        const merged = enter.merge(sel);
        merged
            .attr("y", d => axisY + DIMS[d.type].top)
            .attr("height", d => DIMS[d.type].bottom - DIMS[d.type].top)
            .attr("fill", d => d.type === '6h' ? "rgba(255,255,255,0.7)" : d.type === '12h' ? "rgba(255,255,255,0.45)" : tint(d).fill)
                        .attr("stroke", d => tint(d).stroke)
            .attr("stroke-width", 1)
            .attr("stroke-dasharray", d => d.type === '6h' ? "3,3" : null);
        if (ms) {
            enter.transition().duration(ms).delay(ms * 0.3).attr("opacity", 1);
            sel.transition().duration(ms).attr("x", d => d.p0).attr("width", d => Math.max(0, d.p1 - d.p0)).attr("opacity", 1);
        } else {
            merged.interrupt();
            merged.attr("x", d => d.p0).attr("width", d => Math.max(0, d.p1 - d.p0)).attr("opacity", 1);
        }

        // Clickable labels (collapse)
        const labelData = data.filter(d => d.p1 - d.p0 >= 44);
        const lsel = this.gBoxLabel.selectAll("text.ef-box-label").data(labelData, d => d.id);
        lsel.exit().remove();
        const lenter = lsel.enter().append("text")
            .attr("class", "ef-box-label")
            .attr("font-weight", "700")
            .attr("stroke", "#ffffff").attr("stroke-width", 3).attr("paint-order", "stroke")
            .style("cursor", "pointer");
                       lenter.append("title").text(d => d.type === 'day'
            ? 'Day opened into 12-hour windows — click to close'
            : d.type === '12h'
                ? '12-hour window opened into 6-hour windows — click to close'
                : '6-hour window opened into 1-hour windows — click to close');
        const lmerged = lenter.merge(lsel);
        lmerged
            .attr("x", d => Math.min(Math.max(d.p0 + 6, this.margin.left + 2), Math.max(d.p0 + 6, d.p1 - 40)))
                       .attr("y", d => axisY + (d.type === 'day' ? -40 : d.type === '12h' ? -28 : -16))
            .attr("font-size", d => d.type === '6h' ? "9px" : "10px")
            .attr("fill", d => tint(d).text)
            .text(d => d.label)
            .on("click", function (event, d) {
                event.stopPropagation();
                self._collapseKey(d.id);
            })
            .on("mouseenter", function () { d3.select(this).attr("text-decoration", "underline"); })
            .on("mouseleave", function () { d3.select(this).attr("text-decoration", null); });
    }
    _renderOverlay(ms) {
        const ov = this._overlay;
        this._nodeCache.forEach(n => { n._same = null; });
        if (!ov) {
            this.gChain.selectAll("*").remove();
            this.gChainHit.selectAll("*").remove();
            this._updateWidthChip(null);
            if (this.sparkBtn) this.sparkBtn.style("display", "none");
            return;
        }
        const self = this;
        const pathOf = d => {
            const [f, t] = self._arcEnds(d);
            return self._edgePath(d, f.px, t.px);
        };
        // hops whose two ends fall in the same (collapsed) node cannot be drawn
        const drawArcs = ov.arcs.filter(a => {
            const [f, t] = self._arcEnds(a);
            return f.key !== t.key;
        });
        drawArcs.forEach(pathOf);   // also stores each arc's top point (_apex) for the badges

        // Thickness = BTC, linear over THIS set of edges: smallest = 1.5px, largest = 9px
let lo = 0, hi = 0, widthOf = () => (ov.kind === 'suspects' ? 2.5 : 3.5);
if (ov.kind !== 'single' && ov.kind !== 'suspects' && ov.arcs.length > 1) {
const allHops = (ov.kind === 'chain' || ov.kind === 'peel') ? this._hopsForSpark() : null;
const vals = allHops && allHops.length > 1 ? allHops.map(h => h.btc) : ov.arcs.map(a => a.btc);
            lo = Math.min(...vals); hi = Math.max(...vals);
            if (hi > lo) {
                const ws = d3.scaleLinear().domain([lo, hi]).range([1.5, 9]);
                widthOf = d => ws(d.btc);
            }
        }
const curKey = ov.kind !== 'suspects' ? (this._hopKey || null) : (this._suspectView && this._suspectView[this._suspectCur])
? this._suspectView[this._suspectCur].startArc.key : null;
        const finalW = d => widthOf(d) + (d.key === curKey ? 2.5 : 0);
        this._updateWidthChip(ov.kind !== 'single' && hi > lo ? { lo, hi, color: ov.color } : null);
        if (this.sparkBtn) this.sparkBtn.style("display", (ov.kind === 'chain' || ov.kind === 'peel') ? null : "none");

        // visible edges (no pointer events: hovering is done by the wider invisible paths below)
        const sel = this.gChain.selectAll("path.chain-arc").data(drawArcs, d => d.key);
        sel.exit().remove();
        const enter = sel.enter().append("path")
            .attr("class", "chain-arc")
            .attr("fill", "none")
            .attr("stroke-linecap", "round")
            .attr("opacity", 0)
            .attr("d", pathOf)
            .style("pointer-events", "none");
        enter.transition().duration(300).attr("opacity", 1);
        if (ms) sel.transition().duration(ms).attr("d", pathOf);
        else { sel.interrupt(); sel.attr("d", pathOf).attr("opacity", 1); }
        enter.merge(sel).attr("stroke", ov.color).attr("stroke-width", finalW);

        // invisible 16px hover paths, so even a 1.5px edge is easy to hover
        const hitData = ov.kind === 'single' ? [] : drawArcs;
        const hsel = this.gChainHit.selectAll("path.chain-hit").data(hitData, d => d.key);
        hsel.exit().remove();
        const henter = hsel.enter().append("path")
            .attr("class", "chain-hit")
            .attr("fill", "none")
            .attr("stroke", "transparent")
            .attr("stroke-width", 16)          // <- hover area, change here if needed
            .attr("stroke-linecap", "round")
            .style("cursor", "pointer");
        const visOf = d => self.gChain.selectAll("path.chain-arc").filter(a => a.key === d.key);
        henter.merge(hsel)
            .attr("d", pathOf)
            .on("mouseenter", function (event, d) {
                self.gChain.selectAll("path.chain-arc").attr("opacity", a => a.key === d.key ? 1 : 0.35);
                visOf(d).attr("stroke-width", finalW(d) + 2);
                self._showTooltip(event, d);
            })
            .on("mousemove", function (event) {
                self.tip.style("left", (event.clientX + 15) + "px").style("top", (event.clientY - 15) + "px");
            })
            .on("mouseleave", function (event, d) {
                self.gChain.selectAll("path.chain-arc").attr("opacity", 1);
                visOf(d).attr("stroke-width", finalW(d));
                self.tip.style("opacity", 0);
            })
            .on("click", function (event, d) {
                event.stopPropagation();
                self.tip.style("opacity", 0);
                // clicking the start edge of a suspicious chain shows the whole chain
                if (ov.kind === 'suspects' && self._suspectByKey) {
                    const s = self._suspectByKey.get(d.key);
if (s) self._selectSuspect(s);
                }
            });

        // hop-count badge on each suspicious start edge
const badgeData = ov.kind === 'suspects' && this._suspectByKey && (this._suspectView || []).length <= 25
            ? drawArcs.filter(a => a._apex && this._suspectByKey.has(a.key) &&
                a._apex[0] > this.margin.left && a._apex[0] < this.svgW - this.margin.right)
            : [];
        const bsel = this.gChain.selectAll("g.chain-badge").data(badgeData, d => d.key);
        bsel.exit().remove();
        const benter = bsel.enter().append("g").attr("class", "chain-badge").style("pointer-events", "none");
        benter.append("rect").attr("rx", 7).attr("height", 14).attr("y", -7)
            .attr("fill", "#ffffff").attr("stroke", "#F59E0B").attr("stroke-width", 1);
        benter.append("text").attr("text-anchor", "middle").attr("y", 3)
            .attr("font-size", 9).attr("font-weight", 700).attr("fill", "#92610a");
        const bm = benter.merge(bsel);
const hopsOf = d => { const s = self._suspectByKey.get(d.key); return `#${s.idx + 1} · ${s.cand.length} hops`; };
// keep neighbouring badges from covering each other: push a badge down when it would overlap another
               const placed = [];
        const BOX_TOP = this._axisY - 50 - 14;   // just above the day box
        const BOX_BOT = this._axisY + 46 + 14;   // just below the day box
        badgeData.slice().sort((a, b) => a._apex[0] - b._apex[0]).forEach(d => {
            const w = 10 + 6 * hopsOf(d).length;
            const up = (d._side || 1) === 1;
            let y = up ? Math.min(d._apex[1] - 10, BOX_TOP)
                       : Math.max(d._apex[1] + 10, BOX_BOT);
            let again = true, guard = 0;
            while (again && guard++ < 12) {
                again = false;
                placed.forEach(p => {
                    if (Math.abs(p.x - d._apex[0]) < (p.w + w) / 2 + 3 && Math.abs(p.y - y) < 16) {
                        y = up ? p.y - 16 : p.y + 16; again = true;
                    }
                });
            }
            y = Math.max(this.margin.top + 8, Math.min(this.svgH - 10, y));
            d._by = y;
            placed.push({ x: d._apex[0], y, w });
        });
        bm.attr("transform", d => `translate(${d._apex[0]},${d._by})`);
                bm.select("text").text(hopsOf);
        bm.select("rect").attr("width", d => 10 + 6 * hopsOf(d).length)
            .attr("x", d => -(10 + 6 * hopsOf(d).length) / 2);

        // same-hour hops have no arc: a dashed ring on their node (hover the node for the amounts)
        const visKeys = new Set(this.visibleNodes.map(n => n.key));
        const sameNodes = [];
        if (ov.kind === 'chain' || ov.kind === 'peel') {
            const by = new Map();
            (this._hiddenHops || []).forEach(h => {
                const tx = self.txMap.get(h.hashFrom);
                if (!tx) return;
                const n = self._nodeFor(tx.time);
                if (!by.has(n.key)) { by.set(n.key, n); n._same = []; }
                n._same.push(h);
            });
            by.forEach(n => { if (visKeys.has(n.key)) sameNodes.push(n); });
        }
        const rsel = this.gChain.selectAll("circle.chain-same").data(sameNodes, d => d.key);
        rsel.exit().remove();
        rsel.enter().append("circle").attr("class", "chain-same").attr("fill", "none")
            .attr("stroke-width", 2).attr("stroke-dasharray", "2,2").style("pointer-events", "none")
            .merge(rsel)
            .attr("cx", d => d.px).attr("cy", this._axisY)
            .attr("r", this.NODE_R + 4).attr("stroke", ov.color);
    }
    _drawLegend() {
        this.svgEl.selectAll(".ef-legend").remove();
        const slot = d3.select("#ef-amount-slot");
        if (slot.empty()) return;
        const edges = this.visibleEdges;
        if (!edges.length) { slot.html(''); this._legendKey = null; return; }
        const hasAgg = edges.some(e => !e.isSingle);
        const hasSingle = edges.some(e => e.isSingle);
        const wc = this._wcInfo;

        // only rewrite when something changed (this runs on every pan frame)
        const key = wc ? `t|${wc.lo}|${wc.hi}|${wc.color}` : `s|${hasAgg}|${hasSingle}`;
        if (this._legendKey === key) return;
        this._legendKey = key;

        const bEdges = this.dayColorScale.bucketEdges;
        const blue = this.dayColorScale.range();
        const teal = this.hourColorScale.range();
        const fmtB = v => {
            if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
            if (v >= 1) return v.toFixed(v >= 100 ? 0 : 1);
            return v.toFixed(v >= 0.01 ? 2 : 4);
        };

        // a chain is open: thickness explains the amounts
        if (wc) {
            const sw = px => `<span style="display:inline-block;width:18px;height:0;border-top:${px}px solid ${wc.color};vertical-align:middle;margin:0 4px"></span>`;
            slot.html(`
                <b style="color:#555">Thickness = BTC</b>
                <span style="color:#999">(this chain)</span>
                <span style="color:#555">${sw(1.5)}${fmtB(wc.lo)} ₿ → ${sw(8)}${fmtB(wc.hi)} ₿</span>`);
            return;
        }

        // otherwise: shade explains the amounts (each colour with its own range)
        const fmtR = v => v >= 100 ? Math.round(v).toLocaleString('en-US') : fmtB(v);
        const swatches = blue.map((c, i) => {
            const lo = bEdges[i], hi = bEdges[i + 1];
            const bg = (hasAgg && hasSingle) ? `linear-gradient(135deg, ${c} 50%, ${teal[i]} 50%)`
                : (hasSingle ? teal[i] : c);
            const label = i === blue.length - 1 ? `>${fmtR(lo)}` : `${fmtR(lo)}–${fmtR(hi)}`;
            return `<span title="${fmtR(lo)} to ${i === blue.length - 1 ? '∞' : fmtR(hi)} BTC" style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap"><span style="width:10px;height:10px;border-radius:2px;background:${bg};display:inline-block"></span>${label}</span>`;
        }).join('');
        slot.html(`
            <b style="color:#555">Shade = BTC</b>
            <span style="display:inline-flex;gap:10px;flex-wrap:wrap">${swatches}</span>
            <span style="color:#999">₿ · log scale</span>`);
    }
    // ════════════════════════════════════════════════════════════════
    //  EXPAND / COLLAPSE / SELECTION
    // ════════════════════════════════════════════════════════════════
    _dropSelectionState() {
        this.selectedArc = null;
        this._overlay = null;
        this._activeChainArcs = [];
        this._activeChainIdx = -1;
                this._preOverlayState = null;
this.gHitTop.style("pointer-events", null);
this._suspects = null; this._suspectByKey = null; this._suspectCur = -1; this._hiddenHops = null;
        this._suspectView = null; this._suspectSel = null;
if (this.suspectChip) this._updateSuspectChip();
this._hopKey = null; this._hopsOpen = false;
this._hopsWide = false;
this._renderSparkPanel();

                this.gChain.selectAll("*").remove();
        if (this.gChainHit) this.gChainHit.selectAll("*").remove();
                this.gHitBot.style("pointer-events", null);
    }

// True while a pink chain or an amber peeling candidate is highlighted
    _chainOverlayActive() {
        return !!(this._overlay && this._overlay.kind !== 'single');
    }

    _clearSelection() {
                const saved = this._preOverlayState;
        this._dropSelectionState();
        if (saved) {
            this.overrides = saved.overrides;
            this._applyAutoLevel(saved.autoLevel);
            this.zoomT = saved.zoomT;
        }
        this._refresh(true);
    }

    _expandNode(node) {
        if (!node || node.level === 'hour') return;
        const screenX = this.zoomT.applyX(node.bx);
        if (!this._overlay) this._dropSelectionState();
        if (this.tip) this.tip.style("opacity", 0);
        let test;
        if (node.level === 'day') { this.overrides.set(node.dayKey, true); test = n => n.dayKey === node.dayKey; }
        else if (node.level === '12h') { this.overrides.set(node.twKey, true); test = n => n.twKey === node.twKey; }
        else { this.overrides.set(node.sixKey, true); test = n => n.sixKey === node.sixKey; }
        this._applyAutoLevel(this.autoLevel);
        this._refresh(true, { screenX, test });
    }
    _collapseKey(key) {
        const box = this.boxes.find(b => b.id === key);
                      const screenX = box ? this.zoomT.applyX((box.x0 + box.x1) / 2) : this.svgW / 2;
        if (!this._overlay) this._dropSelectionState();
        if (this.tip) this.tip.style("opacity", 0);
                this.overrides.set(key, false);
        [...this.overrides.keys()].forEach(k => { if (k.startsWith(key + '|')) this.overrides.delete(k); });
        // a 12-hour box also owns its two 6-hour windows
        const m12 = /^(.+)\|12h(\d\d)$/.exec(key);
        if (m12) [+m12[2], +m12[2] + 6].forEach(h => this.overrides.delete(`${m12[1]}|6h${efP2(h)}`));
                this._applyAutoLevel(this.autoLevel);
        this._refresh(true, { screenX, test: n => n.key === key });
    }

    _collapseAll() {
        this._focusKey = null;
                this._dropSelectionState();
                this.overrides.clear();
        this._applyAutoLevel(0);
        this._refresh(true, { reset: true });
    }

    // Open every day / 6-hour window that contains an end of the given single flows,
    // so those flows can be drawn as individual TX outputs between hour nodes.
    _expandToHours(arcs) {
        arcs.forEach(a => [a.time_from, a.time_to].forEach(t => {
            const dk = this._dayKeyOf(t);
            this.overrides.set(dk, true);
            this.overrides.set(`${dk}|12h${efP2(Math.floor(t.getUTCHours() / 12) * 12)}`, true);
            this.overrides.set(`${dk}|6h${efP2(Math.floor(t.getUTCHours() / 6) * 6)}`, true);
        }));
        this._applyAutoLevel(this.autoLevel);
    }

    _setOverlay(ov) {
                const flowArcs = ov.arcs.filter(a => !a.isAggregated);
        // Remember the view the user came from, so closing the highlight returns to it.
        if (flowArcs.length && !this._preOverlayState) {
            this._preOverlayState = { overrides: new Map(this.overrides), autoLevel: this.autoLevel, zoomT: this.zoomT };
        }
        this._overlay = ov;
        this.gHitTop.style("pointer-events", "none");
        this.gHitBot.style("pointer-events", "none");
        if (flowArcs.length) this._expandToHours(flowArcs);
        this._refresh(true);
if (!ov.keepView) this._centerOnArc(ov.focusArc || ov.arcs[0]);
        this._renderSparkPanel();
        }
        // Chains are built from single address links, so before detection the whole view switches to
    // the 1-hour single TX output (green) view. The notice explains it and offers a way back.
    prepareSingleView() {
        if (this.singleMode) return false;
        const saved = { overrides: new Map(this.overrides), autoLevel: this.autoLevel, zoomT: this.zoomT };
        this._dropSelectionState();
        this.overrides.clear();
        this._applyAutoLevel(3);
        this._refresh(true, { reset: true });
        this._showViewNotice(
            'Chains are built from single address links, so the view switched to 1-hour single TX outputs (green).',
            () => {
                this.overrides = saved.overrides;
                this._applyAutoLevel(saved.autoLevel);
                this.zoomT = saved.zoomT;
                this._dropSelectionState();
                this._refresh(true);
            });
        return true;
    }

    _showViewNotice(text, onBack) {
        this.container.selectAll(".ef-notice").remove();
        const box = this.container.append("div").attr("class", "ef-notice")
            .style("position", "absolute").style("top", "66px").style("left", "16px").style("z-index", "7")
            .style("max-width", "600px").style("display", "flex").style("align-items", "center").style("gap", "10px")
            .style("background", "#FFFBEB").style("border", "1px solid #F59E0B").style("border-radius", "6px")
            .style("padding", "6px 10px").style("font-size", "11px").style("color", "#78510a");
        box.append("span").text(text);
        const btn = (label, fn) => box.append("button").text(label)
            .style("background", "transparent").style("border", "1px solid #F59E0B").style("color", "#78510a")
            .style("border-radius", "4px").style("padding", "2px 8px").style("font-size", "10px")
            .style("cursor", "pointer").style("white-space", "nowrap")
            .on("click", () => { box.remove(); if (fn) fn(); });
        if (onBack) btn("Back to previous view", onBack);
        btn("✕", null);
        setTimeout(() => box.remove(), 20000);
    }
        _highlightChain(arc) {
        if (!arc) { this._clearSelection(); return; }
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

        const chainArcs = this.levels.hour.filter(a => {
            if (!chainIdx.has(a.hashFrom) || !chainIdx.has(a.hashTo)) return false;
            return chainIdx.get(a.hashTo) === chainIdx.get(a.hashFrom) + 1;
        }).sort((a, b) => chainIdx.get(a.hashFrom) - chainIdx.get(b.hashFrom));

        // If the clicked flow is a side branch that is not part of the main chain, show it alone.
const onMain = chainArcs.some(a => a.key === arc.key);   // is the clicked edge really part of the main chain?
const arcs = onMain ? chainArcs : [arc];                 // a side branch is shown alone
         this._activeChainArcs = arcs;
        this._chainTrueTotal = chain.length;

        // every link of the chain (for "Amount per hop") and the ones with no arc (inside one hour)
        const chainHops = [];
        for (let i = 0; i < chain.length - 1; i++) {
            const nx = this.nextHopMap.get(chain[i]);
            if (nx && nx.spendHash === chain[i + 1])
chainHops.push({ n: chainHops.length + 1, hashFrom: chain[i], hashTo: chain[i + 1], btc: nx.btc, addr: nx.addr });        }
this._chainHops = onMain ? chainHops : [];
        this._hiddenHops = onMain
            ? chainHops.filter(h => !this.hourArcByKey.has(`${h.hashFrom}|${h.hashTo}|${h.addr}`)) : [];
        this._overlayHidden = this._hiddenHops.length;

        this._setOverlay({ kind: 'chain', color: '#EC4899', arcs });
    }

       _highlightPeelCandidate(candidate) {            // used by the list panel
        const s = (this._suspects || []).find(x => x.cand === candidate);
        if (!s) return;
        // a chain that is not among the shown ones: show all so it becomes part of the view
        if (this._suspectLimit && !(this._suspectView || []).includes(s)) {
            this._suspectLimit = 0;
            this._showSuspectMarks(false);
        }
        this._selectSuspect(s);
    }

    // Detect button: mark the FIRST edge of the longest suspicious chains.
    _showSuspects(cands) {
        if (this._peelPanel) this._peelPanel.style("display", "none");
        this._dropSelectionState();
        const list = (cands || []).map(c => {
            const runArcs = c.arcs
                .map(h => this.hourArcByKey.get(`${h.hashFrom}|${h.hashTo}|${h.addr}`))
                .filter(Boolean);
            return { cand: c, runArcs, startArc: runArcs[0] || null };
        }).filter(s => s.startArc);            // chains with no drawable edge are left out
        if (!list.length) {
            this._showViewNotice('No suspicious chains found with these settings. Try fewer hops or a lower retain %.', null);
            return;
        }
        list.forEach((s, i) => { s.idx = i; });  // list order = longest first
        this._suspects = list;
        this._suspectByKey = new Map(list.map(s => [s.startArc.key, s]));
        this._peelCandidates = list.map(s => s.cand);
        if (this._suspectLimit === undefined) this._suspectLimit = 10;
        this._suspectCur = -1;
        this._showSuspectMarks(true);
    }

    // The start-edge view: only the first edge of each shown chain, thin and amber.
    _showSuspectMarks(center) {
        if (!this._suspects || !this._suspects.length) return;
        const limit = this._suspectLimit;
        const view = (limit ? this._suspects.slice(0, limit) : this._suspects.slice());
        this._suspectView = view;
        this._suspectSel = null;
        const starts = view.map(s => s.startArc);
        this._hiddenHops = null;
        this._activeChainArcs = starts;
        this.selectedArc = starts[0];
        if (center) this._suspectCur = view.indexOf(this._suspects[0]);   // jump to the longest chain
        this._setOverlay({ kind: 'suspects', color: '#F59E0B', arcs: starts,
            keepView: !center, focusArc: this._suspects[0].startArc });
        this._updateSuspectChip();
    }

    _setSuspectLimit(v) {
        this._suspectLimit = v;
        this._suspectCur = -1;
        this._showSuspectMarks(false);
    }

    // Show the whole suspicious chain (amber, thickness = BTC).
    _selectSuspect(s) {
        if (!s) return;
        const c = s.cand;
        this._suspectSel = s;
        this._suspectCur = (this._suspectView || []).indexOf(s);
        this._sparklineHops = c.arcs;
        this._sparklineIdx = 0;
        this._chainTrueTotal = c.arcs.length;
this._hiddenHops = c.arcs.map((h, i) => ({ ...h, n: i + 1 }))
    .filter(h => !this.hourArcByKey.has(`${h.hashFrom}|${h.hashTo}|${h.addr}`));
            this._overlayHidden = this._hiddenHops.length;
        this._activeChainArcs = s.runArcs;
        this.selectedArc = s.startArc;
        this._setOverlay({ kind: 'peel', color: '#F59E0B', arcs: s.runArcs });
        this._updateSuspectChip();
    }

    // ◀ ▶ in the chip: next / previous shown chain in time
    _stepSuspect(delta) {
        const view = this._suspectView || [];
        const n = view.length;
        if (!n) return;
        let cur = this._suspectCur;
        if (cur < 0) cur = delta > 0 ? -1 : n;
        const next = (cur + delta + n) % n;
        if (this._overlay && this._overlay.kind === 'peel') this._selectSuspect(view[next]);
        else {
            this._suspectCur = next;
            this._centerOnArc(view[next].startArc);
            this._updateSuspectChip();
        }
    }

    _updateSuspectChip() {
        if (!this.suspectChip) return;
        const self = this;
        const total = this._suspects ? this._suspects.length : 0;
        const chip = this.suspectChip;
        chip.selectAll("*").remove();
        if (!total) { chip.style("display", "none"); return; }
        chip.style("display", "flex");
        const n = (this._suspectView || []).length;
        const mk = (label, title, fn) => chip.append("button").text(label).attr("title", title)
            .style("background", "transparent").style("border", "none").style("color", "#92610a")
            .style("cursor", "pointer").style("padding", "0 3px").style("font-size", "11px")
            .on("click", event => { event.stopPropagation(); fn(); });

        chip.append("span").style("font-weight", "700")
            .attr("title", "Chains that match the system's peeling-chain rules")
            .text(`⚠ ${total} suspicious`);
        const sel = chip.append("select").style("font-size", "10px")
            .attr("title", "How many chains are drawn (longest first)")
            .on("change", function () { self._setSuspectLimit(+this.value); });
        [[10, "10 longest"], [25, "25 longest"], [0, "all"]]
            .forEach(([v, t]) => sel.append("option").attr("value", v).text(t));
        sel.property("value", this._suspectLimit || 0);

        mk("◀", "Previous chain", () => self._stepSuspect(-1));
        chip.append("span").attr("title", "Rank: #1 is the longest chain")
            .text(`#${this._suspectCur >= 0 ? this._suspectCur + 1 : '–'} / ${n}`);
        mk("▶", "Next chain", () => self._stepSuspect(1));
        mk("✕", "Clear", () => self._clearSuspects());
    }
 

    _fitTitle() {          // shorten the view title with "…" instead of letting the chip cover it
        if (!this.hintBar) return;
        const bar = this.container.select(".ef-topbar").node();
        const cw = this.container.node().getBoundingClientRect().width;
        const bw = bar ? bar.getBoundingClientRect().width : 0;
        this.hintBar.style("white-space", "nowrap").style("overflow", "hidden")
            .style("text-overflow", "ellipsis").style("max-width", `${Math.max(80, cw - bw - 48)}px`);
    }


    _clearSuspects() {
        if (this._peelPanel) this._peelPanel.style("display", "none");
        if (this.tip) this.tip.style("opacity", 0);
        this._clearSelection();
    }

      _updateWidthChip(info) {          // the legend itself is drawn in _drawLegend (bottom row)
        this._wcInfo = info || null;
    }

    _tooltipSuspect(d) {
        const s = this._suspectByKey && this._suspectByKey.get(d.key);
        if (!s) return '';
        const c = s.cand;
        const f = v => v >= 100 ? v.toFixed(1) : v.toFixed(3);
        const pct = `${c.declinePct >= 0 ? '−' : '+'}${Math.abs(c.declinePct * 100).toFixed(1)}%`;
        const t0 = this.txMap ? this.txMap.get(c.arcs[0].hashFrom) : null;
        const start = t0 ? d3.utcFormat("%d %b %Y, %H:%M UTC")(t0.time) : '';
        return `
            <div style="font-weight:700;color:#F59E0B;margin-bottom:4px">Suspicious chain #${s.idx + 1}</div>
            <div style="font-size:10px;color:#333;margin-bottom:2px">${c.length} hops · ₿ ${f(c.startBtc)} → ₿ ${f(c.endBtc)} (${pct})</div>
            ${start ? `<div style="font-size:10px;color:#555;margin-bottom:2px">Starts ${start}</div>` : ''}
            <div style="font-size:9px;color:#888">Click to show the chain</div>`;
    }
    // Amounts of the hops that have no arc (inside one hour), shown when hovering their node.
    _sameHourHtml(n) {
        if (!n._same || !n._same.length) return '';
        const f = v => v >= 100 ? v.toFixed(1) : v.toFixed(3);
const list = n._same.slice(0, 8).map(h => `hop ${h.n}: ₿ ${f(h.btc)}`).join('<br>');
return `<div style="font-size:10px;color:#92610a;margin-top:4px">${n._same.length} hop${n._same.length === 1 ? '' : 's'} received and spent inside this window (no edge):<br>${list}${n._same.length > 8 ? '<br>…' : ''}</div>`;
    }

    // ── "Amounts per hop": the sparkline, only on request ──
    _hopsForSpark() {
        const k = this._overlay && this._overlay.kind;
        if (k === 'peel') return this._sparklineHops;
        if (k === 'chain') return this._chainHops;
        return null;
    }

    _toggleSparkPanel() { /* the amounts now live in the left panel */ }

    // Left panel (under Heuristics): detected-chains button + amount of every hop of the open chain
    _renderSparkPanel() {
        const hostNode = document.getElementById("ef-hop-panel");
        if (!hostNode) return;
        const oldSt = document.getElementById("ef-side-style");
        if (oldSt) oldSt.remove();
        const st = document.createElement("style");
        st.id = "ef-side-style";
        st.textContent = `
            .ef-side-row { display:flex; align-items:center; justify-content:space-between; gap:8px;
                           margin-top:8px; font-size:11px; font-weight:600; color:#333; }
            .ef-side-row:first-child { margin-top:0; }
            .ef-side-row button { background:#F59E0B; color:#fff; border:none; border-radius:4px;
                           width:76px; padding:4px 0; font-size:10px; font-weight:700; cursor:pointer; }
            .ef-side-hops { margin-top:6px; }
            .ef-side-empty { font-size:10px; color:var(--text-hint); line-height:1.4; }
            .ef-side-note { font-size:9px; color:#999; margin-top:3px; line-height:1.4; }`;
        document.head.appendChild(st);

        const host = d3.select(hostNode);
        const self = this;
        const total = this._suspects ? this._suspects.length : 0;
        const hops = this._hopsForSpark();
        const merged = this._overlay && this._overlay.kind === 'single' ? this._overlay.arcs[0] : null;
        host.html("");
        if (!total && !hops && !merged) { host.style("display", "none"); this._hopsRef = null; return; }
        host.style("display", "block")
            .style("margin", "10px 0 70px").style("padding", "10px 12px")   // 70px bottom: keeps the last line clear of the Apply button
            .style("border", "1px solid var(--border)").style("border-radius", "8px")
            .style("background", "#ffffff").style("box-sizing", "border-box");

        // row 1: all detected chains
        if (total) {
            const row = host.append("div").attr("class", "ef-side-row");
            row.append("span").text(`${total} chains detected`);
            row.append("button").text("View all")
                .attr("title", "Open the list of every detected chain")
                .on("click", () => self._showPeelResults(self._peelCandidates));
           
        }

        // a selected merged (blue) edge: details only on request
        if (merged) {
            const acc = document.getElementById("acc-peel");
            if (acc && !acc.open) acc.open = true;
            const rowM = host.append("div").attr("class", "ef-side-row");
            rowM.append("span").text(`Selected edge · ${merged.count} flow${merged.count === 1 ? '' : 's'}`);
            rowM.append("button").text("Details")
                .attr("title", "List the transactions merged into this edge")
                .on("click", () => self._openMergedDetails());
            return;
        }

        // row 2: amount per hop (opens only when the button is pressed)
        const row2 = host.append("div").attr("class", "ef-side-row");
        row2.append("span").text("Amount per hop");
        row2.append("button").text(this._hopsOpen ? "Hide" : "Show")
            .attr("title", "Amount of every hop of the selected chain")
            .on("click", () => {
                self._hopsOpen = !self._hopsOpen;
                self._renderSparkPanel();
                self._draw(false);
            });
        if (!this._hopsOpen) { this._hopsRef = null; this._hopKey = null; return; }

        const box = host.append("div").attr("class", "ef-side-hops");
        if (!hops || hops.length < 2) {
            box.append("div").attr("class", "ef-side-empty").text("Click a chain on the graph first.");
            this._hopsRef = null;
            return;
        }
        if (this._hopsRef !== hops) { this._hopsRef = hops; this._hopIdx = 0; this._hopKey = null; }
        const col = this._overlay.color;
        const cur = Math.min(this._hopIdx || 0, hops.length - 1);
        const open = this._overlay.kind === 'peel' ? this._suspectSel : null;
        box.append("div").style("font-size", "11px").style("font-weight", "700").style("color", col)
            .style("margin-bottom", "4px")
            .text(open ? `Chain #${open.idx + 1} · ${hops.length} hops` : `Selected chain · ${hops.length} hops`);

        // mini chart: one dot per hop, log scale; at least 6px per hop (scrolls sideways if longer)
        const H = 78, pt = 8, pb = 8, padX = 10;
        const viewW = Math.max(160, Math.floor(hostNode.getBoundingClientRect().width) - 70);
        const innerW = Math.max(viewW, hops.length * 6 + 2 * padX);
        const vals = hops.map(h => h.btc);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const L = v => Math.log(Math.max(v, 1e-6));
        const x = i => padX + (hops.length > 1 ? i / (hops.length - 1) : 0) * (innerW - 2 * padX);
        const y = v => hi === lo ? H / 2 : pt + (1 - (L(v) - L(lo)) / (L(hi) - L(lo))) * (H - pt - pb);
        const fmt = v => v >= 100 ? v.toFixed(0) : v.toFixed(2);
        const spacing = hops.length > 1 ? (innerW - 2 * padX) / (hops.length - 1) : 20;
        const r = Math.max(1.6, Math.min(3.5, spacing * 0.4));

        const rowC = box.append("div").style("display", "flex").style("gap", "4px").style("align-items", "stretch");
        const labels = rowC.append("div").style("width", "38px").style("height", `${H}px`)
            .style("display", "flex").style("flex-direction", "column").style("justify-content", "space-between")
            .style("font-size", "8px").style("color", "#888").style("padding", "2px 0");
        labels.append("span").text(`₿${fmt(hi)}`);
        labels.append("span").text(hi !== lo ? `₿${fmt(lo)}` : "");
        const wrap = rowC.append("div").style("flex", "1").style("min-width", "0")
            .style("overflow-x", innerW > viewW + 1 ? "auto" : "hidden")
            .style("border", "1px solid rgba(0,0,0,0.08)").style("border-radius", "5px").style("background", "#fff");
        const svg = wrap.append("svg").attr("width", innerW).attr("height", H)
            .style("display", "block").style("cursor", "pointer");
        svg.append("polyline").attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.2).attr("opacity", 0.5)
            .attr("points", hops.map((h, i) => `${x(i)},${y(h.btc)}`).join(" "));
        hops.forEach((h, i) => {
            if (i === cur) return;
            svg.append("circle").attr("cx", x(i)).attr("cy", y(h.btc)).attr("r", r).attr("fill", col);
        });
        svg.append("line").attr("x1", x(cur)).attr("x2", x(cur)).attr("y1", pt - 4).attr("y2", H - pb + 4)
            .attr("stroke", col).attr("stroke-dasharray", "2,2").attr("opacity", 0.6);
        svg.append("circle").attr("cx", x(cur)).attr("cy", y(hops[cur].btc)).attr("r", r + 3)
            .attr("fill", "#fff").attr("stroke", col).attr("stroke-width", 2.2);
        const idxAt = mx => Math.max(0, Math.min(hops.length - 1,
            Math.round((mx - padX) / (innerW - 2 * padX) * (hops.length - 1))));

             // ◀ Hop n / N ▶  (hovering the chart shows that hop's amount instead)
        const navBtn = "background:#fff;border:1px solid var(--border);border-radius:4px;padding:1px 9px;cursor:pointer;font-size:10px";
        const nav = box.append("div").style("display", "flex").style("align-items", "center")
            .style("justify-content", "space-between").style("margin-top", "6px");
        nav.append("button").attr("style", navBtn).text("◀").attr("title", "Previous hop")
            .on("click", () => self._stepHop(-1));
        const readout = nav.append("span").style("font-size", "10px").style("color", "#555")
            .text(`Hop ${cur + 1} / ${hops.length}`);
        nav.append("button").attr("style", navBtn).text("▶").attr("title", "Next hop")
            .on("click", () => self._stepHop(1));
        svg.on("mousemove", function (event) {
            const i = idxAt(d3.pointer(event, this)[0]);
            readout.style("color", col).style("font-weight", "700")
                .text(`Hop ${i + 1} · ₿ ${hops[i].btc.toFixed(4)}`);
        }).on("mouseleave", () => readout.style("color", "#555").style("font-weight", "400")
            .text(`Hop ${cur + 1} / ${hops.length}`))
          .on("click", function (event) { self._goHop(idxAt(d3.pointer(event, this)[0])); });
        if (innerW > viewW + 1) wrap.node().scrollLeft = Math.max(0, x(cur) - viewW / 2);

                    const h = hops[cur];
        const txF = this.txMap.get(h.hashFrom), txT = this.txMap.get(h.hashTo);
        const drawn = this.hourArcByKey.has(`${h.hashFrom}|${h.hashTo}|${h.addr}`);
        const fT = d3.utcFormat("%d %b %H:%M");
        const line = box.append("div").style("margin-top", "10px").style("padding-top", "8px")
            .style("border-top", "1px solid rgba(0,0,0,0.08)");
        line.append("div").style("font-size", "14px").style("font-weight", "700").style("color", col)
            .style("margin-bottom", "6px").text(`₿ ${h.btc.toFixed(4)}`);
        const kv = (k, v) => {
            const r = line.append("div").style("display", "flex").style("gap", "8px")
                .style("font-size", "11px").style("margin-top", "3px");
            r.append("span").style("flex", "0 0 62px").style("color", "#888").text(k);
            r.append("span").style("color", "#333").style("font-weight", "600").text(v);
        };
        if (txF && txT) {
            kv("Received", `${fT(txF.time)} UTC`);
            kv("Spent", `${fT(txT.time)} UTC`);
            if (!drawn) line.append("div").style("font-size", "10px").style("color", "#92610a")
                .style("margin-top", "5px").text("Not drawn: received and spent in the same hour.");
        }
    
    }
    _openMergedDetails() {
        const arc = this._overlay && this._overlay.kind === 'single' ? this._overlay.arcs[0] : null;
        if (!arc) return;
        const tx = this.txMap ? this.txMap.get(arc.hashFrom) : null;
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
        const destAddr = maxOut ? maxOut.addr : (arc.addresses[0] ? arc.addresses[0].addr : "—");
        this._openMerged = true;
        this._showChainPanel(arc.hashFrom, destAddr, arc.btc, arc, false);
        this._openMerged = false;
    }
    _goHop(i) {
        const hops = this._hopsForSpark();
        if (!hops || i < 0 || i >= hops.length) return;
        this._hopIdx = i;
        const h = hops[i];
        const arc = this.hourArcByKey.get(`${h.hashFrom}|${h.hashTo}|${h.addr}`);
        this._hopKey = arc ? arc.key : null;          // this edge is drawn thicker
        this._draw(false);
        this._renderSparkPanel();
        if (arc) this._centerOnArc(arc);
        else {                                        // hop inside one hour: go to its node
            const tx = this.txMap.get(h.hashFrom);
            const n = tx ? this._nodeFor(tx.time) : null;
            if (n && n.bx != null) this.svgEl.transition().duration(500).call(this.zoom.translateTo, n.bx, this._axisY);
        }
    }

    _stepHop(delta) { this._goHop((this._hopIdx || 0) + delta); }

    _drawChainArcsOnly(chainArcs) {
        if (!chainArcs || !chainArcs.length) return;
        this._activeChainArcs = chainArcs;
        this._setOverlay({ kind: 'peel', color: '#F59E0B', arcs: chainArcs });
    }

    _highlightSingleArc(arc, color) {
        const focusColor = this._getArcHlColor(arc);
        color = color || focusColor || "#EC4899";
        this._activeChainArcs = [arc];
        this._setOverlay({ kind: 'single', color, arcs: [arc] });
    }
        
    _centerOnArc(arc) {
        if (!arc || !this.zoom) return;
        const [f] = this._arcEnds(arc);
        if (!f || f.bx == null) return;
        this.svgEl.transition().duration(500)
            .call(this.zoom.translateTo, f.bx, this._axisY);
    }
    // Press P while hovering: keeps a selectable copy of the tooltip on screen.
    _pinTip() {
        if (!this.tip || +this.tip.style("opacity") < 0.5) { this._unpinTip(); return; }
        const node = this.tip.node();
        const r = node.getBoundingClientRect();
        this._unpinTip();
        const pin = d3.select(document.body).append("div")
            .attr("class", "ef-pinned-tip")
            .style("position", "fixed")
            .style("left", Math.min(r.left, window.innerWidth - 380) + "px")
            .style("top", r.top + "px")
            .style("max-width", "360px")
            .style("background", "#ffffff").style("padding", "10px 14px")
            .style("border", "1px solid #EC4899").style("border-radius", "6px")
            .style("box-shadow", "0 4px 14px rgba(0,0,0,0.18)")
            .style("color", "#1a1a1a").style("font-size", "11px")
            .style("z-index", "1001")
            .style("pointer-events", "auto").style("user-select", "text")
            .style("cursor", "text");
        pin.html(node.innerHTML);
        pin.selectAll(".ef-pin-hint, .ef-copied").remove();
        // show full values (hashes, addresses) instead of the shortened ones
        pin.selectAll("[data-full]").each(function () {
            this.textContent = this.getAttribute("data-full");
            this.style.wordBreak = "break-all";
        });
        pin.insert("div", ":first-child")
            .style("display", "flex").style("justify-content", "space-between")
            .style("align-items", "center").style("margin-bottom", "4px")
            .style("font-size", "9px").style("color", "#888")
            .html(`<span>Pinned · select text and copy · Esc to close</span>`)
            .append("button").text("✕")
            .style("background", "none").style("border", "none").style("cursor", "pointer")
            .style("font-size", "13px").style("color", "#555")
            .on("click", () => this._unpinTip());
        this.tip.style("opacity", 0);
    }

    _unpinTip() {
        d3.selectAll(".ef-pinned-tip").remove();
    }
    // ════════════════════════════════════════════════════════════════
    //  TOOLTIPS
    // ════════════════════════════════════════════════════════════════
    _showTooltip(event, d) {
        this.tip.style("opacity", 1)
            .style("left", (event.clientX + 15) + "px")
            .style("top", (event.clientY - 15) + "px")
            .html(d.isSingle ? this._tooltipHour(d) : this._tooltipDay(d));
    }

    _showNodeTip(event, n) {
        const hint = n.level === 'hour'
            ? 'Click to focus on this window’s edges'
            : `Click to expand into ${n.level === 'day' ? '12-hour windows' : n.level === '12h' ? '6-hour windows' : 'hours'} · Shift+click to focus`;
        this.tip.style("opacity", 1)
            .style("left", (event.clientX + 15) + "px")
            .style("top", (event.clientY - 15) + "px")
            .html(`
            <div style="font-weight:700;color:#57534e;margin-bottom:4px">${this._nodeLabelFull(n)}</div>
            <div style="font-size:9px;color:#888">${hint}</div>
            ${this._sameHourHtml(n)}
            ${n._hid ? `<div style="font-size:9px;color:#64748b;margin-top:2px">${n._hid} long edge${n._hid === 1 ? '' : 's'} hidden</div>` : ''}
                    `);
    }
     _tooltipDay(d) {
        const hlColor = this._getArcHlColor(d);
        const largest = d.addresses && d.addresses.length ? d3.max(d.addresses, f => f.btc) : 0;
        const fl = this._computeArcOutlierFlags(d);
        const tags = [];
        if (fl.selfLoops.length) tags.push(`${fl.selfLoops.length} self-loop`);
        if (fl.globalOutliers.length) tags.push(`${fl.globalOutliers.length} top 1%`);
        if (fl.dominant) tags.push('dominant flow');
        if (fl.repeatedAddrFlows.length) tags.push('repeated address');
        return `
            <div style="font-weight:700;color:${hlColor || '#EC4899'};margin-bottom:5px">${d.count} merged flow${d.count === 1 ? '' : 's'} · ₿ ${d.btc.toFixed(4)}</div>
            <div style="margin-bottom:2px;font-size:10px;color:#555">${this._nodeLabelFull(d.fromNode)} → ${this._nodeLabelFull(d.toNode)}</div>
            <div style="margin-bottom:2px;font-size:10px;color:#555">Largest single flow: <b style="color:#1a1a1a">₿ ${largest.toFixed(4)}</b></div>
            ${tags.length ? `<div style="font-size:10px;color:#92610a;margin-bottom:2px">${tags.join(' · ')}</div>` : ''}
            <div style="font-size:9px;color:#888">Click to select · "Details" in the left panel lists the flows</div>`;
    }
    _chainLabel(d, pos) {
        const hops = this._hopsForSpark();
        if (hops) {
            const i = hops.findIndex(h => h.hashFrom === d.hashFrom && h.hashTo === d.hashTo);
            if (i >= 0) return `${this._overlay.kind === 'peel' ? 'suspicious hop' : 'hop'} ${i + 1} of ${hops.length}`;
        }
        return `TX ${pos} of ${d.chainLen}`;
    }
        _tooltipHour(d) {
        const hlColor = this._getArcHlColor(d);
if (this._overlay && this._overlay.kind === 'suspects') return this._tooltipSuspect(d);
        const accent = hlColor || (this._overlay && this._overlay.kind === 'peel' ? '#F59E0B' : '#EC4899');
        const tx = this.txMap ? this.txMap.get(d.hashFrom) : null;
        const timeStr = tx ? d3.utcFormat("%d %b %Y, %H:%M:%S UTC")(tx.time) : '—';
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
const outAddr = d.inAddr || (d.addresses[0] ? d.addresses[0].addr : '—');
        const sh = s => s && s.length > 22 ? s.slice(0, 10) + '…' + s.slice(-8) : s;
        const pos = d.chainLen - d.hops;

        const e0 = d.addresses && d.addresses[0];
        const gapH = e0 && e0.timeFrom && e0.timeTo ? (e0.timeTo - e0.timeFrom) / 3600000 : null;
        const gapStr = gapH == null ? null
            : gapH < 1 ? `${Math.round(gapH * 60)} min`
            : gapH < 48 ? `${gapH.toFixed(1)} h` : `${(gapH / 24).toFixed(1)} days`;
        const row = (t, v, mono) => `<div style="display:flex;gap:8px;margin-bottom:3px;font-size:10px;color:#333">
            <span style="flex:0 0 76px;color:#888;user-select:none">${t}</span>
            <span style="flex:1;min-width:0;word-break:break-all;${mono ? 'font-family:monospace;' : ''}">${v}</span></div>`;
        const hid = (this._overlay && this._overlayHidden > 0)
            ? `<div style="font-size:9px;color:#92610a;margin-top:5px">${this._overlayHidden} hop${this._overlayHidden === 1 ? '' : 's'} of this ${this._overlay.kind === 'peel' ? 'suspicious run' : 'chain'} happen inside one hour (not drawn)</div>` : '';
        return `
            <div style="font-weight:700;font-size:13px;color:${accent};margin-bottom:6px">₿ ${d.btc.toFixed(4)}</div>
            ${row('Time', timeStr)}
            ${row('TX hash', `<span data-full="${d.hashFrom}">${sh(d.hashFrom)}</span>`, true)}
            ${row('Spent address', `<span data-full="${outAddr}">${sh(outAddr)}</span>`, true)}
            ${gapStr ? row('Spent after', gapStr) : ''}
            ${row('Chain', this._chainLabel(d, pos))}
            ${d.bridged ? `<div style="font-size:9px;color:#92610a;margin-top:5px">≈ ₿ ${d.gapBtc.toFixed(4)} left through a transaction that is not in the loaded data</div>` : ''}
            ${hid}
            <div class="ef-pin-hint" style="font-size:9px;color:#888;margin-top:5px">Press <b>P</b> to pin this box, then select and copy text</div>`;
            }        
    _buildTooltip() {
        this.tip = d3.select("body").append("div")
            .attr("class", "ef-tooltip")
            .style("position", "fixed").style("pointer-events", "none").style("opacity", 0)
            .style("background", "rgba(255,255,255,0.98)").style("padding", "10px 14px")
            .style("border", "1px solid rgba(0,0,0,0.12)").style("border-radius", "6px")
            .style("color", "#1a1a1a").style("font-size", "11px").style("z-index", "1000");
    }

    // ════════════════════════════════════════════════════════════════
    //  PANELS
    // ════════════════════════════════════════════════════════════════
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
            origTop = rect.top;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            let newLeft = origLeft + (e.clientX - startX);
            let newTop = origTop + (e.clientY - startY);
            newLeft = Math.max(-node.offsetWidth + 60, Math.min(newLeft, window.innerWidth - 60));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
            node.style.left = `${newLeft}px`;
            node.style.top = `${newTop}px`;
            node.style.right = 'auto';
        });

        window.addEventListener('mouseup', () => { dragging = false; });
    }

    _buildChainPanel() {
        if (this._chainPanel) return;
        this._chainPanel = d3.select(document.body)
            .append("div").attr("class", "ef-chain-panel")
            .style("position", "fixed")
            .style("top", "12px")
            .style("left", `${Math.max(12, window.innerWidth - 332)}px`)
            .style("width", "320px").style("min-width", "220px").style("max-width", "600px")
            .style("height", "420px").style("min-height", "180px").style("max-height", "85vh")
            .style("resize", "both").style("overflow-y", "auto")
            .style("background", "rgba(255,255,255,0.98)")
            .style("border", "1px solid #EC4899").style("border-radius", "8px")
            .style("padding", "14px 16px").style("color", "#1a1a1a").style("font-size", "11px")
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
            .style("color", "#92610a")
            .text(`${missingCount} of ${missingCount + this._activeChainArcs.length} hops happened within the same clock hour as their prior hop, so they have no separate arc to plot — they're still counted in the chain, just not drawn individually.`);
    }

    _showChainPanel(txHash, destAddr, btc, arc, isPeelView = null) {
       if (isPeelView !== null) this._chainPanelShowSparkline = isPeelView;
// Single-edge / chain clicks no longer open a panel: the graph and the hover tooltip carry the information.
if ((arc && arc.isAggregated) ? !this._openMerged : !this._chainPanelShowSparkline) {
    if (this._chainPanel) this._chainPanel.style("display", "none");
    return;
}
        if (!this._chainPanel) this._buildChainPanel();
        // Merged (blue) edges show the list of merged flows; single flows show the chain step.
        const isDay = !!(arc && arc.isAggregated);
        // Panel color follows which chain is on screen: amber for a Detect Candidates
        // result, pink for a plain arc click.
        const hlColor = this._chainPanelShowSparkline ? '#F59E0B' : '#EC4899';

        // Position/total always come from the arcs actually navigable via Prev/Next.
        // In peel-candidate mode, navigate/plot the FULL hop sequence (includes same-hour
        // hops with no drawable arc). Otherwise use drawable arcs only.
        const usingFullHops = this._chainPanelShowSparkline && this._sparklineHops && this._sparklineHops.length;
        const navArcs = usingFullHops ? this._sparklineHops : (this._activeChainArcs || []);
        const pos = usingFullHops ? (this._sparklineIdx + 1) : (this._activeChainIdx + 1);
        const total = navArcs.length;
        const matchList = navArcs.map((d, i) => ({ idx: i, color: this._matchColorFor(d) })).filter(m => m.color);

        const matched = arc ? this._getMatchedStats(arc) : null;

        const copyBtn = (val, color) =>
            `<button class="ef-copy-btn" data-copy="${val.replace(/"/g, '&quot;')}"
            style="flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
                   width:22px;height:22px;background:transparent;border:1px solid ${color};
                   color:${color};border-radius:4px;cursor:pointer;padding:0">${ic('copy', 11)}</button>`;
        let body;
        if (isDay) {
            const labelFrom = this._nodeLabelFull(arc.fromNode);
            const labelTo = this._nodeLabelFull(arc.toNode);

            const flags = this._computeArcOutlierFlags(arc);
            const flows = arc.addresses;
            const maxFlow = d3.max(flows, f => f.btc);
            const minFlow = d3.min(flows, f => f.btc);

            const flagRows = [];
            if (flags.dominant) {
                flagRows.push(`<span style="color:#6366F1">●</span> One transaction makes up <b>${(flags.dominant.pct * 100).toFixed(0)}%</b> of this arc's volume (₿${flags.dominant.flow.btc.toFixed(4)})`);
            }
            if (flags.selfLoops.length) {
                flagRows.push(`<span style="color:#A855F7">●</span> <b>${flags.selfLoops.length}</b> transaction${flags.selfLoops.length > 1 ? 's' : ''} sent funds back to the same address (self-loop)`);
            }
            if (flags.globalOutliers.length) {
                flagRows.push(`<span style="color:#EF4444">●</span> <b>${flags.globalOutliers.length}</b> transaction${flags.globalOutliers.length > 1 ? 's are' : ' is'} in the top 1% of amounts across the whole dataset`);
            }
            if (flags.repeatedAddrFlows.length) {
                const uniqueRepeated = new Set(flags.repeatedAddrFlows.map(f => f.addr)).size;
                flagRows.push(`<span style="color:#06B6D4">●</span> <b>${uniqueRepeated}</b> address${uniqueRepeated > 1 ? 'es' : ''} appear more than once in this arc (${flags.repeatedAddrFlows.length} transactions total)`);
            }

            const shortAddr = a => a.length > 18 ? a.slice(0, 8) + '…' + a.slice(-6) : a;
            const dominantFlow = flags.dominant ? flags.dominant.flow : null;
            const selfLoopSet = new Set(flags.selfLoops.map(f => f.hashTo + '|' + f.addr));
            const globalOutlierSet = new Set(flags.globalOutliers.map(f => f.hashTo + '|' + f.addr));
            const repeatedSet = new Set(flags.repeatedAddrFlows.map(f => f.hashTo + '|' + f.addr));
            const self = this;

            const sortedFlows = [...flows].sort((a, b) => {
                const score = f => (dominantFlow === f ? 3 : 0) + (selfLoopSet.has(f.hashTo + '|' + f.addr) ? 2 : 0) + (globalOutlierSet.has(f.hashTo + '|' + f.addr) ? 2 : 0) + (repeatedSet.has(f.hashTo + '|' + f.addr) ? 1 : 0);
                return score(b) - score(a) || b.btc - a.btc;
            });

            const rowsHtml = sortedFlows.map(flow => {
                const tx = self.txMap ? self.txMap.get(flow.hashTo) : null;
                const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
                const destAddr = maxOut ? maxOut.addr : "—";
                const timeStr = flow.timeTo ? d3.utcFormat("%d %b %Y, %H:%M")(flow.timeTo) : "—";
                const flowKey = flow.hashTo + '|' + flow.addr;

                const badges = [];
                if (dominantFlow === flow) badges.push('<span style="background:#6366F114;border:1px solid #6366F155;color:#6366F1;padding:1px 6px;border-radius:3px;font-size:8px">dominant</span>');
                if (selfLoopSet.has(flowKey)) badges.push('<span style="background:#A855F714;border:1px solid #A855F755;color:#A855F7;padding:1px 6px;border-radius:3px;font-size:8px">self-loop</span>');
                if (globalOutlierSet.has(flowKey)) badges.push('<span style="background:#EF444414;border:1px solid #EF444455;color:#EF4444;padding:1px 6px;border-radius:3px;font-size:8px">top 1%</span>');
                if (repeatedSet.has(flowKey)) badges.push('<span style="background:#06B6D414;border:1px solid #06B6D455;color:#06B6D4;padding:1px 6px;border-radius:3px;font-size:8px">repeated addr</span>');
                badges.push(flow.chainLen > 1
                    ? `<span style="background:#6b728014;border:1px solid #6b728055;color:#6b7280;padding:1px 6px;border-radius:3px;font-size:8px">${flow.chainLen}-hop chain</span>`
                    : `<span style="background:#6b728014;border:1px solid #6b728055;color:#6b7280;padding:1px 6px;border-radius:3px;font-size:8px">no further hops</span>`);
                return `
                <div style="font-family:monospace;padding:8px;border:1px solid rgba(0,0,0,0.08);border-radius:5px;background:#fafafa;margin-bottom:6px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:3px">
                        <span style="color:#888;font-size:9px">${timeStr}</span>
                        <span style="display:flex;gap:3px;flex-wrap:wrap">${badges.join('')}</span>
                    </div>
                    <div style="margin-bottom:3px;font-size:10px"><b style="color:#F7931A">₿${flow.btc.toFixed(4)}</b></div>
                    <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;font-size:9px;color:#555">
                        <span title="${flow.hashTo}">TX: ${shortAddr(flow.hashTo)}</span>${copyBtn(flow.hashTo, '#555')}
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;font-size:9px;color:#333">
                        <span title="${flow.addr}">In: ${shortAddr(flow.addr)}</span>${copyBtn(flow.addr, '#333')}
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;margin-bottom:5px;font-size:9px;color:#333">
                        <span title="${destAddr}">Out: ${shortAddr(destAddr)}</span>${copyBtn(destAddr, '#333')}
                    </div>
                </div>`;
            }).join('');

            body = `
            <div style="color:#888;font-size:9px;margin-bottom:6px">${labelFrom} → ${labelTo}</div>
            <div style="margin-bottom:4px;font-size:10px;color:#555">
                Combined volume: <b style="color:#1a1a1a">₿ ${btc.toFixed(4)}</b>
            </div>

            <div style="display:flex;gap:10px;margin-bottom:8px;font-size:9px;color:#555;flex-wrap:wrap">
                <span>Largest: <b style="color:#1a1a1a">₿${maxFlow.toFixed(4)}</b></span>
                <span>Smallest: <b style="color:#1a1a1a">₿${minFlow.toFixed(4)}</b></span>
            </div>
            ${matched ? `
            <div style="margin-bottom:10px;padding:6px 8px;background:${hlColor}14;border:1px solid ${hlColor}55;border-radius:4px;font-size:10px">
                <span style="color:${hlColor}">Your searched address's share:</span>
                ₿ ${matched.btc.toFixed(4)} (${matched.count} of ${arc.count})
            </div>` : ''}
            ${flagRows.length ? `
            <div style="padding:8px 10px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.08);border-radius:6px;font-size:10px;line-height:1.9;margin-bottom:10px">
                ${flagRows.join('<br>')}
            </div>`
                : `<div style="font-size:9px;color:#999;margin-bottom:10px">No self-loop, dominant transaction, repeated address, or top-1% outlier detected among the ${flows.length} transaction${flows.length > 1 ? 's' : ''} merged into this arc.</div>`}
            <div style="color:#888;font-size:9px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Merged transactions (${flows.length})</div>
            ${rowsHtml}
            `;
        } else {
            const tx = this.txMap ? this.txMap.get(txHash) : null;
            const timeStr = tx ? d3.utcFormat("%d %b %Y, %H:%M:%S UTC")(tx.time) : '—';
            const matchedSingle = arc ? this._getMatchedStats(arc) : null;
            body = `
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Exact time</div>
            <div style="margin-bottom:10px;font-size:10px;color:#333">${timeStr}</div>
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">TX hash</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:10px">
                <span style="font-family:monospace;font-size:8.5px;color:#333;word-break:break-all;flex:1">${txHash}</span>
                ${copyBtn(txHash, '#555')}
            </div>
            <div style="color:#888;font-size:9px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Main output (continues the chain)</div>
            <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:12px">
                <span style="font-family:monospace;font-size:8.5px;color:#333;word-break:break-all;flex:1">${destAddr}</span>
                ${copyBtn(destAddr, '#555')}
            </div>
            <div style="color:#555;font-size:10px;margin-bottom:8px">
                Volume: <b style="color:#1a1a1a">₿ ${btc.toFixed(4)}</b>
            </div>
            ${matchedSingle ? `
            <div style="margin-bottom:10px;padding:6px 8px;background:${hlColor}14;border:1px solid ${hlColor}55;border-radius:4px;font-size:10px">
                <span style="color:${hlColor}">This transaction matches your searched address.</span>
            </div>` : ''}
            <div style="background:${hlColor}12;border:1px solid ${hlColor}40;
                 border-radius:4px;padding:6px 8px;font-size:10px">
                <div style="color:${hlColor};font-weight:700;margin-bottom:4px">Chain summary</div>
                <div style="color:#555">Plotted length: <b style="color:#1a1a1a">${total}</b>${this._chainTrueTotal && this._chainTrueTotal > total
                    ? ` <span style="color:#777">(of ${this._chainTrueTotal} total)</span>` : ''
                }</div>
                <div style="color:#555">This transaction is: <b style="color:#1a1a1a">number ${pos} of ${total}</b></div>
                ${matchList.length ? `
                <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.12)">
                    <div style="font-size:9px;color:#555;margin-bottom:4px">Your searched address${matchList.length > 1 ? 'es appear' : ' appears'} at:</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px">
                        ${matchList.map(m => `<button onclick="window._efChart._gotoHopIndex(${m.idx})" style="font-size:9px;padding:2px 7px;border-radius:3px;border:1px solid ${m.color};color:${m.color};background:${m.color}14;cursor:pointer">#${m.idx + 1}</button>`).join('')}
                    </div>
                </div>` : ''}
                ${this._chainPanelShowSparkline ? `
    <div style="display:flex;justify-content:flex-end;margin-bottom:2px">
        <button onclick="window._efChart._toggleSparklineView()"
            style="background:transparent;border:1px solid ${hlColor};color:${hlColor};
                   font-size:9px;padding:2px 8px;border-radius:3px;cursor:pointer">
            Sparkline: ${this._sparklineDayView ? 'Day view' : 'Hour view'} (switch)
        </button>
    </div>` : ''}
    ${this._chainPanelShowSparkline ? this._buildSparkline(navArcs, usingFullHops ? this._sparklineIdx : this._activeChainIdx) : ''}
                ${this._chainPanelShowSparkline ? (() => {
                    const addrOf = hp => hp.addr || hp.inAddr;
                    let drawnCount, sameLabel;
                    if (this._sparklineDayView) {
                        drawnCount = navArcs.filter(hp => {
                            const txFrom = this.txMap.get(hp.hashFrom);
                            const txTo = this.txMap.get(hp.hashTo);
                            return txFrom && txTo &&
                                d3.utcFormat("%Y-%m-%d")(txFrom.time) !== d3.utcFormat("%Y-%m-%d")(txTo.time);
                        }).length;
                        sameLabel = 'in the same calendar day as the hop before it';
                    } else {
                        drawnCount = navArcs.filter(hp => this.hourArcByKey.has(`${hp.hashFrom}|${hp.hashTo}|${addrOf(hp)}`)).length;
                        sameLabel = 'in the same clock hour as the hop before it';
                    }
                    const sameCount = navArcs.length - drawnCount;
                    return sameCount > 0
                        ? `<div style="color:#888;font-size:9px;margin-top:6px;padding-bottom:10px">
                             ${drawnCount} hop${drawnCount === 1 ? '' : 's'} drawn as arcs ·
                             ${sameCount} hop${sameCount === 1 ? '' : 's'} ${sameLabel}
                             (no separate arc — shown as a hollow dot above, still counted)
                           </div>`
                        : '';
                })() : ''}
                <div style="display:flex;justify-content:space-between;margin-top:8px">
                    <button onclick="window._efChart._gotoHop(-1)" style="flex:1;margin-right:4px;padding:5px;background:transparent;border:1px solid ${hlColor};color:${hlColor};border-radius:4px;cursor:pointer;font-size:10px">◀ Prev hop</button>
                    <button onclick="window._efChart._gotoHop(1)" style="flex:1;margin-left:4px;padding:5px;background:transparent;border:1px solid ${hlColor};color:${hlColor};border-radius:4px;cursor:pointer;font-size:10px">Next hop ▶</button>
                </div>
            </div>`;
        }

        this._chainPanel.style("border-color", hlColor);
        this._chainPanel.style("display", "block").html(`
        <div class="ef-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move">
            <span style="font-weight:700;color:${hlColor};font-size:12px">${isDay ? 'Merged Flow Details' : (this._chainPanelShowSparkline ? 'Peeling Chain Step' : 'Transaction Detail')}</span>
        ${!isDay ? `<span style="font-size:10px;color:#555">TX ${pos} / ${total}</span>` : ''}
            <button onclick="this.closest('.ef-chain-panel').style.display='none'"
                style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0;line-height:1">✕</button>
        </div>
        ${body}
    `);
        this._chainPanel.selectAll(".ef-copy-btn").on("click", function () {
            const val = this.getAttribute("data-copy");
            navigator.clipboard.writeText(val).then(() => {
                this.innerHTML = ic('check', 11);
                setTimeout(() => { this.innerHTML = ic('copy', 11); }, 1200);
            });
        });

        // If some hops in the true chain have no drawable arc (they landed in the same
        // time bucket as their prior hop), say so plainly.
        if (!isDay && this._chainTrueTotal && total < this._chainTrueTotal) {
            this._showUnplottableHopsNotice(this._chainTrueTotal - total);
        }
    }

    _gotoHop(delta) {
        // Peel-candidate mode: step through the FULL hop sequence (including same-hour hops
        // with no drawable arc), using the detector's own values.
        if (this._chainPanelShowSparkline && this._sparklineHops && this._sparklineHops.length) {
            const newIdx = this._sparklineIdx + delta;
            if (newIdx < 0 || newIdx >= this._sparklineHops.length) return;
            this._sparklineIdx = newIdx;
            const hop = this._sparklineHops[newIdx];

            const matchingArc = this.hourArcByKey.get(`${hop.hashFrom}|${hop.hashTo}|${hop.addr}`);
            if (matchingArc) {
                this.selectedArc = matchingArc;
                this._activeChainIdx = (this._activeChainArcs || []).findIndex(a => a.key === matchingArc.key);
            }

            const tx = this.txMap.get(hop.hashFrom);
            const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
            const destAddr = maxOut ? maxOut.addr : hop.addr;
            this._showChainPanel(hop.hashFrom, destAddr, hop.btc, matchingArc || null, true);
            return;
        }

        // Plain arc-click mode: navigates drawable arcs only.
        if (!this._activeChainArcs || this._activeChainIdx < 0) return;
        const newIdx = this._activeChainIdx + delta;
        if (newIdx < 0 || newIdx >= this._activeChainArcs.length) return;
        this._activeChainIdx = newIdx;
        const d = this._activeChainArcs[newIdx];
        this.selectedArc = d;
        const tx = this.txMap.get(d.hashFrom);
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
        const destAddr = maxOut ? maxOut.addr : (d.addresses[0]?.addr || "—");
        this._showChainPanel(d.hashFrom, destAddr, d.btc, d);
    }

    _gotoHopIndex(idx) {
        if (this._chainPanelShowSparkline && this._sparklineHops && this._sparklineHops.length) {
            if (idx < 0 || idx >= this._sparklineHops.length) return;
            this._sparklineIdx = idx;
            const hop = this._sparklineHops[idx];
            const matchingArc = this.hourArcByKey.get(`${hop.hashFrom}|${hop.hashTo}|${hop.addr}`);
            if (matchingArc) {
                this.selectedArc = matchingArc;
                this._activeChainIdx = (this._activeChainArcs || []).findIndex(a => a.key === matchingArc.key);
            }
            const tx = this.txMap.get(hop.hashFrom);
            const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
            const destAddr = maxOut ? maxOut.addr : hop.addr;
            this._showChainPanel(hop.hashFrom, destAddr, hop.btc, matchingArc || null, true);
            return;
        }
        if (!this._activeChainArcs || idx < 0 || idx >= this._activeChainArcs.length) return;
        this._activeChainIdx = idx;
        const d = this._activeChainArcs[idx];
        this.selectedArc = d;
        const tx = this.txMap.get(d.hashFrom);
        const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
        const destAddr = maxOut ? maxOut.addr : (d.addresses[0]?.addr || "—");
        this._showChainPanel(d.hashFrom, destAddr, d.btc, d);
    }

    _toggleSparklineView() {
        this._sparklineDayView = !this._sparklineDayView;
        if (this._sparklineHops && this._sparklineHops.length) {
            const hop = this._sparklineHops[this._sparklineIdx];
            const tx = this.txMap.get(hop.hashFrom);
            const maxOut = tx && tx.outputs.length ? tx.outputs.reduce((a, b) => b.btc > a.btc ? b : a) : null;
            const destAddr = maxOut ? maxOut.addr : hop.addr;
            const matchingArc = this.hourArcByKey.get(`${hop.hashFrom}|${hop.hashTo}|${hop.addr}`);
            this._showChainPanel(hop.hashFrom, destAddr, hop.btc, matchingArc || null, true);
        }
    }

    _buildSparkline(hops, currentIdx, dayView = this._sparklineDayView) {
        if (!hops || hops.length < 2) return '';
        const w = Math.max(286, hops.length * 14);
        const h = 190, pad = 16;
        const plotTop = 34, plotBottom = h - 34;

        const vals = hops.map(hp => hp.btc);
        const dataMin = Math.max(Math.min(...vals), 1e-6);
        const dataMax = Math.max(...vals);

        const FIXED_TICKS = [10, 100, 1000];
        const domainMin = Math.min(dataMin, FIXED_TICKS[0]);
        const domainMax = Math.max(dataMax, FIXED_TICKS[FIXED_TICKS.length - 1]);
        const logMin = Math.log(domainMin), logMax = Math.log(domainMax);

        const x = i => pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = v => plotBottom - ((Math.log(Math.max(v, domainMin)) - logMin) / (logMax - logMin)) * (plotBottom - plotTop);

        const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');

        const dots = hops.map((hop, i) => {
            const isCurrent = i === currentIdx;
            const addr = hop.addr || hop.inAddr;
            let hasArc;
            if (dayView) {
                const txFrom = this.txMap.get(hop.hashFrom);
                const txTo = this.txMap.get(hop.hashTo);
                hasArc = !txFrom || !txTo ||
                    d3.utcFormat("%Y-%m-%d")(txFrom.time) !== d3.utcFormat("%Y-%m-%d")(txTo.time);
            } else {
                hasArc = this.hourArcByKey.has(`${hop.hashFrom}|${hop.hashTo}|${addr}`);
            }
            if (isCurrent) {
                return `<circle cx="${x(i)}" cy="${y(hop.btc)}" r="6.5" fill="#ffffff" stroke="#F59E0B" stroke-width="2.2" />`;
            }
            return hasArc
                ? `<circle cx="${x(i)}" cy="${y(hop.btc)}" r="4" fill="#F59E0B" />`
                : `<circle cx="${x(i)}" cy="${y(hop.btc)}" r="4" fill="none" stroke="#F59E0B" stroke-width="1.8" />`;
        }).join('');

        const fmtB = v => v >= 1 ? v.toFixed(v >= 100 ? 0 : 2) : v.toFixed(4);

        const midMarks = FIXED_TICKS.map(v => {
            const yy = y(v);
            return `<line x1="${pad}" y1="${yy}" x2="${w - pad}" y2="${yy}" stroke="rgba(0,0,0,0.25)" stroke-width="0.75" stroke-dasharray="2,2"/>
                <text x="${w - pad}" y="${yy - 2}" font-size="7" font-weight="700" fill="#333" text-anchor="end">₿${v}</text>`;
        }).join('');

        return `<div style="overflow-x:auto;overflow-y:hidden;margin:8px 0 4px;border:1px solid rgba(0,0,0,0.1);border-radius:4px">
        <svg width="${w}" height="${h}" style="display:block">
            <text x="${w - pad}" y="16" font-size="11" font-weight="700" fill="#333" text-anchor="end">₿${fmtB(dataMax)}</text>
            <text x="${w - pad}" y="${h - 8}" font-size="11" font-weight="700" fill="#333" text-anchor="end">₿${fmtB(dataMin)}</text>
            <polyline points="${pts}" fill="none" stroke="rgba(245,158,11,0.35)" stroke-width="1"/>${midMarks}${dots}
        </svg>
    </div>`;
    }

    // ════════════════════════════════════════════════════════════════
    //  FILTERS + PEELING CHAIN DETECTION
    // ════════════════════════════════════════════════════════════════
    _arcPassesFilters(a, f = this.activeFilters) {
        const e0 = a.addresses[0];
        const gapHours = (e0 && e0.timeFrom && e0.timeTo)
            ? (e0.timeTo - e0.timeFrom) / 3600000                      // exact time between the two transactions
            : (a.toCenterTime - a.fromCenterTime) / 3600000;
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
        maxAddrTx = Infinity, minAddrTx = 0, animate = true
    }) {
        this.hlColorMap = hlColorMap;
        this.activeQueries = queries;

        this.activeFilters = { queries, excludes, minB, maxB, minGapH, maxGapH, minHops, maxAddrTx, minAddrTx };

        // Filters are applied per single flow, then the visible edges are merged from the survivors.
        this.filteredLevels.hour = this.levels.hour.filter(a => this._arcPassesFilters(a, this.activeFilters));
        this.filteredLevels.day = this.filteredLevels.hour; // legacy alias

        this._dropSelectionState();
this._refresh(animate);
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

        if (btc < f.minB || btc > f.maxB) return false;
        return true;
    }

    _detectPeelingChainCandidates(minLength = 3, minRetainPct = 0.9, requireDecreasing = true) {
               // Detection uses the same filters as the view: Temporal Gap and Minimum Single Flow Value.
        // A hop below the minimum value ends the run, just like a hop outside the gap range.
        const f = { ...this.activeFilters };
        const roots = new Set();
        this.levels.hour.filter(a => this._arcPassesFilters(a, f))
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
                    chainHashes[i], next.spendHash, next.addr, next.btc, f
                );

                const retainPct = next.btc / originTx.btc_in;
                seq.push({
                    hashFrom: chainHashes[i], hashTo: chainHashes[i + 1],
                    btc: next.btc, retainPct, addr: next.addr,
                    isCleanPeel: retainPct >= minRetainPct && passesActiveFilters
                });
            }
            if (seq.length < minLength) return;

            // Slice into runs: clean peel AND amount decreasing vs prior hop
            let runStart = 0;
            for (let i = 1; i <= seq.length; i++) {
                const broke = i === seq.length ||
                    !seq[i].isCleanPeel ||
                    (requireDecreasing && seq[i].btc > seq[i - 1].btc);

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
            .style("background", "rgba(255,255,255,0.98)")
            .style("border", "1px solid #F59E0B").style("border-radius", "8px")
            .style("padding", "14px 16px").style("color", "#1a1a1a").style("font-size", "11px")
            .style("z-index", "9999").style("display", "none").style("pointer-events", "all");
        this._makeDraggable(this._peelPanel);
    }

    _showPeelResults(candidates) {
        if (!this._peelPanel) this._buildPeelPanel();
        this._peelCandidates = candidates;

        const header = `
            <div class="ef-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move">
                <span style="font-weight:700;color:#F59E0B;font-size:12px">
Suspicious chains (${candidates.length})
                </span>
                <button onclick="this.closest('.ef-peel-panel').style.display='none'"
                    style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0;line-height:1">✕</button>
            </div>`;

        if (!candidates.length) {
            this._peelPanel.style("display", "block").html(header + `
                <div style="color:#888;font-size:10px">
                    No chains matched these settings. Try lowering the minimum number of hops
                    or the retain percentage in the sidebar.
                </div>`);
            return;
        }

        const rows = candidates.map((c, i) => `
            <div class="ef-peel-row" data-idx="${i}" style="
                padding:8px 10px;margin-bottom:6px;border:1px solid rgba(245,158,11,0.3);
                border-radius:5px;cursor:pointer;background:rgba(245,158,11,0.05)">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:#333">
<span><b style="color:#92610a">#${i + 1}</b> &nbsp;<b style="color:#F59E0B">${c.length}</b> hops</span>                    <span>${c.startBtc.toFixed(3)} ₿ → ${c.endBtc.toFixed(3)} ₿</span>
                </div>
                <div style="font-size:9px;color:#888;margin-top:2px">
                    ${(c.declinePct * 100).toFixed(1)}% total decline over the chain
                </div>
            </div>`).join('');

        this._peelPanel.style("display", "block").html(header + `
            <div style="font-size:9px;color:#777;margin-bottom:8px">Click a chain to show it on the graph.</div>
            ${rows}
        `);

        this._peelPanel.selectAll(".ef-peel-row").on("click", (event) => {
            const idx = +event.currentTarget.getAttribute("data-idx");
            this._highlightPeelCandidate(this._peelCandidates[idx]);
        });
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
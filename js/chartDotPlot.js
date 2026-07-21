class ChartDotPlot {
    constructor(selector, data) {
        this.selector = selector;
        this.rawData = data; 
        this.currentCluster = null;
        this.displayData = []; 
        this.isDrilledDown = false; 
        this.selectedTxHash = null;
        this.jitterOffsets = new Map();
        this.currentClusterTimeRange = null;
        this.margin = { top: 60, right: 60, bottom: 60, left: 100 };
        
        const container = d3.select(this.selector).node();
        this.width = container.getBoundingClientRect().width - this.margin.left - this.margin.right;
        this.height = container.getBoundingClientRect().height - this.margin.top - this.margin.bottom;

        this.init();
    }

     init() {
        document.getElementById('sb-day-section')?.style.removeProperty('display');
        document.querySelector('.sb-footer')?.style.removeProperty('display');
        document.querySelectorAll('.viz-chip').forEach(el => el.style.removeProperty('display'));
        d3.select(".ef-chain-panel").remove();
    d3.select(".ef-peel-panel").remove();
        d3.select("#ef-legend-footer").remove();
        d3.select(".ef-zoom-notice").remove();
        d3.select(this.selector).selectAll("*").remove();
        d3.select(this.selector).style("position", "relative");

        this.backBtn = d3.select(this.selector)
            .append("button")
            .attr("class", "back-button")
            .style("display", "none")
            .html("← General view")
            .on("click", () => this.updateData(this.rawData));

        this.svgElement = d3.select(this.selector)
            .append("svg")
            .attr("width", this.width + this.margin.left + this.margin.right)
            .attr("height", this.height + this.margin.top + this.margin.bottom);

        this.svg = this.svgElement.append("g")
            .attr("transform", `translate(${this.margin.left},${this.margin.top})`);

        this.svg.append("defs").append("clipPath")
            .attr("id", "clip")
            .append("rect")
            .attr("width", this.width)
            .attr("height", this.height);

        this.dotGroup = this.svg.append("g").attr("class", "dots-group").attr("clip-path", "url(#clip)");
        this.gX = this.svg.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${this.height})`);
        this.gY = this.svg.append("g").attr("class", "axis y-axis");

        if (this.rawData && this.rawData.length > 0) {
            this.updateData(this.rawData);
        }
    }

    generateGridClusters(data) {
        if (!data || data.length === 0) return [];
        const tiers = [
            { id: "high", min: 500, max: Infinity, yPos: 900, color: "#ff4444" },
            { id: "mid",  min: 100, max: 500,      yPos: 500, color: "#ffbb33" },
            { id: "low",  min: 0,   max: 100,      yPos: 100, color: "#00C851" }
        ];

        const grid = new Map();
        data.forEach(d => {
            const val = +d.maxSingleVal;
            const tier = tiers.find(t => val >= t.min && val < t.max);
            if (!tier) return;

            const date = new Date(d.time);
            date.setMinutes(0, 0, 0);
            const timeBucket = date.getTime();

            const key = `${tier.id}-${timeBucket}`;
            if (!grid.has(key)) {
                grid.set(key, {
                    id: key,
                    isCluster: true,
                    tierId: tier.id,
                    time: new Date(timeBucket),
                    yValue: tier.yPos,
                    color: tier.color,
                    count: 0,
                    children: []
                });
            }
            const cell = grid.get(key);
            cell.count++;
            cell.children.push(d);
        });
        return Array.from(grid.values());
    }

    setupScales() {
        const domainX = this.isDrilledDown && this.currentClusterTimeRange 
            ? [this.currentClusterTimeRange.start, this.currentClusterTimeRange.end]
            : d3.extent(this.rawData, d => new Date(d.time));
        
        this.xScale = d3.scaleUtc().domain(domainX).range([0, this.width]);

    let domainY;
        if (this.isDrilledDown && this.displayData.length > 0) {
            const minV = d3.min(this.displayData, d => +d.maxSingleVal);
            const maxV = d3.max(this.displayData, d => +d.maxSingleVal);
            const pad = (maxV - minV) * 0.2 || minV * 0.1;
            domainY = [Math.max(0, minV - pad), maxV + pad];
        } else {
            domainY = [0, 1000];
        }

        this.yScale = d3.scaleLinear().domain(domainY).range([this.height, 0]);


        this.xAxis = d3.axisBottom(this.xScale).tickSize(-this.height).tickFormat(d3.utcFormat("%H:%M"));
        this.yAxis = d3.axisLeft(this.yScale).tickSize(-this.width);

        if (!this.isDrilledDown) {
            this.yAxis.tickValues([100, 500, 900])
                .tickFormat(d => {
                    if (d === 100) return "< 100 BTC";
                    if (d === 500) return "100–500 BTC";
                    if (d === 900) return "> 500 BTC";
                });
        } else {
            this.yAxis.tickValues(null).tickFormat(d => `${d.toFixed(2)} BTC`);
        }

        this.gX.call(this.xAxis);
        this.gY.call(this.yAxis);
    }

    updateData(newData) {
        this.rawData = newData;
        this.isDrilledDown = false;
        this.selectedTxHash = null;
        this.currentClusterTimeRange = null;
        this.displayData = this.generateGridClusters(this.rawData);
        
        this.backBtn.style("display", "none");
        this.setupScales();
        this.updateZoomTranslateExtent();
        
        this.svgElement.transition().duration(750).call(
            d3.zoom().transform,
            d3.zoomIdentity
        );
        
        this.updateElements(this.xScale, this.yScale);
    }

    updateZoomTranslateExtent() {
        const minX = this.xScale(this.xScale.domain()[0]);
        const maxX = this.xScale(this.xScale.domain()[1]);
        const minScale = this.isDrilledDown ? 0.2 : 1;

        const zoom = d3.zoom()
            .scaleExtent([minScale, 100])
            .translateExtent([[minX - 500, -500], [maxX + 500, this.height + 500]])
            .on("zoom", (event) => {
                const newX = event.transform.rescaleX(this.xScale);
                const newY = event.transform.rescaleY(this.yScale);
                this.gX.call(this.xAxis.scale(newX));
                this.gY.call(this.yAxis.scale(newY));
                this.updateElements(newX, newY);
            });

        this.svgElement.call(zoom);
    }

    updateElements(newX, newY) {
        const dots = this.dotGroup.selectAll(".dot")
            .data(this.displayData, d => d.id || d.transaction_hash);

        dots.exit().remove();

        const dotsEnter = dots.enter()
            .append("circle")
            .attr("class", "dot")
            .on("click", (event, d) => {
                if (d.isCluster) {
                    this.currentCluster = d;
                    this.isDrilledDown = true;
                    this.displayData = d.children;
                    this.backBtn.style("display", "block");
                    
                    const times = d.children.map(c => new Date(c.time).getTime());
                    const minT = Math.min(...times);
                    const maxT = Math.max(...times);
                    const paddingX = (maxT - minT) * 0.2 || 3600000;

                    this.currentClusterTimeRange = { 
                        start: new Date(minT - paddingX), 
                        end: new Date(maxT + paddingX) 
                    };

                    this.setupScales();
                    this.updateZoomTranslateExtent();
                    
                    const t = this.svgElement.transition().duration(750);
                    t.call(d3.zoom().transform, d3.zoomIdentity);
                    this.gX.transition(t).call(this.xAxis);
                    this.gY.transition(t).call(this.yAxis);

                    this.updateElements(this.xScale, this.yScale);
                } else {
                    this.selectedTxHash = (this.selectedTxHash === d.transaction_hash) ? null : d.transaction_hash;
                    this.showDetails(d);
                    this.updateElements(newX, newY);
                }
            });

        dotsEnter.merge(dots)
            .attr("cx", d => { 
                const baseCx = newX(new Date(d.time));
                if (d.isCluster) return baseCx;
                const id = d.transaction_hash;
                if (!this.jitterOffsets.has(id)) {
                    this.jitterOffsets.set(id, {
                        x: (Math.random() - 0.5) * 25,
                        y: (Math.random() - 0.5) * 20
                    });
                }
                return baseCx + this.jitterOffsets.get(id).x;
            })
            .attr("cy", d => {
                if (d.isCluster) return newY(d.yValue);
                const valY = this.isDrilledDown ? +d.maxSingleVal : 
                             (d.maxSingleVal >= 500 ? 900 : d.maxSingleVal >= 100 ? 500 : 100);
                const jitterY = this.isDrilledDown ? 0 : this.jitterOffsets.get(d.transaction_hash).y;
                return newY(valY) + jitterY;
            })
            .attr("r", d => d.isCluster
                ? Math.min(30, Math.sqrt(d.count) * 2.5 + 8)
                : (d.transaction_hash === this.selectedTxHash ? 10 : 6))
            .style("fill", d => {
                if (d.isCluster) return d.color;
                if (d.transaction_hash === this.selectedTxHash) return "#00f2ff";
                return d.wasSpent ? "#ff4444" : "#4a90e2";
            })
            .style("opacity", 0.9)
            .style("stroke", d => (d.isCluster || d.transaction_hash === this.selectedTxHash) ? "white" : "none")
            .style("stroke-width", 2);

        const labels = this.dotGroup.selectAll(".cluster-label")
            .data(this.isDrilledDown ? [] : this.displayData, d => d.id);

        labels.exit().remove();
        labels.enter().append("text")
            .attr("class", "cluster-label")
            .attr("text-anchor", "middle")
            .attr("dy", ".3em")
            .style("fill", "white")
            .style("font-size", "12px")
            .style("font-weight", "bold")
            .style("pointer-events", "none")
            .merge(labels)
            .attr("x", d => newX(new Date(d.time)))
            .attr("y", d => newY(d.yValue))
            .text(d => d.count);
    }

    showDetails(d) {
        const panel = d3.select("#transaction-details-panel");
        const content = d3.select("#panel-content");
        if (!this.selectedTxHash) { panel.classed("open", false); return; }

        const outputValues = d.all_outputs.map(out => +out.output_value_BTC);
        const maxOut = Math.max(...outputValues);
        const minOut = Math.min(...outputValues);
        const gap = maxOut - minOut;

        const sortedOutputs = [...d.all_outputs]
            .sort((a, b) => +b.output_value_BTC - +a.output_value_BTC);
        const sortedValues = sortedOutputs.map(o => +o.output_value_BTC);
        const barColors = sortedValues.map(v =>
            v === maxOut ? '#ff5c5c' : v === minOut ? '#2ecc71' : '#378add'
        );

        const rowsHtml = sortedOutputs.map((out) => {
            const v = +out.output_value_BTC;
            const color = v === maxOut ? '#ff5c5c' : v === minOut ? '#2ecc71' : '#7a8fa6';
            return `<tr>
                <td style="word-break:break-all; white-space:normal; max-width:260px;">${out.output_address}</td>
                <td style="color:${color}; white-space:nowrap;">${v.toFixed(6)}</td>
            </tr>`;
        }).join('');

        content.html(`
            <div class="hash-box">
                <div class="hash-label">Hash</div>
                <div class="hash-value">${d.transaction_hash}</div>
            </div>

            <div class="panel-metrics">
                <div class="metric-chip">
                    <div class="chip-label">Volume</div>
                    <div class="chip-value">${d.totalVolume.toFixed(4)}</div>
                    <div class="chip-unit">BTC</div>
                </div>
                <div class="metric-chip">
                    <div class="chip-label">Max out</div>
                    <div class="chip-value" style="color:#ff5c5c;">${maxOut.toFixed(4)}</div>
                    <div class="chip-unit">BTC</div>
                </div>
                <div class="metric-chip">
                    <div class="chip-label">Min out</div>
                    <div class="chip-value" style="color:#2ecc71;">${minOut.toFixed(4)}</div>
                    <div class="chip-unit">BTC</div>
                </div>
                <div class="metric-chip metric-gap">
                    <div class="chip-label" style="color:#f7931a99;">Gap</div>
                    <div class="chip-value" style="color:#f7931a;">${gap.toFixed(4)}</div>
                    <div class="chip-unit" style="color:#f7931a66;">BTC</div>
                </div>
            </div>

            <div class="section-label">Output gap chart — ${d.all_outputs.length} outputs</div>
            <div style="position:relative; height:110px; margin-bottom:8px;">
                <canvas id="gap-bar-chart" role="img" aria-label="Bar chart of output values"></canvas>
            </div>
            <div style="display:flex; gap:16px; font-size:10px; color:#444; margin-bottom:18px;">
                <span style="display:flex;align-items:center;gap:5px;">
                    <span style="width:8px;height:8px;border-radius:2px;background:#ff5c5c;display:inline-block;"></span>Max
                </span>
                <span style="display:flex;align-items:center;gap:5px;">
                    <span style="width:8px;height:8px;border-radius:2px;background:#2ecc71;display:inline-block;"></span>Min
                </span>
                <span style="display:flex;align-items:center;gap:5px;">
                    <span style="width:8px;height:8px;border-radius:2px;background:#378add;display:inline-block;"></span>Others
                </span>
            </div>

            <div class="section-label">Outputs <span style="color:#2a2b36;">${d.all_outputs.length}</span></div>
            <div class="output-table-wrap">
                <table class="output-table">
                    <thead>
                        <tr>
                            <th>Address</th>
                            <th>Value (BTC)</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `);

        panel.classed("open", true);

        requestAnimationFrame(() => {
            const canvas = document.getElementById('gap-bar-chart');
            if (!canvas) return;
            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();

            new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: sortedValues.map((_, i) => `#${i + 1}`),
                    datasets: [{
                        data: sortedValues,
                        backgroundColor: barColors,
                        borderRadius: 4,
                        borderSkipped: false,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#1e1f28',
                            borderColor: '#2a2b36',
                            borderWidth: 1,
                            titleColor: '#888',
                            bodyColor: '#e0e0e0',
                            callbacks: {
                                title: items => sortedOutputs[items[0].dataIndex]
                                    .output_address.substring(0, 22) + '…',
                                label: ctx => `${ctx.raw.toFixed(6)} BTC`
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#444', font: { size: 10 } },
                            grid: { color: '#1e1f28' },
                            border: { color: '#2a2b36' }
                        },
                        y: {
                            ticks: {
                                color: '#444',
                                font: { size: 10 },
                                callback: v => v >= 1 ? v.toFixed(1) : v.toFixed(2)
                            },
                            grid: { color: '#1e1f28' },
                            border: { color: '#2a2b36' }
                        }
                    }
                }
            });
        });
    }
}
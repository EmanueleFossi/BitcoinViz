const EF_CSV = "data_cleaned/bitcoin_filtered.csv";

async function initExplorativeFlow() {
    const chartArea = d3.select("#chart-area");
    chartArea.selectAll("*").remove();
    d3.select("#filter-controls-container").selectAll("*").remove();
    d3.selectAll(".ef-tooltip").remove();

    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) applyBtn.style.display = 'none';

    chartArea.append("p").attr("class","loading-text").text("Loading UTXO flow data…");

    try {
        const raw = await d3.csv(EF_CSV, d => {
            let timeStr = d.time ? d.time.trim() : "";
            if (!timeStr) return null;

            let parsedDate;
            if (timeStr.includes("T") || timeStr.includes("Z")) {
                parsedDate = new Date(timeStr);
            } else if (timeStr.includes(" ")) {
                parsedDate = new Date(timeStr.replace(" ", "T") + "Z");
            } else {
                parsedDate = new Date(timeStr + "T00:00:00Z");
            }

            if (isNaN(parsedDate.getTime())) parsedDate = new Date(timeStr);
            if (isNaN(parsedDate.getTime())) {
                console.warn("Data non valida, riga saltata:", d.time);
                return null;
            }

            return {
                hash:        d.transaction_hash ? d.transaction_hash.trim() : "unknown",
                time:        parsedDate,
                btc_out:    +d.output_value_BTC || 0,
                out_address: d.output_address ? d.output_address.trim() : "unknown",
                in_addresses: (d.input_addresses || "")
                                .split(",").map(a => a.trim()).filter(a => a.length > 0)
            };
        });

        const cleanedRaw = raw.filter(Boolean);
        if (!cleanedRaw.length) throw new Error("Nessun dato temporale valido trovato.");

        chartArea.selectAll("*").remove();

        const chart = new ExplorativeFlowChart(chartArea, cleanedRaw);
        buildExplorativeSidebar(chart);

    } catch (err) {
        console.error("ExplorativeFlow error:", err);
        d3.select("#chart-area").html(`
            <div style="color:#F43F5E;padding:24px;border:1px solid #F43F5E;
                        border-radius:8px;margin:20px;background:rgba(244,63,94,0.06)">
                <b>Errore caricamento dati</b><br><br>${err.message}
            </div>
        `);
    }
}

function buildExplorativeSidebar(chart) {
    const container = d3.select("#filter-controls-container");
    container.selectAll("*").remove();

    const lbl = (text) => container.append("label")
        .text(text)
        .style("color","#888").style("font-size","11px")
        .style("margin-top","10px").style("display","block");

    lbl("Search Address:");
    const addrInput = container.append("input")
        .attr("type","text").attr("class","filter-input")
        .attr("placeholder","Input o output address…")
        .style("width","100%").style("box-sizing","border-box");

    lbl("Remove Address:");
    const excludeInput = container.append("input")
        .attr("type","text").attr("class","filter-input")
        .attr("placeholder","Address to exclude…")
        .style("width","100%").style("box-sizing","border-box");

    lbl("Minimum BTC visible:");
    const sliderLabel = container.append("div")
        .style("font-size","10px").style("color","#F7931A")
        .style("margin-bottom","4px").text("0 BTC");

    container.append("input")
        .attr("type","range").attr("min", 0).attr("max", 500).attr("value", 0)
        .style("width","100%")
        .on("input", function() {
            chart.btcThreshold = +this.value;
            sliderLabel.text(`${(+this.value).toFixed(0)} BTC`);
            chart.update(d3.zoomTransform(chart.svgEl.node()).k, false);
        });

    lbl("Maximum gap (hours):");
    const gapRow = container.append("div")
        .style("display","flex").style("align-items","center").style("gap","8px");

    const gapEnabled = gapRow.append("input")
        .attr("type","checkbox")
        .style("cursor","pointer").style("flex-shrink","0");

    const gapInput = gapRow.append("input")
        .attr("type","number").attr("placeholder","es. 6").attr("min","1")
        .attr("class","filter-input")
        .style("width","100%").style("box-sizing","border-box");

    lbl("Minimum jumps largest output:");
    const hopsRow = container.append("div")
        .style("display","flex").style("align-items","center").style("gap","8px");

    const hopsEnabled = hopsRow.append("input")
        .attr("type","checkbox")
        .style("cursor","pointer").style("flex-shrink","0");

    const hopsInput = hopsRow.append("input")
        .attr("type","number").attr("placeholder","es. 2").attr("min","1")
        .attr("class","filter-input")
        .style("width","100%").style("box-sizing","border-box");

    container.append("button")
        .text("Apply Filters")
        .attr("class","apply-btn")
        .style("width","100%").style("margin-top","14px")
        .on("click", () => {
            chart.applyFilters({
                query:   addrInput.property("value").trim().toLowerCase(),
                exclude: excludeInput.property("value").trim().toLowerCase(),
                minB:    0,
                maxB:    Infinity,
                maxGapH: gapEnabled.property("checked") && gapInput.property("value")
                            ? +gapInput.property("value") : Infinity,
                minHops: hopsEnabled.property("checked") && hopsInput.property("value")
                            ? +hopsInput.property("value") : 0
            });
        });
}
class FilterManager {
    constructor(data, onFilterChange, container) {
        this.originalData = data;
        this.onFilterChange = onFilterChange;
        this.container = container || d3.select("#dynamic-controls");
        
        this.renderingLimit = 5000; // Alzato: le TX sono meno degli output
        this.unbalancedThreshold = 1; 
        this.minSingleOutput = 0; 
        this.topRatioThreshold = 1; 
        this.onlySpentInPeriod = false; 

        // Raggruppiamo i dati una volta sola nel costruttore per performance
        this.aggregatedTransactions = this.precomputeStats(data);

        this.filterState = {
            minInputs: 0,
            maxInputs: d3.max(this.aggregatedTransactions, d => d.inputs),
            minOutputs: 0,
            maxOutputs: d3.max(this.aggregatedTransactions, d => d.outputs)
        };

        this.init();
    }

    precomputeStats(data) {
        const groups = d3.group(data, d => d.transaction_hash);
        const txList = [];
        
        groups.forEach((outputs, hash) => {
            const values = outputs.map(d => +d.output_value_BTC).sort((a, b) => b - a);
            const numInputs = Number(outputs[0].transaction_inputs) || 0;
            const numOutputs = outputs.length;

            let topRatio = 1;
            if (values.length >= 2 && values[1] > 0) {
                topRatio = values[0] / values[1];
            }

            let isSpentInPeriod = false;
            if (typeof globalSpentSet !== 'undefined' && globalSpentSet) {
                isSpentInPeriod = outputs.some(out => globalSpentSet.has(out.output_address));
            }

            txList.push({
                transaction_hash: hash,
                time: outputs[0].time instanceof Date ? outputs[0].time : new Date(outputs[0].time),
                maxSingleVal: values[0],
                minSingleVal: values[values.length - 1],
                totalVolume: d3.sum(values),
                ratio: (values[values.length - 1] > 0 && numOutputs > 1) ? (values[0] / values[values.length - 1]) : 1,
                topRatio: topRatio,
                inputs: numInputs,
                outputs: numOutputs,
                wasSpent: isSpentInPeriod,
                totalInputBTC: outputs[0].total_input_value_BTC,
                all_outputs: outputs
            });
        });

        return txList;
    }

    init() {
    this.container.selectAll("*").remove();
    const wrapper = this.container.append("div").attr("class", "filter-wrapper");

    const ubSection = wrapper.append("div").attr("class", "filter-section");
    ubSection.append("label").text("Max / Min ratio");
    this.ubInput = ubSection.append("input").attr("type", "number").attr("min", 1).attr("step", 0.1).attr("value", 1);

    const trSection = wrapper.append("div").attr("class", "filter-section");
    trSection.append("label").text("1° / 2° Output Ratio");
    this.trInput = trSection.append("input").attr("type", "number").attr("min", 1).attr("step", 0.1).attr("value", 1);

    const minValSection = wrapper.append("div").attr("class", "filter-section");
    minValSection.append("label").text("Minimum Output (BTC)");
    this.minValInput = minValSection.append("input").attr("type", "number").attr("min", 0).attr("step", 0.01).attr("value", 0);

    const inSection = wrapper.append("div").attr("class", "filter-section");
    inSection.append("label").text("Inputs (min – max)");
    const inRow = inSection.append("div").style("display", "flex").style("gap", "6px");
    this.minIn = inRow.append("input").attr("type", "number").attr("value", 0).attr("placeholder", "min");
    this.maxIn = inRow.append("input").attr("type", "number").attr("value", this.filterState.maxInputs).attr("placeholder", "max");

    const outSection = wrapper.append("div").attr("class", "filter-section");
    outSection.append("label").text("Outputs (min – max)");
    const outRow = outSection.append("div").style("display", "flex").style("gap", "6px");
    this.minOut = outRow.append("input").attr("type", "number").attr("value", 0).attr("placeholder", "min");
    this.maxOut = outRow.append("input").attr("type", "number").attr("value", this.filterState.maxOutputs).attr("placeholder", "max");

    const spentRow = wrapper.append("label").style("display", "flex").style("align-items", "center").style("gap", "7px").style("font-size", "11px").style("color", "#6b7280").style("cursor", "pointer");
    this.spentCheck = spentRow.append("input").attr("type", "checkbox").attr("id", "spent-check");
    spentRow.append("span").text("Spent in period");

    this.infoArea = wrapper.append("div").attr("class", "filter-info");

    const inputs = [this.ubInput, this.trInput, this.minValInput, this.minIn, this.maxIn, this.minOut, this.maxOut, this.spentCheck];
    inputs.forEach(el => el.on("input", () => this.updatePreview()));
    this.updatePreview();

    // Collega il bottone Applica esterno (nel footer sidebar)
    const applyBtn = document.getElementById('apply-filters-btn');
    if (applyBtn) {
        applyBtn.style.display = 'block';
        applyBtn.onclick = () => this.onFilterChange(this.applyFilters());
    }
}

updatePreview() {
    this.unbalancedThreshold = +this.ubInput.property("value") || 1;
    this.topRatioThreshold   = +this.trInput.property("value") || 1;
    this.minSingleOutput     = +this.minValInput.property("value") || 0;
    this.filterState.minInputs  = +this.minIn.property("value") || 0;
    this.filterState.maxInputs  = +this.maxIn.property("value") || 0;
    this.filterState.minOutputs = +this.minOut.property("value") || 0;
    this.filterState.maxOutputs = +this.maxOut.property("value") || 0;
    this.onlySpentInPeriod = this.spentCheck.property("checked");

    const filtered = this.applyFilters();
    const countEl = document.getElementById('tx-count-val');
    if (countEl) countEl.textContent = filtered.length.toLocaleString('it-IT');
    this.infoArea.html('');
}

    triggerUpdate() {
        if (this.onFilterChange) {
            this.onFilterChange(this.applyFilters());
        }
    }

    applyFilters() {
        const filtered = this.aggregatedTransactions.filter(tx => {
            const matchUnbalanced = tx.ratio >= this.unbalancedThreshold;
            const matchTopRatio = tx.topRatio >= this.topRatioThreshold;
            const matchMinVal = tx.maxSingleVal >= this.minSingleOutput;
            const matchInputs = tx.inputs >= this.filterState.minInputs && tx.inputs <= this.filterState.maxInputs;
            const matchOutputs = tx.outputs >= this.filterState.minOutputs && tx.outputs <= this.filterState.maxOutputs;
            const matchSpent = !this.onlySpentInPeriod || tx.wasSpent;

            return matchUnbalanced && matchTopRatio && matchMinVal && matchInputs && matchOutputs && matchSpent;
        });
        return filtered;
    }
}
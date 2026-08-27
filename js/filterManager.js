class FilterManager {
    constructor(data, onFilterChange, container) {
        this.originalData = data;
        this.onFilterChange = onFilterChange;
        this.container = container || d3.select("#dynamic-controls");
        
        this.renderingLimit = 5000;
        this.minSingleOutput = 0;        // Minimum threshold on the TX's maximum output
        this.maxSingleOutput = Infinity; // Maximum threshold on the TX's maximum output
        this.minMinOutput    = 0;        // Minimum threshold on the TX's minimum output
        this.maxMinOutput    = Infinity; // Maximum threshold on the TX's minimum output
        this.onlySpentInPeriod = false; 

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
                time:             outputs[0].time instanceof Date ? outputs[0].time : new Date(outputs[0].time),
                source_file:      outputs[0].source_file ?? "",
                maxSingleVal:     values[0],
                minSingleVal:     values[values.length - 1],
                totalVolume:      d3.sum(values),
                ratio:            (values[values.length - 1] > 0 && numOutputs > 1) ? (values[0] / values[values.length - 1]) : 1,
                topRatio:         topRatio,
                inputs:           numInputs,
                outputs:          numOutputs,
                wasSpent:         isSpentInPeriod,
                totalInputBTC:    outputs[0].total_input_value_BTC,
                all_outputs:      outputs
            });
        });

        return txList;
    }
init() {
        this.container.selectAll("*").remove();
        const wrapper = this.container.append("div").attr("class", "filter-wrapper");

        // ── Date range (Start date / End date) ────────────────────
        // Only matters when Export/Apply sends filters to the backend —
        // the live Dot Chart preview still shows just the single day
        // picked in the Day dropdown, since that's all that's loaded here.
        const dateSection = wrapper.append("div").attr("class", "filter-section");
        dateSection.append("label").text("Date range (start – end)");
        const dateRow = dateSection.append("div").style("display", "flex").style("gap", "6px");
        this.startDateInput = dateRow.append("input")
            .attr("type", "date").attr("value", "2024-05-24")
            .attr("class", "fp-date-input");
        this.endDateInput = dateRow.append("input")
            .attr("type", "date").attr("value", "2024-06-05")
            .attr("class", "fp-date-input");

       // ── Largest Output range (min – max) ────────────────────────
        const largestSection = wrapper.append("div").attr("class", "filter-section");
        largestSection.append("label").text("Largest Output (min – max BTC)");
        const largestRow = largestSection.append("div").style("display", "flex").style("gap", "6px");
        this.minValInput = largestRow.append("input").attr("type", "number").attr("min", 0).attr("step", 0.01).attr("value", 0).attr("placeholder", "min");
        this.maxValInput = largestRow.append("input").attr("type", "number").attr("min", 0).attr("step", 0.01).attr("value", "").attr("placeholder", "no limit");

        // ── Smallest Output range (min – max) ← NUOVO ────────────────
        const smallestSection = wrapper.append("div").attr("class", "filter-section");
        smallestSection.append("label").text("Smallest Output (min – max BTC)");
        const smallestRow = smallestSection.append("div").style("display", "flex").style("gap", "6px");
        this.minMinInput = smallestRow.append("input").attr("type", "number").attr("min", 0).attr("step", 0.01).attr("value", 0).attr("placeholder", "min");
        this.maxMinInput = smallestRow.append("input").attr("type", "number").attr("min", 0).attr("step", 0.01).attr("value", "").attr("placeholder", "no limit");

        // ── Inputs range ──────────────────────────────────────────
        const inSection = wrapper.append("div").attr("class", "filter-section");
        inSection.append("label").text("Inputs (min – max)");
        const inRow = inSection.append("div").style("display", "flex").style("gap", "6px");
        this.minIn = inRow.append("input").attr("type", "number").attr("value", 0).attr("placeholder", "min");
        this.maxIn = inRow.append("input").attr("type", "number").attr("value", this.filterState.maxInputs).attr("placeholder", "max");

        // ── Outputs range ─────────────────────────────────────────
        const outSection = wrapper.append("div").attr("class", "filter-section");
        outSection.append("label").text("Outputs (min – max)");
        const outRow = outSection.append("div").style("display", "flex").style("gap", "6px");
        this.minOut = outRow.append("input").attr("type", "number").attr("value", 0).attr("placeholder", "min");
        this.maxOut = outRow.append("input").attr("type", "number").attr("value", this.filterState.maxOutputs).attr("placeholder", "max");

        // ── Spent in period ───────────────────────────────────────
        const spentRow = wrapper.append("label")
            .style("display", "flex").style("align-items", "center")
            .style("gap", "7px").style("font-size", "11px")
            .style("color", "#6b7280").style("cursor", "pointer");
        this.spentCheck = spentRow.append("input").attr("type", "checkbox").attr("id", "spent-check");
        spentRow.append("span").text("Spent in period");

        this.infoArea = wrapper.append("div").attr("class", "filter-info");

        // ── Listeners ─────────────────────────────────────────────
       const inputs = [
            this.minValInput, this.maxValInput,
            this.minMinInput, this.maxMinInput,
            this.minIn, this.maxIn,
            this.minOut, this.maxOut,
            this.spentCheck,
            this.startDateInput, this.endDateInput
        ];
        inputs.forEach(el => el.on("input", () => this.updatePreview()));
        this.updatePreview();

        // Bottone Apply esterno (footer sidebar)
        const applyBtn = document.getElementById('apply-filters-btn');
        if (applyBtn) {
            applyBtn.style.display = 'block';
            applyBtn.onclick = () => this.onFilterChange(this.applyFilters());
        }
    }

   updatePreview() {
        this.startDate = this.startDateInput.property("value") || null;
        this.endDate   = this.endDateInput.property("value") || null;

       this.minSingleOutput = +this.minValInput.property("value") || 0;
        this.maxSingleOutput = +this.maxValInput.property("value") || Infinity;
        this.minMinOutput    = +this.minMinInput.property("value") || 0;
        this.maxMinOutput    = +this.maxMinInput.property("value") || Infinity;   // NEW
        this.filterState.minInputs  = +this.minIn.property("value")     || 0;
        this.filterState.maxInputs  = +this.maxIn.property("value")     || 0;
        this.filterState.minOutputs = +this.minOut.property("value")    || 0;
        this.filterState.maxOutputs = +this.maxOut.property("value")    || 0;
        this.onlySpentInPeriod      = this.spentCheck.property("checked");

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
        return this.aggregatedTransactions.filter(tx => {
           const matchMinVal = tx.maxSingleVal >= this.minSingleOutput;
            const matchMaxVal = tx.maxSingleVal <= this.maxSingleOutput;
            const matchMinMin = tx.minSingleVal >= this.minMinOutput;
            const matchMaxMin = tx.minSingleVal <= this.maxMinOutput;   // NEW
            const matchInputs     = tx.inputs  >= this.filterState.minInputs  && tx.inputs  <= this.filterState.maxInputs;
            const matchOutputs    = tx.outputs >= this.filterState.minOutputs && tx.outputs <= this.filterState.maxOutputs;
            const matchSpent      = !this.onlySpentInPeriod || tx.wasSpent;

           return  matchMinVal && matchMaxVal
                && matchMinMin && matchMaxMin
                && matchInputs && matchOutputs && matchSpent;
        });
    }

   getFilterParams() {
        return {
            startDate:           this.startDate || null,
            endDate:             this.endDate || null,
            minSingleOutput:     this.minSingleOutput,
            maxSingleOutput:     this.maxSingleOutput,
            minMinOutput:        this.minMinOutput,
            maxMinOutput:        this.maxMinOutput,   // NEW
            filterState:         { ...this.filterState },
            onlySpentInPeriod:   this.onlySpentInPeriod,
        };
    }
}
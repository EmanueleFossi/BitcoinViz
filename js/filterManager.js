class FilterManager {
    constructor(data, onFilterChange) {
        this.originalData = data;
        this.onFilterChange = onFilterChange; // Callback per aggiornare il grafico
        this.hideSingleOutput = false;

        this.init();
    }

    init() {
        const container = d3.select("#dynamic-controls");
        
        // Creazione bottone filtro
        this.filterBtn = container.append("button")
            .attr("class", "btn-secondary")
            .text("Mostra solo Split (>1 output)")
            .on("click", () => this.toggleSingleOutputFilter());
    }

    toggleSingleOutputFilter() {
        this.hideSingleOutput = !this.hideSingleOutput;
        
        // Aggiorna stile bottone
        this.filterBtn.classed("active", this.hideSingleOutput);
        this.filterBtn.text(this.hideSingleOutput ? "Mostrando solo Split" : "Mostra solo Split (>1 output)");

        // Applica il filtro e comunica il cambiamento
        const filtered = this.applyFilters();
        this.onFilterChange(filtered);
    }

    applyFilters() {
        let data = [...this.originalData];

        if (this.hideSingleOutput) {
            // Conta quanti output ha ogni transazione
            const counts = d3.rollup(data, v => v.length, d => d.transaction_hash);
            // Tieni solo le transazioni che appaiono più di una volta
            data = data.filter(d => counts.get(d.transaction_hash) > 1);
        }

        return data;
    }
}
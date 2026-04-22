class ChartDotPlot {
    constructor(selector, data) {
        this.selector = selector;
        this.data = data;
        this.selectedTxHash = null;
        this.margin = { top: 50, right: 50, bottom: 60, left: 80 };
        
        const container = d3.select(this.selector).node();
        this.width = container.getBoundingClientRect().width - this.margin.left - this.margin.right;
        this.height = container.getBoundingClientRect().height - this.margin.top - this.margin.bottom;

        this.init();
    }

    init() {
        d3.select(this.selector).selectAll("*").remove();
        
        this.svgElement = d3.select(this.selector)
            .append("svg")
            .attr("class", "svg-container") 
            .attr("width", this.width + this.margin.left + this.margin.right)
            .attr("height", this.height + this.margin.top + this.margin.bottom);

        // Rettangolo invisibile per catturare lo zoom su tutta l'area
        this.zoomRect = this.svgElement.append("rect")
            .attr("width", this.width + this.margin.left + this.margin.right)
            .attr("height", this.height + this.margin.top + this.margin.bottom)
            .attr("fill", "none")
            .attr("pointer-events", "all");

        this.svg = this.svgElement.append("g")
            .attr("transform", `translate(${this.margin.left},${this.margin.top})`);

        this.svg.append("defs").append("clipPath")
            .attr("id", "clip")
            .append("rect")
            .attr("width", this.width)
            .attr("height", this.height);

        this.processData();
        this.setupScales();
        this.render();
        this.setupZoom();
    }

   processData() {
        this.data.forEach(d => {
            d.output_value_BTC = +d.output_value_BTC;
            
            // FIX FUSO ORARIO: Forza D3 a leggere la data come UTC se è una stringa
            if (!(d.time instanceof Date)) {
                // Se la stringa non ha Z o +00:00, la aggiungiamo per forzare UTC
                let timeStr = d.time;
                if (!timeStr.includes('Z') && !timeStr.includes('+')) {
                    timeStr += 'Z'; 
                }
                d.time = new Date(timeStr);
            }
            d.is_outlier_bool = String(d.is_outlier).toLowerCase() === "true" || d.is_outlier === true;
        });
    }

    // --- AGGIUNTA/MODIFICA: Metodo per aggiornare i dati esternamente ---
    updateData(newData) {
        this.data = newData;
        this.processData();
        
        // Se la transazione selezionata non esiste più nei nuovi dati, resetta
        if (this.selectedTxHash) {
            const exists = this.data.some(d => d.transaction_hash === this.selectedTxHash);
            if (!exists) this.selectedTxHash = null;
        }

        // Ricalcoliamo le scale per adattarle ai nuovi dati (opzionale, ma consigliato)
        this.setupScales(true); 
        this.updateElements(this.xScale, this.yScale);
    }

    setupScales(isUpdate = false) {
    // 1. Prepariamo i dati
    const outlierHashes = new Set(this.data.filter(d => d.is_outlier_bool).map(d => d.transaction_hash));
    const initialView = this.data.filter(d => outlierHashes.has(d.transaction_hash));

    if (initialView.length === 0) return;

    // 2. Calcolo dominio asse X in UTC
    // Usiamo d3.utcDay per ignorare il fuso orario del browser (CET/CEST)
    const baseDate = new Date(initialView[0].time);
    const startOfDay = d3.utcDay.floor(baseDate); 
    const endOfDay = d3.utcDay.offset(startOfDay, 1);

    // Cambiato scaleTime in scaleUtc per coerenza con i dati blockchain
    this.xScale = d3.scaleUtc()
        .domain([startOfDay, endOfDay])
        .range([0, this.width]);

    // 3. Calcolo dominio asse Y (Logaritmico)
    this.yScale = d3.scaleLog()
        .domain([
            d3.min(initialView, d => d.output_value_BTC) || 0.0001, 
            d3.max(initialView, d => d.output_value_BTC)
        ])
        .range([this.height, 0])
        .nice();

    // 4. Configurazione Assi
    // Usiamo utcFormat per mostrare le ore correttamente senza salti di giorno
    this.xAxis = d3.axisBottom(this.xScale)
        .tickSize(-this.height)
        .tickFormat(d3.utcFormat("%H:%M")); 

    this.yAxis = d3.axisLeft(this.yScale)
        .ticks(10, ".1e")
        .tickSize(-this.width);

    // 5. Rendering o Aggiornamento
    if (!isUpdate) {
        this.svg.selectAll(".axis").remove();

        this.gX = this.svg.append("g")
            .attr("class", "axis x-axis")
            .attr("transform", `translate(0,${this.height})`)
            .call(this.xAxis);

        this.gY = this.svg.append("g")
            .attr("class", "axis y-axis")
            .call(this.yAxis);
    } else {
        this.gX.transition().duration(500).call(this.xAxis);
        this.gY.transition().duration(500).call(this.yAxis);
    }
}
render() {
    // Gruppo per le linee (con clip-path per tagliare fuori dai bordi)
    this.linkGroup = this.svg.append("g")
        .attr("class", "links-group")
        .attr("clip-path", "url(#clip)");
    
    // Gruppo per i punti (con clip-path per tagliare fuori dai bordi)
    this.dotGroup = this.svg.append("g")
        .attr("class", "dots-group")
        .attr("clip-path", "url(#clip)");

    this.updateElements(this.xScale, this.yScale);
}

    updateElements(newX, newY) {
    // MODIFICA: Ora visibleData contiene SEMPRE tutti gli outlier e i loro fratelli,
    // a prescindere che ci sia una selezione o meno.
    const outlierHashes = new Set(this.data.filter(d => d.is_outlier_bool).map(d => d.transaction_hash));
    let visibleData = this.data.filter(d => outlierHashes.has(d.transaction_hash));

    // Comunichiamo all'SVG se c'è una selezione attiva
    this.svgElement.classed("has-selection", !!this.selectedTxHash);

    // 1. LINEE VERTICALI
    const hashGroups = Array.from(d3.group(visibleData, d => d.transaction_hash));
    const internalLinks = this.linkGroup.selectAll(".internal-link")
        .data(hashGroups.filter(g => g[1].length > 1), d => d[0]);

    internalLinks.exit().remove();

    internalLinks.enter()
        .append("line")
        .attr("class", "internal-link")
        .merge(internalLinks)
        // Aggiungiamo is-active se la linea appartiene alla TX selezionata
        .classed("is-active", d => d[0] === this.selectedTxHash)
        .attr("x1", d => newX(d[1][0].time))
        .attr("x2", d => newX(d[1][0].time))
        .attr("y1", d => newY(d3.max(d[1], p => p.output_value_BTC)))
        .attr("y2", d => newY(d3.min(d[1], p => p.output_value_BTC)));

    // 2. PUNTI
    const dots = this.dotGroup.selectAll(".dot")
        .data(visibleData, d => d.output_address + d.transaction_hash + d.output_value_BTC);

    dots.exit().remove();

    const dotsEnter = dots.enter()
        .append("circle")
        .attr("class", "dot")
        .attr("data-is-outlier", d => String(d.is_outlier_bool))
        .on("click", (event, d) => {
            this.selectedTxHash = (this.selectedTxHash === d.transaction_hash) ? null : d.transaction_hash;
            if (typeof this.showDetails === "function" && this.selectedTxHash) this.showDetails(d);
            this.updateElements(newX, newY);
        });

    dotsEnter.merge(dots)
        .attr("cx", d => newX(d.time))
        .attr("cy", d => newY(d.output_value_BTC))
        .attr("r", d => d.is_outlier_bool ? 8 : 5)
        // Classi per l'evidenziazione
        .classed("is-selected", d => d.is_outlier_bool && d.transaction_hash === this.selectedTxHash)
        .classed("is-related", d => !d.is_outlier_bool && d.transaction_hash === this.selectedTxHash);
}

    setupZoom() {
        const zoom = d3.zoom()
            .scaleExtent([0.8, 40])
            .translateExtent([[-1000, -1000], [this.width + 1000, this.height + 1000]])
            .on("zoom", (event) => {
                const newX = event.transform.rescaleX(this.xScale);
                const newY = event.transform.rescaleY(this.yScale);
                
                this.gX.call(this.xAxis.scale(newX));
                this.gY.call(this.yAxis.scale(newY));
                
                this.updateElements(newX, newY);
            });
        
        this.svgElement.call(zoom);
        this.svgElement.on("dblclick.zoom", null);
    }
}
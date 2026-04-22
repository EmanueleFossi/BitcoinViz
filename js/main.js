let currentType = 'scatter'; 
let chartInstance = null; // Memorizziamo l'istanza del grafico attuale
let filterManager = null; // Memorizziamo l'istanza del filtro

async function loadDataAndDraw(fileName) {
    d3.select("#viz-container").selectAll("p").remove();

    try {
        console.log("Caricamento file:", fileName);
        const rawData = await d3.csv(`data_filtered/${fileName}`);
        
        const cleanData = rawData.map(d => ({
            ...d,
            time: d3.timeParse("%Y-%m-%d %H:%M:%S%Z")(d.time) || new Date(d.time),
            output_value_BTC: +d.output_value_BTC,
            total_input_value_BTC: +d.total_input_value_BTC
        }));

        if (currentType === 'scatter') {
            // 1. Creiamo il grafico
            chartInstance = new ChartDotPlot("#viz-container", cleanData);

            // 2. Inizializziamo (o resettiamo) il FilterManager
            // Rimuoviamo vecchi bottoni del filtro se esistenti
            d3.select("#filter-controls-container").remove(); 
            const filterContainer = d3.select("#dynamic-controls")
                .append("div")
                .attr("id", "filter-controls-container");

            filterManager = new FilterManager(cleanData, (filteredData) => {
                // Questa funzione viene chiamata dal FilterManager quando il bottone viene cliccato
                if (chartInstance && currentType === 'scatter') {
                    chartInstance.updateData(filteredData);
                }
            }, filterContainer); // Passiamo il container specifico

        } else {
            chartInstance = new ChartStackedBarChart("#viz-container", cleanData);
            filterManager = null; // I filtri specifici del dot plot non servono qui
        }
    } catch (err) {
        console.error("Errore critico caricamento:", err);
        d3.select("#viz-container").html(`<p style="color:red; padding: 20px;"><b>Errore con il file ${fileName}</b><br><br>Dettaglio errore: <code>${err.message}</code></p>`);
    }
}

function switchChart(type) {
    currentType = type;
    const btn = d3.select("#toggle-btn");
    const controls = d3.select("#dynamic-controls");
    
    controls.selectAll("*").remove();

    if (type === 'scatter') {
        btn.text("Passa a Stacked Bar").on("click", () => switchChart('stacked'));

        const select = controls.append("select")
            .attr("class", "day-selector")
            .on("change", (event) => loadDataAndDraw(event.target.value));

        const days = [
            { label: "24 Maggio", file: "filtered_Bitcoin_Data_2024_05_24.csv" },
            { label: "25 Maggio", file: "filtered_Bitcoin_Data_2024_05_25.csv" },
            { label: "26 Maggio", file: "filtered_Bitcoin_Data_2024_05_26.csv" },
            { label: "27 Maggio", file: "filtered_Bitcoin_Data_2024_05_27.csv" },
            { label: "28 Maggio", file: "filtered_Bitcoin_Data_2024_05_28.csv" },
            { label: "29 Maggio", file: "filtered_Bitcoin_Data_2024_05_29.csv" },
            { label: "30 Maggio", file: "filtered_Bitcoin_Data_2024_05_30.csv" },
            { label: "31 Maggio", file: "filtered_Bitcoin_Data_2024_05_31.csv" },
            { label: "01 Giugno", file: "filtered_Bitcoin_Data_2024_06_01.csv" },
            { label: "02 Giugno", file: "filtered_Bitcoin_Data_2024_06_02.csv" },
            { label: "03 Giugno", file: "filtered_Bitcoin_Data_2024_06_03.csv" },
            { label: "04 Giugno", file: "filtered_Bitcoin_Data_2024_06_04.csv" },
            { label: "05 Giugno", file: "filtered_Bitcoin_Data_2024_06_05.csv" }
        ];

        select.selectAll("option")
            .data(days).enter().append("option")
            .attr("value", d => d.file).text(d => d.label);

        select.property("value", days[days.length - 1].file);
        loadDataAndDraw(days[days.length - 1].file);

    } else {
        btn.text("Passa a Dot Plot").on("click", () => switchChart('scatter'));
        loadDataAndDraw("Bitcoin_Data_Summary.csv"); 
    }
}

switchChart('scatter');
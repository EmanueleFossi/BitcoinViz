function createClusters(data, targetPointsPerCluster = 500) {
    // 1. Definiamo le fasce di valore
    const tiers = [
        { id: "high", min: 500, max: Infinity, label: "> 500 BTC", yCenter: 750 },
        { id: "mid", min: 100, max: 500, label: "100-500 BTC", yCenter: 300 },
        { id: "low", min: 0, max: 100, label: "< 100 BTC", yCenter: 50 }
    ];

    const clusters = [];

    tiers.forEach(tier => {
        // Filtriamo le transazioni che cadono in questa fascia di valore
        const tierData = data.filter(d => {
            const val = +d.maxSingleVal; // Usiamo il valore massimo della TX
            return val >= tier.min && val < tier.max;
        });

        if (tierData.length === 0) return;

        // Ordiniamo per tempo
        tierData.sort((a, b) => a.time - b.time);

        // 2. Suddivisione in fasce orarie dinamiche per rispettare il limite di ~500 TX
        let currentCluster = [];
        tierData.forEach((d, i) => {
            currentCluster.push(d);
            
            // Se raggiungiamo il limite o è l'ultimo elemento, chiudiamo il cluster
            if (currentCluster.length >= targetPointsPerCluster || i === tierData.length - 1) {
                const startTime = currentCluster[0].time;
                const endTime = currentCluster[currentCluster.length - 1].time;
                
                clusters.push({
                    id: `cluster-${tier.id}-${i}`,
                    tierId: tier.id,
                    count: currentCluster.length,
                    startTime: startTime,
                    endTime: endTime,
                    // Il punto grafico sarà al centro temporale del cluster
                    timeCenter: new Date((startTime.getTime() + endTime.getTime()) / 2),
                    yCenter: tier.yCenter,
                    transactions: [...currentCluster] // Salviamo le TX per il drill-down
                });
                currentCluster = [];
            }
        });
    });

    return clusters;
}
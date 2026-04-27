// ===== Chart.js Helpers =====

const CHART_COLORS = [
    '#fafafa', '#a1a1aa', '#52525b', '#3f3f46', '#27272a'
];

const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            labels: {
                color: '#a1a1aa',
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                padding: 16,
                boxWidth: 12
            }
        },
        tooltip: {
            backgroundColor: '#09090b',
            titleColor: '#fafafa',
            bodyColor: '#a1a1aa',
            borderColor: '#3f3f46',
            borderWidth: 1,
            cornerRadius: 0,
            titleFont: { family: "'JetBrains Mono', monospace", weight: '700' },
            bodyFont: { family: "'JetBrains Mono', monospace" },
            padding: 12
        }
    },
    scales: {
        x: {
            ticks: { color: '#52525b', font: { family: "'JetBrains Mono', monospace", size: 10 } },
            grid: { color: '#27272a', drawBorder: false }
        },
        y: {
            ticks: { color: '#52525b', font: { family: "'JetBrains Mono', monospace", size: 10 } },
            grid: { color: '#27272a', drawBorder: false }
        }
    }
};

// Store active chart instances for cleanup
const activeCharts = {};

function destroyChart(id) {
    if (activeCharts[id]) {
        activeCharts[id].destroy();
        delete activeCharts[id];
    }
}

function createLineChart(canvasId, labels, datasets) {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    activeCharts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: datasets.map((ds, i) => ({
                ...ds,
                borderColor: CHART_COLORS[i % CHART_COLORS.length],
                backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '20',
                borderWidth: 2,
                tension: 0.4,
                fill: true,
                pointRadius: 3,
                pointHoverRadius: 6
            }))
        },
        options: {
            ...CHART_DEFAULTS,
            interaction: { intersect: false, mode: 'index' }
        }
    });
}

function createBarChart(canvasId, labels, data, label = 'Value') {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    activeCharts[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label,
                data,
                backgroundColor: CHART_COLORS.map(c => c + '80'),
                borderColor: CHART_COLORS,
                borderWidth: 1,
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            ...CHART_DEFAULTS,
            plugins: {
                ...CHART_DEFAULTS.plugins,
                legend: { display: false }
            }
        }
    });
}

function createDoughnutChart(canvasId, labels, data) {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    activeCharts[canvasId] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: CHART_COLORS.map(c => c + 'CC'),
                borderColor: '#1a1f2e',
                borderWidth: 3,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#94a3b8',
                        font: { family: 'Inter', size: 12 },
                        padding: 12,
                        usePointStyle: true,
                        pointStyleWidth: 8
                    }
                },
                tooltip: CHART_DEFAULTS.plugins.tooltip
            }
        }
    });
}

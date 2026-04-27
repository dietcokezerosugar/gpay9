// ===== WebSocket Live Connection =====

const WS = {
    socket: null,
    listeners: [],
    reconnectDelay: 2000,

    connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = new WebSocket(`${protocol}//${location.host}`);

        this.socket.onopen = () => {
            this.updateStatus(true);
            console.log('[WS] Connected');
        };

        this.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.listeners.forEach(fn => fn(msg));
            } catch {}
        };

        this.socket.onclose = () => {
            this.updateStatus(false);
            console.log('[WS] Disconnected. Reconnecting...');
            setTimeout(() => this.connect(), this.reconnectDelay);
        };

        this.socket.onerror = () => {
            this.socket.close();
        };
    },

    onMessage(fn) {
        this.listeners.push(fn);
    },

    updateStatus(connected) {
        const el = document.getElementById('wsStatus');
        if (!el) return;

        const dot = el.querySelector('.status-dot');
        const text = el.querySelector('span:last-child');

        if (connected) {
            dot.className = 'status-dot connected';
            text.textContent = 'Live';
        } else {
            dot.className = 'status-dot disconnected';
            text.textContent = 'Disconnected';
        }
    }
};

// Start connection
WS.connect();

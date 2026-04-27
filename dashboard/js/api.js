// ===== REST API Client =====

const API = {
    getHeaders() {
        const token = localStorage.getItem('gpay_admin_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    },

    async handleResponse(res) {
        if (res.status === 401) {
            if (typeof App !== 'undefined' && App.showAuthWall) App.showAuthWall();
            throw new Error("Unauthorized");
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `API Error: ${res.status}`);
        }
        return res.json();
    },

    async get(url) {
        const res = await fetch(url, { headers: API.getHeaders() });
        return API.handleResponse(res);
    },

    async post(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: API.getHeaders(),
            body: JSON.stringify(data)
        });
        return API.handleResponse(res);
    },

    async put(url, data) {
        const res = await fetch(url, {
            method: 'PUT',
            headers: API.getHeaders(),
            body: JSON.stringify(data)
        });
        return API.handleResponse(res);
    },

    async delete(url) {
        const res = await fetch(url, { 
            method: 'DELETE',
            headers: API.getHeaders()
        });
        return API.handleResponse(res);
    },

    // ── Pre-Auth Login ──
    login: async (username, password) => {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!res.ok) throw new Error("Invalid credentials");
        return res.json();
    },

    // ── Accounts ──
    getAccounts: () => API.get('/api/accounts'),
    addAccount: (data) => API.post('/api/accounts', data),
    updateAccount: (name, data) => API.put(`/api/accounts/${name}`, data),
    deleteAccount: (name) => API.delete(`/api/accounts/${name}`),
    
    // ── Settings ──
    getSettings: () => API.get('/api/settings'),
    saveSettings: (data) => API.put('/api/settings', data),

    // ── Bots ──
    startBot: (name) => API.post(`/api/bots/${name}/start`),
    stopBot: (name) => API.post(`/api/bots/${name}/stop`),
    restartBot: (name) => API.post(`/api/bots/${name}/restart`),
    resetBotSession: (name) => API.post(`/api/bots/${name}/reset`),
    getBotStatus: () => API.get('/api/bots/status'),
    startFleet: () => API.post('/api/fleet/start'),
    stopFleet: () => API.post('/api/fleet/stop'),

    // ── Transactions ──
    getTransactions: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return API.get(`/api/transactions?${qs}`);
    },
    exportTransactions: async (params = {}) => {
        const qs = new URLSearchParams({ ...params, format: 'csv' }).toString();
        const res = await fetch(`/api/transactions/export?${qs}`, { headers: API.getHeaders() });
        if (!res.ok) throw new Error("Export failed");
        
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions_export_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    },

    // ── Analytics ──
    getSummary: () => API.get('/api/analytics/summary'),
    getHourly: (account) => API.get(`/api/analytics/hourly${account ? '?account=' + account : ''}`),
    getTopPayers: (limit = 10) => API.get(`/api/analytics/top-payers?limit=${limit}`),
    getDistribution: () => API.get('/api/analytics/distribution'),

    // ── Events ──
    getEvents: (account, limit = 100) => {
        const params = new URLSearchParams({ limit });
        if (account) params.set('account', account);
        return API.get(`/api/events?${params}`);
    }
};

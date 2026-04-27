const EventEmitter = require('events');
const axios = require('axios');

class GatewayClient extends EventEmitter {
    constructor({ accountName, logger }) {
        super();
        this.accountName = accountName;
        this.log = logger || console.log;


        this.connected = false;
        this.authenticated = false;
        this.assignedGateways = [];
    }

    connect() {
        throw new Error('connect() must be implemented by subclass');
    }

    disconnect() {
        throw new Error('disconnect() must be implemented by subclass');
    }

    getStatus() {
        throw new Error('getStatus() must be implemented by subclass');
    }

    sendAccountStatus(gatewayId, status, errorReason = null) {
        throw new Error('sendAccountStatus() must be implemented by subclass');
    }

    sendGatewayStart(gatewayId) {
        throw new Error('sendGatewayStart() must be implemented by subclass');
    }

    sendGatewayStop(gatewayId) {
        throw new Error('sendGatewayStop() must be implemented by subclass');
    }

    sendStopAll(reason) {
        throw new Error('sendStopAll() must be implemented by subclass');
    }

    sendTransaction(data) {
        throw new Error('sendTransaction() must be implemented by subclass');
    }

    async _reportRest(endpoint, data) {
        if (!this.baseUrl || !this.botToken) return;

        try {
            const url = `${this.baseUrl}${endpoint}`;
            const res = await axios.post(url, {
                ...data,
                connection_id: this.connectionId
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.botToken}`
                },
                timeout: 10000
            });

            if (res.data.status !== 'success') {
                this._log(`[REST] Reporting to ${endpoint} failed: ${res.data.message || 'Unknown error'}`);
            }
            return res.data;
        } catch (err) {
            this._log(`[REST] Error calling ${endpoint}: ${err.message}`);
            return null;
        }
    }


    _log(msg) {
        this.log(msg);
    }
}

module.exports = GatewayClient;


const Ably = require('ably');
const axios = require('axios');
const path = require('path');
const GatewayClient = require('./gateway-client');

class GatewayAblyClient extends GatewayClient {
    constructor(opts) {
        super(opts);
        this.baseUrl = opts.baseUrl;
        this.botToken = opts.botToken;
        this.projectId = opts.projectId;


        this.realtime = null;
        this.connectionId = null;
        this.channels = null;
        

        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.baseReconnectDelay = 2000;
        this.reconnectTimer = null;
        this.intentionalClose = false;


        this.heartbeatTimer = null;
        this.heartbeatIntervalMs = 60000;
        

        this.sessionFile = path.join(opts.sessionDir || '.', '.ably-session.json');


        this.pendingRequests = new Map();
    }

    async connect() {
        if (this.realtime && (this.realtime.connection.state === 'connected' || this.realtime.connection.state === 'connecting')) {
            return;
        }

        if (!this.baseUrl || !this.botToken) {
            this._log('[Ably] Missing baseUrl or botToken — cannot connect');
            return;
        }

        this.intentionalClose = false;
        this._loadSession();

        this._log(`[Ably] Bootstrapping via helper: ${this.baseUrl} (Session: ${this.connectionId || 'New'})`);

        try {

            const bootstrap = await this._fetchBootstrapData();
            
            const { ably, connection } = bootstrap.data;
            this.connectionId = connection.connection_id;
            this.channels = ably.channels;
            const initialTokenRequest = ably.token_request;


            this._saveSession();

            this._log(`[Ably] Bootstrap success. Connection ID: ${this.connectionId}`);




            this.realtime = new Ably.Realtime({
                authCallback: async (tokenParams, callback) => {
                    if (this.connected) {
                         this._log('[Ably] Token expired — fetching fresh token_request');
                         try {
                             const fresh = await this._fetchBootstrapData();
                             callback(null, fresh.data.ably.token_request);
                         } catch (e) {
                             callback(e, null);
                         }
                    } else {
                        callback(null, initialTokenRequest);
                    }
                },
                closeOnUnload: true
            });

            this.realtime.connection.on('connected', () => this._onConnected());
            this.realtime.connection.on('disconnected', () => this._onDisconnected());
            this.realtime.connection.on('failed', (err) => this._onFailed(err));
            this.realtime.connection.on('closed', () => this._onClosed());

        } catch (err) {
            this._log(`[Ably] Connection failed: ${err.message}`);
            this._scheduleReconnect();
        }
    }

    _loadSession() {
        try {
            const fs = require('fs');
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
                if (data.projectId === this.projectId) {
                    this.connectionId = data.connectionId;
                    this.channels = data.channels;
                }
            }
        } catch (e) {}
    }

    _saveSession() {
        try {
            const fs = require('fs');
            fs.writeFileSync(this.sessionFile, JSON.stringify({
                projectId: this.projectId,
                connectionId: this.connectionId,
                channels: this.channels,
                updatedAt: new Date().toISOString()
            }));
        } catch (e) {}
    }

    async _fetchBootstrapData() {
        const res = await axios.post(`${this.baseUrl}/api/ably_helper/connect.php`, {
            account_limit: 10,
            active_pg_ids: [parseInt(this.projectId)]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-bot-token': this.botToken
            },
            timeout: 15000
        });

        if (res.data.status !== 'success') {
            throw new Error(res.data.message || 'Bootstrap failed');
        }
        return res.data;
    }

    disconnect(reason = 'Bot shutting down') {
        this.intentionalClose = true;
        this._clearTimers();

        if (this.realtime) {
            this.realtime.connection.close();
            this.realtime = null;
        }

        this.connected = false;
        this.authenticated = false;
    }

    getStatus() {
        return {
            connected: this.connected,
            authenticated: this.authenticated,
            connectionId: this.connectionId,
            assignedGateways: this.assignedGateways,
            reconnectAttempts: this.reconnectAttempts,
            transport: 'ably'
        };
    }

    sendAccountStatus(gatewayId, status, errorReason = null) {
        this._log(`[Ably] Gateway ${gatewayId} → ${status}${errorReason ? ' (' + errorReason + ')' : ''}`);
        
        this._sendHeartbeat();


        this._publishToEvents('bot.account.sync', {
            gatewayId,
            status,
            errorReason
        });
    }

    sendGatewayStart(gatewayId) {
        this._log(`[Ably] Reporting gateway START: ${gatewayId}`);

        this._publishToEvents('bot.order.update', {
            gatewayId,
            action: 'started',
            timestamp: new Date().toISOString()
        });
    }

    sendGatewayStop(gatewayId) {
        this._log(`[Ably] Reporting gateway STOP: ${gatewayId}`);
        this._publishToEvents('bot.order.update', {
            gatewayId,
            action: 'stopped',
            timestamp: new Date().toISOString()
        });
    }

    sendStopAll(reason = 'Graceful bot shutdown initiated.') {
        this._log(`[Ably] Sending bot.disconnect: ${reason}`);
        this._publishToEvents('bot.disconnect', { reason });
    }

    sendTransaction(data) {
        this._log(`[Ably] Reporting transaction via REST: ${data.transaction?.transaction_id || data.transaction_id}`);
        

        this._reportRest('/api/bot/webhook.php', {
            order_id: data.transaction?.transaction_id || data.transaction_id,
            order_status: 'SUCCESS',
            utr: data.transaction?.utr || data.utr,
            pg_id: this.projectId || 1
        });


        this._publishToEvents('bot.order.update', {
            order_id: data.transaction?.transaction_id || data.transaction_id,
            order_status: 'SUCCESS',
            utr: data.transaction?.utr || data.utr,
            amount: data.transaction?.amount || data.amount,
            payer: data.transaction?.payer || data.payer,
            engine: data.engine,
            full_data: data.transaction || data
        });
    }



    async _onConnected() {
        this.connected = true;
        this.authenticated = true;
        this.reconnectAttempts = 0;
        this._log('[Ably] ✅ Connected to Ably Realtime');
        this.emit('connected');
        this.emit('authenticated', { connectionId: this.connectionId });

        try {
            const controlChannel = this.realtime.channels.get(this.channels.bot_control);
            const eventChannel = this.realtime.channels.get(this.channels.connection_events);

            await controlChannel.subscribe((msg) => this._onControlMessage(msg));
            await eventChannel.subscribe((msg) => this._onEventMessage(msg));

            this._log(`[Ably] Subscribed to control and connection channels`);

            this._startHeartbeat();
        } catch (err) {
            this._log(`[Ably] Subscription failed: ${err.message}`);
        }
    }

    _onControlMessage(msg) {
        const { name, data } = msg;
        this._log(`[Ably] Received control: ${name}`);


        switch (name) {
            case 'server.account.command':
                if (data.action === 'assign_accounts') {
                    this._handleAccountAssignment(data.payload);
                }
                break;
            case 'server.order.command':
            case 'server.gateway.command':
                if (data.action === 'start_gateway') {
                    this.emit('force_start', { gatewayId: data.gatewayId });
                } else if (data.action === 'stop_gateway') {
                    this.emit('force_stop', { gatewayId: data.gatewayId });
                }
                break;
            case 'server.connection.notice':
                this._log(`[Ably] Notice: ${data.message || JSON.stringify(data)}`);
                break;
        }
    }

    _onEventMessage(msg) {
        const { name, data } = msg;
        const requestId = data?.request_id;

        if (requestId && this.pendingRequests.has(requestId)) {
            const entry = this.pendingRequests.get(requestId);
            clearTimeout(entry.timer);
            this.pendingRequests.delete(requestId);
            
            if (name.endsWith('.ok')) {
                entry.resolve(data);
            } else {
                entry.reject(data);
            }
        }
    }

    _handleAccountAssignment(payload) {
        const gateways = payload.gateways || [];
        this._log(`[Ably] Server assigned ${gateways.length} gateway(s)`);
        this.assignedGateways = gateways.map(g => g.gatewayId);

        for (const gw of gateways) {
            this.emit('assign_gateway', {
                gatewayId: gw.gatewayId,
                credentials: gw.credentials
            });
        }
    }

    _onDisconnected() {
        this.connected = false;
        this._log('[Ably] Disconnected');
        this.emit('disconnected', { reason: 'Ably disconnected' });
    }

    _onFailed(err) {
        this.connected = false;
        this._log(`[Ably] Connection failed: ${err.message}`);
        this._scheduleReconnect();
    }

    _onClosed() {
        this.connected = false;
        this._log('[Ably] Connection closed');
    }

    _scheduleReconnect() {
        if (this.intentionalClose) return;
        this.reconnectAttempts++;
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
        this._log(`[Ably] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt #${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    _clearTimers() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }

    async _publishToEvents(eventName, payload) {
        if (!this.realtime || this.realtime.connection.state !== 'connected') return false;

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        
        try {
            const eventChannel = this.realtime.channels.get(this.channels.bot_events);
            

            this._log(`[Ably] Publishing ${eventName}...`);

            await eventChannel.publish(eventName, {
                request_id: requestId,
                connection_id: this.connectionId,
                timestamp: new Date().toISOString(),
                payload: payload
            });
            return true;
        } catch (err) {


            if (err.code === 40160) {
                this._log(`[Ably] Publish capability denied (Read-Only Token). Staying connected for incoming commands.`);
            } else {
                this._log(`[Ably] Publish failed: ${err.message}`);
            }
            return false;
        }
    }

    _startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        

        this._sendHeartbeat();
        

        this.heartbeatTimer = setInterval(() => {
            this._sendHeartbeat();
        }, this.heartbeatIntervalMs);
    }

    _sendHeartbeat() {
        this._log(`[Ably] Sending REST heartbeat...`);
        

        this._reportRest('/api/bot/heartbeat.php', {
            bot_name: this.accountName,
            status: 'online',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),

            accounts: this.assignedGateways.map(gid => ({
                gatewayId: gid,
                status: 'active',
                pg_id: parseInt(this.projectId)
            }))
        });


        this._publishToEvents('bot.heartbeat', {
            bot_name: this.accountName,
            status: 'online',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = GatewayAblyClient;

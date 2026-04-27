
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const GatewayClient = require('./gateway-client');

class GatewayWSClient extends GatewayClient {
    constructor(opts) {
        super(opts);
        this.baseUrl = opts.baseUrl;
        this.botToken = opts.botToken;
        this.serverUrl = opts.serverUrl;
        this.authToken = opts.authToken;
        this.sessionDir = opts.sessionDir;
        this.sslEnabled = opts.ssl !== false;


        this.ws = null;
        this.sessionId = null;


        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.baseReconnectDelay = 1000;
        this.reconnectTimer = null;
        this.intentionalClose = false;


        this.pingInterval = null;
        this.pongTimeout = null;
        this.heartbeatIntervalMs = 30000;
        this.pongTimeoutMs = 10000;


        this.sessionFile = path.join(this.sessionDir, '.gateway-session.json');


        this._loadSession();
    }

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        if (!this.serverUrl) {
            this._log('[WS] No gateway server URL configured — running in standalone mode');
            return;
        }

        this.intentionalClose = false;
        this._log(`[WS] Connecting to gateway server: ${this.serverUrl}`);

        try {
            const wsOpts = {
                headers: { 'X-Bot-Name': this.accountName },
                handshakeTimeout: 10000
            };

            if (!this.sslEnabled) {
                wsOpts.rejectUnauthorized = false;
            }

            this.ws = new WebSocket(this.serverUrl, wsOpts);
        } catch (err) {
            this._log(`[WS] Connection creation failed: ${err.message}`);
            this._scheduleReconnect();
            return;
        }

        this.ws.on('open', () => this._onOpen());
        this.ws.on('message', (data) => this._onMessage(data));
        this.ws.on('close', (code, reason) => this._onClose(code, reason));
        this.ws.on('error', (err) => this._onError(err));
        this.ws.on('pong', () => this._onPong());
    }

    disconnect(reason = 'Bot shutting down') {
        this.intentionalClose = true;
        this._clearTimers();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.sendStopAll(reason);
            
            setTimeout(() => {
                if (this.ws) {
                    this.ws.close(1000, reason);
                    this.ws = null;
                }
            }, 500);
        } else {
            if (this.ws) {
                this.ws.terminate();
                this.ws = null;
            }
        }

        this.connected = false;
        this.authenticated = false;
    }

    getStatus() {
        return {
            connected: this.connected,
            authenticated: this.authenticated,
            serverUrl: this.serverUrl || null,
            sessionId: this.sessionId,
            assignedGateways: this.assignedGateways,
            reconnectAttempts: this.reconnectAttempts
        };
    }

    sendAccountStatus(gatewayId, status, errorReason = null) {
        this._log(`[WS] Gateway ${gatewayId} → ${status}${errorReason ? ' (' + errorReason + ')' : ''}`);
        
 // report via rest heartbeat (syncs accounts)
        this._sendHeartbeat();

        this._send({
            type: 'system_config',
            action: 'account_status',
            payload: {
                gatewayId,
                status,
                errorReason
            }
        });
    }

    sendGatewayStart(gatewayId) {
        this._log(`[WS] Reporting gateway START: ${gatewayId}`);
        this._send({
            type: 'gateway_control',
            action: 'start',
            gatewayId
        });
    }

    sendGatewayStop(gatewayId) {
        this._log(`[WS] Reporting gateway STOP: ${gatewayId}`);
        this._send({
            type: 'gateway_control',
            action: 'stop',
            gatewayId
        });
    }

    sendStopAll(reason = 'Graceful bot shutdown initiated.') {
        this._log(`[WS] Sending STOP_ALL: ${reason}`);
        this._send({
            type: 'system_control',
            action: 'stop_all',
            payload: {
                reason
            }
        });
    }

    sendTransaction(data) {
        this._log(`[WS] Reporting transaction via REST: ${data.transaction?.transaction_id || data.transaction_id}`);
        

        this._reportRest('/api/bot/orders.php', {
            order_id: data.transaction?.transaction_id || data.transaction_id,
            order_status: 'SUCCESS',
            utr: data.transaction?.utr || data.utr,
            amount: data.transaction?.amount || data.amount,
            payer: data.transaction?.payer || data.payer,
            engine: data.engine,
            full_data: data.transaction || data
        });


        this._send({
            type: 'transaction',
            action: 'new',
            payload: data
        });
    }



    _authenticate() {
        if (this.sessionId) {
            this._log(`[WS] Resuming session: ${this.sessionId.substring(0, 8)}...`);
            this._send({
                type: 'auth',
                action: 'resume',
                payload: { sessionId: this.sessionId }
            });
        } else {
            this._log('[WS] Authenticating with token...');
            this._send({
                type: 'auth',
                action: 'new',
                payload: { token: this.authToken }
            });
        }
    }

    _handleAccountAssignment(payload) {
        const gateways = payload.gateways || [];
        this._log(`[WS] Server assigned ${gateways.length} gateway(s): ${gateways.map(g => g.gatewayId).join(', ')}`);
        this.assignedGateways = gateways.map(g => g.gatewayId);

        for (const gw of gateways) {
            this.emit('assign_gateway', {
                gatewayId: gw.gatewayId,
                credentials: gw.credentials
            });
        }
    }

    _onOpen() {
        this.connected = true;
        this.reconnectAttempts = 0;
        this._log('[WS] ✅ Connected to gateway server');
        this.emit('connected');
        this._startHeartbeat();
        this._authenticate();
    }

    _onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }

        switch (msg.type) {
            case 'auth_success':
            case 'auth':
                if (msg.action === 'success' || msg.type === 'auth_success') {
                    this.authenticated = true;
                    if (msg.payload?.sessionId || msg.sessionId) {
                        this.sessionId = msg.payload?.sessionId || msg.sessionId;
                        this._saveSession();
                    }
                    this._log(`[WS] 🔐 Authentication successful (session: ${(this.sessionId || '').substring(0, 8)}...)`);
                    this.emit('authenticated', { sessionId: this.sessionId });
                } else if (msg.action === 'failed' || msg.action === 'error') {
                    this._log(`[WS] ❌ Authentication failed: ${msg.payload?.reason || msg.reason || 'Unknown'}`);
                    this.sessionId = null;
                    this._clearSession();
                    this.emit('auth_failed', msg.payload || msg);
                }
                break;

            case 'system_config':
                if (msg.action === 'assign_accounts') {
                    this._handleAccountAssignment(msg.payload);
                }
                break;

            case 'bot_command':
                this._handleBotCommand(msg);
                break;

            case 'ping':
                this._send({ type: 'pong' });
                break;

            default:
                this.emit('unknown_message', msg);
                break;
        }
    }

    _handleBotCommand(msg) {
        const { action, gatewayId } = msg;
        switch (action) {
            case 'start_gateway':
                this._log(`[WS] ⚡ Server commanded: START gateway ${gatewayId}`);
                this.emit('force_start', { gatewayId });
                break;
            case 'stop_gateway':
                this._log(`[WS] 🛑 Server commanded: STOP gateway ${gatewayId}`);
                this.emit('force_stop', { gatewayId });
                break;
        }
    }

    _onClose(code, reason) {
        this.connected = false;
        this.authenticated = false;
        this._clearTimers();

        const reasonStr = reason ? reason.toString() : 'No reason';
        this._log(`[WS] Connection closed (code: ${code}, reason: ${reasonStr})`);
        this.emit('disconnected', { code, reason: reasonStr });

        if (!this.intentionalClose) {
            this._scheduleReconnect();
        }
    }

    _onError(err) {
        if (err.code === 'ECONNREFUSED' && this.reconnectAttempts > 1) return;
        this._log(`[WS] Error: ${err.message}`);
        this.emit('error', err);
    }

    _onPong() {
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    _scheduleReconnect() {
        if (this.intentionalClose) return;
        this.reconnectAttempts++;
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
        this._log(`[WS] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt #${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    _startHeartbeat() {
        this._clearTimers();
        

        this._sendHeartbeat();

        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {

                this._sendHeartbeat();


                this.ws.ping();
                this.pongTimeout = setTimeout(() => {
                    this._log('[WS] Heartbeat timeout — connection appears dead');
                    if (this.ws) this.ws.terminate();
                }, this.pongTimeoutMs);
            }
        }, this.heartbeatIntervalMs);
    }

    _sendHeartbeat() {
        this._reportRest('/api/bot/heartbeat.php', {
            bot_name: this.accountName,
            status: 'online',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            accounts: this.assignedGateways.map(gid => ({
                gatewayId: gid,
                status: 'active',
                pg_id: 1
            }))
        });
    }

    _saveSession() {
        try {
            const data = { sessionId: this.sessionId, savedAt: new Date().toISOString() };
            fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
        } catch (e) { }
    }

    _loadSession() {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
                if (data.sessionId) this.sessionId = data.sessionId;
            }
        } catch (e) {
            this.sessionId = null;
        }
    }

    _clearSession() {
        try { if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile); } catch (e) { }
        this.sessionId = null;
    }

    _send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(payload));
                return true;
            } catch (e) {
                this._log(`[WS] Send failed: ${e.message}`);
                return false;
            }
        }
        return false;
    }

    _clearTimers() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }
}

module.exports = GatewayWSClient;

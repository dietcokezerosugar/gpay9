/**
 * Floxi PG REST Client
 * 
 * Communicates with floxi.online Bot API to:
 *   - Register/connect the bot
 *   - Send periodic heartbeats
 *   - Fetch pending payment orders
 *   - Confirm payments (match transactions → orders)
 *   - Gracefully disconnect
 */

const axios = require('axios');

class FloxiClient {
    constructor({ baseUrl, botToken, projectId, logger, accounts }) {
        this.baseUrl = (baseUrl || 'https://floxi.online').replace(/\/+$/, '');
        this.botToken = botToken;
        this.projectId = projectId;
        this.accounts = accounts || []; // GPay account list from config

        this.connected = false;
        this.connectionId = null;
        this.heartbeatTimer = null;
        this.orderPollTimer = null;
        this.heartbeatIntervalMs = 60000;
        this.orderPollIntervalMs = 4000; // Poll orders every 4s
        this.orderCache = [];
        this.orderCacheTime = 0;
        this.orderCacheTTL = 500; // 500ms cache — near real-time

        // Log ring buffer for dashboard live view
        this.logBuffer = [];
        this.maxLogSize = 500;
        this.sseClients = [];

        this.stats = {
            ordersMatched: 0,
            ordersFailed: 0,
            heartbeats: 0,
            lastMatch: null,
            lastHeartbeat: null,
            pendingOrders: 0
        };

        // Wrap logger to capture all messages
        const externalLog = logger || console.log;
        this.log = (msg) => {
            externalLog(msg);
            const entry = { time: new Date().toISOString(), msg };
            this.logBuffer.push(entry);
            if (this.logBuffer.length > this.maxLogSize) this.logBuffer.shift();
            // Push to SSE subscribers
            this.sseClients.forEach(res => {
                try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (e) {}
            });
        };
    }

    /** Get stored logs */
    getLogs(limit = 200) {
        return this.logBuffer.slice(-limit);
    }

    /** Subscribe to live log stream (SSE) */
    addSSEClient(res) {
        this.sseClients.push(res);
        res.on('close', () => {
            this.sseClients = this.sseClients.filter(c => c !== res);
        });
    }

    /**
     * Build default headers for all Floxi API requests
     */
    _headers() {
        return {
            'Content-Type': 'application/json',
            'x-bot-token': this.botToken
        };
    }

    /**
     * Connect bot to Floxi PG
     */
    async connect() {
        if (!this.botToken) {
            this.log('[FLOXI] ⚠ No bot_token configured — Floxi integration disabled');
            return false;
        }

        try {
            this.log(`[FLOXI] 🔌 Connecting to ${this.baseUrl}...`);
            const res = await axios.post(`${this.baseUrl}/api/bot/connect.php`, {
                project_id: this.projectId
            }, {
                headers: this._headers(),
                timeout: 15000
            });

            if (res.data.status === 'success') {
                this.connected = true;
                this.connectionId = res.data.data?.connection_id || null;
                this.log(`[FLOXI] ✅ Connected to Floxi PG (connection: ${this.connectionId || 'active'})`);
                this._startHeartbeat();
                return true;
            } else {
                this.log(`[FLOXI] ❌ Connect failed: ${res.data.message || 'Unknown error'}`);
                return false;
            }
        } catch (err) {
            this.log(`[FLOXI] ❌ Connect error: ${err.message}`);
            // Still start heartbeat — it will auto-retry connections
            this._startHeartbeat();
            return false;
        }
    }

    /**
     * Send heartbeat / keep-alive to Floxi
     */
    async heartbeat() {
        if (!this.botToken) return;

        try {
            const res = await axios.post(`${this.baseUrl}/api/bot/heartbeat.php`, {
                connection_id: this.connectionId,
                project_id: this.projectId,
                status: 'online',
                uptime: Math.floor(process.uptime()),
                timestamp: new Date().toISOString(),
                accounts: this.accounts.map(acc => ({
                    name: acc.name,
                    status: 'active',
                    pg_id: parseInt(this.projectId) || 1
                }))
            }, {
                headers: this._headers(),
                timeout: 10000
            });

            this.stats.heartbeats++;
            this.stats.lastHeartbeat = new Date().toISOString();

            if (res.data.status === 'success') {
                if (!this.connected) {
                    this.connected = true;
                    this.log('[FLOXI] \u{1F504} Reconnected via heartbeat');
                }
            }
        } catch (err) {
            // Only log the first failure, don't spam
            if (this.connected) {
                this.log(`[FLOXI] \u26A0 Heartbeat failed: ${err.message}`);
                this.connected = false;
            }
        }
    }

    /**
     * Sync GPay account statuses to Floxi so it knows where to assign orders
     */
    async syncAccounts() {
        if (!this.botToken || this.accounts.length === 0) return;

        try {
            const res = await axios.post(`${this.baseUrl}/api/bot/accounts.php`, {
                connection_id: this.connectionId,
                project_id: this.projectId,
                accounts: this.accounts.map(acc => ({
                    name: acc.name,
                    email: acc.email,
                    status: 'active',
                    pg_id: parseInt(this.projectId) || 1
                }))
            }, {
                headers: this._headers(),
                timeout: 10000
            });

            if (res.data.status === 'success') {
                this.log(`[FLOXI] \u{1F4E1} Synced ${this.accounts.length} PG account(s) to Floxi`);
            }
        } catch (err) {
            this.log(`[FLOXI] \u26A0 Account sync error: ${err.message}`);
        }
    }

    /**
     * Update the accounts list (called when config changes)
     */
    updateAccounts(accounts) {
        this.accounts = accounts || [];
    }

    /**
     * Fetch pending orders from Floxi (with caching)
     */
    async fetchPendingOrders() {
        if (!this.botToken) return [];

        const now = Date.now();
        if (now - this.orderCacheTime < this.orderCacheTTL && this.orderCache.length > 0) {
            return this.orderCache;
        }

        try {
            const res = await axios.get(`${this.baseUrl}/api/bot/orders.php`, {
                headers: this._headers(),
                params: { project_id: this.projectId },
                timeout: 10000
            });

            if (res.data.status === 'success') {
                this.orderCache = res.data.data?.orders || [];
                this.orderCacheTime = now;
                this.stats.pendingOrders = this.orderCache.length;
                this._lastFetchError = false;
                return this.orderCache;
            }
            return this.orderCache; // Return stale cache on non-success
        } catch (err) {
            // Only log ONCE when error state changes
            if (!this._lastFetchError) {
                this.log(`[FLOXI] \u26A0 Fetch orders error: ${err.message}`);
                this._lastFetchError = true;
            }
            return this.orderCache; // Return stale cache
        }
    }

    /**
     * Confirm a payment to Floxi — tell Floxi that an order has been paid.
     * Sends ALL transaction fields so Floxi has the complete picture.
     */
    async confirmPayment(orderId, transactionData) {
        if (!this.botToken) return false;

        try {
            this.log(`[FLOXI] 💸 Confirming payment for order ${orderId} (₹${transactionData.amount})`);
            const res = await axios.post(`${this.baseUrl}/api/bot/webhook.php`, {
                // Core Floxi fields
                order_id: orderId,
                order_status: 'SUCCESS',
                utr: transactionData.utr || transactionData.transaction_id || '',
                amount: String(transactionData.amount),
                currency: 'INR',
                project_id: this.projectId,
                timestamp: transactionData.creation_time || new Date().toISOString(),

                // Full transaction details (mirrors dashboard data exactly)
                payer: transactionData.payer || '',
                paid_via: transactionData.paid_via || 'UPI',
                transaction_id: transactionData.transaction_id || '',
                transaction_type: transactionData.type || 'Payment',
                net_amount: String(transactionData.net_amount || transactionData.amount),
                processing_fee: String(transactionData.processing_fee || 0),
                status: transactionData.status || 'Completed',
                creation_time: transactionData.creation_time || '',
                update_time: transactionData.update_time || new Date().toISOString(),
                notes: transactionData.notes || '',
                account: transactionData.account || '',

                // Attach complete raw transaction as backup
                full_data: transactionData
            }, {
                headers: this._headers(),
                timeout: 15000
            });

            if (res.data.status === 'success') {
                this.stats.ordersMatched++;
                this.stats.lastMatch = new Date().toISOString();
                this.log(`[FLOXI] ✅ Payment confirmed: order ${orderId} ← txn ${transactionData.transaction_id}`);
                // Invalidate cache since order list changed
                this.orderCacheTime = 0;
                return true;
            } else {
                this.stats.ordersFailed++;
                this.log(`[FLOXI] ❌ Confirm failed for ${orderId}: ${res.data.message || 'Unknown'}`);
                return false;
            }
        } catch (err) {
            this.stats.ordersFailed++;
            this.log(`[FLOXI] ❌ Confirm error for ${orderId}: ${err.message}`);
            return false;
        }
    }

    /**
     * Match incoming transactions against pending Floxi orders.
     * 
     * Strategy (in priority order):
     *   1. ORDER ID IN NOTES — Customer puts the Floxi order_id in the UPI payment note.
     *      We scan the notes field for any pending order_id.
     *   2. AMOUNT FALLBACK — If no note match, try exact amount match (FIFO).
     * 
     * Each order is matched at most once per batch.
     * 
     * @param {Array} transactions - Array of transaction objects from gpay
     * @returns {Object} { matched: [{orderId, transaction, matchType}], unmatched: [transaction] }
     */
    async matchAndConfirm(transactions) {
        if (!this.botToken || !transactions || transactions.length === 0) {
            return { matched: [], unmatched: transactions || [] };
        }

        const pendingOrders = await this.fetchPendingOrders();
        if (pendingOrders.length === 0) {
            return { matched: [], unmatched: transactions };
        }

        // Build a set of available orders (clone so we can remove matched ones)
        const availableOrders = new Map();
        for (const order of pendingOrders) {
            if (order.order_status === 'PENDING' || order.order_status === 'NEW') {
                availableOrders.set(order.order_id, order);
            }
        }

        const matched = [];
        const unmatched = [];

        for (const tx of transactions) {
            let matchedOrder = null;
            let matchType = null;

            // --- PRIORITY 1: Match order_id found in transaction notes ---
            const notes = (tx.notes || '').trim();
            if (notes) {
                for (const [orderId, order] of availableOrders) {
                    if (notes.includes(orderId)) {
                        matchedOrder = order;
                        matchType = 'note_order_id';
                        this.log(`[FLOXI] 🎯 Note match: "${notes}" contains order ${orderId}`);
                        break;
                    }
                }
            }

            // --- PRIORITY 2: Fallback to amount match (FIFO — oldest first) ---
            if (!matchedOrder) {
                const txAmount = parseFloat(tx.amount);
                if (!isNaN(txAmount) && txAmount > 0) {
                    // Sort by creation time for FIFO
                    const sortedOrders = [...availableOrders.values()].sort((a, b) => {
                        return new Date(a.created_at || a.order_created || 0) - new Date(b.created_at || b.order_created || 0);
                    });

                    for (const order of sortedOrders) {
                        const orderAmount = parseFloat(order.amount);
                        if (Math.abs(orderAmount - txAmount) < 0.01) {
                            matchedOrder = order;
                            matchType = 'amount';
                            break;
                        }
                    }
                }
            }

            if (matchedOrder) {
                availableOrders.delete(matchedOrder.order_id);
                matched.push({ orderId: matchedOrder.order_id, transaction: tx, matchType });

                // Confirm payment — don't block the loop
                this.confirmPayment(matchedOrder.order_id, tx).catch(() => { });
            } else {
                unmatched.push(tx);
            }
        }

        if (matched.length > 0) {
            const noteMatches = matched.filter(m => m.matchType === 'note_order_id').length;
            const amtMatches = matched.filter(m => m.matchType === 'amount').length;
            this.log(`[FLOXI] 🎯 Matched ${matched.length}/${transactions.length} txn(s) — ${noteMatches} by order_id in note, ${amtMatches} by amount`);
        }

        return { matched, unmatched };
    }

    /**
     * Disconnect bot from Floxi
     */
    async disconnect() {
        if (!this.botToken) return;

        this._stopTimers();

        try {
            await axios.post(`${this.baseUrl}/api/bot/disconnect.php`, {
                connection_id: this.connectionId,
                project_id: this.projectId
            }, {
                headers: this._headers(),
                timeout: 10000
            });
            this.log('[FLOXI] \u{1F44B} Disconnected from Floxi PG');
        } catch (err) {
            this.log(`[FLOXI] \u26A0 Disconnect error: ${err.message}`);
        }

        this.connected = false;
    }

    /**
     * Get current Floxi integration status
     */
    getStatus() {
        return {
            connected: this.connected,
            baseUrl: this.baseUrl,
            projectId: this.projectId,
            connectionId: this.connectionId,
            stats: { ...this.stats },
            cachedOrders: this.orderCache.length
        };
    }

    _startHeartbeat() {
        this._stopTimers();

        // Heartbeat every 60s
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
        this.heartbeat();

        // Sync accounts on connect, then every 5 min
        this.syncAccounts();
        this.accountSyncTimer = setInterval(() => this.syncAccounts(), 300000);

        // Poll orders every 4s
        let lastOrderCount = -1;
        this.orderPollTimer = setInterval(() => {
            this.fetchPendingOrders().then(orders => {
                if (orders.length !== lastOrderCount) {
                    if (orders.length > 0) this.log(`[FLOXI] \u{1F4CB} ${orders.length} pending order(s) in queue`);
                    lastOrderCount = orders.length;
                }
            }).catch(() => { });
        }, 4000);
    }

    _stopTimers() {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.orderPollTimer) { clearInterval(this.orderPollTimer); this.orderPollTimer = null; }
        if (this.accountSyncTimer) { clearInterval(this.accountSyncTimer); this.accountSyncTimer = null; }
    }
}

module.exports = FloxiClient;

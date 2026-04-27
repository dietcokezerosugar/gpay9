const express = require('express');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');
const axios = require('axios');
const { chromium } = require('playwright');
const {
    insertTransactionsBulk,
    insertBotEvent,
    getTransactions,
    getAccountSummary,
    getFleetSummary,
    getRecentEvents,
    updateTransactionStatus,
    getUnsentTransactions,
    markWebhookSuccess,
    incrementWebhookAttempts
} = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function formatToHubDate(val) {
    if (!val) return new Date().toISOString().replace('T', ' ').split('.')[0];
    try {
        let d;
        if (typeof val === 'string' && val.includes(',')) {
            d = new Date(val.replace(',', ''));
        } else {
            d = new Date(val);
        }
        if (isNaN(d.getTime())) d = new Date();
        const Y = d.getFullYear(); const M = String(d.getMonth() + 1).padStart(2, '0'); const D = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0'); const m = String(d.getMinutes()).padStart(2, '0'); const s = String(d.getSeconds()).padStart(2, '0');
        return `${Y}-${M}-${D} ${h}:${m}:${s}`;
    } catch (e) { return new Date().toISOString().replace('T', ' ').split('.')[0]; }
}

const PORT = 3000;
const ACCOUNTS_FILE = path.join(__dirname, '../config/accounts.json');
const LOGS_DIR = path.join(__dirname, '../logs');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../dashboard')));

function loadAccounts() { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')); }
function saveAccounts(config) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(config, null, 4)); }

function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}

async function getPM2Status() {
    return new Promise((resolve) => {
        require('child_process').exec('npx pm2 jlist', { windowsHide: true }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            try {
                const jsonStartIndex = stdout.indexOf('[');
                if (jsonStartIndex === -1) return resolve([]);
                const list = JSON.parse(stdout.substring(jsonStartIndex));
                resolve(list.filter(p => p.name.startsWith('gpay-')).map(p => ({
                    name: p.name.replace('gpay-', ''),
                    status: p.pm2_env.status,
                    uptime: p.pm2_env.pm_uptime,
                    restarts: p.pm2_env.restart_time,
                    memory: p.monit?.memory || 0,
                    cpu: p.monit?.cpu || 0
                })));
            } catch { resolve([]); }
        });
    });
}

async function pm2Action(action, name) {
    return new Promise((resolve, reject) => {
        const processName = `gpay-${name}`;
        let cmd = '';
        switch (action) {
            case 'start': 
                const ecosystemPath = path.join(__dirname, '../ecosystem.config.js');
                cmd = `npx pm2 start "${ecosystemPath}" --only ${processName}`; 
                break;
            case 'stop': cmd = `npx pm2 stop ${processName}`; break;
            case 'restart': cmd = `npx pm2 restart ${processName}`; break;
            case 'delete': cmd = `npx pm2 delete ${processName}`; break;
            default: return reject(new Error('Unknown action: ' + action));
        }
        require('child_process').exec(cmd, { windowsHide: true, cwd: path.join(__dirname, '..') }, (err) => {
            if (err) reject(err); else resolve(true);
        });
    });
}

app.post('/api/control/wakeup', async (req, res) => {
    try {
        const { bot_name } = req.body;
        if (!bot_name) return res.status(400).json({ error: 'Requires bot_name in payload' });

        const config = loadAccounts();
        const idx = config.accounts.findIndex(a => a.name === bot_name);
        if (idx === -1) return res.status(404).json({ error: 'Bot not found' });

        const botPort = 5001 + idx;
        res.json({ status: 'Wakeup Sequence Initiated for ' + bot_name });

        try { await axios.post(`http://localhost:${botPort}/internal/wakeup`, {}, { timeout: 2000 }); } 
        catch(e) { console.log(`[HUB] Failed to reach internal bot ${bot_name} at port ${botPort}`); }
    } catch(err) {
        if(!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ------ MANUAL HEADFUL LOGIN PROXY ------
const activeLoginSessions = new Set();

app.post('/api/bots/:name/login', async (req, res) => {
    const name = req.params.name;

    if (activeLoginSessions.has(name)) {
        return res.status(409).json({ error: `Login window already open for ${name}. Close it first.` });
    }

    console.log(`[HUB] Launching headful session for ${name}...`);
    activeLoginSessions.add(name);

    try {
        try { await pm2Action('stop', name); } catch(e){}
        broadcast('bot_status', { name, status: 'stopped' });
        
        const SESSION_DIR = path.join(__dirname, `../session-${name}`);
        const context = await chromium.launchPersistentContext(SESSION_DIR, {
            headless: false,
            args: ['--disable-blink-features=AutomationControlled']
        });
        
        const page = await context.newPage();
        
        // Dynamic merchant discovery
        page.on('framenavigated', frame => {
            const match = frame.url().match(/https:\/\/pay\.google\.com\/g4b\/transactions\/([A-Z0-9]+)/);
            if (match && match[1]) {
                const config = loadAccounts();
                const idx = config.accounts.findIndex(a => a.name === name);
                if (idx !== -1 && config.accounts[idx].report_id !== match[1]) {
                    config.accounts[idx].report_id = match[1];
                    saveAccounts(config);
                    insertBotEvent.run(name, 'discovery', `Report ID Discovery: ${match[1]}`);
                }
            }
        });

        await page.goto('https://pay.google.com/g4b/transactions');
        
        context.on('close', () => {
            activeLoginSessions.delete(name);
            console.log(`[HUB] Login session saved for ${name}`);
        });

        res.json({ success: true, message: 'Headful window opened. Close it when authenticated.' });
    } catch(e) {
        activeLoginSessions.delete(name);
        res.status(500).json({ error: e.message });
    }
});

function requireAuth(req, res, next) {
    if (req.path === '/login' || req.path === '/report' || req.path === '/control/wakeup') return next();
    const config = loadAccounts();
    const password = config.dashboard_password;
    if (!password) return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
    if (authHeader.split(' ')[1] !== password) return res.status(401).json({ error: 'Invalid token' });
    next();
}

app.use('/api', requireAuth);

app.post('/api/login', (req, res) => {
    try {
        const config = loadAccounts();
        const { username, password } = req.body;
        if (!config.dashboard_password) return res.json({ success: true, token: 'no_auth' });
        const validUser = config.dashboard_username || 'admin';
        if (username === validUser && password === config.dashboard_password) {
            res.json({ success: true, token: password });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/accounts', async (req, res) => {
    try {
        const config = loadAccounts();
        const pm2Status = await getPM2Status();
        const accounts = config.accounts.map((acc, idx) => {
            const pm2Info = pm2Status.find(p => p.name === acc.name) || { status: 'stopped', uptime: 0, restarts: 0, memory: 0, cpu: 0 };
            const summary = getAccountSummary(acc.name);
            return { name: acc.name, email: acc.email, report_id: acc.report_id, pm2: pm2Info, stats: summary, port: 5001 + idx };
        });
        res.json({ accounts });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', (req, res) => {
    try {
        const config = loadAccounts();
        res.json({
            webhook_url: config.webhook_url || '',
            telegram_bot_token: config.telegram_bot_token || '',
            telegram_chat_id: config.telegram_chat_id || '',
            download_interval_sec: config.download_interval_sec || 40,
            webhook_status_secret: config.webhook_status_secret || '',
            dashboard_password: config.dashboard_password || ''
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', (req, res) => {
    try {
        const config = loadAccounts();
        const { webhook_url, telegram_bot_token, telegram_chat_id, download_interval_sec, webhook_status_secret, dashboard_password } = req.body;
        if (webhook_url !== undefined) config.webhook_url = webhook_url;
        if (telegram_bot_token !== undefined) config.telegram_bot_token = telegram_bot_token;
        if (telegram_chat_id !== undefined) config.telegram_chat_id = telegram_chat_id;
        if (download_interval_sec !== undefined) config.download_interval_sec = parseInt(download_interval_sec) || 40;
        if (webhook_status_secret !== undefined) config.webhook_status_secret = webhook_status_secret;
        if (dashboard_password !== undefined) config.dashboard_password = dashboard_password;
        saveAccounts(config);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', (req, res) => {
    try {
        const { name, email, password, report_id, webhook_url, telegram_bot_token, telegram_chat_id, download_interval_sec } = req.body;
        if (!name || !email) return res.status(400).json({ error: 'Required fields missing' });
        const config = loadAccounts();
        if (config.accounts.find(a => a.name === name)) return res.status(409).json({ error: 'Profile name already exists' });
        const newAccount = { name, email, password: password || '', report_id: report_id || '' };
        if (webhook_url) newAccount.webhook_url = webhook_url;
        if (telegram_bot_token) newAccount.telegram_bot_token = telegram_bot_token;
        if (telegram_chat_id) newAccount.telegram_chat_id = telegram_chat_id;
        if (download_interval_sec) newAccount.download_interval_sec = parseInt(download_interval_sec) || undefined;
        config.accounts.push(newAccount);
        saveAccounts(config);
        broadcast('account_added', { name, email });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/accounts/:name', (req, res) => {
    try {
        const config = loadAccounts();
        const idx = config.accounts.findIndex(a => a.name === req.params.name);
        if (idx === -1) return res.status(404).json({ error: 'Profile not found' });
        const { email, password, report_id, webhook_url, telegram_bot_token, telegram_chat_id, download_interval_sec } = req.body;
        if (email) config.accounts[idx].email = email;
        if (password) config.accounts[idx].password = password;
        if (report_id) config.accounts[idx].report_id = report_id;
        if (webhook_url !== undefined) config.accounts[idx].webhook_url = webhook_url || undefined;
        if (telegram_bot_token !== undefined) config.accounts[idx].telegram_bot_token = telegram_bot_token || undefined;
        if (telegram_chat_id !== undefined) config.accounts[idx].telegram_chat_id = telegram_chat_id || undefined;
        if (download_interval_sec !== undefined) config.accounts[idx].download_interval_sec = parseInt(download_interval_sec) || undefined;
        saveAccounts(config);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/accounts/:name', async (req, res) => {
    try {
        const config = loadAccounts();
        config.accounts = config.accounts.filter(a => a.name !== req.params.name);
        saveAccounts(config);
        try { await pm2Action('delete', req.params.name); } catch {}
        broadcast('account_removed', { name: req.params.name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots/:name/start', async (req, res) => {
    try {
        await pm2Action('start', req.params.name);
        insertBotEvent.run(req.params.name, 'start', 'Process started');
        broadcast('bot_status', { name: req.params.name, status: 'online' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots/:name/stop', async (req, res) => {
    try {
        await pm2Action('stop', req.params.name);
        insertBotEvent.run(req.params.name, 'stop', 'Process stopped');
        broadcast('bot_status', { name: req.params.name, status: 'stopped' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots/:name/restart', async (req, res) => {
    try {
        await pm2Action('restart', req.params.name);
        insertBotEvent.run(req.params.name, 'restart', 'Process restarted');
        broadcast('bot_status', { name: req.params.name, status: 'online' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bots/:name/reset', async (req, res) => {
    try {
        const name = req.params.name;
        try { await pm2Action('stop', name); } catch (e) {}
        const sessionPath = path.join(__dirname, `../session-${name}`);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        insertBotEvent.run(name, 'reset', 'Persistent session cleared');
        broadcast('bot_status', { name, status: 'stopped' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function dispatchWebhook(account, transactions) {
    if (!transactions || transactions.length === 0) return;
    const config = loadAccounts();
    const accountConfig = config.accounts.find(a => a.name === account) || {};
    const urls = [accountConfig.webhook_url || config.webhook_url, accountConfig.secondary_webhook_url || config.secondary_webhook_url].filter(Boolean);
    if (urls.length === 0) return;

    for (const tx of transactions) {
        for (const url of urls) {
            try {
                await axios.post(url, tx, { timeout: 15000 });
                if (url === (accountConfig.webhook_url || config.webhook_url)) markWebhookSuccess(tx.transaction_id);
            } catch (e) {
                insertBotEvent.run(account, 'webhook_error', `Failure for ${tx.transaction_id}: ${e.message}`);
                incrementWebhookAttempts(tx.transaction_id);
            }
        }
    }
}

app.post('/api/report', async (req, res) => {
    try {
        const payload = req.body;
        const { account, transactions } = payload;
        if (!account || !transactions || !Array.isArray(transactions)) return res.status(400).json({ error: 'Payload validation failed' });

        const result = insertTransactionsBulk(account, transactions);
        insertBotEvent.run(account, 'capture', `Capture sync: ${result.newCount} unique records`);

        // Forward to the external client storefront webhooks exactly in identical format extracted natively
        if (result.insertedRows && result.insertedRows.length > 0) {
            await dispatchWebhook(account, result.insertedRows);
        }

        const unsent = getUnsentTransactions(account);
        if (unsent.length > 0) await dispatchWebhook(account, unsent);
        
        broadcast('new_download', { account: payload.account, newRows: result.insertedRows.length, transactions: result.insertedRows });
        res.json({ success: true, newCount: result.newCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transactions', (req, res) => {
    try {
        const { account, status, search, limit, offset, startDate, endDate } = req.query;
        res.json(getTransactions({ account, status, search, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0, startDate, endDate }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/summary', async (req, res) => {
    try {
        const fleet = getFleetSummary();
        const pm2Status = await getPM2Status();
        const config = loadAccounts();
        const totals = fleet.reduce((acc, a) => ({
            transactions: acc.transactions + a.total_transactions,
            amount: acc.amount + a.total_amount,
            net: acc.net + a.total_net,
            settled: acc.settled + a.settled_amount,
            pending: acc.pending + a.pending_amount
        }), { transactions: 0, amount: 0, net: 0, settled: 0, pending: 0 });
        res.json({ totals, perAccount: fleet, activeBots: pm2Status.filter(p => p.status === 'online').length, totalBots: config.accounts.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events', (req, res) => {
    try {
        const { account, limit } = req.query; res.json(getRecentEvents(account, parseInt(limit) || 100));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fleet mass actions
app.post('/api/fleet/start', async (req, res) => {
    try {
        const config = loadAccounts();
        const results = [];
        for (const acc of config.accounts) {
            try {
                await pm2Action('start', acc.name);
                insertBotEvent.run(acc.name, 'start', 'Fleet mass start');
                results.push({ name: acc.name, status: 'started' });
            } catch (e) { results.push({ name: acc.name, status: 'error', message: e.message }); }
        }
        broadcast('fleet_status', { action: 'start' });
        res.json({ success: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fleet/stop', async (req, res) => {
    try {
        const config = loadAccounts();
        const results = [];
        for (const acc of config.accounts) {
            try {
                await pm2Action('stop', acc.name);
                insertBotEvent.run(acc.name, 'stop', 'Fleet mass stop');
                results.push({ name: acc.name, status: 'stopped' });
            } catch (e) { results.push({ name: acc.name, status: 'error', message: e.message }); }
        }
        broadcast('fleet_status', { action: 'stop' });
        res.json({ success: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Analytics endpoints (inline queries since db.js was ported from gpy4 without these)
const Database = require('better-sqlite3');
const analyticsDb = new Database(path.join(__dirname, '../data/gpay.db'));

app.get('/api/analytics/hourly', (req, res) => {
    try {
        const { account } = req.query;
        let query = `SELECT substr(creation_time, 12, 2) as hour_part, COUNT(*) as count, SUM(amount) as total FROM transactions WHERE 1=1`;
        const params = [];
        if (account) { query += ' AND account = ?'; params.push(account); }
        query += ' GROUP BY hour_part ORDER BY hour_part';
        const rows = analyticsDb.prepare(query).all(...params);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/top-payers', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const rows = analyticsDb.prepare(`SELECT payer, COUNT(*) as count, SUM(amount) as total_amount FROM transactions GROUP BY payer ORDER BY total_amount DESC LIMIT ?`).all(limit);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/analytics/distribution', (req, res) => {
    try {
        const rows = analyticsDb.prepare(`
            SELECT 
                CASE 
                    WHEN amount < 100 THEN '< ₹100'
                    WHEN amount < 500 THEN '₹100-500'
                    WHEN amount < 1000 THEN '₹500-1K'
                    WHEN amount < 5000 THEN '₹1K-5K'
                    ELSE '₹5K+'
                END as bucket,
                COUNT(*) as count
            FROM transactions GROUP BY bucket ORDER BY MIN(amount)
        `).all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

wss.on('connection', ws => ws.send(JSON.stringify({ type: 'connected', data: { message: 'Gateway connected' } })));
server.listen(PORT, () => console.log(`Server initialized on port ${PORT}`));

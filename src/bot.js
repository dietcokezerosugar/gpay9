
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { parseTransactions } = require('./parser');

process.env.PLAYWRIGHT_CHROMIUM_USE_HEADLESS_NEW = '1'; // fix console window on windows

const ACCOUNTS_FILE = path.join(__dirname, '../config/accounts.json');
function loadAccounts() { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')); }

const config = loadAccounts();
const ACCOUNT_NAME = process.argv[2];
if (!ACCOUNT_NAME) { console.error('Required bot name via args'); process.exit(1); }

const accountIdx = config.accounts.findIndex(a => a.name === ACCOUNT_NAME);
if (accountIdx === -1) { console.error('Account missing in config.'); process.exit(1); }

const account = config.accounts[accountIdx];
const BOT_PORT = 5001 + accountIdx;

const SESSION_DIR = path.join(__dirname, `../session-${ACCOUNT_NAME}`);
const DOWNLOAD_DIR = path.join(__dirname, '../downloads', ACCOUNT_NAME);

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let wsClient = null;
let engineContext = null;
let enginePage = null;
let engineRunning = false;
let isInitialLoad = true;

let statsEngineA = { captured: 0, lastCapture: null };
let statsEngineB = { captured: 0, lastCapture: null, lastDownload: null };

const app = express();
app.use(express.json());

let uiClients = [];
function log(msg) { 
    console.log(`[${new Date().toISOString()}] [${ACCOUNT_NAME}] ${msg}`); 
    let safeMsg = `[${ACCOUNT_NAME}] ${msg}`.replace(/\n/g, '<br>');
    uiClients.forEach(client => client.write(`data: ${safeMsg}\n\n`));
}

app.get('/api/control/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    uiClients.push(res);
    res.write(`data: [SYSTEM] Dual-Engine stream for ${ACCOUNT_NAME}...<br>\n\n`);
    req.on('close', () => uiClients = uiClients.filter(c => c !== res));
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ACCOUNT_NAME} — Dual Engine Control</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
        --bg-primary: #020617;
        --bg-card: #0f172a;
        --bg-card-hover: #1e293b;
        --border: rgba(34,211,238,0.3);
        --border-glow: rgba(34,211,238,0.6);
        --text-primary: #e2e8f0;
        --text-muted: #64748b;
        --accent-cyan: #22d3ee;
        --accent-blue: #3b82f6;
        --accent-green: #10b981;
        --accent-amber: #f59e0b;
        --accent-red: #ef4444;
        --accent-purple: #a855f7;
    }
    body { 
        background: var(--bg-primary); 
        color: var(--text-primary); 
        font-family: 'JetBrains Mono', monospace; 
        min-height: 100vh;
        overflow-x: hidden;
    }
    body::before {
        content: '';
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background-image: 
            linear-gradient(rgba(34,211,238,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(34,211,238,0.03) 1px, transparent 1px);
        background-size: 30px 30px;
        pointer-events: none; z-index: 0;
    }

    .container { max-width: 1100px; margin: 0 auto; padding: 24px; position: relative; z-index: 1; }

    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .bot-avatar { font-size: 14px; font-weight: 700; color: var(--accent-cyan); padding: 4px 8px; border: 1px solid var(--accent-cyan); background: rgba(34,211,238,0.1); }
    .bot-name { font-size: 20px; font-weight: 700; color: var(--accent-cyan); }
    .bot-email { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
    .header-right { display: flex; align-items: center; gap: 14px; }
    .live-indicator { display: flex; align-items: center; gap: 8px; border: 1px solid var(--accent-green); padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--accent-green); text-transform: uppercase; letter-spacing: 1px; background: rgba(16,185,129,0.1); }
    .live-dot { width: 8px; height: 8px; background: var(--accent-green); animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,185,129,0.4); } 50% { opacity: 0.5; box-shadow: 0 0 0 6px rgba(16,185,129,0); } }
    .uptime-badge { color: var(--text-muted); font-size: 11px; background: var(--bg-card); border: 1px solid var(--border); padding: 4px 10px; }

    .engines-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
    .engine-card { background: var(--bg-card); border: 1px solid var(--border); padding: 20px; transition: all 0.3s; position: relative; }
    .engine-card::before { content:''; position:absolute; top:0; left:0; width:4px; height:100%; background: var(--accent-blue); }
    .engine-card.engine-b::before { background: var(--accent-amber); }
    .engine-card:hover { border-color: var(--accent-cyan); box-shadow: inset 0 0 20px rgba(34,211,238,0.05); }
    .engine-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 10px; }
    .engine-title { display: flex; align-items: center; gap: 10px; }
    .engine-icon { font-size: 12px; font-weight: 700; padding: 2px 6px; border: 1px solid currentColor; }
    .engine-a .engine-icon { color: var(--accent-blue); background: rgba(59,130,246,0.1); }
    .engine-b .engine-icon { color: var(--accent-amber); background: rgba(245,158,11,0.1); }
    .engine-label { font-size: 14px; font-weight: 600; color: #fff; }
    .engine-sublabel { font-size: 10px; color: var(--text-muted); text-transform: uppercase; }
    .engine-status { font-size: 10px; padding: 2px 6px; border: 1px solid var(--accent-green); color: var(--accent-green); text-transform: uppercase; letter-spacing: 0.5px; }
    .engine-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .engine-stat { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); padding: 10px 12px; }
    .engine-stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
    .engine-stat-value { font-size: 18px; font-weight: 700; }
    .val-blue { color: var(--accent-cyan); }
    .val-green { color: var(--accent-green); }
    .val-amber { color: var(--accent-amber); }

    .summary-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
    .summary-item { background: var(--bg-card); border: 1px solid var(--border); padding: 16px; text-align: center; }
    .summary-item .s-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; }
    .summary-item .s-value { font-size: 20px; font-weight: 700; }

    .recent-txns { background: var(--bg-card); border: 1px solid var(--border); padding: 20px; margin-bottom: 20px; max-height: 200px; overflow-y: auto; }
    .recent-txns h3 { font-size: 12px; font-weight: 700; margin-bottom: 12px; color: var(--accent-cyan); border-bottom: 1px solid var(--border); padding-bottom: 8px; text-transform: uppercase; }
    .txn-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed rgba(255,255,255,0.1); font-size: 12px; animation: slideIn 0.3s ease; }
    .txn-row:last-child { border: none; }
    .txn-payer { color: #fff; font-weight: 500; flex: 1; }
    .txn-amount { color: var(--accent-green); font-weight: 700; margin: 0 16px; }
    .txn-engine { font-size: 10px; padding: 2px 6px; border: 1px solid currentColor; font-weight: 600; text-transform: uppercase; }
    .txn-engine.a { color: var(--accent-blue); background: rgba(59,130,246,0.1); }
    .txn-engine.b { color: var(--accent-amber); background: rgba(245,158,11,0.1); }
    .txn-time { color: var(--text-muted); font-size: 10px; margin-left: 12px; min-width: 60px; text-align: right; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
    .empty-txn { color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px; font-style: italic; }

    .terminal { background: #000; border: 1px solid var(--border); overflow: hidden; }
    .terminal-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: rgba(34,211,238,0.1); border-bottom: 1px solid var(--border); }
    .terminal-title { font-size: 11px; color: var(--accent-cyan); font-weight: 700; }
    .terminal-body { padding: 14px; max-height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.7; color: #a1a1aa; }
    .terminal-body div { padding: 1px 0; border-bottom: 1px dashed rgba(255,255,255,0.05); }
    .terminal-body::-webkit-scrollbar { width: 4px; }
    .terminal-body::-webkit-scrollbar-track { background: transparent; }
    .terminal-body::-webkit-scrollbar-thumb { background: rgba(34,211,238,0.3); } }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div class="header-left">
            <div class="bot-avatar">[OK]</div>
            <div>
                <div class="bot-name">${ACCOUNT_NAME}</div>
                <div class="bot-email">${account.email} • Port ${BOT_PORT}</div>
            </div>
        </div>
        <div class="header-right">
            <div class="uptime-badge" id="uptime">⏱ 00:00:00</div>
            <div class="live-indicator"><span class="live-dot"></span>LIVE</div>
        </div>
    </div>

    <div class="engines-row">
        <div class="engine-card engine-a">
            <div class="engine-header">
                <div class="engine-title">
                    <div class="engine-icon">[XHR]</div>
                    <div><div class="engine-label">Engine A</div><div class="engine-sublabel">XHR Interception</div></div>
                </div>
                <span class="engine-status status-armed">Armed</span>
            </div>
            <div class="engine-stats">
                <div class="engine-stat"><div class="engine-stat-label">Captured</div><div class="engine-stat-value val-blue" id="ea-count">0</div></div>
                <div class="engine-stat"><div class="engine-stat-label">Last Hit</div><div class="engine-stat-value val-green" id="ea-last" style="font-size:12px">—</div></div>
            </div>
        </div>
        <div class="engine-card engine-b">
            <div class="engine-header">
                <div class="engine-title">
                    <div class="engine-icon">[CSV]</div>
                    <div><div class="engine-label">Engine B</div><div class="engine-sublabel">CSV Download</div></div>
                </div>
                <span class="engine-status status-armed">Armed</span>
            </div>
            <div class="engine-stats">
                <div class="engine-stat"><div class="engine-stat-label">Captured</div><div class="engine-stat-value val-amber" id="eb-count">0</div></div>
                <div class="engine-stat"><div class="engine-stat-label">Last Download</div><div class="engine-stat-value val-green" id="eb-last" style="font-size:12px">—</div></div>
            </div>
        </div>
    </div>

    <div class="summary-strip">
        <div class="summary-item"><div class="s-label">Total Known</div><div class="s-value val-blue" id="total-known">0</div></div>
        <div class="summary-item"><div class="s-label">Sweep Cycles</div><div class="s-value val-green" id="sweep-count">0</div></div>
        <div class="summary-item"><div class="s-label">Memory</div><div class="s-value val-amber" id="mem-usage">—</div></div>
        <div class="summary-item"><div class="s-label">Pipeline</div><div class="s-value" style="color:var(--accent-green)" id="pipeline-status">● Active</div></div>
    </div>

    <div class="recent-txns">
        <h3>[ ] Recent Transactions</h3>
        <div id="txn-feed"><div class="empty-txn">Waiting for first transaction capture...</div></div>
    </div>

    <div class="terminal">
        <div class="terminal-header">
            <div class="terminal-title">~/logs/dual-engine-stream.log</div>
        </div>
        <div class="terminal-body" id="term"></div>
    </div>
</div>

<script>
    const bootTime = Date.now();
    let sweepCount = 0;
    const recentTxns = [];

    setInterval(() => {
        const diff = Math.floor((Date.now() - bootTime) / 1000);
        const h = String(Math.floor(diff / 3600)).padStart(2, '0');
        const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
        const s = String(diff % 60).padStart(2, '0');
        document.getElementById('uptime').textContent = '⏱ ' + h + ':' + m + ':' + s;
    }, 1000);

    setInterval(() => {
        const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : '—';
        document.getElementById('mem-usage').textContent = mem;
    }, 5000);

    setInterval(async () => {
        try {
            const res = await fetch('/internal/stats');
            const data = await res.json();
            document.getElementById('ea-count').textContent = data.engineA.captured;
            document.getElementById('eb-count').textContent = data.engineB.captured;
            document.getElementById('total-known').textContent = data.known;
            if (data.engineA.lastCapture) document.getElementById('ea-last').textContent = new Date(data.engineA.lastCapture).toLocaleTimeString();
            if (data.engineB.lastDownload) document.getElementById('eb-last').textContent = new Date(data.engineB.lastDownload).toLocaleTimeString();
        } catch(e) {}
    }, 3000);

    const ev = new EventSource('/api/control/logs');
    ev.onmessage = e => {
        const term = document.getElementById('term');
        const d = document.createElement('div');
        const msg = e.data;
        d.innerHTML = msg;

        term.innerHTML = ''; 
        if (msg.includes('ENGINE-A')) d.style.color = '#6366f1';
        else if (msg.includes('ENGINE-B')) d.style.color = '#f59e0b';
        else if (msg.includes('NEW')) d.style.color = '#10b981';
        else if (msg.includes('CRASH') || msg.includes('ERROR')) d.style.color = '#ef4444';
        else if (msg.includes('WAKEUP')) d.style.color = '#a855f7';
        else if (msg.includes('SYNC')) d.style.color = '#22d3ee';
        else d.style.color = '#94a3b8';

        term.appendChild(d);
        term.scrollTop = term.scrollHeight;

        if (msg.includes('Sweep cycle')) {
            sweepCount++;
            document.getElementById('sweep-count').textContent = sweepCount;
        }

        if (msg.includes('NEW:') || msg.includes('NEW TRANSACTION')) {
            const amtMatch = msg.match(/₹([\\d,.]+)/);
            const fromMatch = msg.match(/from\\s+(.+?)\\s*[|\\n]/);
            const engine = msg.includes('ENGINE-A') ? 'a' : 'b';
            if (amtMatch) {
                addTxnToFeed({
                    payer: fromMatch ? fromMatch[1].trim() : 'Unknown',
                    amount: amtMatch[1],
                    engine: engine,
                    time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                });
            }
        }

        while (term.children.length > 200) term.removeChild(term.firstChild);
    };

    function addTxnToFeed(txn) {
        const feed = document.getElementById('txn-feed');
        if (feed.querySelector('.empty-txn')) feed.innerHTML = '';
        
        const row = document.createElement('div');
        row.className = 'txn-row';
        row.innerHTML = '<span class="txn-payer">' + txn.payer + '</span>' +
            '<span class="txn-amount">₹' + txn.amount + '</span>' +
            '<span class="txn-engine ' + txn.engine + '">' + (txn.engine === 'a' ? 'XHR' : 'CSV') + '</span>' +
            '<span class="txn-time">' + txn.time + '</span>';
        feed.insertBefore(row, feed.firstChild);
        
        while (feed.children.length > 15) feed.removeChild(feed.lastChild);
    }
</script>
</body></html>`);
});

async function sendTelegram(msg) {
    const token = account.telegram_bot_token || config.telegram_bot_token;
    const chat = account.telegram_chat_id || config.telegram_chat_id;
    if (!token || !chat) return;
    try {
        const text = encodeURIComponent(msg);
        await axios.get(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${chat}&text=${text}`, { timeout: 5000 });
    } catch (err) { }
}

function normalizeFromXHR(trx) {
    const amt = parseFloat(trx.amount) || 0;
    return {
        'Transaction ID': trx.merchantTransactionId || '',
        'Payer name': trx.payerName || 'Unknown',
        'Payer': trx.payerName || 'Unknown',
        'Amount': amt,
        'Paid via': trx.payerUpiId || 'UPI',
        'Type': 'Payment',
        'Creation time': trx.timestamp || new Date().toISOString(),
        'Status': 'Completed',
        'Processing fee': 0,
        'Net amount': amt,
        'Update time': new Date().toISOString(),
        'Notes': trx.note || ''
    };
}

async function syncToHub(rows, engine) {
    if (!rows || rows.length === 0) return;
    try {
        const res = await axios.post('http://localhost:3000/api/report', {
            account: ACCOUNT_NAME,
            timestamp: new Date().toISOString(),
            transactions: rows
        }, { timeout: 15000 });
        log(`[${engine}] Synced ${rows.length} rows → ${res.data.newCount || 0} new`);
    } catch (e) {
        log(`[${engine}] Hub sync failed: ${e.message}`);
    }
}

async function processEngineA(payload) {
    if (!payload || payload.length === 0) return;

    const exportRows = payload.map(trx => normalizeFromXHR(trx));
    const newOnes = payload.filter(t => !knownTransactions.has(t.merchantTransactionId));
    for (const trx of payload) { knownTransactions.add(trx.merchantTransactionId); }

    await syncToHub(exportRows, 'ENGINE-A');
    statsEngineA.captured += newOnes.length;
    statsEngineA.lastCapture = new Date().toISOString();

    if (!isInitialLoad && newOnes.length > 0) {
        for (const trx of newOnes) {
            log(`[ENGINE-A] ⚡ NEW: ₹${trx.amount} from ${trx.payerName} | ${trx.note}`);
            sendTelegram(`⚡ ENGINE-A [${ACCOUNT_NAME}]\nAmount: ₹${trx.amount}\nFrom: ${trx.payerName || 'Unknown'}\nNote: ${trx.note}\nID: ${trx.merchantTransactionId}`);
        }
    } else if (isInitialLoad) {
        log(`[ENGINE-A] Initial load: ${exportRows.length} transactions synced to dashboard`);
    }
    isInitialLoad = false;
}

function parseCSV(text) {
    const results = [];
    const lines = text.split(/\r?\n/);
    if (lines.length < 1) return results;

    const headers = lines[0].replace(/^\ufeff/, '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = [];
        let current = '';
        let inQuotes = false;

        for (let char of line) {
            if (char === '"') inQuotes = !inQuotes;
            else if (char === ',' && !inQuotes) {
                values.push(current.trim().replace(/^"|"$/g, ''));
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim().replace(/^"|"$/g, ''));

        const row = {};
        headers.forEach((header, idx) => { row[header] = values[idx] || ''; });
        results.push(row);
    }
    return results;
}

async function runEngineB() {
    if (!engineRunning || !enginePage) return;

    try {
        const reportUrl = `https://pay.google.com/g4b/reports/${account.report_id}`;
        const reportPage = await engineContext.newPage();
        
        try {
            await reportPage.goto(reportUrl, { timeout: 30000, waitUntil: 'load' });
            await reportPage.waitForTimeout(3000);

            await reportPage.evaluate(() => {
                const radio = document.querySelector('input[type="radio"][value="today"]');
                if (radio && !radio.checked) radio.click();
            });
            await reportPage.waitForTimeout(1500);

            const btnLocator = reportPage.locator('button:has-text("Download report")');
            const count = await btnLocator.count();

            if (count === 0) {
                log('[ENGINE-B] No download button found');
                await reportPage.close();
                return;
            }

            const oldFiles = fs.readdirSync(DOWNLOAD_DIR);
            for (const file of oldFiles) fs.unlinkSync(path.join(DOWNLOAD_DIR, file));

            log('[ENGINE-B] 📄 Initiating CSV download...');
            await reportPage.getByRole('button', { name: /download/i }).first().click();

            const downloadPromise = reportPage.waitForEvent('download', { timeout: 15000 }).catch(() => null);
            const modalPromise = reportPage.waitForSelector('text=CSV', { timeout: 5000 }).catch(() => null);
            const firstAction = await Promise.race([downloadPromise, modalPromise]);

            let downloadObj;
            if (firstAction && !firstAction.saveAs) {
                await reportPage.getByText('CSV').click(); 
                await reportPage.waitForTimeout(1000);
                const finalBtn = reportPage.getByRole('button', { name: /download/i }).last();
                [downloadObj] = await Promise.all([
                    reportPage.waitForEvent('download', { timeout: 30000 }),
                    finalBtn.click()
                ]);
            } else if (firstAction) {
                downloadObj = firstAction;
            } else {
                log('[ENGINE-B] Download timeout');
                await reportPage.close();
                return;
            }

            const dlPath = path.join(DOWNLOAD_DIR, `report_${Date.now()}.csv`);
            await downloadObj.saveAs(dlPath);

            const csvText = fs.readFileSync(dlPath, 'utf-8');
            const rows = parseCSV(csvText);
            
            log(`[ENGINE-B] 📄 CSV captured: ${rows.length} rows`);
            
            await syncToHub(rows, 'ENGINE-B'); 
            statsEngineB.captured += rows.length;
            statsEngineB.lastDownload = new Date().toISOString();

            await downloadObj.delete().catch(() => {});
            
        } finally {
            await reportPage.close().catch(() => {});
        }

    } catch (e) {
        log(`[ENGINE-B] CSV cycle error: ${e.message}`);
    }
}

async function runDualPollingLoop() {
    if (!engineRunning) return;
    try {
        log('[DUAL] 🔄 Sweep cycle starting...');
        
        await enginePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        log('[ENGINE-A] ⚡ XHR sweep complete');

        if (statsEngineB.captured === 0 || Math.random() < 0.3) {
            await runEngineB();
        }
        
        setTimeout(runDualPollingLoop, (account.download_interval_sec || config.download_interval_sec || 40) * 1000);
    } catch(e) {
        log(`[CRASH] Playwright stalled: ${e.message}. Auto-recovering...`);
        engineRunning = false;
        try { await engineContext.close(); } catch(x){}
        engineContext = null; enginePage = null;
        setTimeout(async () => { engineRunning = true; await bootEngine(); }, 5000);
    }
}

async function bootEngine() {
    let merchantUrl = 'https://pay.google.com/g4b/signup';
    if (account.report_id) {
        merchantUrl = `https://pay.google.com/g4b/transactions/${account.report_id}`;
    }

    try {
        log(`🚀 Booting Dual-Engine for ${ACCOUNT_NAME}...`);

        const lockPath = path.join(SESSION_DIR, 'SingletonLock');
        const lockFile = path.join(SESSION_DIR, 'lockfile');
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

        const chromePath = require('playwright').chromium.executablePath();

        engineContext = await chromium.launchPersistentContext(SESSION_DIR, {
            headless: false,
            executablePath: chromePath,
            acceptDownloads: true,
            downloadsPath: DOWNLOAD_DIR,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--headless=new',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-sandbox'
            ]
        });

        enginePage = await engineContext.newPage();

        await engineContext.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font'].includes(type)) return route.abort();
            return route.continue();
        });

        enginePage.on('response', async response => {
            if (response.url().includes('batchexecute') && response.url().includes('RPtkab')) {
                try {
                    if (response.status() === 200) {
                        const body = await response.text();
                        processEngineA(parseTransactions(body));
                    }
                } catch (err) {}
            }
        });

        try {
            await enginePage.goto(merchantUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            try {
                await enginePage.waitForURL(/BCR[A-Z0-9]{10,}/, { timeout: 15000 });
            } catch(e) { } 

            const currentUrl = enginePage.url();
            const match = currentUrl.match(/(BCR[A-Z0-9]{10,})/);
            
            if (match && match[1]) {
                if (account.report_id !== match[1]) {
                    account.report_id = match[1];
                    const fs = require('fs');
                    const config = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../config/accounts.json'), 'utf-8'));
                    const idx = config.accounts.findIndex(a => a.name === ACCOUNT_NAME);
                    if (idx !== -1) {
                        config.accounts[idx].report_id = match[1];
                        fs.writeFileSync(require('path').join(__dirname, '../config/accounts.json'), JSON.stringify(config, null, 4));
                    }
                    log(`[SYSTEM] 🎯 Auto-discovered Merchant ID: ${match[1]}`);
                }
                
                if (!currentUrl.includes('/transactions')) {
                    log('[SYSTEM] Routing to transactions view...');
                    await enginePage.goto(`https://pay.google.com/g4b/transactions/${account.report_id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else {
                    log(`[SYSTEM] Anchored to transactions page`);
                }
            } else {
                log(`[WARNING] Could not auto-discover Merchant ID. URL: ${currentUrl}`);
                if (!account.report_id) {
                    log('[ERROR] Missing Merchant ID and auto-discovery failed. Please login.');
                    engineRunning = false;
                    return false;
                }
            }
        } catch (e) { log(`[WARNING] Page goto: ${e.message}`); }

        log('[SYSTEM] ⚡ Engine A — ARMED');
        log('[SYSTEM] 📄 Engine B — ARMED');
        setTimeout(runDualPollingLoop, (account.download_interval_sec || config.download_interval_sec || 40) * 1000);
        return true;
    } catch (e) {
        log(`[CRITICAL] Boot failed: ${e.message}`);
        engineRunning = false; return false;
    }
}

app.post('/internal/wakeup', async (req, res) => {
    log('[WAKEUP] Multi-stage sweep initiated!');
    res.json({ ok: true });
    if (!engineRunning || !enginePage) return;

    setTimeout(async () => {
        if (!engineRunning) return;
        try {
            log('[WAKEUP] Sweep #1');
            await enginePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            
            setTimeout(async () => {
                await runEngineB();
            }, 3000);

            setTimeout(async () => {
                if (!engineRunning) return;
                try {
                    log('[WAKEUP] Sweep #2');
                    await enginePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                } catch(e) { log(`[WAKEUP] Sweep #2 error: ${e.message}`); }
            }, 7000);
        } catch(e) { log(`[WAKEUP] Sweep #1 error: ${e.message}`); }
    }, 2000);
});

app.get('/internal/stats', (req, res) => {
    res.json({ engineA: statsEngineA, engineB: statsEngineB, known: knownTransactions.size });
});

app.listen(BOT_PORT, async () => {
    log(`Dual-Engine Wakeup Receiver on port ${BOT_PORT}`);
    engineRunning = true;
    await bootEngine();
});

async function handleShutdown() {
    log(`Terminating dual-engine...`);
    if (engineContext) await engineContext.close().catch(() => {});
    process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

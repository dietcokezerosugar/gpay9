const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '../data/gpay.db');
const dbDir = path.dirname(dbFile);

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbFile);

// Enable WAL mode and normal sync for performance on disk-heavy environments
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Database Schema Initialization
db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        payer TEXT,
        paid_via TEXT,
        type TEXT,
        creation_time TEXT,
        transaction_id TEXT UNIQUE,
        amount REAL,
        processing_fee REAL,
        net_amount REAL,
        status TEXT,
        update_time TEXT,
        notes TEXT,
        webhook_status INTEGER DEFAULT 0, -- 0: Pending, 1: Success
        webhook_attempts INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

`);

// Ensure existing databases are updated with new webhook tracking columns
try { db.exec("ALTER TABLE transactions ADD COLUMN webhook_status INTEGER DEFAULT 0;"); } catch (e) {}
try { db.exec("ALTER TABLE transactions ADD COLUMN webhook_attempts INTEGER DEFAULT 0;"); } catch (e) {}

db.exec(`
    CREATE TABLE IF NOT EXISTS download_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        row_count INTEGER,
        new_rows INTEGER,
        total_amount REAL,
        downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        event_type TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

/**
 * Bulk inserts transactions and handles deduplication via UNIQUE constraint on transaction_id.
 */
function insertTransactionsBulk(account, transactions) {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO transactions (
            account, payer, paid_via, type, creation_time, transaction_id, 
            amount, processing_fee, net_amount, status, update_time, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const logDownload = db.prepare(`
        INSERT INTO download_logs (account, row_count, new_rows, total_amount)
        VALUES (?, ?, ?, ?)
    `);

    let newCount = 0;
    let totalAmount = 0;
    const insertedRows = [];

    const transaction = db.transaction((rows) => {
        for (const row of rows) {
            const amount = parseFloat(row['Amount'] || 0);
            const fee = parseFloat(row['Processing fee'] || 0);
            const net = parseFloat(row['Net amount'] || 0);
            
            const result = insert.run(
                account,
                row['Payer name'] || row['Payer'],
                row['Paid via'],
                row['Type'],
                row['Creation time'],
                row['Transaction ID'],
                amount,
                fee,
                net,
                row['Status'] || 'Completed',
                row['Update time'],
                row['Notes']
            );

            if (result.changes > 0) {
                newCount++;
                totalAmount += amount;
                insertedRows.push({
                    transaction_id: row['Transaction ID'],
                    amount: amount,
                    payer: row['Payer name'] || row['Payer'],
                    paid_via: row['Paid via'],
                    type: row['Type'],
                    creation_time: row['Creation time'],
                    status: row['Status'] || 'Completed',
                    processing_fee: fee,
                    net_amount: net,
                    notes: row['Notes']
                });
            }
        }
        logDownload.run(account, rows.length, newCount, totalAmount);
    });

    transaction(transactions);
    return { newCount, totalAmount, insertedRows };
}

/**
 * Logs bot internal events or capture errors.
 */
const insertBotEvent = db.prepare(`
    INSERT INTO bot_events (account, event_type, message)
    VALUES (?, ?, ?)
`);

// Repository Queries

function getTransactions({ account, status, search, limit, offset, startDate, endDate }) {
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (account) { query += ' AND account = ?'; params.push(account); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (search) {
        query += ' AND (payer LIKE ? OR transaction_id LIKE ? OR notes LIKE ?)';
        const p = `%${search}%`;
        params.push(p, p, p);
    }
    if (startDate) { query += ' AND creation_time >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND creation_time <= ?'; params.push(endDate); }

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
    const total = db.prepare(countQuery).get(...params).total;

    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params);
    return { total, rows };
}

function updateTransactionStatus(transactionId, status) {
    const info = db.prepare('UPDATE transactions SET status = ?, update_time = ? WHERE transaction_id = ?')
        .run(status, new Date().toISOString(), transactionId);
    return info.changes > 0;
}

function getAccountSummary(account) {
    return db.prepare(`
        SELECT 
            COUNT(*) as total_count,
            SUM(amount) as total_amount,
            SUM(CASE WHEN LOWER(status) = 'completed' OR LOWER(status) = 'settled' THEN amount ELSE 0 END) as settled_amount
        FROM transactions 
        WHERE account = ?
    `).get(account);
}

function getFleetSummary() {
    return db.prepare(`
        SELECT 
            account,
            COUNT(*) as total_transactions,
            SUM(amount) as total_amount,
            SUM(net_amount) as total_net,
            SUM(CASE WHEN LOWER(status) = 'completed' OR LOWER(status) = 'settled' THEN amount ELSE 0 END) as settled_amount,
            SUM(CASE WHEN LOWER(status) = 'pending' THEN amount ELSE 0 END) as pending_amount
        FROM transactions
        GROUP BY account
    `).all();
}

function getRecentEvents(account, limit) {
    let query = 'SELECT * FROM bot_events';
    const params = [];
    if (account) { query += ' WHERE account = ?'; params.push(account); }
    query += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(query).all(...params);
}

function getUnsentTransactions(account) {
    return db.prepare('SELECT * FROM transactions WHERE account = ? AND webhook_status = 0 ORDER BY id ASC LIMIT 50')
        .all(account);
}

function markWebhookSuccess(transactionId) {
    db.prepare('UPDATE transactions SET webhook_status = 1 WHERE transaction_id = ?')
        .run(transactionId);
}

function incrementWebhookAttempts(transactionId) {
    db.prepare('UPDATE transactions SET webhook_attempts = webhook_attempts + 1 WHERE transaction_id = ?')
        .run(transactionId);
}

module.exports = {
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
};


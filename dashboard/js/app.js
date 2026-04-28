// ===== GPay Fleet Dashboard — SPA Router & Page Renderers =====

const App = {
    currentPage: 'overview',
    refreshInterval: null,
    renderDebounce: null,
    isUpdating: false,
    state: {
        accounts: [],
        summary: { totals: { amount: 0, settled: 0, pending: 0, transactions: 0 }, activeBots: 0, totalBots: 0 },
        transactions: { rows: [], total: 0 }
    },

    init() {
        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const page = link.dataset.page;
                this.navigate(page);
            });
        });

        // WebSocket live updates
        WS.onMessage(msg => this.handleWS(msg));

        // Submit Login form
        document.getElementById('login-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            const errDiv = document.getElementById('login-error');
            const user = document.getElementById('admin-username').value;
            const pwd = document.getElementById('admin-password').value;
            
            btn.textContent = "VERIFYING...";
            errDiv.classList.add('hidden');
            
            try {
                const res = await API.login(user, pwd);
                localStorage.setItem('gpay_admin_token', res.token);
                document.getElementById('auth-wall').classList.add('hidden');
                document.getElementById('sidebar').style.display = 'flex';
                document.getElementById('main-content').style.display = 'block';
                this.navigate('overview');
            } catch (err) {
                errDiv.classList.remove('hidden');
                btn.textContent = "ACCESS SYSTEM";
            }
        });

        // Start on overview
        this.navigate('overview');
    },

    showAuthWall() {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        document.getElementById('sidebar').style.display = 'none';
        document.getElementById('main-content').style.display = 'none';
        document.getElementById('auth-wall').classList.remove('hidden');
    },

    navigate(page) {
        this.currentPage = page;

        // Update active nav
        document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
        document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

        // Clear refresh interval
        if (this.refreshInterval) clearInterval(this.refreshInterval);

        // Render page
        this.render(page);
    },

    updateDOM(el, htmlString) {
        if (!window.morphdom) {
            el.innerHTML = htmlString;
            return;
        }
        
        const temp = document.createElement('div');
        temp.innerHTML = htmlString;
        
        morphdom(el, temp, {
            childrenOnly: true,
            onBeforeElUpdated: function(fromEl, toEl) {
                // Prevent input loss during live server diffs
                if (fromEl.tagName === 'INPUT' || fromEl.tagName === 'SELECT' || fromEl.tagName === 'TEXTAREA') {
                    if (document.activeElement === fromEl) return false;
                    
                    // Maintain user-typed values even if not strictly focused
                    if (fromEl.value !== '' && toEl.value === '') {
                        toEl.value = fromEl.value; 
                    }
                }
                return true;
            }
        });
    },

    async render(page, params = {}, isLive = false) {
        const content = document.getElementById('page-content');
        if (this.isUpdating && !isLive) return;
        
        // Don't mark as updating for live background refreshes to prevent blocking
        if (!isLive) this.isUpdating = true;

        // Transitions only for manual navigation, not background noise
        if (!isLive) content.classList.add('page-transitioning');

        try {
            switch (page) {
                case 'overview':    await this.renderOverview(content); break;
                case 'transactions': await this.renderTransactions(content, params); break;
                case 'analytics':   await this.renderAnalytics(content); break;
                case 'accounts':    await this.renderAccounts(content); break;
                case 'logs':        await this.renderLogs(content); break;
                case 'settings':    await this.renderSettings(content); break;
            }
            
            // Only apply visual transitions if it's a structural page change
            if (!isLive) {
                content.classList.add('fade-in');
                setTimeout(() => content.classList.remove('fade-in', 'page-transitioning'), 400);
            }

        } catch (err) {
            this.updateDOM(content, `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${err.message}</p></div>`);
        } finally {
            this.isUpdating = false;
        }
    },

    handleWS(msg) {
        // Instant Feedback
        if (msg.type === 'new_download') {
            showToast(`📦 ${msg.data.account}: ${msg.data.newRows} new transactions`, 'success');
            
            // Instantly update local state Summary
            if (msg.data.transactions) {
                msg.data.transactions.forEach(tx => {
                    this.state.summary.totals.amount += tx.amount || 0;
                    this.state.summary.totals.transactions += 1;
                    if (tx.status === 'Settled') {
                        this.state.summary.totals.settled += tx.amount || 0;
                    } else {
                        this.state.summary.totals.pending += tx.amount || 0;
                    }
                });
                
                // Surgical update of summary UI if on overview
                const summaryEl = document.getElementById('overview-summary');
                if (summaryEl) {
                    this.updateDOM(summaryEl, this.renderSummaryHTML(this.state.summary.totals, this.state.summary));
                }
            }
            
            this.syncLiveMetrics(); // Keep as secondary background refresh
        }
        if (msg.type === 'bot_status') {
            if (msg.data.status === 'stopped' || msg.data.status === 'error' || msg.data.status === 'online') {
                 showToast(`🤖 ${msg.data.name}: ${msg.data.status}`, 'info');
            }
            this.syncLiveMetrics();
        }
        if (msg.type === 'transaction_status_updated') {
            showToast(`✅ Txn ${msg.data.transaction_id.substring(0,8)}... updated`, 'success');
            this.syncLiveMetrics();
        }

        if (this.currentPage === 'transactions') {
            if (msg.data.transactions) {
                // Surgical update: prepend new rows instantly
                this.prependTransactions(msg.data.transactions);
                
                // Update total count subtitle
                const sub = document.querySelector('.page-header .subtitle');
                if (sub) {
                    const current = parseInt(sub.textContent) || 0;
                    sub.textContent = `${current + msg.data.newRows} total transactions`;
                }
            } else {
                // Fallback to debounce render if no data in msg
                if (this.renderDebounce) clearTimeout(this.renderDebounce);
                this.renderDebounce = setTimeout(() => {
                    this.render('transactions', this.currentTxnParams || {}, true);
                }, 1000);
            }
        }
    },

    prependTransactions(rows) {
        const tbody = document.querySelector('table tbody');
        if (!tbody) return;

        // Remove empty state if present
        if (tbody.innerHTML.includes('No transactions found')) {
            tbody.innerHTML = '';
        }

        // Convert to HTML and prepend
        rows.forEach(t => {
            const tr = document.createElement('tr');
            tr.className = 'new-row-pulse';
            tr.innerHTML = this.renderTransactionRowHtml(t);
            tbody.insertBefore(tr, tbody.firstChild);
        });

        // Optional: Trim table to stay at reasonable size (e.g. 100 rows)
        while (tbody.children.length > 100) {
            tbody.removeChild(tbody.lastChild);
        }
    },

    renderTransactionRowHtml(t) {
        return `
            <td><span style="color:var(--accent-cyan);font-weight:500">${t.account}</span></td>
            <td style="color:var(--text-primary)">${t.payer}</td>
            <td style="color:var(--accent-green);font-weight:600">₹${parseFloat(t.amount || 0).toLocaleString('en-IN')}</td>
            <td>₹${parseFloat(t.net_amount || 0).toLocaleString('en-IN')}</td>
            <td><span class="status-badge ${t.status === 'Settled' ? 'online' : 'stopped'}" style="font-size:11px">${t.status === 'Settled' ? '✓ Settled' : '⏳ Pending'}</span></td>
            <td>${t.type}</td>
            <td style="font-family:monospace;font-size:12px">${t.transaction_id}</td>
            <td style="white-space:nowrap">${t.creation_time}</td>
            <td style="color:var(--text-muted);font-size:12px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${t.notes || ''}">${t.notes || '-'}</td>
        `;
    },

    async syncLiveMetrics() {
        if (this.currentPage !== 'overview' && this.currentPage !== 'accounts') return;
        
        try {
            const [data, summary] = await Promise.all([
                API.getAccounts(),
                API.getSummary()
            ]);

            // Update state
            this.state.accounts = data.accounts;
            this.state.summary = summary;

            // Surgical Summary Update
            const summaryEl = document.getElementById('overview-summary');
            if (summaryEl) {
                this.updateDOM(summaryEl, this.renderSummaryHTML(summary.totals, summary));
            }

            // Surgical Account Cards Update
            data.accounts.forEach(acc => {
                const cardEl = document.getElementById(`card-${acc.name}`);
                if (cardEl) {
                    this.updateDOM(cardEl, this.renderAccountCard(acc));
                }
            });
        } catch (err) {
            console.error('Failed to sync live metrics:', err);
        }
    },

    // =====================
    // FLEET OVERVIEW
    // =====================
    async renderOverview(el) {
        const [data, summary] = await Promise.all([
            API.getAccounts(),
            API.getSummary()
        ]);

        this.state.accounts = data.accounts;
        this.state.summary = summary;

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Fleet Overview</h1>
                    <div class="subtitle">${summary.activeBots}/${summary.totalBots} bots active • ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                </div>
                <div style="display:flex;gap:12px;align-items:center">
                    <button class="btn btn-success" onclick="App.startFleet()">▶ Boot Fleet</button>
                    <button class="btn btn-danger" onclick="App.stopFleet()">⏹ Kill Fleet</button>
                    <div class="live-badge" style="margin-left:16px"><span class="live-dot"></span> LIVE</div>
                </div>
            </div>

            <div class="summary-row" id="overview-summary">
                ${this.renderSummaryHTML(summary.totals, summary)}
            </div>

            <div class="account-grid" id="account-grid">
                ${data.accounts.map(acc => this.renderAccountCard(acc)).join('')}
            </div>
        `);

        // Auto-refresh every 15s (background sync)
        this.refreshInterval = setInterval(() => {
            if (this.currentPage === 'overview') this.syncLiveMetrics();
        }, 15000);
    },

    renderSummaryHTML(totals, summary) {
        return `
            <div class="summary-card blue">
                <div class="label">Total Revenue Today</div>
                <div class="value">₹${formatMoney(totals.amount)}</div>
                <div class="sub">${totals.transactions} transactions</div>
            </div>
            <div class="summary-card green">
                <div class="label">Settled</div>
                <div class="value">₹${formatMoney(totals.settled)}</div>
            </div>
            <div class="summary-card yellow">
                <div class="label">Pending</div>
                <div class="value">₹${formatMoney(totals.pending)}</div>
            </div>
            <div class="summary-card purple">
                <div class="label">Active Bots</div>
                <div class="value">${summary.activeBots}<span style="font-size:16px;color:var(--text-muted)">/${summary.totalBots}</span></div>
            </div>
        `;
    },

    renderAccountCard(acc) {
        const s = acc.stats;
        const pm2 = acc.pm2;
        const status = pm2.status || 'stopped';
        const lastDl = s.lastDownload ? timeAgo(s.lastDownload) : 'Never';

        return `
            <div class="account-card" id="card-${acc.name}">
                <div class="account-card-header">
                    <div>
                        <div class="name">${acc.name}</div>
                        <div class="email">${acc.email}</div>
                    </div>
                    <span class="status-badge ${status}">
                        <span class="badge-dot"></span>
                        ${status}
                    </span>
                </div>
                <div class="account-stats">
                    <div class="account-stat">
                        <div class="stat-label">Revenue</div>
                        <div class="stat-value green">₹${formatMoney(s.total_amount || 0)}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Transactions</div>
                        <div class="stat-value blue">${s.total_transactions || 0}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Settled</div>
                        <div class="stat-value green">₹${formatMoney(s.settled_amount || 0)}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Last Download</div>
                        <div class="stat-value" style="font-size:14px">${lastDl}</div>
                    </div>
                </div>
                <div class="account-actions">
                    ${status === 'online'
                        ? `<button class="btn btn-danger btn-sm" onclick="botAction('stop','${acc.name}')">⏹ Stop</button>
                           <button class="btn btn-ghost btn-sm" onclick="botAction('restart','${acc.name}')">🔄 Restart</button>
                           <button class="btn btn-primary btn-sm" style="background:#a855f7;border:none;color:white" onclick="openLiveLogsPanel('${acc.name}', ${acc.port})">🖥️ Live Logs</button>`
                        : `<button class="btn btn-ghost btn-sm" onclick="botAction('login','${acc.name}')">🔑 Login</button>
                           <button class="btn btn-success btn-sm" onclick="botAction('start','${acc.name}')">▶ Start</button>`
                    }
                    <button class="btn btn-ghost btn-sm reset-session-btn" style="margin-left:auto;color:var(--accent-red);border-color:rgba(239, 68, 68, 0.2)" onclick="botAction('reset','${acc.name}')">🗑️ Reset Session</button>
                </div>
            </div>
        `;
    },

    // =====================
    // TRANSACTIONS
    // =====================
    async renderTransactions(el, params = {}) {
        const data = await API.getAccounts();
        const accountNames = data.accounts.map(a => a.name);

        const limit = 50;
        const offset = params.offset || 0;
        const txns = await API.getTransactions({ limit, offset, ...params });

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Transactions</h1>
                    <div class="subtitle">${txns.total} total transactions</div>
                </div>
                <button class="btn btn-ghost" onclick="API.exportTransactions()">📥 Export CSV</button>
            </div>

            <div class="table-container">
                <div class="table-toolbar">
                    <input type="text" class="search-input" id="txn-search" placeholder="Search by payer, transaction ID, or notes..." value="${params.search || ''}">
                    <select class="filter-select" id="txn-account">
                        <option value="">All Accounts</option>
                        ${accountNames.map(n => `<option value="${n}" ${params.account === n ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                    <select class="filter-select" id="txn-status">
                        <option value="">All Statuses</option>
                        <option value="Settled" ${params.status === 'Settled' ? 'selected' : ''}>Settled</option>
                        <option value="Scheduled to Settle" ${params.status === 'Scheduled to Settle' ? 'selected' : ''}>Pending</option>
                    </select>
                    <button class="btn btn-primary btn-sm" onclick="App.applyTxnFilters()">Filter</button>
                </div>
                <div style="overflow-x:auto">
                    <table>
                        <thead>
                            <tr>
                                <th>Account</th>
                                <th>Payer</th>
                                <th>Amount</th>
                                <th>Net</th>
                                <th>Status</th>
                                <th>Type</th>
                                <th>Transaction ID</th>
                                <th>Time</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${txns.rows.length === 0
                                ? '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">No transactions found</td></tr>'
                                : txns.rows.map(t => `<tr class="fade-in">${this.renderTransactionRowHtml(t)}</tr>`).join('')
                            }
                        </tbody>
                    </table>
                </div>
                <div class="table-pagination">
                    <span>Showing ${offset + 1}–${Math.min(offset + limit, txns.total)} of ${txns.total}</span>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-ghost btn-sm" ${offset === 0 ? 'disabled' : ''} onclick="App.renderTransactions(document.getElementById('page-content'), { offset: ${Math.max(0, offset - limit)} })">← Prev</button>
                        <button class="btn btn-ghost btn-sm" ${offset + limit >= txns.total ? 'disabled' : ''} onclick="App.renderTransactions(document.getElementById('page-content'), { offset: ${offset + limit} })">Next →</button>
                    </div>
                </div>
            </div>
        `);
    },

    applyTxnFilters() {
        const search = document.getElementById('txn-search')?.value || '';
        const account = document.getElementById('txn-account')?.value || '';
        const status = document.getElementById('txn-status')?.value || '';
        this.renderTransactions(document.getElementById('page-content'), { search, account, status, offset: 0 });
    },

    // =====================
    // ANALYTICS
    // =====================
    async renderAnalytics(el) {
        const [summary, hourly, topPayers, distribution] = await Promise.all([
            API.getSummary(),
            API.getHourly(),
            API.getTopPayers(),
            API.getDistribution()
        ]);

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Analytics</h1>
                    <div class="subtitle">Today's performance insights</div>
                </div>
            </div>

            <div class="summary-row">
                <div class="summary-card blue">
                    <div class="label">Total Volume</div>
                    <div class="value">₹${formatMoney(summary.totals.amount)}</div>
                    <div class="sub">${summary.totals.transactions} transactions</div>
                </div>
                <div class="summary-card green">
                    <div class="label">Avg Transaction</div>
                    <div class="value">₹${summary.totals.transactions > 0 ? formatMoney(summary.totals.amount / summary.totals.transactions) : '0'}</div>
                </div>
                <div class="summary-card yellow">
                    <div class="label">Processing Fees</div>
                    <div class="value">₹0</div>
                    <div class="sub">No fees charged</div>
                </div>
                <div class="summary-card purple">
                    <div class="label">Accounts Active</div>
                    <div class="value">${summary.perAccount.length}</div>
                </div>
            </div>

            <div class="charts-grid">
                <div class="chart-card">
                    <h3>📈 Hourly Transaction Volume</h3>
                    <div class="chart-wrapper"><canvas id="chart-hourly"></canvas></div>
                </div>
                <div class="chart-card">
                    <h3>💰 Revenue per Account</h3>
                    <div class="chart-wrapper"><canvas id="chart-revenue"></canvas></div>
                </div>
                <div class="chart-card">
                    <h3>🏷️ Amount Distribution</h3>
                    <div class="chart-wrapper"><canvas id="chart-distribution"></canvas></div>
                </div>
                <div class="chart-card">
                    <h3>👤 Top Payers</h3>
                    <div class="chart-wrapper"><canvas id="chart-payers"></canvas></div>
                </div>
            </div>
        `);

        // Render charts after DOM is ready
        requestAnimationFrame(() => {
            // Hourly volume
            const hours = hourly.map(h => h.hour_part || '??');
            const counts = hourly.map(h => h.count);
            const amounts = hourly.map(h => h.total);
            createLineChart('chart-hourly', hours, [
                { label: 'Transaction Count', data: counts },
                { label: 'Amount (₹)', data: amounts }
            ]);

            // Revenue per account
            const accNames = summary.perAccount.map(a => a.account);
            const accRevenue = summary.perAccount.map(a => a.total_amount);
            createBarChart('chart-revenue', accNames, accRevenue, 'Revenue (₹)');

            // Distribution
            const distLabels = distribution.map(d => d.bucket);
            const distData = distribution.map(d => d.count);
            createDoughnutChart('chart-distribution', distLabels, distData);

            // Top payers
            const payerNames = topPayers.map(p => p.payer.substring(0, 15));
            const payerAmounts = topPayers.map(p => p.total_amount);
            createBarChart('chart-payers', payerNames, payerAmounts, 'Total (₹)');
        });
    },

    // =====================
    // ACCOUNTS
    // =====================
    async renderAccounts(el) {
        const data = await API.getAccounts();

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Account Manager</h1>
                    <div class="subtitle">${data.accounts.length} accounts configured</div>
                </div>
                <button class="btn btn-primary" onclick="App.showAddAccountModal()">+ Add Account</button>
            </div>

            <div class="table-container">
                <div style="overflow-x:auto">
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Email</th>
                                <th>Report ID</th>
                                <th>Status</th>
                                <th>Revenue Today</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${data.accounts.map(acc => `
                                <tr>
                                    <td style="color:var(--text-primary);font-weight:600">${acc.name}</td>
                                    <td>${acc.email}</td>
                                    <td style="font-family:monospace;font-size:12px">${acc.report_id}</td>
                                    <td><span class="status-badge ${acc.pm2.status || 'stopped'}"><span class="badge-dot"></span>${acc.pm2.status || 'stopped'}</span></td>
                                    <td style="color:var(--accent-green);font-weight:600">₹${formatMoney(acc.stats.total_amount || 0)}</td>
                                    <td>
                                        <div style="display:flex;gap:6px">
                                            <button class="btn btn-ghost btn-sm" onclick="App.showEditAccountModal('${encodeURIComponent(JSON.stringify(acc))}')">✏️ Edit</button>
                                            <button class="btn btn-danger btn-sm" onclick="App.deleteAccount('${acc.name}')">🗑️</button>
                                        </div>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `);
    },

    showAddAccountModal() {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal">
                <h2>Add New Account</h2>
                <div class="form-group"><label>Account Name</label><input id="m-name" placeholder="e.g. shop11"></div>
                <div class="form-group"><label>Email</label><input id="m-email" type="email" placeholder="account@gmail.com"></div>
                <div class="form-group"><label>Password</label><input id="m-pass" type="password" placeholder="Account password"></div>
                <div class="form-group"><label>Report ID</label><input id="m-report" placeholder="BCR2DN4T3XYJJTQU"></div>
                <div class="modal-actions">
                    <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
                    <button class="btn btn-primary" onclick="App.addAccount()">Add Account</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    },

    showEditAccountModal(accDataStr) {
        const acc = JSON.parse(decodeURIComponent(accDataStr));
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal" style="max-width:500px">
                <h2>Edit ${acc.name}</h2>
                <div class="form-group"><label>Email</label><input id="m-edit-email" value="${acc.email}"></div>
                <div class="form-group"><label>New Password (leave blank to keep current)</label><input id="m-edit-pass" type="password"></div>
                <div class="form-group"><label>Report ID</label><input id="m-edit-report" value="${acc.report_id}"></div>
                
                <hr style="margin:20px 0;border:none;border-top:1px solid var(--bg-dark)">
                
                <h4 style="margin-bottom:12px;color:var(--accent-orange)">Advanced Routing Overrides (Optional)</h4>
                <p style="font-size:12px;color:var(--text-muted);margin-bottom:15px">Leave blank to inherit global settings.</p>
                <div class="form-group"><label>Custom Webhook URL</label><input id="m-edit-webhook" placeholder="Inherit global URL" value="${acc.webhook_url || ''}"></div>
                <div class="form-group"><label>Custom Telegram Bot Token</label><input id="m-edit-tg-token" type="password" placeholder="Inherit global token" value="${acc.telegram_bot_token || ''}"></div>
                <div class="form-group"><label>Custom Telegram Chat ID</label><input id="m-edit-tg-chat" placeholder="Inherit global chat" value="${acc.telegram_chat_id || ''}"></div>
                <div class="form-group"><label>Custom Download Interval (Sec)</label><input id="m-edit-interval" type="number" placeholder="Inherit global speed" value="${acc.download_interval_sec || ''}"></div>
                
                <div class="modal-actions" style="margin-top:20px">
                    <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
                    <button class="btn btn-primary" onclick="App.updateAccount('${acc.name}')">Save Configuration</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    },

    async addAccount() {
        try {
            const name = document.getElementById('m-name').value.trim();
            const email = document.getElementById('m-email').value.trim();
            const password = document.getElementById('m-pass').value;
            const report_id = document.getElementById('m-report').value.trim();

            if (!name || !email || !password || !report_id) {
                return showToast('All required core fields are missing', 'error');
            }

            await API.addAccount({ name, email, password, report_id });
            document.querySelector('.modal-overlay')?.remove();
            showToast(`Account "${name}" created!`, 'success');
            this.renderAccounts(document.getElementById('page-content'));
        } catch (err) {
            showToast(err.message, 'error');
        }
    },

    async updateAccount(name) {
        try {
            const data = {
                email: document.getElementById('m-edit-email').value.trim(),
                report_id: document.getElementById('m-edit-report').value.trim()
            };
            
            const password = document.getElementById('m-edit-pass').value;
            if (password) data.password = password;
            
            // Overrides
            data.webhook_url = document.getElementById('m-edit-webhook').value.trim();
            data.telegram_bot_token = document.getElementById('m-edit-tg-token').value.trim();
            data.telegram_chat_id = document.getElementById('m-edit-tg-chat').value.trim();
            data.download_interval_sec = document.getElementById('m-edit-interval').value.trim();

            await API.updateAccount(name, data);
            document.querySelector('.modal-overlay')?.remove();
            showToast(`Configuration for "${name}" updated`, 'success');
            this.renderAccounts(document.getElementById('page-content'));
        } catch (err) {
            showToast(err.message, 'error');
        }
    },

    async deleteAccount(name) {
        if (!confirm(`Delete account "${name}"? This will also stop the bot.`)) return;
        try {
            await API.deleteAccount(name);
            showToast(`Account "${name}" deleted`, 'success');
            this.renderAccounts(document.getElementById('page-content'));
        } catch (err) {
            showToast(err.message, 'error');
        }
    },

    // =====================
    // LOGS
    // =====================
    async renderLogs(el) {
        const data = await API.getAccounts();
        const accountNames = data.accounts.map(a => a.name);
        const events = await API.getEvents(null, 200);

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Live Logs</h1>
                    <div class="subtitle">${events.length} recent events</div>
                </div>
                <div class="live-badge"><span class="live-dot"></span> LIVE</div>
            </div>

            <div class="log-container">
                <div class="table-toolbar">
                    <select class="filter-select" id="log-account" onchange="App.filterLogs()">
                        <option value="">All Accounts</option>
                        ${accountNames.map(n => `<option value="${n}">${n}</option>`).join('')}
                    </select>
                    <select class="filter-select" id="log-type" onchange="App.filterLogs()">
                        <option value="">All Types</option>
                        <option value="download">Downloads</option>
                        <option value="start">Start</option>
                        <option value="stop">Stop</option>
                        <option value="error">Errors</option>
                        <option value="crash">Crashes</option>
                        <option value="restart">Restarts</option>
                    </select>
                </div>
                <div class="log-stream" id="log-stream">
                    ${events.map(e => this.renderLogEntry(e)).join('')}
                    ${events.length === 0 ? '<div class="empty-state"><div class="empty-icon">📋</div><p>No events yet. Start a bot to see logs.</p></div>' : ''}
                </div>
            </div>
        `);

        // Auto-scroll to top
        const stream = document.getElementById('log-stream');
        if (stream) stream.scrollTop = 0;

        // Auto-refresh logs every 5s
        this.refreshInterval = setInterval(() => {
            if (this.currentPage === 'logs') this.refreshLogs();
        }, 5000);
    },

    renderLogEntry(e) {
        const time = new Date(e.created_at).toLocaleTimeString();
        return `
            <div class="log-entry">
                <span class="log-time">${time}</span>
                <span class="log-account">${e.account}</span>
                <span class="log-type ${e.event_type}">${e.event_type}</span>
                <span class="log-message">${e.message}</span>
            </div>
        `;
    },

    async filterLogs() {
        const account = document.getElementById('log-account')?.value;
        const type = document.getElementById('log-type')?.value;
        let events = await API.getEvents(account, 200);
        if (type) events = events.filter(e => e.event_type === type);

        const stream = document.getElementById('log-stream');
        if (stream) {
            stream.innerHTML = events.map(e => this.renderLogEntry(e)).join('');
        }
    },

    async refreshLogs() {
        const account = document.getElementById('log-account')?.value;
        const events = await API.getEvents(account, 200);
        const stream = document.getElementById('log-stream');
        if (stream) {
            stream.innerHTML = events.map(e => this.renderLogEntry(e)).join('');
        }
    },

    // =====================
    // SETTINGS
    // =====================
    async renderSettings(el) {
        let config = { webhook_url: '', telegram_bot_token: '', telegram_chat_id: '', download_interval_sec: 10 };
        try {
            config = await API.getSettings();
        } catch (err) {
            showToast('Failed to load settings data', 'error');
        }

        this.updateDOM(el, `
            <div class="page-header">
                <div>
                    <h1>Settings</h1>
                    <div class="subtitle">Global application configuration</div>
                </div>
                <button class="btn btn-primary" onclick="App.saveSettings()">💾 Save Configuration</button>
            </div>

            <div class="settings-card">
                <h3>🌐 Webhook Configuration</h3>
                <div class="form-group">
                    <label>External Notification Webhook (Outgoing)</label>
                    <input id="s-webhook" placeholder="https://webhook.site/..." value="${config.webhook_url}">
                    <p class="form-help">Where we send transaction data after download.</p>
                </div>
            </div>

            <div class="settings-card" style="border-left:3px solid #a855f7">
                <h3>🔮 Floxi PG Integration <span id="floxi-status-badge" style="font-size:12px;padding:3px 10px;border-radius:12px;margin-left:10px;font-weight:600;${config.floxi_status?.connected ? 'background:rgba(16,185,129,0.15);color:#10b981' : 'background:rgba(239,68,68,0.15);color:#ef4444'}">${config.floxi_status?.connected ? '● Connected' : '○ Disconnected'}</span></h3>
                <div class="form-group">
                    <label>Floxi Base URL</label>
                    <input id="s-floxi-url" placeholder="https://floxi.online" value="${config.floxi_base_url || 'https://floxi.online'}">
                </div>
                <div class="form-group">
                    <label>Bot Token</label>
                    <input id="s-floxi-token" type="password" placeholder="Your Floxi bot token" value="${config.floxi_bot_token || ''}">
                </div>
                <div class="form-group">
                    <label>Project ID</label>
                    <input id="s-floxi-project" placeholder="e.g. 2" value="${config.floxi_project_id || ''}">
                </div>
                ${config.floxi_status ? `
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px">
                    <div class="account-stat">
                        <div class="stat-label">Orders Matched</div>
                        <div class="stat-value" style="font-size:16px;color:var(--accent-green)">${config.floxi_status.stats?.ordersMatched || 0}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Heartbeats</div>
                        <div class="stat-value" style="font-size:16px">${config.floxi_status.stats?.heartbeats || 0}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Cached Orders</div>
                        <div class="stat-value" style="font-size:16px">${config.floxi_status.cachedOrders || 0}</div>
                    </div>
                </div>
                ` : ''}

            <div class="settings-card">
                <h3>📥 Incoming Status Webhook</h3>
                <div class="form-group">
                    <label>Webhook URL (Incoming)</label>
                    <input readonly value="${location.origin}/api/webhook/status" style="background:var(--bg-secondary);cursor:default">
                    <p class="form-help">Point your external completion events to this URL.</p>
                </div>
                <div class="form-group">
                    <label>Webhook Secret</label>
                    <input id="s-webhook-secret" placeholder="Secret key..." value="${config.webhook_status_secret}">
                </div>
            </div>

            <div class="settings-card">
                <h3>🔒 Security & Access</h3>
                <div class="form-group">
                    <label>Dashboard Admin Password</label>
                    <input id="s-admin-password" type="password" placeholder="System password..." value="${config.dashboard_password}">
                </div>
            </div>

            <div class="settings-card">
                <h3>⏱️ Bot Fleet Operations</h3>
                <div class="form-group">
                    <label>Auto-Download Interval (Seconds)</label>
                    <input id="s-download-interval" type="number" min="5" max="3600" placeholder="10" value="${config.download_interval_sec || 10}">
                </div>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
                    Wait time between download cycles.
                </p>
            </div>

            <div class="settings-card">
                <h3>⚙️ System Info</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                    <div class="account-stat">
                        <div class="stat-label">Dashboard Port</div>
                        <div class="stat-value" style="font-size:16px">${location.port || 3000}</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Heartbeat</div>
                        <div class="stat-value" style="font-size:16px">30 min</div>
                    </div>
                    <div class="account-stat">
                        <div class="stat-label">Database</div>
                        <div class="stat-value" style="font-size:16px">SQLite</div>
                    </div>
                </div>
            </div>
        `);
    },

    async saveSettings() {
        const payload = {
            webhook_url: document.getElementById('s-webhook').value.trim(),
            telegram_bot_token: config.telegram_bot_token, // Preserve TG token
            telegram_chat_id: config.telegram_chat_id,     // Preserve TG chat
            download_interval_sec: parseInt(document.getElementById('s-download-interval').value) || 10,
            webhook_status_secret: document.getElementById('s-webhook-secret').value.trim(),
            dashboard_password: document.getElementById('s-admin-password').value.trim(),
            floxi_base_url: document.getElementById('s-floxi-url').value.trim(),
            floxi_bot_token: document.getElementById('s-floxi-token').value.trim(),
            floxi_project_id: document.getElementById('s-floxi-project').value.trim()
        };

        try {
            await API.saveSettings(payload);
            showToast('✅ Configuration strongly written to disk!', 'success');
        } catch(err) {
            showToast(`Failed to save: ${err.message}`, 'error');
        }
    }
};

// ===== BOT ACTIONS =====

async function botAction(action, name) {
    try {
        switch (action) {
            case 'start': await API.startBot(name); break;
            case 'stop': await API.stopBot(name); break;
            case 'restart': await API.restartBot(name); break;
            case 'login': await API.post(`/api/bots/${name}/login`); break;
            case 'reset': 
                if (!confirm(`⚠️ RESET SESSION DATA for "${name}"?\n\nThis will delete all cookies and login info. You will need to log in manually again.`)) return;
                await API.resetBotSession(name); 
                break;
        }
        showToast(`Bot "${name}" ${action}ed`, 'success');
        setTimeout(() => App.render(App.currentPage), 1000);
    } catch (err) {
        showToast(`Failed to ${action} ${name}: ${err.message}`, 'error');
    }
}

// Map the new mass fleet actions to the App controller
App.startFleet = async function() {
    try {
        await API.startFleet();
        showToast(`Mass Fleet successfully booted!`, 'success');
        setTimeout(() => App.render(App.currentPage), 1500);
    } catch (err) {
        showToast(`Failed to boot fleet: ${err.message}`, 'error');
    }
};

App.stopFleet = async function() {
    try {
        await API.stopFleet();
        showToast(`All active fleet processes terminated!`, 'info');
        setTimeout(() => App.render(App.currentPage), 1500);
    } catch (err) {
        showToast(`Failed to kill fleet: ${err.message}`, 'error');
    }
};

// ===== UTILITIES =====

function formatMoney(num) {
    if (!num || isNaN(num)) return '0';
    return parseFloat(num).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ===== FLOXI LOG PANEL =====

function openLiveLogsPanel(botName, botPort) {
    // Remove existing panel if open
    document.querySelector('.floxi-panel-overlay')?.remove();

    const isSplit = !!botName && !!botPort;
    const title = isSplit ? `🖥️ ${botName} Live Logs` : `📡 Floxi PG Live`;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay floxi-panel-overlay';
    overlay.innerHTML = `
        <div class="modal" style="width:95vw;max-width:${isSplit ? '1400px' : '750px'};height:85vh;display:flex;flex-direction:column;border-left:3px solid #a855f7">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-shrink:0">
                <div style="display:flex;align-items:center;gap:12px">
                    <h2 style="margin:0">${title}</h2>
                    <span id="floxi-live-dot" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981"><span style="width:6px;height:6px;background:#10b981;border-radius:50%;display:inline-block;animation:pulse 2s ease-in-out infinite"></span>STREAMING</span>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="this.closest('.floxi-panel-overlay').remove()" style="font-size:18px;padding:4px 10px">✕</button>
            </div>
            
            <div style="display:flex;flex:1;gap:20px;overflow:hidden">
                ${isSplit ? `
                <!-- Bot Panel Left Side -->
                <div style="flex:1;display:flex;flex-direction:column;border:1px solid rgba(34,211,238,0.3);border-radius:10px;overflow:hidden;box-shadow:0 0 30px rgba(34,211,238,0.05)">
                    <div style="background:#083344;padding:10px 16px;font-size:12px;font-weight:600;font-family:'JetBrains Mono',monospace;border-bottom:1px solid rgba(34,211,238,0.3);color:#22d3ee;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.5px">
                        <div style="display:flex;align-items:center;gap:10px">
                            <span style="display:inline-block;width:8px;height:12px;background:#22d3ee;box-shadow:0 0 8px #22d3ee;animation:pulse 2s ease-in-out infinite"></span>
                            <span><span style="color:#67e8f9">root@bot</span>:~/${botName}$</span>
                        </div>
                        <span style="font-size:10px;color:rgba(34,211,238,0.8);background:rgba(34,211,238,0.15);padding:2px 6px;border-radius:4px;border:1px solid rgba(34,211,238,0.3)">tcp:${botPort}</span>
                    </div>
                    <iframe src="http://localhost:${botPort}" style="width:100%;height:100%;border:none;background:var(--bg-darker)"></iframe>
                </div>
                ` : ''}
                
                <!-- Floxi Logs Right Side -->
                <div style="flex:1;display:flex;flex-direction:column;border:1px solid rgba(168,85,247,0.3);border-radius:10px;overflow:hidden;box-shadow:0 0 30px rgba(168,85,247,0.05)">
                    <div style="background:#2e1065;padding:10px 16px;font-size:12px;font-weight:600;font-family:'JetBrains Mono',monospace;border-bottom:1px solid rgba(168,85,247,0.3);color:#c084fc;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.5px">
                        <div style="display:flex;align-items:center;gap:10px">
                            <span style="display:inline-block;width:8px;height:8px;background:#a855f7;border-radius:50%;box-shadow:0 0 10px #a855f7"></span>
                            <span>[floxi-gateway] stream</span>
                        </div>
                        <span style="font-size:10px;color:rgba(192,132,252,0.8);background:rgba(168,85,247,0.15);padding:2px 6px;border-radius:4px;border:1px solid rgba(168,85,247,0.3)">sse:live</span>
                    </div>
                    <div id="floxi-log-stream" style="flex:1;overflow-y:auto;background:rgba(0,0,0,0.5);padding:14px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.8"></div>
                </div>
            </div>

            <div style="display:flex;justify-content:flex-end;align-items:center;margin-top:12px;flex-shrink:0">
                <span style="font-size:11px;color:var(--text-muted);margin-right:16px" id="floxi-log-count">0 entries</span>
                <button class="btn btn-ghost btn-sm" onclick="document.getElementById('floxi-log-stream').innerHTML='';" style="font-size:11px">Clear Floxi Logs</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const stream = document.getElementById('floxi-log-stream');
    let entryCount = 0;

    function colorize(msg) {
        if (msg.includes('✅') || msg.includes('Matched') || msg.includes('Synced')) return '#10b981';
        if (msg.includes('❌') || msg.includes('error') || msg.includes('Error')) return '#ef4444';
        if (msg.includes('⚠')) return '#f59e0b';
        if (msg.includes('🎯') || msg.includes('💸')) return '#a855f7';
        if (msg.includes('🔌') || msg.includes('📡')) return '#6366f1';
        if (msg.includes('📋')) return '#22d3ee';
        return '#94a3b8';
    }

    function appendLog(entry) {
        const div = document.createElement('div');
        div.style.padding = '2px 0';
        div.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
        const time = new Date(entry.time).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        div.innerHTML = `<span style="color:var(--text-muted);margin-right:10px">${time}</span><span style="color:${colorize(entry.msg)}">${entry.msg}</span>`;
        stream.appendChild(div);
        stream.scrollTop = stream.scrollHeight;
        entryCount++;
        const counter = document.getElementById('floxi-log-count');
        if (counter) counter.textContent = entryCount + ' entries';
    }

    // Connect to SSE stream
    const token = localStorage.getItem('gpay_admin_token') || '';
    const evtSource = new EventSource(`/api/floxi/stream?token=${encodeURIComponent(token)}`);
    evtSource.onmessage = (e) => {
        try {
            const entry = JSON.parse(e.data);
            appendLog(entry);
        } catch (err) {}
    };
    evtSource.onerror = () => {
        const dot = document.getElementById('floxi-live-dot');
        if (dot) { dot.style.background = 'rgba(239,68,68,0.15)'; dot.style.color = '#ef4444'; dot.innerHTML = '<span style="width:6px;height:6px;background:#ef4444;border-radius:50%;display:inline-block"></span>DISCONNECTED'; }
    };

    // Cleanup SSE on panel close
    const obs = new MutationObserver(() => {
        if (!document.querySelector('.floxi-panel-overlay')) {
            evtSource.close();
            obs.disconnect();
        }
    });
    obs.observe(document.body, { childList: true });
}

// ===== BOOT =====

document.addEventListener('DOMContentLoaded', () => App.init());

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'accounts.json'), 'utf-8'));

module.exports = {
    apps: config.accounts.map((account, index) => ({
        name: `gpay-${account.name}`,
        script: './src/bot.js',
        args: account.name,
        cwd: __dirname,

        // Auto-restart
        autorestart: true,
        max_restarts: 50,
        min_uptime: '10s',
        restart_delay: 5000 + (index * 3000),

        // Memory management
        max_memory_restart: '800M',

        // Cron restart: every 6 hours
        cron_restart: '0 */6 * * *',

        // Logs
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: `./logs/${account.name}-error.log`,
        out_file: `./logs/${account.name}-out.log`,
        merge_logs: true,
        log_type: 'json',

        // Environment
        env: {
            NODE_ENV: 'production',
            PLAYWRIGHT_CHROMIUM_USE_HEADLESS_NEW: '1'
        },

        watch: false
    }))
};

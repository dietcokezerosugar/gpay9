# GPay Fleet Automation (V9 Hybrid)

High-performance, dual-engine transaction capture system for Google Pay Business.

## 🚀 Getting Started

### 1. Installation
Ensure you have Node.js (v20+) installed.
```bash
npm install
npx playwright install chromium
```

### 2. Configuration
- **Bot Config**: Edit `config.json` to set your Floxi API credentials (`bot_token`, `project_id`).
- **Accounts**: Add your GPay Business accounts to `config/accounts.json`. Ensure `report_id` (Merchant ID) is filled for each account.

### 3. Running the Fleet
The system uses PM2 for process management and auto-restart.
```bash
# Start all bots and the Hub server
pm2 start ecosystem.config.js

# Monitor live logs
pm2 logs
```

## 🛠 Features
- **Dual-Engine Capture**: Combines real-time XHR interception with reliable CSV audit fallbacks.
- **Hybrid Reporting**: Synchronizes transaction status via REST API and Ably Real-time events.
- **Remote Control**: Support for remote `start_gateway` and `stop_gateway` commands via Ably.
- **Admin Dashboard**: Access the local dashboard at `http://localhost:3000` to manage profiles and view analytics.
- **Telegram Watchdog**: Automatic alerts for critical errors and daily heartbeat summaries.

## 📁 Project Structure
- `/src`: Core logic (Bot, Server, Gateway Clients).
- `/config`: Account and webhook settings.
- `/dashboard`: Web-based admin interface.
- `/data`: SQLite database and backups.
- `/logs`: Rotating system and bot logs.

---
**Production State**: Verified and Ready.
**Verification**: All tests passed against `floxi.online` API (April 2026).

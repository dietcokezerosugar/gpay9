
const GatewayWSClient = require('./ws-client');
const GatewayAblyClient = require('./ably-client');

class GatewayFactory {
    static create(config, opts) {
        const type = (config.type || 'websocket').toLowerCase();

        if (type === 'ably') {
            return new GatewayAblyClient({
                baseUrl: config.url,
                botToken: config.bot_token,
                projectId: config.project_id,
                accountName: opts.accountName,
                sessionDir: opts.sessionDir,
                logger: opts.logger
            });
        } 
        
        if (type === 'websocket' || !type) {
            return new GatewayWSClient({
                baseUrl: config.url,
                botToken: config.bot_token || config.key,
                serverUrl: config.url,
                authToken: config.key || config.bot_token,
                accountName: opts.accountName,
                sessionDir: opts.sessionDir,
                logger: opts.logger,
                ssl: config.ssl !== false
            });
        }

        return null;
    }
}

module.exports = GatewayFactory;

/**
 * Parses the raw base64 Google Pay Dashboard /batchexecute response
 * into a clean, structured array of transaction objects.
 */

function parseTransactions(rawBody) {
    try {
        // Strip out the custom URL header
        const withoutHeader = rawBody.replace(/URL:.*?\n\n/s, '');
        // Split by newlines and find lines starting with [["wrb.fr"
        const lines = withoutHeader.split('\n');
        
        let targetEnvelope = null;
        for (const line of lines) {
            if (line.startsWith('[["wrb.fr"')) {
                try {
                    const outerArray = JSON.parse(line);
                    targetEnvelope = outerArray.find(item => item[0] === 'wrb.fr' && item[1] === 'RPtkab');
                    if (targetEnvelope) break;
                } catch (e) {
                    // Ignore JSON parse errors for partial lines
                }
            }
        }

        if (!targetEnvelope || !targetEnvelope[2]) return [];

        const innerList = JSON.parse(targetEnvelope[2]);
        const transactionsRaw = innerList[0];

        if (!transactionsRaw || !Array.isArray(transactionsRaw)) return [];

        return transactionsRaw.map(t => {
            return {
                merchantTransactionId: t[0], // e.g. "8162837377597833216"
                utr: t[1],                   // e.g. "050701155108"
                timestamp: t[2] && t[2][0] ? new Date(parseInt(t[2][0]) * 1000).toISOString() : null,
                amount: t[3] && t[3][1] ? parseFloat(`${t[3][1]}.${t[3][2] || '00'}`) : 0, 
                payerName: t[8] && t[8][0] ? t[8][0] : null,
                payerUpiId: t[8] && t[8][1] ? t[8][1] : null,
                note: t[9],                  // THIS IS THE EXACT UPI NOTE FIELD!
                status: t[10] === 5 ? 'COMPLETED' : 'UNKNOWN'
            };
        });

    } catch (e) {
        console.error('Failed to parse transactions:', e.message);
        return [];
    }
}

module.exports = { parseTransactions };

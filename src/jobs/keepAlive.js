// src/jobs/keepAlive.js
//
// Self-ping every 5 minutes to keep Render free-tier dyno awake.
// Render idles after ~15 min of no traffic; 5-min interval gives 3x safety margin.
// Also fires an immediate ping on startup so the dyno's first real request isn't
// also its cold-start wake call.

const cron = require('node-cron');

let task = null;

function pingSelf() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL;
    if (!baseUrl) return;

    const url = `${baseUrl.replace(/\/$/, '')}/health`;
    const transport = url.startsWith('https') ? require('https') : require('http');

    const req = transport.get(url, { timeout: 10000 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
            const lvl = res.statusCode < 400 ? '✅' : '⚠️';
            console.log(`[KeepAlive] ${lvl} Self-ping ${res.statusCode} — dyno awake`);
        });
    });

    req.on('timeout', () => {
        req.destroy();
        console.warn('[KeepAlive] ⚠️ Self-ping timed out (dyno may be waking)');
    });

    req.on('error', (err) => {
        console.warn('[KeepAlive] ⚠️ Self-ping failed:', err.message);
    });
}

function start() {
    if (task) {
        console.log('[KeepAlive] Already running — skipping duplicate start');
        return task;
    }

    if (!process.env.RENDER_EXTERNAL_URL) {
        console.log('[KeepAlive] RENDER_EXTERNAL_URL not set — no-op (local dev)');
        return null;
    }

    // Fire immediately so the dyno doesn't go cold between deploy and first cron tick
    setTimeout(pingSelf, 5000);

    // Every 5 minutes — safely under Render's 15-minute idle-sleep threshold
    task = cron.schedule('*/5 * * * *', pingSelf, { scheduled: true });
    console.log('[KeepAlive] ✅ Started — self-pinging every 5 minutes to prevent Render idle sleep');
    return task;
}

function stop() {
    if (task) {
        task.stop();
        task = null;
        console.log('[KeepAlive] Stopped');
    }
}

module.exports = { start, stop, pingSelf };

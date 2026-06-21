// src/jobs/keepAlive.js
//
// FIX (Report outstanding issue / forensic audit): Render's free tier spins the
// service down after ~15 minutes with no inbound HTTP traffic. The next request
// then pays a cold-start penalty and, worse, anything that fires concurrently on
// wake (multiple iframes booting Phase6Bootstrap, friend/message fetches, socket
// reconnects) all 503 or time out simultaneously, which is the "cascading 503s
// and Socket.IO failures" symptom flagged after the websocket/auth pass.
//
// This job self-pings the service's own /health (or /api/friends/ping as a
// fallback) every 10 minutes — comfortably inside Render's 15-minute idle
// window — so the dyno never goes to sleep in the first place. It only runs
// when RENDER_EXTERNAL_URL is present (i.e. actually deployed on Render);
// it's a no-op locally.
//
// Wire this up in server.js next to the other phase bootstraps with:
//   require('./jobs/keepAlive').start();

const cron = require('node-cron');

let task = null;

function pingSelf() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL;
    if (!baseUrl) return;

    const url = `${baseUrl.replace(/\/$/, '')}/health`;
    const https = url.startsWith('https') ? require('https') : require('http');

    const req = https.get(url, { timeout: 8000 }, (res) => {
        // Drain the response so the socket can be reused/closed cleanly.
        res.on('data', () => {});
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                console.log(`[KeepAlive] ✅ Self-ping OK (${res.statusCode})`);
            } else {
                console.warn(`[KeepAlive] ⚠️ Self-ping returned ${res.statusCode}`);
            }
        });
    });

    req.on('timeout', () => {
        req.destroy();
        console.warn('[KeepAlive] ⚠️ Self-ping timed out');
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
        console.log('[KeepAlive] RENDER_EXTERNAL_URL not set — skipping (not on Render, or var not configured)');
        return null;
    }

    // Every 10 minutes — safely under Render's 15-minute idle-sleep threshold.
    task = cron.schedule('*/10 * * * *', pingSelf, { scheduled: true });
    console.log('[KeepAlive] ✅ Started — self-pinging every 10 minutes to prevent Render idle sleep');
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

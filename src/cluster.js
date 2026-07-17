'use strict';

/**
 * Cluster entrypoint — run with `npm run prod:cluster` (see package.json).
 *
 * This was referenced by package.json's "prod:cluster" script but the file
 * itself did not exist in the repo, so `node src/server.js` (single process,
 * single CPU core) was the only thing actually running in production
 * regardless of how many cores the Render instance had.
 *
 * What this does:
 *   - Forks one worker per CPU core (override with WEB_CONCURRENCY env var).
 *   - The PRIMARY process binds the real PORT and, via @socket.io/sticky,
 *     forwards each incoming connection to a worker using IP-hash based
 *     "least connections" balancing. Sticky routing is required because
 *     Socket.IO's HTTP long-polling transport issues several separate HTTP
 *     requests per client — without stickiness those requests could land on
 *     different workers and the connection would break.
 *   - Each WORKER runs the exact same Express + Socket.IO app defined in
 *     src/server.js (via its existing `main()` export), just without binding
 *     its own port — see the CLUSTER_STICKY_WORKER branch added to
 *     Application.start() in src/server.js.
 *   - Cross-worker (and cross-Render-instance) Socket.IO broadcast is handled
 *     separately by the Redis adapter wired in src/server.js — sticky
 *     sessions and the Redis adapter solve two different problems and both
 *     are needed together.
 *   - A dead worker is automatically replaced so one crash doesn't reduce
 *     capacity permanently.
 */

const cluster = require('cluster');
const os = require('os');
const http = require('http');

const numCPUs = os.cpus().length;
const WORKER_COUNT = parseInt(process.env.WEB_CONCURRENCY, 10) || numCPUs;

if (cluster.isPrimary || cluster.isMaster) {
    const { setupMaster } = require('@socket.io/sticky');

    console.log(`[Cluster] Primary ${process.pid} starting — ${WORKER_COUNT} worker(s) (detected ${numCPUs} CPU core(s))`);

    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HOST || '0.0.0.0';

    // The primary owns the real listening socket; @socket.io/sticky forwards
    // accepted connections to workers over the cluster IPC channel.
    const httpServer = http.createServer();

    setupMaster(httpServer, {
        loadBalancingMethod: 'least-connection',
    });

    // 'advanced' serialization is required by @socket.io/sticky for passing
    // raw connections between primary and workers.
    if (cluster.setupPrimary) {
        cluster.setupPrimary({ serialization: 'advanced' });
    } else {
        cluster.setupMaster({ serialization: 'advanced' });
    }

    httpServer.listen(PORT, HOST, () => {
        console.log(`[Cluster] Primary listening on ${HOST}:${PORT}, distributing to ${WORKER_COUNT} worker(s)`);
    });

    httpServer.on('error', (err) => {
        console.error('[Cluster] Primary failed to bind port:', err.message);
        process.exit(1);
    });

    for (let i = 0; i < WORKER_COUNT; i++) {
        cluster.fork();
    }

    cluster.on('online', (worker) => {
        console.log(`[Cluster] Worker ${worker.process.pid} online`);
    });

    cluster.on('exit', (worker, code, signal) => {
        console.error(`[Cluster] Worker ${worker.process.pid} died (code=${code}, signal=${signal}) — restarting`);
        cluster.fork();
    });

    // Graceful shutdown: let workers finish in-flight requests before exit.
    const shutdown = () => {
        console.log('[Cluster] Primary shutting down, notifying workers...');
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        httpServer.close(() => process.exit(0));
        // Failsafe in case a worker hangs on shutdown.
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

} else {
    // Worker process: boot the real app defined in src/server.js. The
    // CLUSTER_STICKY_WORKER flag tells Application.start() (in src/server.js)
    // not to bind its own port and to register with @socket.io/sticky instead.
    process.env.CLUSTER_STICKY_WORKER = '1';

    require('./server')
        .main()
        .catch((err) => {
            console.error(`[Cluster] Worker ${process.pid} failed to start:`, err);
            process.exit(1);
        });
}

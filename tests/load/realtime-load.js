// Realtime messaging load test (HTTP send + Socket.IO delivery), multi-instance aware.
//
// Usage:  node tests/load/realtime-load.js <users> <durationSec> <sendIntervalMs> <firstUserId>
// Env:    PORTS=3101,3102          backend instances (users are spread round-robin,
//                                  so with 2+ ports every message crosses instances)
//         JWT_ACCESS_SECRET=...    secret the backend verifies access tokens with
//         PG_COUNT_CMD='psql ... -At -c "select count(*) from pg_stat_activity ..."'
//                                  optional; prints peak DB connections
//         RESULTS_FILE=/tmp/lt_results.jsonl
// Setup:  needs N consecutive user ids starting at <firstUserId> (a seed SQL
//         insert is fine) and `npm i --no-save socket.io-client`. Tokens are
//         minted locally so the auth rate limiter is NOT bypassed or weakened:
//         run it only against a TEST backend you own.
// Records connect/disconnect counts, HTTP + delivery latency percentiles,
// duplicate deliveries, delivery rate, server CPU/RSS (Linux /proc) and DB
// connections. Nothing is reported as "passed" by this script itself.
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const cp = require('child_process');

const N = +process.argv[2], DUR = +process.argv[3], INTERVAL = +process.argv[4] || 5000, FIRST = +process.argv[5] || 43;
const PORTS = (process.env.PORTS || '3101,3102').split(',').map(Number);
const SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
if (!SECRET) { console.error('Set JWT_ACCESS_SECRET'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

const pidOf = (port) => {
  try {
    for (const pid of cp.execSync('pgrep -f "src/server.js"').toString().trim().split('\n')) {
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        if (env.includes('PORT=' + port)) return +pid;
      } catch {}
    }
  } catch {}
  return 0;
};
const pids = PORTS.map(pidOf);
const cpuTicks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' '); return +f[13] + +f[14]; } catch { return 0; } };
const rssMB = (pid) => { try { return +fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1] / 1024; } catch { return 0; } };
const pgConns = () => {
  if (!process.env.PG_COUNT_CMD) return -1;
  try { return +cp.execSync(process.env.PG_COUNT_CMD).toString().trim(); } catch { return -1; }
};

const st = { connectOk: 0, connectErr: 0, disconnects: 0, sent: 0, httpOk: 0, httpErr: 0, http429: 0, timeouts: 0, delivered: 0, dupes: 0 };
const httpLat = [], delivLat = [];
const sentAt = new Map(); // marker -> t0
const seen = new Set();

(async () => {
  const users = Array.from({ length: N }, (_, i) => {
    const id = FIRST + i;
    return { id, port: PORTS[i % PORTS.length], token: jwt.sign({ userId: id, id, email: `load${i + 1}@ex.com`, username: `load${i + 1}`, role: 'user', type: 'access', sessionTimeoutMs: 0 }, SECRET) };
  });

  // connect with ramp
  const t0c = Date.now();
  await Promise.all(users.map(async (u, i) => {
    await sleep(Math.floor(i / 50) * 400); // 50 connects / 0.4s
    await new Promise((res) => {
      const s = io(`http://127.0.0.1:${u.port}`, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, timeout: 15000 });
      u.sock = s;
      s.on('connect', () => { st.connectOk++; res(); });
      s.on('connect_error', () => { st.connectErr++; res(); });
      s.on('disconnect', () => { if (u.sock.__closing) return; st.disconnects++; });
      s.on('message:new', (...args) => {
        const m = JSON.stringify(args).match(/lt-(\d+)-(\d+)-([a-z0-9]+)/);
        if (!m) return;
        const key = m[0];
        if (seen.has(u.id + key)) { st.dupes++; return; }
        seen.add(u.id + key);
        const t = sentAt.get(key);
        if (t) { st.delivered++; delivLat.push(Date.now() - t); }
      });
    });
  }));
  const connectSecs = (Date.now() - t0c) / 1000;
  await sleep(3000);

  const base = pids.map(cpuTicks); const tStart = Date.now();
  let peakRss = 0, peakPg = 0;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, pids.reduce((a, p) => a + rssMB(p), 0)); peakPg = Math.max(peakPg, pgConns()); }, 2000);

  const run = tStart + DUR * 1000;
  const tag = Date.now().toString(36);
  await Promise.all(users.map(async (u, i) => {
    const to = users[(i + 1) % N].id;
    await sleep(Math.random() * INTERVAL);
    let seq = 0;
    while (Date.now() < run) {
      if (u.sock.connected) {
        const marker = `lt-${u.id}-${++seq}-${tag}`;
        const t = Date.now(); sentAt.set(marker, t); st.sent++;
        const ctl = new AbortController(); const to_ = setTimeout(() => ctl.abort(), 10000);
        fetch(`http://127.0.0.1:${u.port}/api/messages`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ receiverId: to, content: marker, type: 'text', clientMessageId: marker }) })
          .then((r) => { httpLat.push(Date.now() - t); if (r.status === 201 || r.status === 200) st.httpOk++; else if (r.status === 429) st.http429++; else st.httpErr++; return r.arrayBuffer(); })
          .catch((e) => { if (e.name === 'AbortError') st.timeouts++; else st.httpErr++; })
          .finally(() => clearTimeout(to_));
      }
      await sleep(INTERVAL * (0.7 + Math.random() * 0.6));
    }
  }));
  await sleep(6000); // drain
  clearInterval(sampler);
  const secs = (Date.now() - tStart) / 1000;
  const cpu = pids.map((p, i) => ((cpuTicks(p) - base[i]) / 100 / secs) * 100);
  const res = {
    users: N, durationSec: DUR, sendIntervalMs: INTERVAL, connectSecs: +connectSecs.toFixed(1),
    connectOk: st.connectOk, connectErr: st.connectErr, disconnects: st.disconnects,
    messagesSent: st.sent, httpOk: st.httpOk, http429: st.http429, httpErr: st.httpErr, timeouts: st.timeouts,
    msgPerSec: +(st.sent / DUR).toFixed(1),
    httpP50: pct(httpLat, 0.5), httpP95: pct(httpLat, 0.95), httpP99: pct(httpLat, 0.99),
    delivered: st.delivered, deliveryRate: +(st.delivered / Math.max(1, st.sent)).toFixed(4), dupes: st.dupes,
    deliveryP50: pct(delivLat, 0.5), deliveryP95: pct(delivLat, 0.95), deliveryP99: pct(delivLat, 0.99),
    serverCpuPct: cpu.map((c) => +c.toFixed(0)), serverPeakRssMBTotal: +peakRss.toFixed(0), peakPgConns: peakPg,
  };
  console.log(JSON.stringify(res));
  fs.appendFileSync(process.env.RESULTS_FILE || '/tmp/lt_results.jsonl', JSON.stringify(res) + '\n');
  users.forEach((u) => { if (u.sock) { u.sock.__closing = true; u.sock.close(); } });
  await sleep(1000);
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERR', e); process.exit(1); });

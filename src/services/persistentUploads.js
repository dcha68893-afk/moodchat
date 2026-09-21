'use strict';
/**
 * Persistent copy of uploaded files (documents, images, video, audio) for deployments WITHOUT Cloudinary/S3.
 *
 * ROOT CAUSE THIS FIXES: uploads are written to ./uploads on the server's local disk. On Render that disk is EPHEMERAL --
 * it is wiped on every restart, redeploy and free-tier spin-down. The chat/group message keeps the file URL, the recipient
 * receives it fine, and later:
 *   - opening a document  -> {"success":false,"message":"Route not found: GET /uploads/documents/....pdf"}
 *   - images/videos       -> fail to load, and the UI swaps in the app fallback image.
 *
 * Every saved file is now ALSO stored in Postgres (persistent), and the /uploads route serves it from there whenever the
 * disk copy is missing. Cloudinary (when configured) still takes precedence and is the better long-term choice for large
 * media; this is the safety net that stops files disappearing.
 *
 * Env: UPLOAD_DB_MAX_BYTES (default 31457280 = 30 MB per file), UPLOAD_DB_PERSIST=false to disable.
 */
const fs = require('fs');
const path = require('path');

const ENABLED = String(process.env.UPLOAD_DB_PERSIST || 'true').toLowerCase() !== 'false';
const MAX_BYTES = parseInt(process.env.UPLOAD_DB_MAX_BYTES || '31457280', 10);
const ROOT = path.join(process.cwd(), 'uploads');
let tableReady = null;

const sequelize = () => { try { return require('../models').sequelize || null; } catch (_) { return null; } };

function ensureTable() {
  const sq = sequelize();
  if (!sq) return Promise.reject(new Error('database not ready'));
  if (!tableReady) {
    tableReady = sq.query(`CREATE TABLE IF NOT EXISTS uploaded_files (
        rel_path   TEXT PRIMARY KEY,
        mime_type  TEXT NOT NULL,
        size       INTEGER NOT NULL,
        data       BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`).catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}

// "/documents/123-abc.pdf" (relative to /uploads). Rejects traversal.
function normalizeRel(rel) {
  let r = String(rel || '');
  try { r = decodeURIComponent(r); } catch (_) { return null; }
  r = r.replace(/\\/g, '/');
  if (!r.startsWith('/')) r = '/' + r;
  if (r.includes('..') || r.includes('\0') || r.length > 300) return null;
  return r;
}

async function saveFile(relPath, absPath, mimeType) {
  if (!ENABLED) return false;
  try {
    const rel = normalizeRel(relPath); if (!rel) return false;
    const st = fs.statSync(absPath);
    if (st.size > MAX_BYTES) { console.warn(`[persistentUploads] ${rel} is ${st.size} bytes (> ${MAX_BYTES}); not persisted. Configure Cloudinary/S3 for large media.`); return false; }
    await ensureTable();
    await sequelize().query(
      `INSERT INTO uploaded_files (rel_path, mime_type, size, data) VALUES (:p, :m, :s, :d)
       ON CONFLICT (rel_path) DO UPDATE SET mime_type = EXCLUDED.mime_type, size = EXCLUDED.size, data = EXCLUDED.data`,
      { replacements: { p: rel, m: mimeType || 'application/octet-stream', s: st.size, d: fs.readFileSync(absPath) } });
    return true;
  } catch (e) { console.warn('[persistentUploads] save failed:', e.message); return false; }
}

// Express middleware, mount at /uploads BEFORE express.static. Disk copy present -> next() (static serves it).
async function serveMissingFromDb(req, res, next) {
  if (!ENABLED || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
  try {
    const rel = normalizeRel(req.path); if (!rel || rel === '/') return next();
    const abs = path.join(ROOT, rel);
    if (abs.startsWith(ROOT) && fs.existsSync(abs)) return next();
    await ensureTable();
    const [rows] = await sequelize().query('SELECT mime_type, size, data FROM uploaded_files WHERE rel_path = :p LIMIT 1', { replacements: { p: rel } });
    const row = rows && rows[0]; if (!row) return next();
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    // put it back on disk so following requests are served by express.static (best effort)
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data); } catch (_) {}
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] !== '' || range[2] !== '')) { // video/audio seeking
      let start = range[1] === '' ? Math.max(0, data.length - Number(range[2])) : Number(range[1]);
      let end = range[1] === '' || range[2] === '' ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
      if (start > end || start >= data.length) { res.status(416).setHeader('Content-Range', `bytes */${data.length}`); return res.end(); }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
      res.setHeader('Content-Length', end - start + 1);
      return req.method === 'HEAD' ? res.end() : res.end(data.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', data.length);
    return req.method === 'HEAD' ? res.end() : res.end(data);
  } catch (e) { console.warn('[persistentUploads] serve failed:', e.message); return next(); }
}

// Catch uploads written by any other route (avatars, media, tools ...) that do not call saveFile() themselves.
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
async function sweepDiskToDb() {
  if (!ENABLED || !fs.existsSync(ROOT)) return 0;
  try {
    await ensureTable();
    const [have] = await sequelize().query('SELECT rel_path FROM uploaded_files');
    const known = new Set((have || []).map(r => r.rel_path));
    let saved = 0; const stack = [ROOT];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        const rel = '/' + path.relative(ROOT, full).split(path.sep).join('/');
        const mime = MIME_BY_EXT[path.extname(ent.name).toLowerCase()];
        if (!mime || known.has(rel)) continue;
        if (await saveFile(rel, full, mime)) saved++;
      }
    }
    return saved;
  } catch (e) { console.warn('[persistentUploads] sweep failed:', e.message); return 0; }
}
let timer = null;
function startSweeper(intervalMs = 120000) {
  if (!ENABLED || timer) return;
  setTimeout(() => sweepDiskToDb().then(n => n && console.log(`[persistentUploads] backed up ${n} existing upload(s) to the database`)), 15000).unref?.();
  timer = setInterval(() => sweepDiskToDb(), intervalMs); timer.unref?.();
}

module.exports = { saveFile, serveMissingFromDb, sweepDiskToDb, startSweeper, normalizeRel };

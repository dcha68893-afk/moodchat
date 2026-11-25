'use strict';
/**
 * NECPRA Personal Assistant: reminders. Every query is scoped by user_id (no endpoint takes a userId from the client).
 * A reminder is only reported as saved AFTER the database row exists. Nothing here sends money, messages or anything else:
 * it just remembers a short note and a time. Delivery to the phone is done by the client (it polls GET /reminders/due) -
 * server-side push for reminders is NOT wired here.
 */
const crypto = require('crypto');

const MAX_ACTIVE = Number(process.env.NECPRA_AI_MAX_REMINDERS || 200);
const MAX_AHEAD_MS = 366 * 86400000;
const TZ = 'Africa/Nairobi';

const NUM = '(?:kumi na \\w+|moja|mbili|tatu|nne|tano|sita|saba|nane|tisa|kumi|\\d{1,2})';
/** "remind me tomorrow at 8am to call Wanjiru" -> "call Wanjiru". Falls back to null when nothing is left. */
function taskText(original) {
  let t = String(original == null ? '' : original).replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(?:please|tafadhali|naomba|kindly)\b/gi, ' ')
    .replace(/\b(?:can you|could you|will you)\b/gi, ' ')
    .replace(/\b(?:set (?:a )?reminder|remind me|nikumbushe|nikumbushie|kumbusha|weka kikumbusho|niwekee kumbukumbu)\b/gi, ' ')
    .replace(/\b(?:in|baada ya)\s+(?:masaa\s+|saa\s+)?\d{1,3}\s*(?:hours?|hrs?|minutes?|mins?|masaa|saa|dakika)?\b/gi, ' ')
    .replace(/\b(?:day after tomorrow|keshokutwa|tomorrow|kesho|today|leo|tonight)\b/gi, ' ')
    .replace(/\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|jumatatu|jumanne|jumatano|alhamisi|ijumaa|jumamosi|jumapili)\b/gi, ' ')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ').replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?/gi, ' ')
    .replace(new RegExp('\\bsaa\\s+' + NUM + '(?:\\s+(?:asubuhi|mchana|jioni|usiku))?', 'gi'), ' ')
    .replace(/\s+/g, ' ').trim().replace(/^(?:to|about|that|kwamba|kuhusu|ya|:|,|-)\s+/i, '').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  return t ? t.slice(0, 140) : null;
}

const fmtWhen = (iso, lang) => {
  try { return new Date(iso).toLocaleString(lang === 'sw' ? 'sw-KE' : 'en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch (_) { return iso; }
};

function createService(opts = {}) {
  const sq = opts.getSequelize || (() => require('../../models').sequelize);
  const now = opts.now || (() => new Date());
  const q = (sql, r, type) => sq().query(sql, { replacements: r, type: type || 'SELECT' });
  const shape = (r) => ({ id: r.id, text: r.text, dueAt: new Date(r.due_at).toISOString(), status: r.status });

  async function create(userId, { text, dueAt, source }) {
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 140);
    const due = new Date(dueAt), t = now().getTime();
    if (!clean) return { ok: false, status: 400, error: 'text_required' };
    if (!(due.getTime() > t)) return { ok: false, status: 400, error: 'time_in_past' };
    if (due.getTime() - t > MAX_AHEAD_MS) return { ok: false, status: 400, error: 'too_far_ahead' };
    const [c] = await q(`SELECT COUNT(*)::int AS n FROM ai_reminders WHERE user_id = :u AND status = 'pending'`, { u: Number(userId) });
    if (c.n >= MAX_ACTIVE) return { ok: false, status: 429, error: 'too_many_reminders' };
    const id = crypto.randomUUID();
    await q(`INSERT INTO ai_reminders (id, user_id, text, due_at, source) VALUES (:id, :u, :text, :due, :src)`,
      { id, u: Number(userId), text: clean, due: due.toISOString(), src: source === 'api' ? 'api' : 'voice' }, 'INSERT');
    return { ok: true, reminder: { id, text: clean, dueAt: due.toISOString(), status: 'pending' } };
  }
  async function list(userId, status, limit) {
    const st = ['pending', 'done', 'cancelled'].includes(status) ? status : 'pending';
    const rows = await q(`SELECT id, text, due_at, status FROM ai_reminders WHERE user_id = :u AND status = :st ORDER BY due_at ASC LIMIT :lim`, { u: Number(userId), st, lim: Math.min(Math.max(Number(limit) || 50, 1), 100) });
    return rows.map(shape);
  }
  async function due(userId) {
    const rows = await q(`SELECT id, text, due_at, status FROM ai_reminders WHERE user_id = :u AND status = 'pending' AND due_at <= :now ORDER BY due_at ASC LIMIT 50`, { u: Number(userId), now: now().toISOString() });
    return rows.map(shape);
  }
  async function setStatus(userId, id, status) {
    const rows = await q(`UPDATE ai_reminders SET status = :st, completed_at = NOW() WHERE id = :id AND user_id = :u AND status = 'pending' RETURNING id, text, due_at, status`, { id: String(id), u: Number(userId), st: status }, 'SELECT');
    return rows && rows.length ? { ok: true, reminder: shape(rows[0]) } : { ok: false, status: 404, error: 'not_found' };
  }
  return { create, list, due, done: (u, id) => setStatus(u, id, 'done'), cancel: (u, id) => setStatus(u, id, 'cancelled') };
}

module.exports = { createService, taskText, fmtWhen, MAX_ACTIVE };

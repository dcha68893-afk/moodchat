'use strict';
/**
 * NECPRA Voice: admin-managed phrases.
 *
 * An ADMIN can teach the assistant a new way of saying something. Every user's app downloads the active list (small, cached on the phone,
 * works offline) and, when a user says the same phrase, the assistant answers for everyone:
 *   kind 'action': runs a KNOWN action from voiceActions.js (same safe path as built-in commands: confirmations still apply)
 *   kind 'reply' : speaks a fixed answer written by the admin (English and optionally Kiswahili)
 * A phrase may contain ONE placeholder such as {name}: "wacha {name} awe rafiki wangu" -> friends.accept with whatever the user said there.
 *
 * Admins can only choose from the action list and fixed reply text. They cannot run code, call URLs or reach other data.
 * Storage: table voice_phrases, created automatically (no migration needed).
 */
const crypto = require('crypto');
const { BY_ID, validate, buildPhrase } = require('./voiceActions');

const MAX_ACTIVE = 3000, MAX_PHRASE = 100, MAX_WORDS = 12, MAX_REPLY = 300;
const MODULE_OF = { nav: 'shell', friends: 'friends', money: 'money', duka: 'tools', messages: 'messages', groups: 'group', status: 'status', settings: 'settings', games: 'games' };

/** Normalisation shared with the app (necpra-voice-nlu.js normPhrase): MUST stay identical. Placeholder {name} survives as "{name}". */
function normPhrase(text) {
  let t = String(text == null ? '' : text);
  const ph = /\{([a-z_]{1,20})\}/i.exec(t);
  if (ph) t = t.replace(ph[0], ' zzplaceholderzz ');
  t = t.toLowerCase();
  try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* old runtime */ }
  t = t.replace(/['\u2019`]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return ph ? t.replace('zzplaceholderzz', '{' + ph[1].toLowerCase() + '}') : t;
}

function cleanReply(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY) : ''; }

/** @returns {{ok:true,value:object}|{ok:false,error:string}} */
function validateInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = typeof b.phrase === 'string' ? b.phrase.trim() : '';
  if (raw.length < 2 || raw.length > MAX_PHRASE) return { ok: false, error: 'Phrase must be 2 to ' + MAX_PHRASE + ' characters.' };
  const holders = raw.match(/\{[^}]*\}/g) || [];
  if (holders.length > 1) return { ok: false, error: 'Use at most one {placeholder} in a phrase.' };
  if (holders.length === 1 && !/^\{[a-z_]{1,20}\}$/i.test(holders[0])) return { ok: false, error: 'A placeholder looks like {name} (letters only).' };
  if (/[{}]/.test(raw.replace(holders[0] || '', ''))) return { ok: false, error: 'Stray { or } in the phrase.' };
  const norm = normPhrase(raw);
  const words = norm.split(' ').filter(Boolean);
  if (!/[a-z0-9]/.test(norm.replace('{', '').replace('}', '')) || words.length > MAX_WORDS) return { ok: false, error: 'Phrase must have letters and at most ' + MAX_WORDS + ' words.' };
  if (holders.length === 1 && words.length < 2) return { ok: false, error: 'A phrase with a placeholder needs at least one other word, e.g. "accept {name}".' };
  const placeholder = holders.length ? holders[0].slice(1, -1).toLowerCase() : null;

  const kind = b.kind;
  if (kind === 'reply') {
    if (placeholder) return { ok: false, error: 'Reply phrases cannot have a placeholder.' };
    const en = cleanReply(b.reply_en), sw = cleanReply(b.reply_sw);
    if (!en) return { ok: false, error: 'Write the English reply (up to ' + MAX_REPLY + ' characters).' };
    return { ok: true, value: { phrase_norm: norm, phrase_raw: raw, kind, action_id: null, slots: {}, placeholder: null, reply_en: en, reply_sw: sw || null } };
  }
  if (kind === 'action') {
    const act = BY_ID[b.action];
    if (!act) return { ok: false, error: 'Unknown action.' };
    const slots = b.slots && typeof b.slots === 'object' && !Array.isArray(b.slots) ? Object.assign({}, b.slots) : {};
    if (placeholder) {
      const def = act.slots[placeholder];
      if (!def || def.type !== 'string') return { ok: false, error: 'This action has no text slot called {' + placeholder + '}. Pick one of: ' + (Object.keys(act.slots).filter((k) => act.slots[k].type === 'string').map((k) => '{' + k + '}').join(', ') || 'none (this action takes no free text)') + '.' };
      slots[placeholder] = 'x';                       // stand-in so the rest can be validated now; the real words come from the user
    }
    for (const k of Object.keys(slots)) if (!act.slots[k]) return { ok: false, error: 'This action has no slot called "' + k + '".' };
    const ok = validate(act.id, slots);
    if (!ok) return { ok: false, error: 'Fill in every required value for this action (' + Object.entries(act.slots).filter(([, d]) => d.required).map(([k]) => k).join(', ') + ').' };
    if (placeholder) delete ok.slots[placeholder];
    return { ok: true, value: { phrase_norm: norm, phrase_raw: raw, kind, action_id: act.id, slots: ok.slots, placeholder, reply_en: null, reply_sw: null } };
  }
  return { ok: false, error: 'Choose what the phrase does: an action or a reply.' };
}

function createStore(sequelize) {
  let ready = null;
  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS voice_phrases (
        id SERIAL PRIMARY KEY, phrase_norm TEXT NOT NULL UNIQUE, phrase_raw TEXT NOT NULL, kind VARCHAR(10) NOT NULL,
        action_id VARCHAR(60), slots TEXT NOT NULL DEFAULT '{}', placeholder VARCHAR(20), reply_en TEXT, reply_sw TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE, created_by INTEGER, updated_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }
  const rowOut = (r) => ({
    id: Number(r.id), phrase: r.phrase_raw, norm: r.phrase_norm, kind: r.kind, action: r.action_id, slots: safeJson(r.slots), placeholder: r.placeholder || null,
    reply_en: r.reply_en || null, reply_sw: r.reply_sw || null, active: !!r.active, created_by: r.created_by, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at
  });
  function safeJson(s) { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }

  async function listAll() { await ensure(); const [rows] = await sequelize.query('SELECT * FROM voice_phrases ORDER BY id DESC LIMIT 5000'); return rows.map(rowOut); }

  /* What every app downloads: only what it needs to match + answer. `version` changes whenever any phrase changes. */
  async function publicList() {
    await ensure();
    const [rows] = await sequelize.query('SELECT * FROM voice_phrases WHERE active = TRUE ORDER BY id ASC LIMIT ' + MAX_ACTIVE);
    const list = [];
    for (const r of rows) {
      const slots = safeJson(r.slots);
      if (r.kind === 'reply') { list.push({ id: Number(r.id), p: r.phrase_norm, kind: 'reply', en: r.reply_en, sw: r.reply_sw || r.reply_en }); continue; }
      const act = BY_ID[r.action_id]; if (!act) continue;                       // an action removed from the app later: skip, never crash
      const base = { id: Number(r.id), p: r.phrase_norm, kind: 'action', action: r.action_id, module: act.module, slots };
      if (r.placeholder) base.ph = r.placeholder;
      else { const b = buildPhrase(r.action_id, slots); if (!b) continue; base.phrase = b.phrase; }
      list.push(base);
    }
    const version = crypto.createHash('sha1').update(rows.map((r) => r.id + ':' + new Date(r.updated_at).getTime()).join('|')).digest('hex').slice(0, 12);
    return { version, phrases: list };
  }

  async function create(value, adminId) {
    await ensure();
    const [[cnt]] = await sequelize.query('SELECT COUNT(*)::int AS n FROM voice_phrases WHERE active = TRUE');
    if (Number(cnt.n) >= MAX_ACTIVE) return { ok: false, status: 409, error: 'Limit of ' + MAX_ACTIVE + ' active phrases reached.' };
    const [dupe] = (await sequelize.query('SELECT id FROM voice_phrases WHERE phrase_norm = :n', { replacements: { n: value.phrase_norm } }))[0];
    if (dupe) return { ok: false, status: 409, error: 'That phrase already exists.' };
    const [rows] = await sequelize.query(
      `INSERT INTO voice_phrases (phrase_norm, phrase_raw, kind, action_id, slots, placeholder, reply_en, reply_sw, active, created_by, updated_by)
       VALUES (:phrase_norm, :phrase_raw, :kind, :action_id, :slots, :placeholder, :reply_en, :reply_sw, TRUE, :by, :by) RETURNING *`,
      { replacements: Object.assign({}, value, { slots: JSON.stringify(value.slots || {}), by: adminId || null }) });
    return { ok: true, row: rowOut(rows[0]) };
  }

  async function update(id, value, adminId, active) {
    await ensure();
    const [found] = (await sequelize.query('SELECT * FROM voice_phrases WHERE id = :id', { replacements: { id } }))[0];
    if (!found) return { ok: false, status: 404, error: 'Not found.' };
    if (value) {
      const [dupe] = (await sequelize.query('SELECT id FROM voice_phrases WHERE phrase_norm = :n AND id <> :id', { replacements: { n: value.phrase_norm, id } }))[0];
      if (dupe) return { ok: false, status: 409, error: 'That phrase already exists.' };
      await sequelize.query(
        `UPDATE voice_phrases SET phrase_norm=:phrase_norm, phrase_raw=:phrase_raw, kind=:kind, action_id=:action_id, slots=:slots, placeholder=:placeholder,
         reply_en=:reply_en, reply_sw=:reply_sw, updated_by=:by, updated_at=NOW() WHERE id=:id`,
        { replacements: Object.assign({}, value, { slots: JSON.stringify(value.slots || {}), by: adminId || null, id }) });
    }
    if (typeof active === 'boolean') await sequelize.query('UPDATE voice_phrases SET active=:a, updated_by=:by, updated_at=NOW() WHERE id=:id', { replacements: { a: active, by: adminId || null, id } });
    const [row] = (await sequelize.query('SELECT * FROM voice_phrases WHERE id = :id', { replacements: { id } }))[0];
    return { ok: true, row: rowOut(row) };
  }

  async function remove(id) {
    await ensure();
    const [found] = (await sequelize.query('SELECT id FROM voice_phrases WHERE id = :id', { replacements: { id } }))[0];
    if (!found) return { ok: false, status: 404, error: 'Not found.' };
    await sequelize.query('DELETE FROM voice_phrases WHERE id = :id', { replacements: { id } });
    return { ok: true };
  }

  return { ensure, listAll, publicList, create, update, remove };
}

module.exports = { createStore, validateInput, normPhrase, MAX_ACTIVE, MODULE_OF };

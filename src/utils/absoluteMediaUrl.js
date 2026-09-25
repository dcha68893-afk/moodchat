// src/utils/absoluteMediaUrl.js (NEW FILE)
// Raw SQL (sequelize.query) bypasses the Users.avatar getter, so manually-uploaded photos stored as
// "/uploads/..." were sent to other users as relative paths that cannot load. Use this on raw rows.
'use strict';

function baseUrl() {
  let base = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || '';
  if (!base) { try { base = require('./requestContext').getRequestBaseUrl() || ''; } catch (_) {} }
  return String(base || '').replace(/\/+$/, '');
}

function absoluteMediaUrl(u) {
  if (!u || typeof u !== 'string') return u;
  u = u.trim();
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^http:\/\/(lh\d\.googleusercontent\.com|res\.cloudinary\.com|ui-avatars\.com)/i.test(u)) return u.replace(/^http:/i, 'https:');
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  const path = u.charAt(0) === '/' ? u : '/' + u;
  const base = baseUrl();
  return base ? base + path : path;
}

function fixUserRow(row) {
  if (row && typeof row === 'object' && row.avatar) row.avatar = absoluteMediaUrl(row.avatar);
  return row;
}

module.exports = { absoluteMediaUrl, fixUserRow };

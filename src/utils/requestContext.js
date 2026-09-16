'use strict';
/**
 * requestContext.js — AsyncLocalStorage-based per-request context.
 *
 * Why this exists: several module-level formatter helpers (e.g.
 * marketplace.controller.js's _formatProduct) need to turn relative
 * /uploads/... paths into absolute URLs, but they run outside any
 * per-request function and have no `req` parameter. Previously they could
 * only fall back to process.env.RENDER_EXTERNAL_URL / BACKEND_URL — if
 * neither was set in production, image URLs stayed relative, 404'd on the
 * frontend's different origin, and the UI silently fell back to a generic
 * placeholder image across every category.
 *
 * This module lets middleware stash the current request's own
 * protocol+host once per request; any code running later in that same
 * request's async chain (including plain module-level functions) can read
 * it back with getRequestBaseUrl(), no env var required.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Express middleware — mount this early (before routes). */
function requestContextMiddleware(req, res, next) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = host ? `${proto}://${host}` : '';
    // Store a live reference to `req` itself (not a snapshot) — this
    // middleware runs before auth middleware sets req.user, but since we
    // keep the object reference, getRequestUser() called later in the same
    // request's async chain still sees whatever auth middleware set.
    als.run({ baseUrl, req }, () => next());
}

/** Returns the current request's own protocol://host, or '' if unavailable
 *  (e.g. code running outside any request, such as a cron job). */
function getRequestBaseUrl() {
    return als.getStore()?.baseUrl || '';
}

/** Returns the current request's req.user (set by auth middleware), or
 *  null if there is no request in scope or the viewer isn't authenticated. */
function getRequestUser() {
    return als.getStore()?.req?.user || null;
}

module.exports = { requestContextMiddleware, getRequestBaseUrl, getRequestUser, als };

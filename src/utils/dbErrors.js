'use strict';
// True when an error means "the database cannot be reached right now"
// (as opposed to a bad query or bad input). Callers map this to HTTP 503
// so clients and load balancers can distinguish an outage from a bug.
const DB_UNAVAILABLE_NAMES = new Set([
  'SequelizeConnectionError',
  'SequelizeConnectionRefusedError',
  'SequelizeHostNotFoundError',
  'SequelizeHostNotReachableError',
  'SequelizeConnectionTimedOutError',
  'SequelizeConnectionAcquireTimeoutError',
  'SequelizeAccessDeniedError',
]);
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  '57P01', '57P02', '57P03', '53300', '08000', '08003', '08006',
]);

function isDbUnavailable(err) {
  if (!err) return false;
  if (DB_UNAVAILABLE_NAMES.has(err.name)) return true;
  const codes = [err.code, err.parent && err.parent.code, err.original && err.original.code];
  if (codes.some((c) => c && DB_UNAVAILABLE_CODES.has(String(c)))) return true;
  return /connection (terminated|timeout)|ConnectionAcquireTimeout|Connection terminated|pool is (closed|draining)/i
    .test(String(err.message || ''));
}

module.exports = { isDbUnavailable };

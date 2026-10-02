'use strict';
const { isDbUnavailable } = require('../../src/utils/dbErrors');

describe('isDbUnavailable', () => {
  test('recognises Sequelize connection errors', () => {
    expect(isDbUnavailable({ name: 'SequelizeConnectionError' })).toBe(true);
    expect(isDbUnavailable({ name: 'SequelizeConnectionAcquireTimeoutError' })).toBe(true);
  });
  test('recognises low-level network / postgres codes', () => {
    expect(isDbUnavailable({ parent: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(isDbUnavailable({ original: { code: '57P01' } })).toBe(true);
    expect(isDbUnavailable({ code: '53300' })).toBe(true);
  });
  test('recognises pool/termination messages', () => {
    expect(isDbUnavailable(new Error('Connection terminated unexpectedly'))).toBe(true);
  });
  test('does not treat validation or SQL errors as an outage', () => {
    expect(isDbUnavailable({ name: 'ValidationError', message: 'bad input' })).toBe(false);
    expect(isDbUnavailable({ name: 'SequelizeDatabaseError', parent: { code: '42P01' } })).toBe(false);
    expect(isDbUnavailable(null)).toBe(false);
  });
});

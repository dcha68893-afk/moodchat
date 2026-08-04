'use strict';
/**
 * config/config.js — sequelize-cli connection config
 *
 * ROOT CAUSE FIX (STALE-MIGRATION-TARGET):
 * sequelize-cli has no built-in way to read `.env` on its own, so it was
 * falling back to config/config.json — which has hardcoded credentials
 * pointing at an old direct Render Postgres instance
 * (dpg-d7k8hrl7vvec73969alg-a...render.com). But the actual running app
 * (src/config/database.js / src/models/index.js) connects using
 * process.env.SUPABASE_DB_URL first, then DATABASE_URL, then discrete
 * DB_* vars — which on the live Render service now points at Supabase,
 * a DIFFERENT database than the one in config.json.
 *
 * That meant every migration ever run by `sequelize-cli db:migrate`
 * (including the startup auto-migrate in src/server.js DatabaseManager
 * .initialize()) was silently applying against the old, unused Render
 * Postgres instance — never touching the Supabase database the app
 * actually reads/writes. Tables and columns added by migrations
 * (starred_messages, marketplace fk fixes, group sender key columns,
 * etc.) never existed on the database real requests hit, producing the
 * "relation/column does not exist" 500s on marketplace, devices/sync,
 * and other routes.
 *
 * Fix: replace the static, credential-hardcoded config.json with this
 * dynamic config that resolves the connection the exact same way
 * src/config/database.js does, so `sequelize-cli db:migrate` (both the
 * CLI and the auto-migrate-on-boot call in server.js) always targets
 * the same database the app actually uses at runtime.
 *
 * config.json is left in place for reference/rollback but is no longer
 * read — see .sequelizerc, which points the CLI at this file instead.
 */

require('dotenv').config();

// FIX-IPV6-ENETUNREACH: same root cause and fix as src/server.js — see the
// writeup there. sequelize-cli db:migrate runs as its own separate `node`
// process (invoked by `npm run db:migrate`), so server.js's DNS fix never
// applies to it; it needs its own copy here, before resolveConnection()
// below ever gets used to open a connection.
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch (_dnsOrderErr) {
  // Node <17 fallback: never block migrations over this, just proceed.
}

function resolveConnection() {
  if (process.env.SUPABASE_DB_URL) {
    return {
      use_env_variable: 'SUPABASE_DB_URL',
      dialect: 'postgres',
      dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    };
  }

  if (process.env.DATABASE_URL) {
    return {
      use_env_variable: 'DATABASE_URL',
      dialect: 'postgres',
      dialectOptions:
        process.env.NODE_ENV === 'production'
          ? { ssl: { require: true, rejectUnauthorized: false } }
          : {},
    };
  }

  // Last resort: discrete DB_* vars (local/legacy dev only)
  return {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    dialect: 'postgres',
  };
}

const base = resolveConnection();

module.exports = {
  development: { ...base, logging: process.env.DB_LOGGING === 'true' ? console.log : false },
  test: { ...base, logging: false },
  production: { ...base, logging: false },
};

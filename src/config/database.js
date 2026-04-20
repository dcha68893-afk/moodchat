// config/database.js
// Supabase PostgreSQL connection layer
// ONLY this file is modified — all services, routes, and queries remain unchanged.

const { Sequelize } = require('sequelize');
const pg = require('pg');

// ============================================================================
// DATABASE CONFIGURATION
// ============================================================================

function getDatabaseConfig() {
  const env = process.env.NODE_ENV || 'development';

  console.log(`[Database] Environment: ${env}`);

  // ✅ PRIMARY: Supabase connection string (all environments)
  if (process.env.SUPABASE_DB_URL) {
    console.log('[Database] Using SUPABASE_DB_URL connection');
    return {
      connectionString: process.env.SUPABASE_DB_URL,
      // Supabase always requires SSL
      ssl: { rejectUnauthorized: false }
    };
  }

  // ✅ FALLBACK: Legacy DATABASE_URL (backward-compatible during migration)
  if (process.env.DATABASE_URL) {
    console.log('[Database] Using DATABASE_URL connection (legacy fallback)');
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: env === 'production' ? { rejectUnauthorized: false } : false
    };
  }

  // ✅ LAST RESORT: Individual env vars (local dev without a connection string)
  console.log('[Database] Using individual DB_* environment variables');
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'myapp',
    dialect: 'postgres',
    dialectModule: pg,
    logging: process.env.DB_LOGGING === 'true' ? console.log : false
  };
}

// ============================================================================
// SEQUELIZE INSTANCE (SINGLETON)
// ============================================================================

let sequelizeInstance = null;

function getSequelizeInstance() {
  if (sequelizeInstance) return sequelizeInstance;

  try {
    const config = getDatabaseConfig();

    const poolConfig = {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    };

    const dialectOptions = {
      keepAlive: true,
      statement_timeout: 10000,
      query_timeout: 10000,
      idle_in_transaction_session_timeout: 10000,
      // SSL is always enabled for Supabase
      ssl: config.ssl || false
    };

    const retryConfig = {
      max: 3,
      timeout: 10000,
      match: [
        /ConnectionError/,
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/,
        /ETIMEDOUT/,
        /ECONNREFUSED/,
        /ENOTFOUND/
      ]
    };

    const defineConfig = {
      timestamps: true,
      underscored: true,
      freezeTableName: true
    };

    if (config.connectionString) {
      sequelizeInstance = new Sequelize(config.connectionString, {
        dialect: 'postgres',
        dialectModule: pg,
        logging: false,
        pool: poolConfig,
        dialectOptions,
        define: defineConfig,
        retry: retryConfig
      });
    } else {
      sequelizeInstance = new Sequelize(
        config.database,
        config.username,
        config.password,
        {
          host: config.host,
          port: config.port,
          dialect: config.dialect,
          dialectModule: config.dialectModule,
          logging: config.logging,
          pool: poolConfig,
          dialectOptions,
          define: defineConfig,
          retry: retryConfig
        }
      );
    }

    console.log('[Database] Sequelize instance created successfully');
    return sequelizeInstance;

  } catch (error) {
    // Never log credentials — only the sanitized message
    console.error('[Database] Failed to create Sequelize instance:', error.message);
    throw new Error(`Database configuration error: ${error.message}`);
  }
}

// ============================================================================
// CONNECTION WITH RETRY
// ============================================================================

async function testDatabaseConnection(maxRetries = 3, retryDelay = 2000) {
  const sequelize = getSequelizeInstance();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Database] Connection attempt ${attempt}/${maxRetries}...`);
      await sequelize.authenticate();
      console.log('[Database] ✅ Connection established successfully');
      return {
        success: true,
        message: 'Database connection successful',
        attempt,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // Safe error — never include connection string or credentials
      console.error(`[Database] ❌ Connection attempt ${attempt} failed:`, error.message);

      if (attempt === maxRetries) {
        // Do NOT throw — let the server start and retry on first real request
        console.error(`[Database] All ${maxRetries} connection attempts exhausted. Server will retry on first request.`);
        return {
          success: false,
          message: `Database unreachable after ${maxRetries} attempts`,
          timestamp: new Date().toISOString()
        };
      }

      console.log(`[Database] Retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function closeDatabaseConnection() {
  if (sequelizeInstance) {
    try {
      await sequelizeInstance.close();
      console.log('[Database] Connection closed gracefully');
      sequelizeInstance = null;
    } catch (error) {
      console.error('[Database] Error closing connection:', error.message);
    }
  }
}

// ============================================================================
// HEALTH CHECK (unchanged contract — used by routes)
// ============================================================================

async function checkDatabaseHealth() {
  try {
    const sequelize = getSequelizeInstance();
    await sequelize.authenticate();

    const [tablesResult] = await sequelize.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('users', 'tokens')
    `);

    const hasUsersTable = tablesResult.some(row => row.table_name === 'users');
    const hasTokensTable = tablesResult.some(row => row.table_name === 'tokens');

    return {
      status: 'healthy',
      connected: true,
      tables: {
        users: hasUsersTable,
        tokens: hasTokensTable,
        allAuthTables: hasUsersTable && hasTokensTable
      },
      timestamp: new Date().toISOString(),
      connection: {
        // Safe: host and db name only — never URL or password
        host: sequelize.config.host || '(supabase)',
        database: sequelize.config.database || '(supabase)',
        dialect: sequelize.config.dialect
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      connected: false,
      // Sanitize — never expose connection details to health route callers
      error: 'Database connection failed',
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================================================
// SAFE QUERY HELPER (unchanged contract — used by routes)
// ============================================================================

async function executeSafeQuery(query, options = {}) {
  const sequelize = getSequelizeInstance();
  const defaultOptions = {
    logging: false,
    timeout: 5000,
    retries: 1,
    ...options
  };

  for (let attempt = 0; attempt <= defaultOptions.retries; attempt++) {
    try {
      const result = await sequelize.query(query, defaultOptions);
      return {
        success: true,
        data: result[0],
        metadata: result[1],
        attempt: attempt + 1
      };
    } catch (error) {
      if (attempt === defaultOptions.retries) {
        console.error('[Database] Query failed after all retries:', {
          query: query.substring(0, 100) + '...',
          error: error.message
        });
        return {
          success: false,
          error: error.message,
          code: error.code || 'QUERY_ERROR',
          attempt: attempt + 1
        };
      }
      console.warn(`[Database] Query attempt ${attempt + 1} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

// ============================================================================
// AUTO-CONNECT ON LOAD (opt-in via env flag)
// ============================================================================

(async function initializeOnLoad() {
  if (process.env.DB_CONNECT_ON_LOAD === 'true') {
    console.log('[Database] Auto-connecting on module load...');
    await testDatabaseConnection();
  }
})();

// ============================================================================
// GRACEFUL SHUTDOWN HANDLERS
// ============================================================================

process.on('SIGINT', async () => {
  console.log('[Database] Received SIGINT, closing connections...');
  await closeDatabaseConnection();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[Database] Received SIGTERM, closing connections...');
  await closeDatabaseConnection();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await closeDatabaseConnection();
});

// ============================================================================
// EXPORTS (identical surface — no consumer changes required)
// ============================================================================

module.exports = {
  getSequelizeInstance,
  testDatabaseConnection,
  closeDatabaseConnection,
  checkDatabaseHealth,
  executeSafeQuery,
  getDatabaseConfig,

  // Backward-compatible direct reference
  get sequelize() { return getSequelizeInstance(); },

  CONNECTION_STATUS: {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ERROR: 'error'
  }
};
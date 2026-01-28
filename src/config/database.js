// src/database/database.js
const { Sequelize } = require('sequelize');
const pg = require('pg');

// Database connection configuration
function getDatabaseConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isRender = process.env.RENDER === 'true';
  
  console.log(`[Database] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Database] Render environment: ${isRender ? 'Yes' : 'No'}`);
  
  // Use Render database URL if available, otherwise use individual environment variables
  if (process.env.DATABASE_URL) {
    console.log('[Database] Using DATABASE_URL connection');
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: isProduction ? { rejectUnauthorized: false } : false
    };
  }
  
  // Fallback to individual environment variables
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'myapp',
    dialect: 'postgres',
    dialectModule: pg,
    logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  };
  
  console.log(`[Database] Using individual config: ${config.host}:${config.port}/${config.database}`);
  return config;
}

// Initialize Sequelize instance
let sequelizeInstance = null;

function getSequelizeInstance() {
  if (sequelizeInstance) {
    return sequelizeInstance;
  }
  
  try {
    const config = getDatabaseConfig();
    
    if (config.connectionString) {
      // Connection using DATABASE_URL
      sequelizeInstance = new Sequelize(config.connectionString, {
        dialect: 'postgres',
        dialectModule: pg,
        logging: config.logging || false,
        pool: {
          max: 10,
          min: 0,
          acquire: 30000,
          idle: 10000
        },
        dialectOptions: {
          ssl: config.ssl || false,
          keepAlive: true,
          statement_timeout: 10000,
          query_timeout: 10000,
          idle_in_transaction_session_timeout: 10000
        },
        define: {
          timestamps: true,
          underscored: true,
          freezeTableName: true
        },
        retry: {
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
        }
      });
    } else {
      // Connection using individual parameters
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
          pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
          },
          dialectOptions: {
            keepAlive: true,
            statement_timeout: 10000,
            query_timeout: 10000,
            idle_in_transaction_session_timeout: 10000
          },
          define: {
            timestamps: true,
            underscored: true,
            freezeTableName: true
          },
          retry: {
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
          }
        }
      );
    }
    
    console.log('[Database] Sequelize instance created successfully');
    return sequelizeInstance;
    
  } catch (error) {
    console.error('[Database] Failed to create Sequelize instance:', error.message);
    throw new Error(`Database configuration error: ${error.message}`);
  }
}

// Test database connection with retry logic
async function testDatabaseConnection(maxRetries = 3, retryDelay = 2000) {
  const sequelize = getSequelizeInstance();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Database] Connection attempt ${attempt}/${maxRetries}...`);
      
      await sequelize.authenticate();
      
      console.log('[Database] ✅ Connection established successfully');
      console.log('[Database] Connection details:', {
        host: sequelize.config.host,
        port: sequelize.config.port,
        database: sequelize.config.database,
        username: sequelize.config.username,
        dialect: sequelize.config.dialect
      });
      
      return {
        success: true,
        message: 'Database connection successful',
        attempt: attempt,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error(`[Database] ❌ Connection attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        const errorDetails = {
          success: false,
          message: `Failed to connect to database after ${maxRetries} attempts`,
          error: error.message,
          timestamp: new Date().toISOString(),
          config: {
            host: sequelize.config.host,
            port: sequelize.config.port,
            database: sequelize.config.database,
            username: sequelize.config.username
          }
        };
        
        console.error('[Database] Connection error details:', errorDetails);
        throw new Error(`Database connection failed: ${error.message}`);
      }
      
      // Wait before retrying
      console.log(`[Database] Retrying in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Graceful shutdown handler
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

// Health check function for routes
async function checkDatabaseHealth() {
  try {
    const sequelize = getSequelizeInstance();
    
    // Test connection
    await sequelize.authenticate();
    
    // Check if auth tables exist
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
        host: sequelize.config.host,
        database: sequelize.config.database,
        dialect: sequelize.config.dialect
      }
    };
    
  } catch (error) {
    return {
      status: 'unhealthy',
      connected: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Enhanced query helper for routes like /auth/me
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
        
        // Don't crash the server, return error response
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

// Initialize database connection on module load
(async function initializeOnLoad() {
  if (process.env.DB_CONNECT_ON_LOAD === 'true') {
    console.log('[Database] Auto-connecting on module load...');
    try {
      await testDatabaseConnection();
      console.log('[Database] Auto-connection successful');
    } catch (error) {
      console.error('[Database] Auto-connection failed, will retry on first request');
    }
  }
})();

// Setup process event handlers for graceful shutdown
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
  console.log('[Database] Process exiting, closing connections...');
  await closeDatabaseConnection();
});

// Export everything
module.exports = {
  getSequelizeInstance,
  testDatabaseConnection,
  closeDatabaseConnection,
  checkDatabaseHealth,
  executeSafeQuery,
  getDatabaseConfig,
  
  // For backward compatibility with existing code
  sequelize: getSequelizeInstance(),
  
  // Connection status constants
  CONNECTION_STATUS: {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ERROR: 'error'
  }
};
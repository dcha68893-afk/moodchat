// models/index.js - PRODUCTION-SAFE MODEL LOADER (NO SCHEMA CHANGES)
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');

// ===== DATABASE CONFIGURATION =====
const env = process.env.NODE_ENV || 'development';

const getDbConfig = () => {
  // Priority 1: DATABASE_URL (for Render, Heroku, etc.)
  if (process.env.DATABASE_URL) {
    console.log(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 10,
        min: parseInt(process.env.DB_POOL_MIN) || 0,
        acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
        idle: parseInt(process.env.DB_POOL_IDLE) || 10000
      },
      dialectOptions: process.env.DB_SSL === 'true' ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      } : {},
    };
  }
  
  // Priority 2: Individual environment variables
  console.log(`[Database] Using individual config for ${env} environment`);
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'denismoo',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    dialect: process.env.DB_DIALECT || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX) || 10,
      min: parseInt(process.env.DB_POOL_MIN) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE) || 10000
    },
    dialectOptions: process.env.DB_SSL === 'true' ? {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    } : {},
  };
};

const dbConfig = getDbConfig();

// ===== SEQUELIZE INITIALIZATION =====
const sequelize = dbConfig.url
  ? new Sequelize(dbConfig.url, {
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: false,
        freezeTableName: true,
        paranoid: false,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    })
  : new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: false,
        freezeTableName: true,
        paranoid: false,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    });

// ===== DATABASE CONNECTION TEST =====
sequelize.authenticate()
  .then(() => {
    console.log(`[Database] ✅ Connection to ${dbConfig.database || 'database'} (${env}) established successfully`);
  })
  .catch(err => {
    console.error(`[Database] ❌ Unable to connect to database (${env}):`, err.message);
    process.exit(1);
  });

// ===== STRICT MODEL LOADING =====
console.log('[Database] 🛡️ Initializing STRICT model loader (NO SCHEMA CHANGES)...');

const db = {
  sequelize,
  Sequelize,
  Op, // Explicitly export Op for use in route files
  models: {},
  failedModels: {},
  skippedFiles: {},
  associationErrors: {}
};

// CRITICAL: Define essential core models for system startup
const CORE_MODELS = ['Users', 'Token', 'Profile'];

// CRITICAL: Patterns that indicate NON-MODEL files (routers, controllers, etc.)
const NON_MODEL_PATTERNS = [
  'auth', 'route', 'router', 'controller', 'middleware',
  'index', 'utils', 'status', 'error', 'validator', 'schemas',
  'calls', 'chats', 'friends', 'group',
  'rateLimiter', 'errorHandler', 'authMiddleware'
];

// ===== MODEL FILE VALIDATION =====
console.log('[Database] Scanning for REAL Sequelize models only...');

const modelFiles = fs.readdirSync(__dirname)
  .filter(file => {
    const filePath = path.join(__dirname, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      console.log(`[Database] 📁 Skipping directory: ${file}`);
      db.skippedFiles[file] = 'Directory (not a model file)';
      return false;
    }
    
    if (!file.endsWith('.js')) {
      console.log(`[Database] 📄 Skipping non-JS file: ${file}`);
      db.skippedFiles[file] = 'Not a JavaScript file';
      return false;
    }
    
    if (file === 'index.js') {
      console.log(`[Database] 🔧 Skipping model index file: ${file}`);
      db.skippedFiles[file] = 'Model index file';
      return false;
    }
    
    const fileName = file.toLowerCase().replace('.js', '');
    
    const isNonModel = NON_MODEL_PATTERNS.some(pattern => 
      fileName.includes(pattern.toLowerCase())
    );
    
    if (isNonModel) {
      console.log(`[Database] 🛡️ Strict Guard: Skipping ${file} - matches non-model pattern`);
      db.skippedFiles[file] = 'Matches non-model pattern (router/controller)';
      return false;
    }
    
    return true;
  });

console.log(`[Database] Found ${modelFiles.length} potential model files after filtering`);

// ===== LOAD MODELS ONLY (NO SYNC, NO ALTER) =====
modelFiles.forEach(file => {
  const modelName = file.replace('.js', '');
  const filePath = path.join(__dirname, file);
  
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    const isSequelizeModel = 
      fileContent.includes('sequelize.define') || 
      fileContent.includes('Sequelize.Model') ||
      (fileContent.includes('module.exports') && 
       (fileContent.includes('(sequelize, DataTypes)') || 
        fileContent.includes('function(sequelize, DataTypes)'))) ||
      (fileContent.includes('class') && fileContent.includes('extends Model')) ||
      fileContent.includes('DataTypes.');
    
    const isRouterOrController = 
      fileContent.includes('express.Router()') ||
      fileContent.includes('express.Router(') ||
      fileContent.includes('app.get(') ||
      fileContent.includes('app.post(') ||
      fileContent.includes('app.use(') ||
      fileContent.includes('router.get(') ||
      fileContent.includes('router.post(') ||
      fileContent.includes('router.use(');
    
    if (isRouterOrController) {
      console.log(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Detected as router/controller`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File is a router/controller, not a Sequelize model',
        timestamp: new Date().toISOString(),
        detection: 'Router/controller pattern detected'
      };
      return;
    }
    
    if (!isSequelizeModel) {
      console.log(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Not a Sequelize model structure`);
      db.failedModels[modelName] = {
        file: file,
        error: 'File does not export a valid Sequelize model structure',
        timestamp: new Date().toISOString(),
        detection: 'Missing Sequelize model patterns'
      };
      return;
    }
    
    console.log(`[Database] Loading model: ${modelName} from ${file}`);
    
    const modelModule = require(filePath);
    
    let modelInstance;
    if (typeof modelModule === 'function') {
      modelInstance = modelModule(sequelize, Sequelize.DataTypes);
    } else if (modelModule && typeof modelModule.init === 'function') {
      modelInstance = modelModule;
      if (!modelInstance.sequelize) {
        // Initialize model WITHOUT auto-creating indexes or foreign keys
        modelInstance.init(modelInstance.rawAttributes || {}, {
          sequelize,
          modelName: modelInstance.name || modelName,
          tableName: modelInstance.tableName || modelInstance.name || modelName,
        });
      }
    } else if (modelModule && typeof modelModule === 'object' && modelModule.rawAttributes) {
      modelInstance = modelModule;
    } else {
      throw new Error(`Invalid model structure in ${file} - not a function or initialized model`);
    }
    
    if (!modelInstance || (!modelInstance.name && !modelName)) {
      throw new Error(`Model instance has no name property`);
    }
    
    const actualModelName = modelInstance.name || modelName;
    
    if (db.models[actualModelName]) {
      console.warn(`[Database] ⚠️ Duplicate model name detected: ${actualModelName}. Skipping duplicate.`);
      db.failedModels[modelName] = {
        file: file,
        error: `Duplicate model name: ${actualModelName} already loaded`,
        timestamp: new Date().toISOString(),
        detection: 'Duplicate model name'
      };
      return;
    }
    
    db.models[actualModelName] = modelInstance;
    
    console.log(`[Database] ✅ Loaded model: ${actualModelName} (NO SYNC)`);
    
  } catch (error) {
    console.error(`[Database] ❌ Failed to load model ${modelName}:`, error.message);
    
    db.failedModels[modelName] = {
      file: file,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      detection: 'Load error'
    };
  }
});

// ===== SAFE ASSOCIATION SETUP =====
console.log('[Database] Setting up associations (constraints: false)...');

Object.keys(db.models).forEach(modelName => {
  const model = db.models[modelName];
  if (model && typeof model.associate === 'function') {
    try {
      // Wrap associate function to ensure constraints: false
      const originalAssociate = model.associate;
      model.associate = function(models) {
        // Store original associate call
        const result = originalAssociate.call(this, models);
        
        // Override any foreign key constraints to prevent auto-creation
        if (this.associations) {
          Object.values(this.associations).forEach(association => {
            if (association.foreignKeyConstraint !== undefined) {
              association.foreignKeyConstraint = false;
            }
            if (association.options) {
              association.options.constraints = false;
              // Remove index flags that trigger creation
              delete association.options.unique;
              delete association.options.index;
            }
          });
        }
        return result;
      };
      
      model.associate(db.models);
      console.log(`[Database] ✅ Associated model: ${modelName} (constraints: false)`);
    } catch (error) {
      console.error(`[Database] ❌ Error associating model ${modelName}:`, error.message);
      db.associationErrors[modelName] = {
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
});

// ===== CORE MODEL VALIDATION =====
console.log('[Database] ===== CORE MODEL VALIDATION =====');
const failedCoreModels = CORE_MODELS.filter(coreModel => 
  !db.models[coreModel] || db.failedModels[coreModel]
);

if (failedCoreModels.length > 0) {
  console.error('[Database] ❌ CRITICAL: Core models failed to load!');
  console.error('[Database] Failed core models:', failedCoreModels.join(', '));
  console.error('[Database] System cannot start without core functionality.');
  
  failedCoreModels.forEach(modelName => {
    if (db.failedModels[modelName]) {
      console.error(`  ${modelName}: ${db.failedModels[modelName].error}`);
    } else {
      console.error(`  ${modelName}: Model not found in loaded models`);
    }
  });
  
  process.exit(1);
}

console.log('[Database] ✅ All core models loaded successfully');

// ===== UTILITY FUNCTIONS =====
db.showCurrentTables = async function() {
  try {
    console.log('[Database] ===== CURRENT DATABASE TABLES =====');
    
    const queryResult = await sequelize.query(
      `SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.table_name) as column_count,
        (SELECT pg_size_pretty(pg_total_relation_size(quote_ident(table_name)))) as table_size
      FROM information_schema.tables t 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;`,
      { type: sequelize.QueryTypes.SELECT }
    );
    
    console.log(`[Database] Total tables: ${queryResult.length}`);
    queryResult.forEach((table, index) => {
      console.log(`  ${index + 1}. ${table.table_name} (${table.column_count} columns, ${table.table_size})`);
    });
    
    console.log('[Database] ============================');
  } catch (error) {
    console.error('[Database] Error listing tables:', error.message);
  }
};

db.testConnection = async function() {
  try {
    await sequelize.authenticate();
    console.log('[Database] Connection test: ✅ SUCCESS');
    return true;
  } catch (error) {
    console.error('[Database] Connection test: ❌ FAILED', error.message);
    return false;
  }
};

db.getLoadedModels = function() {
  return Object.keys(db.models).map(name => ({
    name,
    tableName: db.models[name].tableName || name,
    status: 'LOADED',
    columns: db.models[name].rawAttributes ? Object.keys(db.models[name].rawAttributes).length : 0
  }));
};

db.getFailedModels = function() {
  return Object.keys(db.failedModels).map(name => ({
    name,
    file: db.failedModels[name].file,
    error: db.failedModels[name].error,
    timestamp: db.failedModels[name].timestamp,
    status: 'FAILED',
    detection: db.failedModels[name].detection || 'Unknown'
  }));
};

db.getSkippedFiles = function() {
  return Object.keys(db.skippedFiles).map(fileName => ({
    fileName,
    reason: db.skippedFiles[fileName],
    status: 'SKIPPED'
  }));
};

db.getOperationalStatus = function() {
  const failedCore = CORE_MODELS.filter(coreModel => 
    !db.models[coreModel] || db.failedModels[coreModel]
  );
  
  return {
    mode: failedCore.length > 0 ? 'HALTED' : 
          (Object.keys(db.failedModels).length > 0 ? 'PARTIAL' : 'FULL'),
    coreOperational: failedCore.length === 0,
    loadedCount: Object.keys(db.models).length,
    failedCount: Object.keys(db.failedModels).length,
    skippedCount: Object.keys(db.skippedFiles).length,
    failedModels: Object.keys(db.failedModels),
    coreModels: CORE_MODELS,
    timestamp: new Date().toISOString()
  };
};

// ===== STARTUP REPORT =====
console.log('\n[Database] ===== STARTUP REPORT =====');
console.log(`[Database] Environment: ${env}`);
console.log(`[Database] Database: ${dbConfig.database || 'DATABASE_URL'}`);
console.log(`[Database] Mode: ${db.getOperationalStatus().mode}`);
console.log('');

console.log(`[Database] ✅ SUCCESSFULLY LOADED (${Object.keys(db.models).length}):`);
db.getLoadedModels().forEach((model, index) => {
  console.log(`  ${index + 1}. ${model.name} (table: ${model.tableName})`);
});

console.log('');

if (Object.keys(db.failedModels).length > 0) {
  console.log(`[Database] ❌ FAILED TO LOAD (${Object.keys(db.failedModels).length}):`);
  db.getFailedModels().forEach((failed, index) => {
    console.log(`  ${index + 1}. ${failed.name} (${failed.file})`);
    console.log(`     Error: ${failed.error}`);
  });
}

console.log('');

if (Object.keys(db.skippedFiles).length > 0) {
  console.log(`[Database] ⏭️  SKIPPED FILES (${Object.keys(db.skippedFiles).length}):`);
  db.getSkippedFiles().forEach((skipped, index) => {
    console.log(`  ${index + 1}. ${skipped.fileName} - ${skipped.reason}`);
  });
}

console.log('\n[Database] ===== OPERATIONAL STATUS =====');
const status = db.getOperationalStatus();
if (status.mode === 'HALTED') {
  console.log('[Database] ❌ SYSTEM HALTED: Core models missing');
  console.log('[Database] Server cannot start without core functionality');
} else if (status.mode === 'PARTIAL') {
  console.log('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
  console.log('[Database] Core functionality is operational');
} else {
  console.log('[Database] ✅ FULL OPERATION: All models loaded');
}

console.log('[Database] =================================\n');

if (status.coreOperational) {
  console.log('[Database] 🚀 Server ready');
  console.log('[Database] ✅ Schema changes disabled - respecting existing database structure');
  console.log('[Database] ✅ Associations loaded with constraints: false');
  console.log('[Database] ✅ No auto-sync, no alter, no force');
  console.log('[Database] ✅ Sequelize.Op is available for queries');
}

// ===== EXPORT =====
// Export all necessary Sequelize components in standard pattern
module.exports = {
  ...db, // Spread all db properties
  sequelize, // Direct reference to sequelize instance
  Sequelize, // Direct reference to Sequelize class
  Op, // Direct reference to Op operators
  models: db.models // Direct reference to models
};
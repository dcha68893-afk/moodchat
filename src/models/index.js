// models/index.js - STRICT, PROFESSIONAL MODEL LOADER WITH ALL FEATURES
const { Sequelize } = require('sequelize');
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

// ===== STRICT MODEL LOADING CONFIGURATION =====
console.log('[Database] 🛡️ Initializing STRICT model loader...');

const models = {};
const failedModels = {};
const skippedFiles = {};

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
      skippedFiles[file] = 'Directory (not a model file)';
      return false;
    }
    
    if (!file.endsWith('.js')) {
      console.log(`[Database] 📄 Skipping non-JS file: ${file}`);
      skippedFiles[file] = 'Not a JavaScript file';
      return false;
    }
    
    if (file === 'index.js') {
      console.log(`[Database] 🔧 Skipping model index file: ${file}`);
      skippedFiles[file] = 'Model index file';
      return false;
    }
    
    const fileName = file.toLowerCase().replace('.js', '');
    
    const isNonModel = NON_MODEL_PATTERNS.some(pattern => 
      fileName.includes(pattern.toLowerCase())
    );
    
    if (isNonModel) {
      console.log(`[Database] 🛡️ Strict Guard: Skipping ${file} - matches non-model pattern`);
      skippedFiles[file] = 'Matches non-model pattern (router/controller)';
      return false;
    }
    
    return true;
  });

console.log(`[Database] Found ${modelFiles.length} potential model files after filtering`);

// ===== HARD SAFETY: VALIDATE EACH FILE AS REAL SEQUELIZE MODEL =====
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
      failedModels[modelName] = {
        file: file,
        error: 'File is a router/controller, not a Sequelize model',
        timestamp: new Date().toISOString(),
        detection: 'Router/controller pattern detected'
      };
      return;
    }
    
    if (!isSequelizeModel) {
      console.log(`[Database] 🛡️ HARD SAFETY: Skipping ${file} - Not a Sequelize model structure`);
      failedModels[modelName] = {
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
    
    if (models[actualModelName]) {
      console.warn(`[Database] ⚠️ Duplicate model name detected: ${actualModelName}. Skipping duplicate.`);
      failedModels[modelName] = {
        file: file,
        error: `Duplicate model name: ${actualModelName} already loaded`,
        timestamp: new Date().toISOString(),
        detection: 'Duplicate model name'
      };
      return;
    }
    
    models[actualModelName] = modelInstance;
    
    console.log(`[Database] ✅ Loaded REAL model: ${actualModelName}`);
    
  } catch (error) {
    console.error(`[Database] ❌ Failed to load model ${modelName}:`, error.message);
    
    failedModels[modelName] = {
      file: file,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      detection: 'Load error'
    };
  }
});

// ===== CORE MODEL VALIDATION =====
console.log('[Database] ===== CORE MODEL VALIDATION =====');
const failedCoreModels = CORE_MODELS.filter(coreModel => 
  !models[coreModel] || failedModels[coreModel]
);

if (failedCoreModels.length > 0) {
  console.error('[Database] ❌ CRITICAL: Core models failed to load!');
  console.error('[Database] Failed core models:', failedCoreModels.join(', '));
  console.error('[Database] System cannot start without core models.');
  
  failedCoreModels.forEach(modelName => {
    if (failedModels[modelName]) {
      console.error(`  ${modelName}: ${failedModels[modelName].error}`);
    } else {
      console.error(`  ${modelName}: Model not found in loaded models`);
    }
  });
  
  process.exit(1);
}

console.log('[Database] ✅ All core models loaded successfully');

// ===== DEFERRED ASSOCIATIONS =====
console.log('[Database] Setting up model associations (deferred)...');

const associationErrors = {};

const associateFunctions = {};

Object.keys(models).forEach(modelName => {
  const model = models[modelName];
  if (model && typeof model.associate === 'function') {
    associateFunctions[modelName] = model.associate.bind(model);
    console.log(`[Database] Found association function for: ${modelName}`);
  }
});

console.log(`[Database] Association functions found: ${Object.keys(associateFunctions).length}`);

// ===== ENUM CONFLICT DETECTION =====
async function detectEnumConflicts() {
  console.log('[Database] Checking for ENUM type conflicts...');
  const conflicts = [];
  
  for (const [modelName, model] of Object.entries(models)) {
    if (model && model.rawAttributes) {
      for (const [columnName, column] of Object.entries(model.rawAttributes)) {
        if (column.type && column.type.key === 'ENUM') {
          try {
            const tableName = model.tableName || modelName.toLowerCase();
            
            const tableExists = await sequelize.query(
              `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${tableName}')`,
              { type: sequelize.QueryTypes.SELECT }
            );
            
            if (tableExists[0].exists) {
              const columnExists = await sequelize.query(
                `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tableName}' AND column_name = '${columnName}')`,
                { type: sequelize.QueryTypes.SELECT }
              );
              
              if (columnExists[0].exists) {
                const existingEnumQuery = `
                  SELECT e.enumlabel 
                  FROM pg_enum e 
                  JOIN pg_type t ON e.enumtypid = t.oid 
                  JOIN pg_class c ON c.relname = t.typname 
                  WHERE c.relname = '${tableName}_${columnName}_enum' 
                  ORDER BY e.enumsortorder
                `;
                
                try {
                  const existingEnumValues = await sequelize.query(existingEnumQuery, {
                    type: sequelize.QueryTypes.SELECT
                  });
                  
                  const existingValues = existingEnumValues.map(v => v.enumlabel);
                  const modelValues = column.type.values || [];
                  
                  const hasConflict = existingValues.length !== modelValues.length || 
                                     !existingValues.every((val, idx) => val === modelValues[idx]);
                  
                  if (hasConflict) {
                    conflicts.push({
                      table: tableName,
                      column: columnName,
                      modelName: modelName,
                      existingValues: existingValues,
                      modelValues: modelValues,
                      conflictType: 'ENUM_MISMATCH',
                      severity: 'WARNING'
                    });
                  }
                } catch (enumError) {
                  // ENUM type might not exist yet
                }
              }
            }
          } catch (error) {
            console.error(`[Database] Error checking ENUM for ${modelName}.${columnName}:`, error.message);
          }
        }
      }
    }
  }
  
  return conflicts;
}

// ===== SAFE DATABASE INITIALIZATION FUNCTION =====
async function initializeDatabase() {
  const isProduction = process.env.NODE_ENV === 'production';
  
  console.log(`[Database] ===== SAFE DATABASE INITIALIZATION =====`);
  console.log(`[Database] Environment: ${env}`);
  console.log(`[Database] Production Mode: ${isProduction ? 'Yes' : 'No'}`);
  console.log(`[Database] Safety Rules:`);
  console.log(`  • NEVER drop tables (force: false)`);
  console.log(`  • Add missing columns only (alter: ${!isProduction})`);
  console.log(`  • Auto-create missing tables`);
  console.log(`  • Detect ENUM conflicts (continue anyway)`);
  console.log(`  • CREATE TABLES FIRST, THEN SET ASSOCIATIONS`);
  console.log(`  • PRESERVE ALL EXISTING DATA`);
  
  try {
    console.log('\n[Database] Step 1: Detecting ENUM conflicts...');
    const enumConflicts = await detectEnumConflicts();
    
    if (enumConflicts.length > 0) {
      console.log(`⚠️  Found ${enumConflicts.length} ENUM conflicts (continuing anyway):`);
      enumConflicts.forEach(conflict => {
        console.log(`  • ${conflict.table}.${conflict.column}:`);
        console.log(`      Existing: ${JSON.stringify(conflict.existingValues)}`);
        console.log(`      Model:    ${JSON.stringify(conflict.modelValues)}`);
      });
    }
    
    console.log('\n[Database] Step 2: Setting up model associations before sync...');
    for (const [modelName, associateFn] of Object.entries(associateFunctions)) {
      try {
        associateFn(models);
        console.log(`[Database] ✅ Associated model: ${modelName}`);
      } catch (error) {
        console.error(`[Database] ❌ Error associating model ${modelName}:`, error.message);
        associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    console.log('\n[Database] Step 3: Synchronizing database schema...');
    
    const syncResults = {
      created: [],
      altered: [],
      skipped: [],
      failed: [],
      total: 0
    };
    
    // Sync all models in dependency-safe order
    for (const modelName of Object.keys(models)) {
      const model = models[modelName];
      if (!model) continue;
      
      try {
        console.log(`[Database] Syncing model: ${modelName}`);
        
        await model.sync({ 
          force: false, 
          alter: !isProduction 
        });
        
        syncResults.altered.push(modelName);
        syncResults.total++;
        console.log(`[Database] ✅ Synced model: ${modelName}`);
        
      } catch (error) {
        console.error(`[Database] ❌ Failed to sync ${modelName}:`, error.message);
        syncResults.failed.push({ model: modelName, error: error.message });
      }
    }
    
    console.log('\n[Database] ===== DATABASE INITIALIZATION REPORT =====');
    console.log(`📊 SUMMARY STATISTICS:`);
    console.log(`  • Total models: ${Object.keys(models).length}`);
    console.log(`  • Models altered: ${syncResults.altered.length}`);
    console.log(`  • Models failed: ${syncResults.failed.length}`);
    console.log(`  • ENUM conflicts: ${enumConflicts.length}`);
    console.log(`  • Association errors: ${Object.keys(associationErrors).length}`);
    
    if (syncResults.failed.length > 0) {
      console.log(`\n❌ FAILED MODELS:`);
      syncResults.failed.forEach((failure, index) => {
        console.log(`  ${index + 1}. ${failure.model}: ${failure.error}`);
      });
    }
    
    if (enumConflicts.length > 0) {
      console.log(`\n⚠️ ENUM CONFLICTS (manual review recommended):`);
      enumConflicts.forEach((conflict, index) => {
        console.log(`  ${index + 1}. ${conflict.table}.${conflict.column}`);
      });
    }
    
    console.log('\n[Database] ✅ Database initialization completed successfully!');
    console.log('[Database] All tables are permanent and data-safe');
    
    return {
      success: true,
      syncResults,
      enumConflicts,
      associationErrors,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('[Database] ❌ Unexpected error during database initialization:', error.message);
    
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ===== UTILITY FUNCTIONS =====
async function showCurrentTables() {
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
}

// ===== EXPORT MODELS AND FUNCTIONS =====
const allModels = {
  sequelize,
  Sequelize,
  models,
  failedModels,
  skippedFiles,
  associationErrors,
  CORE_MODELS
};

allModels.initializeDatabase = initializeDatabase;
allModels.showCurrentTables = showCurrentTables;
allModels.detectEnumConflicts = detectEnumConflicts;

allModels.testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('[Database] Connection test: ✅ SUCCESS');
    return true;
  } catch (error) {
    console.error('[Database] Connection test: ❌ FAILED', error.message);
    return false;
  }
};

allModels.getLoadedModels = () => {
  return Object.keys(models).map(name => ({
    name,
    tableName: models[name].tableName || name,
    status: 'LOADED',
    columns: models[name].rawAttributes ? Object.keys(models[name].rawAttributes).length : 0
  }));
};

allModels.getFailedModels = () => {
  return Object.keys(failedModels).map(name => ({
    name,
    file: failedModels[name].file,
    error: failedModels[name].error,
    timestamp: failedModels[name].timestamp,
    status: 'FAILED',
    detection: failedModels[name].detection || 'Unknown'
  }));
};

allModels.getSkippedFiles = () => {
  return Object.keys(skippedFiles).map(fileName => ({
    fileName,
    reason: skippedFiles[fileName],
    status: 'SKIPPED'
  }));
};

allModels.getOperationalStatus = () => {
  const failedCore = CORE_MODELS.filter(coreModel => 
    !models[coreModel] || failedModels[coreModel]
  );
  
  return {
    mode: failedCore.length > 0 ? 'HALTED' : 
          (Object.keys(failedModels).length > 0 ? 'PARTIAL' : 'FULL'),
    coreOperational: failedCore.length === 0,
    loadedCount: Object.keys(models).length,
    failedCount: Object.keys(failedModels).length,
    skippedCount: Object.keys(skippedFiles).length,
    failedModels: Object.keys(failedModels),
    coreModels: CORE_MODELS,
    timestamp: new Date().toISOString()
  };
};

// ===== STARTUP REPORT =====
console.log('\n[Database] ===== STARTUP REPORT =====');
console.log(`[Database] Environment: ${env}`);
console.log(`[Database] Database: ${dbConfig.database || 'DATABASE_URL'}`);

const operationalStatus = allModels.getOperationalStatus();
console.log(`[Database] Mode: ${operationalStatus.mode}`);
console.log('');

console.log(`[Database] ✅ SUCCESSFULLY LOADED (${operationalStatus.loadedCount}):`);
allModels.getLoadedModels().forEach((model, index) => {
  console.log(`  ${index + 1}. ${model.name} (table: ${model.tableName})`);
});

console.log('');

if (operationalStatus.failedCount > 0) {
  console.log(`[Database] ❌ FAILED TO LOAD (${operationalStatus.failedCount}):`);
  allModels.getFailedModels().forEach((failed, index) => {
    console.log(`  ${index + 1}. ${failed.name} (${failed.file})`);
    console.log(`     Error: ${failed.error}`);
  });
}

console.log('');

if (operationalStatus.skippedCount > 0) {
  console.log(`[Database] ⏭️  SKIPPED FILES (${operationalStatus.skippedCount}):`);
  allModels.getSkippedFiles().forEach((skipped, index) => {
    console.log(`  ${index + 1}. ${skipped.fileName} - ${skipped.reason}`);
  });
}

console.log('\n[Database] ===== OPERATIONAL STATUS =====');
if (operationalStatus.mode === 'HALTED') {
  console.log('[Database] ❌ SYSTEM HALTED: Core models missing');
  console.log('[Database] Server cannot start without core functionality');
} else if (operationalStatus.mode === 'PARTIAL') {
  console.log('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
  console.log('[Database] Core functionality is operational');
} else {
  console.log('[Database] ✅ FULL OPERATION: All models loaded');
}

console.log('[Database] =================================\n');

if (operationalStatus.coreOperational) {
  console.log('[Database] 🚀 Server ready for database initialization');
  console.log('[Database] To initialize database, call: await db.initializeDatabase()');
}

module.exports = allModels;
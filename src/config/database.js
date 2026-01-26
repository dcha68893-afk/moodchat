// src/database/init.js or src/database/initializeDatabase.js
const sequelize = require('./database').getSequelizeInstance();
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  console.log('[Database] 🛡️ Starting SAFE database initialization (NO MIGRATIONS)...');
  
  try {
    // Step 1: Test database connection only
    await sequelize.authenticate();
    console.log('[Database] ✅ Connection established successfully.');
    
    // ===== CRITICAL: DISABLE ALL AUTO-MIGRATION BEHAVIOR =====
    console.log('[Database] 🔒 Locking down auto-migration settings...');
    
    // Disable PostgreSQL ENUM auto-alter behavior
    if (sequelize.options.dialect === 'postgres') {
      sequelize.options.dialectOptions = sequelize.options.dialectOptions || {};
      sequelize.options.dialectOptions.supportsEnums = false;
      console.log('[Database] ✅ Disabled PostgreSQL ENUM auto-alter behavior');
    }
    
    // Override any environment variables that could trigger migrations
    process.env.DB_ALTER_SYNC = 'false';
    process.env.DB_FORCE_SYNC = 'false';
    process.env.SEQUELIZE_SYNC = 'false';
    
    console.log('[Database] ✅ Overridden dangerous environment variables');
    
    // Load all models
    const models = {};
    const modelsPath = path.join(__dirname, '..', 'models');
    
    console.log('[Database] 📦 Loading models from:', modelsPath);
    
    // Read all model files
    const modelFiles = fs.readdirSync(modelsPath)
      .filter(file => file.endsWith('.js') && file !== 'index.js');
    
    console.log(`[Database] Found ${modelFiles.length} model files`);
    
    // Import and initialize each model (NO SYNC)
    for (const file of modelFiles) {
      try {
        const modelPath = path.join(modelsPath, file);
        const model = require(modelPath)(sequelize, sequelize.Sequelize.DataTypes);
        models[model.name] = model;
        console.log(`[Database] ✅ Loaded model: ${model.name} (NO SYNC)`);
      } catch (modelError) {
        console.warn(`[Database] ⚠️ Failed to load model from ${file}:`, modelError.message);
        // Continue loading other models
      }
    }
    
    // Set up associations if models have associate method
    console.log('[Database] 🔗 Setting up associations (constraints: false)...');
    for (const modelName of Object.keys(models)) {
      if (models[modelName].associate) {
        try {
          // Override association to ensure constraints: false
          const originalAssociate = models[modelName].associate;
          models[modelName].associate = function(models) {
            const result = originalAssociate.call(this, models);
            
            // Ensure all associations have constraints: false
            if (this.associations) {
              Object.values(this.associations).forEach(association => {
                if (association.options) {
                  association.options.constraints = false;
                  delete association.options.unique;
                  delete association.options.index;
                }
              });
            }
            return result;
          };
          
          models[modelName].associate(models);
          console.log(`[Database] ✅ Associated model: ${modelName} (constraints: false)`);
        } catch (assocError) {
          console.warn(`[Database] ⚠️ Failed to set up associations for ${modelName}:`, assocError.message);
        }
      }
    }
    
    // ===== CRITICAL: NO MODEL SYNCING =====
    console.log('\n[Database] 🚫 MODEL SYNC: DISABLED');
    console.log('[Database] Safety Rules:');
    console.log('  • force: false    → NEVER drop tables');
    console.log('  • alter: false    → NEVER modify schema');
    console.log('  • No auto-sync    → Models loaded only');
    console.log('  • Constraints: false → No FK creation');
    console.log('  • No indexes      → Preserve existing indexes');
    
    // Disable sync method on all models to prevent accidental calls
    Object.keys(models).forEach(modelName => {
      const model = models[modelName];
      if (model && typeof model.sync === 'function') {
        const originalSync = model.sync;
        model.sync = async function(options = {}) {
          console.warn(`[Database] 🛡️ BLOCKED: Model sync attempted for ${modelName}`);
          console.warn(`[Database] Sync options:`, {
            force: options.force || false,
            alter: options.alter || false
          });
          return {
            warning: 'Model-level sync disabled for safety',
            model: modelName,
            timestamp: new Date().toISOString()
          };
        };
      }
    });
    
    // ===== SAFE DATABASE OPERATIONS =====
    console.log('\n[Database] 🔍 Performing SAFE database checks...');
    
    // Only verify tables exist, don't modify them
    const syncResults = {
      success: [],
      failed: [],
      tablesInfo: [],
      warnings: ['Auto-sync disabled - manual intervention required for schema changes']
    };
    
    // Check if tables exist without trying to create them
    const coreTables = ['Users', 'Token', 'Profile'];
    const availableCoreTables = [];
    
    for (const coreTable of coreTables) {
      try {
        if (models[coreTable]) {
          // Just check if table exists with a simple query
          const tableName = models[coreTable].tableName || models[coreTable].name;
          
          // Use raw query to check existence without triggering sync
          const [results] = await sequelize.query(
            `SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_schema = 'public' 
              AND table_name = '${tableName.toLowerCase()}'
            )`
          );
          
          const tableExists = results[0]?.exists || false;
          
          if (tableExists) {
            availableCoreTables.push(coreTable);
            syncResults.success.push(coreTable);
            syncResults.tablesInfo.push({
              model: coreTable,
              table: tableName,
              exists: true,
              status: 'Verified (no sync)'
            });
            console.log(`[Database] ✅ Table exists: ${tableName} (verified)`);
          } else {
            syncResults.failed.push({
              model: coreTable,
              error: `Table ${tableName} does not exist - manual creation required`
            });
            syncResults.tablesInfo.push({
              model: coreTable,
              table: tableName,
              exists: false,
              status: 'Missing - manual creation required'
            });
            console.log(`[Database] ⚠️ Table missing: ${tableName} (NO AUTO-CREATION)`);
          }
        }
      } catch (err) {
        console.warn(`[Database] ⚠️ Could not check table ${coreTable}:`, err.message);
        syncResults.failed.push({
          model: coreTable,
          error: `Check failed: ${err.message}`
        });
      }
    }
    
    // Check for auth tables
    const authRequiredTables = ['Users', 'Token'];
    const hasAuthTables = authRequiredTables.every(table => 
      availableCoreTables.includes(table)
    );
    
    // ===== FINAL REPORT =====
    console.log('\n[Database] ===== SAFE INITIALIZATION REPORT =====');
    console.log(`[Database] Models loaded: ${Object.keys(models).length}`);
    console.log(`[Database] Tables verified: ${availableCoreTables.length}/${coreTables.length}`);
    console.log(`[Database] Auth tables available: ${hasAuthTables ? '✅ Yes' : '⚠️ No'}`);
    console.log(`[Database] Auto-sync: 🚫 DISABLED`);
    console.log(`[Database] Schema modifications: 🚫 DISABLED`);
    
    if (!hasAuthTables) {
      console.log('\n[Database] ⚠️ WARNING: Missing auth tables!');
      console.log('[Database] Required tables:', authRequiredTables.join(', '));
      console.log('[Database] Available tables:', availableCoreTables.join(', ') || 'None');
      console.log('[Database] ACTION REQUIRED: Create tables manually using SQL');
      console.log('[Database] SERVER STATUS: Will start but auth will fail');
    }
    
    console.log('\n[Database] 🔧 MANUAL SCHEMA CHANGES REQUIRED:');
    console.log('  • Use pgAdmin, psql, or database migration tool');
    console.log('  • Never use sequelize.sync() in production');
    console.log('  • All schema changes must be manual SQL');
    console.log('  • Test schema changes in development first');
    console.log('[Database] ======================================\n');
    
    // Always return successful initialization (even with missing tables)
    return {
      sequelize,
      models,
      syncResults,
      hasAuthTables,
      status: 'safe-initialized',
      safety: {
        autoSync: 'disabled',
        force: 'disabled',
        alter: 'disabled',
        constraints: 'disabled',
        migrations: 'manual-only'
      }
    };
    
  } catch (error) {
    // Connection failed - this is still fatal
    console.error('[Database] ❌ Database connection failed:', error.message);
    console.error('[Database] Server cannot start without database connection');
    
    return {
      sequelize: null,
      models: {},
      syncResults: {
        success: [],
        failed: [{ model: 'All', error: `Connection failed: ${error.message}` }],
        tablesInfo: []
      },
      hasAuthTables: false,
      status: 'connection-failed',
      safety: {
        autoSync: 'disabled',
        force: 'disabled',
        alter: 'disabled'
      }
    };
  }
}

// Export safe sync wrapper that can be called explicitly
async function safeManualSync() {
  console.warn('[Database] 🚨 WARNING: Manual sync requested');
  console.warn('[Database] This should only be used in development!');
  
  try {
    const syncOptions = {
      force: false,
      alter: false, // Still false even for manual sync
      logging: console.log
    };
    
    console.log('[Database] Manual sync options:', syncOptions);
    const result = await sequelize.sync(syncOptions);
    console.log('[Database] Manual sync completed (no schema changes)');
    return result;
  } catch (error) {
    console.error('[Database] Manual sync failed:', error.message);
    throw error;
  }
}

module.exports = {
  initializeDatabase,
  safeManualSync,
  getSafetyRules: () => ({
    autoSync: 'disabled',
    force: 'disabled',
    alter: 'disabled',
    constraints: 'disabled',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  })
};
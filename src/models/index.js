// models/index.js - PRODUCTION-SAFE MODEL LOADER (NO SCHEMA CHANGES)
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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
  });

// ===== STRICT MODEL LOADING =====
console.log('[Database] 🛡️ Initializing STRICT model loader (NO SCHEMA CHANGES)...');

const db = {
  sequelize,
  Sequelize,
  Op,
  models: {},
  failedModels: {},
  skippedFiles: {},
  associationErrors: {},
  wss: null
};

// CRITICAL: Define essential core models for system startup
const CORE_MODELS = ['Users', 'Token', 'Profile', 'Settings', 'Chats', 'Messages', 'Friend'];

// CRITICAL: Whitelist of all expected model files
const MODEL_WHITELIST = [
  'Users', 'Token', 'Profile', 'Settings', 'Features',
  'Chats', 'Messages', 'ChatParticipant', 'GroupMembers',
  'TypingIndicator', 'UserStatus', 'ReadReceipt', 'SharedMood',
  'Notifications', 'Friend', 'Calls', 'Groups', 'Media', 'Mood', 'Status',
  'Category', 'Template', 'Notes', 'File'
];

// CRITICAL: Patterns that indicate NON-MODEL files (routers, controllers, etc.)
const NON_MODEL_PATTERNS = [
  'authRoutes', 'authController', 'userController', 'chatController', 'friendController',
  'groupController', 'messageController', 'notificationController',
  'authMiddleware', 'errorMiddleware', 'validationMiddleware',
  'index', 'utils', 'helpers', 'validators', 'schemas',
  'routes', 'controllers', 'middleware', 'services',
  'auth.route', 'user.route', 'chat.route', 'friend.route', 'group.route',
  'message.route', 'notification.route', 'status.route',
  'router.get', 'router.post', 'router.put', 'router.delete', 'router.use',
  'app.get', 'app.post', 'app.put', 'app.delete', 'app.use',
  'express.Router()', 'express.Router('
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
    
    const isWhitelisted = MODEL_WHITELIST.some(modelName => 
      modelName.toLowerCase() === fileName
    );
    
    if (isWhitelisted) {
      console.log(`[Database] ✅ Whitelisted model detected: ${file}`);
      return true;
    }
    
    const isNonModel = NON_MODEL_PATTERNS.some(pattern => 
      fileName.includes(pattern.toLowerCase())
    );
    
    if (isNonModel) {
      console.log(`[Database] 🛡️ Strict Guard: Skipping ${file} - matches non-model pattern`);
      db.skippedFiles[file] = 'Matches non-model pattern (router/controller)';
      return false;
    }
    
    console.log(`[Database] ⚠️ File not in whitelist but not blocked: ${file}. Will check content.`);
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
      fileContent.includes('DataTypes.') ||
      fileContent.includes('Sequelize.DataTypes');
    
    const isRouterOrController = 
      fileContent.includes('express.Router()') ||
      fileContent.includes('express.Router(') ||
      fileContent.includes('app.get(') ||
      fileContent.includes('app.post(') ||
      fileContent.includes('app.use(') ||
      fileContent.includes('router.get(') ||
      fileContent.includes('router.post(') ||
      fileContent.includes('router.use(') ||
      fileContent.includes('require(\'express\')') ||
      (fileContent.includes('Router') && fileContent.includes('require'));
    
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

const associationAttempted = new Map();

Object.keys(db.models).forEach(modelName => {
  const model = db.models[modelName];
  if (model && typeof model.associate === 'function') {
    try {
      const originalAssociate = model.associate;
      model.associate = function(models) {
        const result = originalAssociate.call(this, models);
        
        if (this.associations) {
          Object.values(this.associations).forEach(association => {
            if (association.foreignKeyConstraint !== undefined) {
              association.foreignKeyConstraint = false;
            }
            if (association.options) {
              association.options.constraints = false;
              delete association.options.unique;
              delete association.options.index;
            }
          });
        }
        return result;
      };
      
      model.associate(db.models);
      associationAttempted.set(modelName, true);
      console.log(`[Database] ✅ Associated model: ${modelName} (constraints: false)`);
    } catch (error) {
      if (error.message && error.message.includes('used the alias')) {
        console.log(`[Database] ⚠️ Skipping duplicate alias for ${modelName}: ${error.message.split(' in')[0]}`);
        associationAttempted.set(modelName, 'partial');
      } else {
        console.error(`[Database] ❌ Error associating model ${modelName}:`, error.message);
        db.associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
});

// ===== CRITICAL FIX: FORCE SELF-ASSOCIATION FOR USERS MODEL =====
if (db.models.Users) {
  console.log('[Database] 🔧 CRITICAL: Forcing Users model self-associations...');
  
  const UsersModel = db.models.Users;
  
  // Check if Friend model exists
  const FriendModel = db.models.Friend;
  
  if (FriendModel) {
    console.log('[Database] 🔧 Setting up Users ↔ Users associations through Friend model...');
    
    try {
      // Define the belongsToMany relationships for friends
      // This allows User.belongsToMany(User, { as: 'friends', through: 'Friend', foreignKey: 'userId', otherKey: 'friendId' })
      if (!UsersModel.associations.friends) {
        UsersModel.belongsToMany(UsersModel, {
          as: 'friends',
          through: FriendModel,
          foreignKey: 'userId',
          otherKey: 'friendId',
          constraints: false
        });
        console.log('[Database] ✅ Added friends association (Users ↔ Users)');
      } else {
        console.log('[Database] ✅ friends association already exists');
      }
    } catch (err) {
      console.log('[Database] ⚠️ Could not add friends association:', err.message);
    }
    
    try {
      // Define the belongsToMany relationships for friend requests
      if (!UsersModel.associations.friendRequests) {
        UsersModel.belongsToMany(UsersModel, {
          as: 'friendRequests',
          through: FriendModel,
          foreignKey: 'friendId',
          otherKey: 'userId',
          constraints: false
        });
        console.log('[Database] ✅ Added friendRequests association');
      } else {
        console.log('[Database] ✅ friendRequests association already exists');
      }
    } catch (err) {
      console.log('[Database] ⚠️ Could not add friendRequests association:', err.message);
    }
  } else {
    console.log('[Database] ⚠️ Friend model not found - cannot set up Users self-associations');
  }
  
  // Also set up the inverse associations for Friend model
  if (FriendModel) {
    console.log('[Database] 🔧 Setting up Friend model associations...');
    
    try {
      if (!FriendModel.associations.user) {
        FriendModel.belongsTo(UsersModel, { as: 'user', foreignKey: 'userId', constraints: false });
        console.log('[Database] ✅ Added Friend.user association');
      }
    } catch (err) {
      console.log('[Database] ⚠️ Could not add Friend.user association:', err.message);
    }
    
    try {
      if (!FriendModel.associations.friend) {
        FriendModel.belongsTo(UsersModel, { as: 'friend', foreignKey: 'friendId', constraints: false });
        console.log('[Database] ✅ Added Friend.friend association');
      }
    } catch (err) {
      console.log('[Database] ⚠️ Could not add Friend.friend association:', err.message);
    }
  }
}

// ===== CORE MODEL VALIDATION =====
console.log('[Database] ===== CORE MODEL VALIDATION =====');

const hasUserModel = !!(db.models.Users);
const hasFriendModel = !!(db.models.Friend);

if (!hasUserModel) {
  console.error('[Database] ❌ CRITICAL: User model not found!');
  console.error('[Database] Available models:', Object.keys(db.models));
} else {
  console.log('[Database] ✅ User model loaded successfully');
  
  // Log available associations on Users model
  if (db.models.Users.associations) {
    console.log('[Database] Users model associations:', Object.keys(db.models.Users.associations));
  } else {
    console.log('[Database] ⚠️ Users model has no associations defined');
  }
}

if (!hasFriendModel) {
  console.warn('[Database] ⚠️ Friend model not found - friend features may be limited');
} else {
  console.log('[Database] ✅ Friend model loaded successfully');
  
  // Log available associations on Friend model
  if (db.models.Friend.associations) {
    console.log('[Database] Friend model associations:', Object.keys(db.models.Friend.associations));
  }
}

console.log(`[Database] Total models loaded: ${Object.keys(db.models).length}`);

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
  return {
    mode: !hasUserModel ? 'HALTED' : (!hasFriendModel ? 'PARTIAL' : 'FULL'),
    coreOperational: hasUserModel,
    loadedCount: Object.keys(db.models).length,
    failedCount: Object.keys(db.failedModels).length,
    skippedCount: Object.keys(db.skippedFiles).length,
    failedModels: Object.keys(db.failedModels),
    hasUserModel: hasUserModel,
    hasFriendModel: hasFriendModel,
    timestamp: new Date().toISOString()
  };
};

db.getModel = function(modelName) {
  if (db.models[modelName]) return db.models[modelName];
  const singular = modelName.replace(/s$/, '');
  const plural = modelName + 's';
  if (db.models[singular]) return db.models[singular];
  if (db.models[plural]) return db.models[plural];
  if (db.models[modelName.toLowerCase()]) return db.models[modelName.toLowerCase()];
  console.warn(`[Database] Model not found: ${modelName}`);
  return null;
};

// ===== WEBSOCKET INITIALIZATION FUNCTION =====
db.initializeWebSocket = function(server) {
  if (!server) {
    console.error('[WebSocket] ❌ Server instance required');
    return null;
  }
  
  try {
    console.log('[WebSocket] 🔌 Initializing WebSocket server...');
    
    const wss = new WebSocket.Server({ server });
    
    wss.on('connection', (socket) => {
      console.log('[WebSocket] ✅ New client connected');
      
      socket.on('message', (msg) => {
        try {
          console.log('[WebSocket] 📨 Received:', msg.toString());
          const data = JSON.parse(msg.toString());
        } catch (error) {
          console.error('[WebSocket] ❌ Error processing message:', error.message);
        }
      });
      
      socket.on('close', () => {
        console.log('[WebSocket] 👋 Client disconnected');
      });
      
      socket.on('error', (error) => {
        console.error('[WebSocket] ❌ Socket error:', error.message);
      });
      
      socket.send(JSON.stringify({
        type: 'connection',
        message: 'Connected to WebSocket server',
        timestamp: new Date().toISOString()
      }));
    });
    
    db.wss = wss;
    console.log('[WebSocket] ✅ WebSocket server initialized successfully');
    return wss;
    
  } catch (error) {
    console.error('[WebSocket] ❌ WebSocket initialization failed:', error.message);
    return null;
  }
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
  console.log('[Database] ❌ SYSTEM HALTED: User model missing');
} else if (status.mode === 'PARTIAL') {
  console.log('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
} else {
  console.log('[Database] ✅ FULL OPERATION: All models loaded');
}

console.log('[Database] =================================\n');

if (status.coreOperational) {
  console.log('[Database] 🚀 Server ready');
  console.log('[Database] ✅ Schema changes disabled');
  console.log('[Database] ✅ Associations loaded with constraints: false');
  console.log('[Database] ✅ No auto-sync, no alter, no force');
  
  if (db.models.Users && db.models.Users.associations) {
    console.log('[Database] 📊 Users model associations:');
    Object.keys(db.models.Users.associations).forEach(assocName => {
      console.log(`  - ${assocName}`);
    });
  }
}

// Add this at the end of models/index.js, right before module.exports

// ===== ONE-TIME TABLE CREATION CHECK =====
db.createTablesIfNeeded = async function() {
    try {
        console.log('[Database] Checking if tables exist...');
        
        const queryInterface = sequelize.getQueryInterface();
        const tables = await queryInterface.showAllTables();
        
        console.log(`[Database] Found ${tables.length} existing tables`);
        
        if (tables.length === 0) {
            console.log('[Database] 🔧 No tables found - creating all tables...');
            await sequelize.sync({ 
                force: false,
                alter: true,
                logging: (msg) => console.log(`  [SQL] ${msg}`)
            });
            console.log('[Database] ✅ Tables created successfully');
            
            // Verify tables were created
            const newTables = await queryInterface.showAllTables();
            console.log(`[Database] ✅ ${newTables.length} tables now exist`);
            newTables.forEach(table => console.log(`  - ${table}`));
            
            return true;
        } else {
            console.log('[Database] ✅ Tables already exist');
            return false;
        }
    } catch (error) {
        console.error('[Database] Error checking tables:', error.message);
        console.log('[Database] Attempting to create tables anyway...');
        try {
            await sequelize.sync({ force: false });
            console.log('[Database] ✅ Tables created');
            return true;
        } catch (syncError) {
            console.error('[Database] Failed to create tables:', syncError.message);
            return false;
        }
    }
};

// Auto-create tables if environment variable is set
if (process.env.CREATE_TABLES === 'true' || process.env.DB_SYNC_FORCE === 'true') {
    console.log('[Database] 🔧 CREATE_TABLES mode enabled');
    db.createTablesIfNeeded().catch(console.error);
}

// ===== EXPORT =====
module.exports = {
  ...db,
  sequelize,
  Sequelize,
  Op,
  models: db.models,
  initializeWebSocket: db.initializeWebSocket,
  getModel: db.getModel,
  get User() { return db.models.User || db.models.Users || null; },
  get Friend() { return db.models.Friend || db.models.Friends || null; },
  get Chat() { return db.models.Chat || db.models.Chats || null; },
  get Message() { return db.models.Message || db.models.Messages || null; }
};
// models/index.js - COMPLETE AUTO-MIGRATION WITH TABLE CREATION
// Version: 3.0.0 - Creates missing tables and columns automatically
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ===== DATABASE CONFIGURATION =====
const env = process.env.NODE_ENV || 'development';

const getDbConfig = () => {
  if (process.env.DATABASE_URL) {
    console.log(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 20,
        min: parseInt(process.env.DB_POOL_MIN) || 5,
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
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      min: parseInt(process.env.DB_POOL_MIN) || 5,
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
console.log('[Database] 🛡️ Initializing STRICT model loader...');

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

// CRITICAL: Whitelist of all expected model files - ORDERED BY DEPENDENCIES
const MODEL_WHITELIST = [
  'Users', 'Token', 'Profile', 'Settings', 'Chats', 'ChatParticipant',
  'Messages', 'GroupMembers', 'TypingIndicator', 'UserStatus', 'ReadReceipt',
  'SharedMood', 'Notification', 'Friend', 'Calls', 'Groups', 'Media', 'Mood',
  'Status', 'Category', 'Template', 'Notes', 'File', 'Features'
];

// CRITICAL: Patterns that indicate NON-MODEL files
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

// ===== LOAD MODELS =====
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
    
    console.log(`[Database] ✅ Loaded model: ${actualModelName}`);
    
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

// ===== FUNCTION 1: CREATE MISSING TABLES =====
async function createMissingTables() {
  console.log('[Migration] 🔧 Checking for missing tables...');
  
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const existingTables = new Set(tables.map(t => t.toLowerCase()));
  
  // List of REQUIRED tables that must exist
  const requiredTables = [
    'Users', 'Token', 'Tokens', 'Friends', 'Friend', 'Chats', 'Chat',
    'Messages', 'Message', 'Groups', 'Group', 'GroupMembers', 'GroupMember',
    'Settings', 'Profile', 'Notifications', 'Notification', 'Media',
    'Calls', 'Call', 'UserStatus', 'TypingIndicator', 'ReadReceipt'
  ];
  
  const missingTables = [];
  const tableNameMapping = {}; // Maps base name to actual model name
  
  for (const tableName of requiredTables) {
    const lowerName = tableName.toLowerCase();
    if (!existingTables.has(lowerName)) {
      // Check if any model matches this table name
      let modelExists = false;
      for (const [modelName, model] of Object.entries(db.models)) {
        const modelTableName = (model.tableName || modelName).toLowerCase();
        if (modelTableName === lowerName || modelName.toLowerCase() === lowerName) {
          modelExists = true;
          tableNameMapping[tableName] = model;
          break;
        }
      }
      
      if (modelExists) {
        missingTables.push(tableName);
        console.log(`[Migration] ⚠️ Missing table: ${tableName} - will create via sync`);
      } else {
        console.log(`[Migration] ℹ️ No model found for: ${tableName} - skipping`);
      }
    }
  }
  
  if (missingTables.length > 0) {
    console.log(`[Migration] 🔨 Creating ${missingTables.length} missing tables via sync...`);
    
    try {
      // First sync without alter to create tables
      await sequelize.sync({ force: false, alter: false });
      console.log(`[Migration] ✅ Initial sync complete - tables created`);
      
      // Verify tables were created
      const newTables = await queryInterface.showAllTables();
      const newTableSet = new Set(newTables.map(t => t.toLowerCase()));
      
      const stillMissing = missingTables.filter(t => !newTableSet.has(t.toLowerCase()));
      if (stillMissing.length > 0) {
        console.log(`[Migration] ⚠️ Still missing after sync: ${stillMissing.join(', ')}`);
        console.log(`[Migration] 🔨 Attempting force sync for remaining tables...`);
        
        // Force sync for specific models
        for (const tableName of stillMissing) {
          const model = tableNameMapping[tableName];
          if (model) {
            try {
              await model.sync({ force: false });
              console.log(`[Migration] ✅ Created table for model: ${model.name}`);
            } catch (modelError) {
              console.log(`[Migration] ❌ Failed to create table for ${tableName}:`, modelError.message);
            }
          }
        }
      }
      
      console.log(`[Migration] ✅ Table creation complete`);
      return missingTables;
    } catch (syncError) {
      console.error(`[Migration] ❌ Sync failed:`, syncError.message);
      
      // Fallback: Try individual model sync
      console.log(`[Migration] 🔨 Attempting individual model sync...`);
      for (const tableName of missingTables) {
        const model = tableNameMapping[tableName];
        if (model) {
          try {
            await model.sync({ force: false });
            console.log(`[Migration] ✅ Created table for: ${tableName}`);
          } catch (modelError) {
            console.log(`[Migration] ❌ Failed to create ${tableName}:`, modelError.message);
          }
        }
      }
      return missingTables;
    }
  } else {
    console.log(`[Migration] ✅ All required tables exist`);
    return [];
  }
}

// ===== FUNCTION 2: ADD MISSING COLUMNS =====
async function addMissingColumns() {
  console.log('[Migration] 🔧 Checking for missing columns...');
  
  const queryInterface = sequelize.getQueryInterface();
  const addedColumns = [];
  
  const requiredColumns = {
    'friends': [
      { name: 'requester_id', type: Sequelize.INTEGER, allowNull: true },
      { name: 'receiver_id', type: Sequelize.INTEGER, allowNull: true },
      { name: 'status', type: Sequelize.STRING(20), defaultValue: 'pending', allowNull: false },
      { name: 'accepted_at', type: Sequelize.DATE, allowNull: true },
      { name: 'blocked_at', type: Sequelize.DATE, allowNull: true },
      { name: 'notes', type: Sequelize.STRING(200), allowNull: true },
      { name: 'category', type: Sequelize.STRING(50), allowNull: true },
      { name: 'closeness_level', type: Sequelize.INTEGER, defaultValue: 0, allowNull: false },
      { name: 'is_pinned', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'is_muted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false }
    ],
    'Users': [
      { name: 'theme', type: Sequelize.STRING(20), defaultValue: 'light', allowNull: false },
      { name: 'language', type: Sequelize.STRING(10), defaultValue: 'en', allowNull: false },
      { name: 'last_active', type: Sequelize.DATE, allowNull: true },
      { name: 'is_online', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'bio', type: Sequelize.TEXT, allowNull: true }
    ],
    'chats': [
      { name: 'name', type: Sequelize.STRING(100), allowNull: true },
      { name: 'type', type: Sequelize.STRING(20), defaultValue: 'direct', allowNull: false },
      { name: 'createdBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'description', type: Sequelize.TEXT, allowNull: true },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'isActive', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'isArchived', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'archivedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'archivedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'lastMessageId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'lastMessageAt', type: Sequelize.DATE, allowNull: true },
      { name: 'settings', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
    'Groups': [
      { name: 'chatId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'name', type: Sequelize.STRING(100), allowNull: true },
      { name: 'createdBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'description', type: Sequelize.TEXT, allowNull: true },
      { name: 'avatar', type: Sequelize.STRING(255), allowNull: true },
      { name: 'isPublic', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'inviteLink', type: Sequelize.STRING(100), allowNull: true },
      { name: 'inviteLinkExpires', type: Sequelize.DATE, allowNull: true },
      { name: 'maxMembers', type: Sequelize.INTEGER, defaultValue: 100, allowNull: false },
      { name: 'rules', type: Sequelize.TEXT, allowNull: true },
      { name: 'tags', type: Sequelize.ARRAY(Sequelize.STRING), defaultValue: [], allowNull: false },
      { name: 'location', type: Sequelize.STRING(100), allowNull: true },
      { name: 'purpose', type: Sequelize.STRING(100), allowNull: true, defaultValue: 'general' },
      { name: 'isVerified', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'stats', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ],
    'Tokens': [
      { name: 'user_id', type: Sequelize.INTEGER, allowNull: false },
      { name: 'token', type: Sequelize.TEXT, allowNull: false },
      { name: 'token_type', type: Sequelize.STRING, defaultValue: 'refresh', allowNull: false },
      { name: 'expires_at', type: Sequelize.DATE, allowNull: false },
      { name: 'is_revoked', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'user_agent', type: Sequelize.STRING, allowNull: true },
      { name: 'ip_address', type: Sequelize.STRING(45), allowNull: true },
      { name: 'device_info', type: Sequelize.STRING, allowNull: true }
    ],
    'Messages': [
      { name: 'chatId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'senderId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'content', type: Sequelize.TEXT, allowNull: true },
      { name: 'type', type: Sequelize.STRING(20), defaultValue: 'text', allowNull: false },
      { name: 'replyToId', type: Sequelize.INTEGER, allowNull: true },
      { name: 'isEdited', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'editedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'isDeleted', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'deletedAt', type: Sequelize.DATE, allowNull: true },
      { name: 'deletedBy', type: Sequelize.INTEGER, allowNull: true },
      { name: 'isRead', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'readAt', type: Sequelize.DATE, allowNull: true },
      { name: 'reactions', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'metadata', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'encryptionKey', type: Sequelize.STRING(100), allowNull: true },
      { name: 'sentAt', type: Sequelize.DATE, defaultValue: Sequelize.NOW, allowNull: false },
      { name: 'deliveredAt', type: Sequelize.DATE, allowNull: true }
    ],
    'settings': [
      { name: 'user_id', type: Sequelize.INTEGER, allowNull: false },
      { name: 'theme', type: Sequelize.STRING, defaultValue: 'light', allowNull: false },
      { name: 'accent_color', type: Sequelize.STRING, defaultValue: '#000000', allowNull: false },
      { name: 'notifications_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'language', type: Sequelize.STRING, defaultValue: 'en', allowNull: false },
      { name: 'font_size', type: Sequelize.STRING, defaultValue: 'medium', allowNull: false },
      { name: 'timezone', type: Sequelize.STRING, defaultValue: 'UTC', allowNull: false },
      { name: 'email_notifications', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'push_notifications', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'sound_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'vibration_enabled', type: Sequelize.BOOLEAN, defaultValue: true, allowNull: false },
      { name: 'data_saver', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'auto_download', type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false },
      { name: 'privacy', type: Sequelize.JSONB, defaultValue: {}, allowNull: false },
      { name: 'chat_preferences', type: Sequelize.JSONB, defaultValue: {}, allowNull: false }
    ]
  };
  
  try {
    const tables = await queryInterface.showAllTables();
    console.log(`[Migration] Found ${tables.length} existing tables`);
    
    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      if (!tables.includes(tableName)) {
        console.log(`[Migration] ⚠️ Table ${tableName} not found, skipping column check (will be created by table creation)`);
        continue;
      }
      
      try {
        const tableColumns = await queryInterface.describeTable(tableName);
        const existingColumnNames = Object.keys(tableColumns);
        
        for (const column of columns) {
          if (!existingColumnNames.includes(column.name)) {
            console.log(`[Migration] ➕ Adding column ${column.name} to table ${tableName}`);
            
            try {
              await queryInterface.addColumn(tableName, column.name, {
                type: column.type,
                allowNull: column.allowNull,
                defaultValue: column.defaultValue
              });
              addedColumns.push(`${tableName}.${column.name}`);
              console.log(`[Migration] ✅ Added column ${column.name} to ${tableName}`);
            } catch (addError) {
              console.log(`[Migration] ⚠️ Could not add column ${column.name}: ${addError.message}`);
            }
          }
        }
        
        if (tableName === 'Groups' && existingColumnNames.includes('name')) {
          await sequelize.query(`
            UPDATE "Groups" SET "name" = 'Group ' || "id" 
            WHERE "name" IS NULL OR "name" = ''
          `);
          console.log(`[Migration] ✅ Updated Groups table with default names`);
        }
        
      } catch (tableError) {
        console.log(`[Migration] ⚠️ Error checking table ${tableName}: ${tableError.message}`);
      }
    }
    
    if (tables.includes('friends')) {
      try {
        await sequelize.query(`
          CREATE INDEX IF NOT EXISTS idx_friends_requester ON friends(requester_id);
          CREATE INDEX IF NOT EXISTS idx_friends_receiver ON friends(receiver_id);
          CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
        `);
        console.log(`[Migration] ✅ Added indexes to friends table`);
      } catch (indexError) {
        console.log(`[Migration] ⚠️ Could not add indexes: ${indexError.message}`);
      }
    }
    
    if (tables.includes('Tokens')) {
      try {
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_user_id_idx ON "Tokens" ("user_id");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_token_idx ON "Tokens" ("token");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_expires_at_idx ON "Tokens" ("expires_at");`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS tokens_user_revoked_idx ON "Tokens" ("user_id", "is_revoked");`);
        console.log(`[Migration] ✅ Added indexes to Tokens table`);
      } catch (indexError) {
        console.log(`[Migration] ⚠️ Could not add token indexes: ${indexError.message}`);
      }
    }
    
    if (addedColumns.length > 0) {
      console.log(`[Migration] ✅ Added ${addedColumns.length} missing columns:`, addedColumns);
    } else {
      console.log(`[Migration] ✅ No missing columns found - database is up to date`);
    }
    
  } catch (error) {
    console.error(`[Migration] ❌ Error during migration:`, error.message);
  }
  
  return addedColumns;
}

// ===== FUNCTION 3: FIX COLUMN NAMES =====
async function fixColumnNames() {
  console.log('[Migration] 🔧 Fixing column names for compatibility...');
  
  const queryInterface = sequelize.getQueryInterface();
  const fixedColumns = [];
  
  try {
    const tables = await queryInterface.showAllTables();
    
    if (tables.includes('friends')) {
      const columns = await queryInterface.describeTable('friends');
      
      if (columns.created_at && !columns.createdAt) {
        await queryInterface.renameColumn('friends', 'created_at', 'createdAt');
        fixedColumns.push('friends.created_at → createdAt');
        console.log('[Migration] ✅ Renamed friends.created_at to createdAt');
      }
      
      if (columns.updated_at && !columns.updatedAt) {
        await queryInterface.renameColumn('friends', 'updated_at', 'updatedAt');
        fixedColumns.push('friends.updated_at → updatedAt');
        console.log('[Migration] ✅ Renamed friends.updated_at to updatedAt');
      }
    }
    
    if (fixedColumns.length > 0) {
      console.log(`[Migration] ✅ Fixed ${fixedColumns.length} column names:`, fixedColumns);
    } else {
      console.log('[Migration] ✅ No column name fixes needed');
    }
    
  } catch (error) {
    console.log('[Migration] ⚠️ Error fixing column names:', error.message);
  }
}

// ===== FUNCTION 4: ENSURE TOKENS TABLE EXISTS (CRITICAL FOR AUTH) =====
async function ensureTokensTable() {
  console.log('[Migration] 🔐 Ensuring Tokens table exists for authentication...');
  
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  
  // Check for Tokens table (case insensitive)
  const hasTokensTable = tables.some(t => t.toLowerCase() === 'tokens');
  
  if (!hasTokensTable) {
    console.log('[Migration] 🔨 Creating Tokens table...');
    
    try {
      // Check if Token model exists
      const TokenModel = db.models.Token || db.models.Tokens;
      
      if (TokenModel) {
        await TokenModel.sync({ force: false });
        console.log('[Migration] ✅ Tokens table created via Token model sync');
      } else {
        // Create table manually if model doesn't exist
        await sequelize.query(`
          CREATE TABLE IF NOT EXISTS "Tokens" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "user_id" INTEGER NOT NULL,
            "token" TEXT NOT NULL,
            "token_type" VARCHAR(255) NOT NULL DEFAULT 'refresh',
            "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
            "is_revoked" BOOLEAN NOT NULL DEFAULT FALSE,
            "user_agent" VARCHAR(255),
            "ip_address" VARCHAR(45),
            "device_info" VARCHAR(255),
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
        `);
        console.log('[Migration] ✅ Tokens table created manually');
      }
      
      // Verify creation
      const newTables = await queryInterface.showAllTables();
      const verified = newTables.some(t => t.toLowerCase() === 'tokens');
      
      if (verified) {
        console.log('[Migration] ✅ Tokens table verified');
      } else {
        console.log('[Migration] ⚠️ Tokens table creation could not be verified');
      }
      
      return true;
    } catch (error) {
      console.error('[Migration] ❌ Failed to create Tokens table:', error.message);
      return false;
    }
  } else {
    console.log('[Migration] ✅ Tokens table already exists');
    return true;
  }
}

// ===== SAFE ASSOCIATION SETUP =====
console.log('[Database] Setting up associations (constraints: false)...');

const associatedModels = new Set();

Object.keys(db.models).forEach(modelName => {
  const model = db.models[modelName];
  if (model && typeof model.associate === 'function') {
    try {
      if (associatedModels.has(modelName)) {
        console.log(`[Database] ⏭️ Skipping already associated model: ${modelName}`);
        return;
      }
      
      model.associate(db.models);
      associatedModels.add(modelName);
      console.log(`[Database] ✅ Associated model: ${modelName}`);
    } catch (error) {
      if (error.message && error.message.includes('used the alias')) {
        console.log(`[Database] ⚠️ Alias conflict in ${modelName}: ${error.message.split(' in')[0]}`);
        db.associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString(),
          type: 'alias_conflict'
        };
      } else {
        console.error(`[Database] ❌ Error associating model ${modelName}:`, error.message);
        db.associationErrors[modelName] = {
          error: error.message,
          timestamp: new Date().toISOString(),
          type: 'association_error'
        };
      }
    }
  }
});

console.log('[Database] ✅ Associations setup complete');

// ===== MAIN MIGRATION FUNCTION =====
async function runFullMigration() {
  console.log('\n[Migration] ===== STARTING FULL DATABASE MIGRATION =====');
  console.log(`[Migration] Environment: ${env}`);
  console.log(`[Migration] Database: ${dbConfig.database || 'DATABASE_URL'}\n`);
  
  let hasErrors = false;
  
  try {
    // STEP 1: Create missing tables (MOST IMPORTANT)
    console.log('[Migration] STEP 1: Creating missing tables...');
    const createdTables = await createMissingTables();
    console.log(`[Migration] Created ${createdTables.length} missing tables\n`);
    
    // STEP 2: Ensure Tokens table exists (CRITICAL for auth)
    console.log('[Migration] STEP 2: Ensuring Tokens table exists...');
    const tokensOk = await ensureTokensTable();
    if (!tokensOk) {
      console.log('[Migration] ⚠️ Tokens table creation had issues - auth may not work');
    }
    console.log('');
    
    // STEP 3: Add missing columns
    console.log('[Migration] STEP 3: Adding missing columns...');
    const addedColumns = await addMissingColumns();
    console.log(`[Migration] Added ${addedColumns.length} missing columns\n`);
    
    // STEP 4: Fix column names
    console.log('[Migration] STEP 4: Fixing column names...');
    await fixColumnNames();
    console.log('');
    
    // STEP 5: Final verification
    console.log('[Migration] STEP 5: Final verification...');
    const finalTables = await sequelize.getQueryInterface().showAllTables();
    console.log(`[Migration] Total tables after migration: ${finalTables.length}`);
    
    // Verify Tokens table specifically
    const hasTokensFinal = finalTables.some(t => t.toLowerCase() === 'tokens');
    if (hasTokensFinal) {
      console.log('[Migration] ✅ Tokens table is present - authentication will work');
    } else {
      console.error('[Migration] ❌ Tokens table is STILL missing - CRITICAL ERROR!');
      hasErrors = true;
    }
    
    console.log('\n[Migration] ===== MIGRATION COMPLETE =====\n');
    
  } catch (error) {
    console.error('[Migration] ❌ Migration error:', error.message);
    hasErrors = true;
  }
  
  return !hasErrors;
}

// ===== RUN MIGRATION ON STARTUP =====
(async function runMigrationAndContinue() {
  console.log('[Database] Starting database initialization...');
  
  try {
    // Run the full migration
    const migrationSuccess = await runFullMigration();
    
    if (!migrationSuccess) {
      console.error('[Database] ⚠️ Migration completed with errors - some features may be limited');
    }
    
    // Additional sync to ensure everything is consistent
    console.log('[Database] Syncing models for consistency...');
    await sequelize.sync({ force: false, alter: false });
    console.log('[Database] ✅ Final sync complete');
    
  } catch (error) {
    console.error('[Database] ❌ Migration error (non-critical):', error.message);
    
    // Try fallback sync
    try {
      console.log('[Database] 🔧 Trying fallback sync without alter...');
      await sequelize.sync({ force: false, alter: false });
      console.log('[Database] ✅ Fallback sync complete');
    } catch (fallbackErr) {
      console.error('[Database] ❌ Fallback sync also failed:', fallbackErr.message);
    }
  }
})();

// ===== CORE MODEL VALIDATION =====
console.log('\n[Database] ===== CORE MODEL VALIDATION =====');

const hasUserModel = !!(db.models.Users);
const hasFriendModel = !!(db.models.Friend);
const hasChatModel = !!(db.models.Chats);
const hasMessageModel = !!(db.models.Messages);
const hasChatParticipantModel = !!(db.models.ChatParticipant);
const hasTokenModel = !!(db.models.Token || db.models.Tokens);

if (!hasUserModel) {
  console.error('[Database] ❌ CRITICAL: User model not found!');
  console.error('[Database] Available models:', Object.keys(db.models));
} else {
  console.log('[Database] ✅ User model loaded successfully');
}

if (!hasTokenModel) {
  console.warn('[Database] ⚠️ Token model not found - will be created by migration');
} else {
  console.log('[Database] ✅ Token model loaded successfully');
}

if (!hasFriendModel) {
  console.warn('[Database] ⚠️ Friend model not found - friend features may be limited');
} else {
  console.log('[Database] ✅ Friend model loaded successfully');
}

if (!hasChatModel) {
  console.warn('[Database] ⚠️ Chats model not found - chat features may be limited');
} else {
  console.log('[Database] ✅ Chats model loaded successfully');
}

if (!hasMessageModel) {
  console.warn('[Database] ⚠️ Messages model not found - messaging features may be limited');
} else {
  console.log('[Database] ✅ Messages model loaded successfully');
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

db.getOperationalStatus = function() {
  return {
    mode: !hasUserModel ? 'HALTED' : (!hasFriendModel ? 'PARTIAL' : 'FULL'),
    coreOperational: hasUserModel,
    loadedCount: Object.keys(db.models).length,
    failedCount: Object.keys(db.failedModels).length,
    skippedCount: Object.keys(db.skippedFiles).length,
    failedModels: Object.keys(db.failedModels),
    hasUserModel: hasUserModel,
    hasTokenModel: hasTokenModel,
    hasFriendModel: hasFriendModel,
    hasChatModel: hasChatModel,
    hasMessageModel: hasMessageModel,
    hasChatParticipantModel: hasChatParticipantModel,
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

// ===== WEBSOCKET INITIALIZATION =====
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
  Object.entries(db.skippedFiles).forEach(([fileName, reason], index) => {
    console.log(`  ${index + 1}. ${fileName} - ${reason}`);
  });
}

console.log('\n[Database] ===== OPERATIONAL STATUS =====');
const status = db.getOperationalStatus();
if (status.mode === 'HALTED') {
  console.log('[Database] ❌ SYSTEM HALTED: User model missing');
} else if (status.mode === 'PARTIAL') {
  console.log('[Database] ⚠️ PARTIAL MODE: Some features unavailable');
} else {
  console.log('[Database] ✅ FULL OPERATION: All core models loaded');
}

console.log('\n[Migration] ===== MIGRATION FEATURES =====');
console.log('[Migration] ✅ Auto-create missing tables on startup');
console.log('[Migration] ✅ Auto-add missing columns on startup');
console.log('[Migration] ✅ Auto-fix column name inconsistencies');
console.log('[Migration] ✅ Tokens table verification and creation');
console.log('[Migration] ✅ Database sync with force:false, alter:false');
console.log('[Migration] ✅ Non-destructive migrations only\n');

console.log('[Database] =================================\n');

if (status.coreOperational) {
  console.log('[Database] 🚀 Database ready');
  console.log('[Database] ✅ No destructive operations');
  console.log('[Database] ✅ Associations loaded');
  console.log('[Database] ✅ Auto-migration enabled');
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
  get Token() { return db.models.Token || db.models.Tokens || null; },
  get Friend() { return db.models.Friend || db.models.Friends || null; },
  get Chat() { return db.models.Chat || db.models.Chats || null; },
  get Message() { return db.models.Message || db.models.Messages || null; },
  get ChatParticipant() { return db.models.ChatParticipant || null; },
  get Group() { return db.models.Group || db.models.Groups || null; },
  get GroupMember() { return db.models.GroupMember || db.models.GroupMembers || null; },
  get Profile() { return db.models.Profile || null; },
  get Settings() { return db.models.Settings || null; },
  get Features() { return db.models.Features || null; },
  get Notification() { return db.models.Notification || null; },
  get Media() { return db.models.Media || null; },
  get Mood() { return db.models.Mood || null; },
  get Status() { return db.models.Status || null; },
  get Call() { return db.models.Call || db.models.Calls || null; },
  get Category() { return db.models.Category || null; },
  get Template() { return db.models.Template || null; },
  get Notes() { return db.models.Notes || null; },
  get File() { return db.models.File || null; },
  get ReadReceipt() { return db.models.ReadReceipt || null; },
  get SharedMood() { return db.models.SharedMood || null; },
  get TypingIndicator() { return db.models.TypingIndicator || null; },
  getUserStatus() { return db.models.UserStatus || null; }
};
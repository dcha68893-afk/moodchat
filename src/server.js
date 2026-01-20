﻿// src/server.js - COMPLETE FRESH IMPLEMENTATION
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'development-secret-key-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ========== DATABASE CONNECTION ==========
let sequelize;
let dbConnected = false;
let models = {};

// ========== IN-MEMORY STORAGE ==========
let users = [];
let messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// State tracking
let storageStatsLogged = false;
let databaseInitialized = false;
let tablesSynchronized = false;
let mountedRoutes = [];

// ========== DATABASE INITIALIZATION ==========
async function initializeDatabase() {
  if (databaseInitialized) {
    return dbConnected;
  }
  
  console.log('🔄 Initializing database...');
  
  try {
    // Create Sequelize instance
    if (process.env.DATABASE_URL) {
      console.log('🔌 Using DATABASE_URL from environment...');
      sequelize = new Sequelize(process.env.DATABASE_URL, {
        dialect: process.env.DB_DIALECT || 'postgres',
        logging: process.env.NODE_ENV === 'development' ? console.log : false,
        pool: {
          max: 10,
          min: 0,
          acquire: 30000,
          idle: 10000
        },
        dialectOptions: process.env.DB_SSL === 'true' ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        } : {},
        define: {
          freezeTableName: true,
          timestamps: true,
          underscored: true,
          paranoid: false
        }
      });
    } else {
      console.log('🔌 Using individual DB environment variables...');
      sequelize = new Sequelize(
        process.env.DB_NAME || 'moodchat',
        process.env.DB_USER || 'postgres',
        process.env.DB_PASSWORD || '24845c1b4df84c17a0526806f7aa0482',
        {
          host: process.env.DB_HOST || '127.0.0.1',
          port: process.env.DB_PORT || 5432,
          dialect: process.env.DB_DIALECT || 'postgres',
          logging: process.env.NODE_ENV === 'development' ? console.log : false,
          pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
          },
          dialectOptions: NODE_ENV === 'production' && process.env.DB_SSL === 'true' ? {
            ssl: {
              require: true,
              rejectUnauthorized: false
            }
          } : {},
          define: {
            freezeTableName: true,
            timestamps: true,
            underscored: true,
            paranoid: false
          }
        }
      );
    }
    
    // Test connection
    console.log('🔌 Testing database connection...');
    await sequelize.authenticate();
    dbConnected = true;
    console.log('✅ Database connection established.');
    
    // ========== CRITICAL: LOAD ALL MODELS FOR AUTOMATIC TABLE CREATION ==========
    console.log('📦 Loading all database models for automatic table creation...');
    
    // Try to load the models index file which contains all models
    try {
      const modelsPath = path.join(__dirname, 'models', 'index.js');
      if (fs.existsSync(modelsPath)) {
        console.log('📦 Loading models from models/index.js...');
        const modelsModule = require(modelsPath);
        
        if (modelsModule && typeof modelsModule === 'object') {
          // Extract all models from the module
          models = modelsModule;
          
          // Remove sequelize and Sequelize from models object
          delete models.sequelize;
          delete models.Sequelize;
          
          console.log(`✅ Loaded ${Object.keys(models).length} models:`, Object.keys(models).join(', '));
        } else {
          console.warn('⚠️  models/index.js did not export models object, creating basic models...');
          createBasicModels();
        }
      } else {
        console.warn('⚠️  models/index.js not found, creating basic models...');
        createBasicModels();
      }
    } catch (error) {
      console.warn('⚠️ Could not load models from models/index.js:', error.message);
      console.log('🔄 Creating basic models...');
      createBasicModels();
    }
    
    function createBasicModels() {
      // Define basic User model
      models.User = sequelize.define('User', {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
          validate: {
            isEmail: true
          }
        },
        username: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true
        },
        password: {
          type: DataTypes.STRING,
          allowNull: false
        },
        avatar: {
          type: DataTypes.STRING,
          defaultValue: 'https://ui-avatars.com/api/?name=User&background=random&color=fff'
        },
        createdAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        },
        updatedAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        }
      }, {
        tableName: 'Users',
        timestamps: true
      });
      
      // Define basic Message model
      models.Message = sequelize.define('Message', {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        room: {
          type: DataTypes.STRING,
          allowNull: false
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: false
        },
        sender_id: {
          type: DataTypes.INTEGER,
          allowNull: false
        },
        sender_username: {
          type: DataTypes.STRING,
          allowNull: false
        },
        sender_avatar: {
          type: DataTypes.STRING
        },
        createdAt: {
          type: DataTypes.DATE,
          defaultValue: DataTypes.NOW
        }
      }, {
        tableName: 'Messages',
        timestamps: true,
        updatedAt: false
      });
    }
    
    // Attach models to app.locals
    app.locals.models = models;
    app.locals.sequelize = sequelize;
    
    // ========== CRITICAL: SYNC ALL TABLES FOR RENDER ==========
    console.log('🔄 Synchronizing database tables for production...');
    console.log('📊 This will automatically create missing PostgreSQL tables on Render...');
    
    // Define sync options based on environment
    const syncOptions = {
      alter: NODE_ENV === 'development', // Safe in development
      force: false, // NEVER in production - this would drop tables!
      logging: NODE_ENV === 'development' ? console.log : false,
      hooks: true
    };
    
    console.log(`📊 Sync options: alter=${syncOptions.alter}, force=${syncOptions.force}, NODE_ENV=${NODE_ENV}`);
    
    // ========== AUTOMATIC TABLE CREATION ==========
    // This ensures tables are created if they don't exist
    console.log('🔨 Creating tables if they do not exist...');
    
    // First, sync all models individually to ensure they exist
    for (const [modelName, model] of Object.entries(models)) {
      if (model && model.sync) {
        try {
          console.log(`🔨 Ensuring ${modelName} table exists...`);
          await model.sync({ force: false, alter: NODE_ENV === 'development' });
          console.log(`✅ ${modelName} table ensured.`);
        } catch (error) {
          console.error(`❌ Failed to sync ${modelName}:`, error.message);
        }
      }
    }
    
    // Then perform global synchronization
    await sequelize.sync(syncOptions);
    
    tablesSynchronized = true;
    console.log('✅ Database tables ensured for production.');
    console.log('✅ Tables are automatically created if missing on Render.');
    
    // ========== VERIFY TABLE CREATION ==========
    try {
      const queryInterface = sequelize.getQueryInterface();
      const allTables = await queryInterface.showAllTables();
      console.log(`📋 Total tables in database: ${allTables.length}`);
      
      // Log table names
      allTables.forEach((table, index) => {
        console.log(`   ${index + 1}. ${table}`);
      });
      
      // Check for specific tables
      const requiredTables = ['Users', 'Messages', 'Friends', 'Groups', 'Status', 'GroupMembers', 'Calls'];
      const missingTables = requiredTables.filter(table => 
        !allTables.map(t => t.toLowerCase()).includes(table.toLowerCase())
      );
      
      if (missingTables.length > 0) {
        console.warn(`⚠️  Missing tables: ${missingTables.join(', ')}`);
        console.log('🔄 Attempting to create missing tables using migrations...');
        
        // Try to run migrations if available
        try {
          const { execSync } = require('child_process');
          console.log('🔨 Running database migrations...');
          execSync('npx sequelize-cli db:migrate', { stdio: 'inherit' });
          console.log('✅ Migrations completed.');
        } catch (migrateError) {
          console.warn('⚠️ Could not run migrations:', migrateError.message);
        }
      } else {
        console.log('✅ All required tables are present.');
      }
    } catch (error) {
      console.warn('⚠️ Could not list tables:', error.message);
    }
    
    // ========== INITIAL DATA CHECK ==========
    // Log initial storage stats ONCE
    if (!storageStatsLogged) {
      try {
        // Count records in database
        let dbUsers = 0;
        let dbMessages = 0;
        
        if (models.User) {
          try {
            dbUsers = await models.User.count();
            console.log(`👤 Database users count: ${dbUsers}`);
          } catch (e) {
            console.warn('Could not count users:', e.message);
          }
        }
        
        if (models.Message) {
          try {
            dbMessages = await models.Message.count();
            console.log(`💬 Database messages count: ${dbMessages}`);
          } catch (e) {
            console.warn('Could not count messages:', e.message);
          }
        }
        
        console.log(`📊 [Storage Stats] Users: ${users.length} (memory) / ${dbUsers} (database), Messages: ${messages.length} (memory) / ${dbMessages} (database), Rooms: ${rooms.length}, DB Connected: ${dbConnected}`);
        storageStatsLogged = true;
      } catch (error) {
        console.log(`📊 [Storage Stats] Users: ${users.length}, Messages: ${messages.length}, Rooms: ${rooms.length}, DB Connected: ${dbConnected}`);
        storageStatsLogged = true;
      }
    }
    
    databaseInitialized = true;
    return true;
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    
    // Log error details
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      code: error.code || 'N/A',
      stack: NODE_ENV === 'development' ? error.stack : undefined
    });
    
    // Initialize empty models
    app.locals.models = {};
    
    // Log storage stats ONCE
    if (!storageStatsLogged) {
      console.log(`📊 [Storage Stats] Users: ${users.length}, Messages: ${messages.length}, Rooms: ${rooms.length}, DB Connected: ${dbConnected}`);
      storageStatsLogged = true;
    }
    
    databaseInitialized = true;
    tablesSynchronized = false;
    
    // Only exit in production if DB is required
    if (NODE_ENV === 'production' && process.env.DB_REQUIRED === 'true') {
      console.error('💀 CRITICAL: Cannot start without database in production');
      process.exit(1);
    }
    
    return false;
  }
}

// ========== MIDDLEWARE ==========
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS Configuration
if (NODE_ENV === 'development') {
  app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID', 'X-Request-ID'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400
  }));
} else {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5000',
    'http://localhost:8080',
    'http://localhost:4000',
    'https://fronted-hm86.onrender.com',
    FRONTEND_URL
  ].filter(Boolean);
  
  app.use(cors({
    origin: function(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log('CORS blocked origin:', origin);
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-Device-ID'],
    exposedHeaders: ['Authorization'],
    optionsSuccessStatus: 200,
    maxAge: 86400
  }));
}

// Request logger
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'no-origin'}`);
  
  if (req.path.startsWith('/api/auth/')) {
    console.log(`[AUTH LOG] ${req.method} ${req.path} - Body:`, req.body ? JSON.stringify(req.body) : 'No body');
  }
  
  next();
});

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use(express.static(path.join(__dirname, 'public')));

// ========== ROUTE MOUNTING ==========
function mountRoutes() {
  const routesPath = path.join(__dirname, 'routes');
  
  if (fs.existsSync(routesPath)) {
    console.log(`📁 Routes directory found at: ${routesPath}`);
    
    const routeFiles = fs.readdirSync(routesPath).filter(file => file.endsWith('.js'));
    
    if (routeFiles.length === 0) {
      console.warn('⚠️  No route files found in routes directory');
    } else {
      console.log(`📋 Found ${routeFiles.length} route file(s):`, routeFiles);
      
      routeFiles.forEach(file => {
        try {
          const routeName = file.replace('.js', '');
          const routePath = path.join(routesPath, file);
          
          delete require.cache[require.resolve(routePath)];
          const routeModule = require(routePath);
          
          let basePath = `/api/${routeName}`;
          if (file === 'index.js') {
            basePath = '/api';
          }
          
          if (file === 'auth.js' && routeModule && typeof routeModule === 'object' && typeof routeModule.use === 'function') {
            app.use(basePath, routeModule);
            mountedRoutes.push(`${basePath}/*`);
            console.log(`✅ Mounted ${file} at ${basePath}`);
            return;
          }
          
          if (routeModule && typeof routeModule === 'function') {
            try {
              const router = routeModule(app);
              if (router && typeof router === 'function') {
                app.use(basePath, router);
                mountedRoutes.push(`${basePath}/*`);
                console.log(`✅ Mounted ${file} at ${basePath}`);
              } else {
                app.use(basePath, routeModule);
                mountedRoutes.push(`${basePath}/*`);
                console.log(`✅ Mounted ${file} at ${basePath}`);
              }
            } catch (error) {
              app.use(basePath, routeModule);
              mountedRoutes.push(`${basePath}/*`);
              console.log(`✅ Mounted ${file} at ${basePath}`);
            }
          } else if (routeModule && typeof routeModule === 'object') {
            if (typeof routeModule.use === 'function') {
              app.use(basePath, routeModule);
              mountedRoutes.push(`${basePath}/*`);
              console.log(`✅ Mounted ${file} at ${basePath}`);
            } else if (routeModule.default && typeof routeModule.default === 'function') {
              const router = routeModule.default();
              app.use(basePath, router);
              mountedRoutes.push(`${basePath}/*`);
              console.log(`✅ Mounted ${file} at ${basePath}`);
            }
          }
        } catch (error) {
          console.error(`❌ Failed to mount route ${file}:`, error.message);
        }
      });
    }
  } else {
    console.warn(`⚠️  Routes directory not found at: ${routesPath}`);
  }
}

// ========== AUTHENTICATION MIDDLEWARE ==========
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required',
      timestamp: new Date().toISOString()
    });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('JWT Verification Error:', err.message);
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token',
        timestamp: new Date().toISOString()
      });
    }
    req.user = user;
    next();
  });
}

// ========== HEALTH ENDPOINTS ==========
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ 
    success: true,
    status: 'OK',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cors: 'enabled',
    database: dbConnected ? 'connected' : 'disconnected',
    tablesSynchronized: tablesSynchronized,
    tablesAutoCreated: 'Sequelize sync on startup',
    databaseProvider: process.env.DATABASE_URL ? 'Render PostgreSQL' : 'Local PostgreSQL',
    automaticTables: 'ENABLED - tables created if missing',
    renderCompatibility: 'Optimized for Render PostgreSQL'
  });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: dbConnected ? 'connected' : 'disconnected',
    tablesSynchronized: tablesSynchronized,
    service: 'moodchat-backend',
    version: '1.0.0',
    databaseSync: 'automatic table creation enabled',
    automaticTables: 'ENABLED',
    tablesCreated: tablesSynchronized ? 'All tables created' : 'Tables not synchronized'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: 'Backend API running',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    version: '1.0.0',
    server: 'MoodChat Backend',
    database: dbConnected ? 'connected' : 'disconnected',
    tablesSynchronized: tablesSynchronized,
    origin: req.headers.origin || 'not specified',
    mountedRoutes: mountedRoutes.length > 0 ? mountedRoutes : 'No routes mounted from routes directory',
    automaticTables: 'Enabled - tables created if missing',
    renderCompatibility: 'Optimized for Render PostgreSQL',
    renderMode: process.env.RENDER ? 'Running on Render' : 'Not on Render'
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    headers: {
      origin: req.headers.origin,
      'user-agent': req.headers['user-agent']
    },
    dbConnected: dbConnected,
    tablesSynchronized: tablesSynchronized,
    databaseInitialized: databaseInitialized,
    env: {
      NODE_ENV: NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
      DB_HOST: process.env.DB_HOST,
      RENDER: process.env.RENDER ? 'Yes' : 'No'
    },
    automaticTables: 'ENABLED',
    modelsLoaded: Object.keys(models).length,
    loadedModels: Object.keys(models)
  });
});

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Use database if available
    if (dbConnected && tablesSynchronized && models.User) {
      try {
        const existingUser = await models.User.findOne({ where: { email } });
        if (existingUser) {
          return res.status(400).json({
            success: false,
            message: 'User already exists',
            timestamp: new Date().toISOString()
          });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await models.User.create({
          email,
          username,
          password: hashedPassword,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
        });
        
        const token = jwt.sign(
          { 
            userId: user.id, 
            email: user.email, 
            username: user.username 
          },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        return res.status(201).json({
          success: true,
          message: 'User registered successfully in database',
          token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            createdAt: user.createdAt
          },
          timestamp: new Date().toISOString(),
          storage: 'database'
        });
      } catch (dbError) {
        console.error('Database registration error:', dbError.message);
        // Fall through to in-memory
      }
    }
    
    // In-memory fallback
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists',
        timestamp: new Date().toISOString()
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(),
      email,
      username,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff`
    };
    
    users.push(user);
    
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully in memory',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      },
      timestamp: new Date().toISOString(),
      storage: 'memory'
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Use database if available
    if (dbConnected && tablesSynchronized && models.User) {
      try {
        let user;
        if (email.includes('@')) {
          user = await models.User.findOne({ where: { email } });
        } else {
          user = await models.User.findOne({ where: { username: email } });
        }
        
        if (!user) {
          return res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
          return res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
        
        const token = jwt.sign(
          { 
            userId: user.id, 
            email: user.email, 
            username: user.username 
          },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        return res.json({
          success: true,
          message: 'Login successful (database)',
          token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            createdAt: user.createdAt
          },
          timestamp: new Date().toISOString(),
          storage: 'database'
        });
      } catch (dbError) {
        console.error('Database login error:', dbError.message);
        // Fall through to in-memory
      }
    }
    
    // In-memory fallback
    let user;
    if (email.includes('@')) {
      user = users.find(u => u.email === email);
    } else {
      user = users.find(u => u.username === email);
    }
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        timestamp: new Date().toISOString()
      });
    }
    
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        username: user.username 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      message: 'Login successful (memory)',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      },
      timestamp: new Date().toISOString(),
      storage: 'memory'
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    // Try database first
    if (dbConnected && tablesSynchronized && models.User) {
      try {
        const user = await models.User.findByPk(req.user.userId);
        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found in database',
            timestamp: new Date().toISOString()
          });
        }
        
        return res.json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            createdAt: user.createdAt
          },
          timestamp: new Date().toISOString(),
          storage: 'database'
        });
      } catch (dbError) {
        console.error('Database profile error:', dbError.message);
        // Fall through
      }
    }
    
    // In-memory fallback
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      },
      timestamp: new Date().toISOString(),
      storage: 'memory'
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== CHAT ROUTES ==========
app.get('/api/chat/rooms', authenticateToken, (req, res) => {
  try {
    const roomsWithStats = rooms.map(room => {
      const roomMessages = messages.filter(m => m.room === room);
      const lastMessage = roomMessages.slice(-1)[0];
      
      return {
        name: room,
        messageCount: roomMessages.length,
        lastMessage: lastMessage ? {
          content: lastMessage.content,
          sender: lastMessage.sender.username,
          timestamp: lastMessage.timestamp
        } : null
      };
    });
    
    res.json({
      success: true,
      rooms: roomsWithStats,
      timestamp: new Date().toISOString(),
      storage: 'memory'
    });
    
  } catch (error) {
    console.error('Rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rooms',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/chat/messages/:room', authenticateToken, (req, res) => {
  try {
    const { room } = req.params;
    
    if (!rooms.includes(room)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid room',
        timestamp: new Date().toISOString()
      });
    }
    
    const roomMessages = messages
      .filter(m => m.room === room)
      .slice(-100);
    
    res.json({
      success: true,
      room,
      messages: roomMessages,
      count: roomMessages.length,
      timestamp: new Date().toISOString(),
      storage: 'memory'
    });
    
  } catch (error) {
    console.error('Messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/chat/messages', authenticateToken, (req, res) => {
  try {
    const { room, content } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!room || !content) {
      return res.status(400).json({
        success: false,
        message: 'Room and message content are required',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!rooms.includes(room)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid room',
        timestamp: new Date().toISOString()
      });
    }
    
    const message = {
      id: Date.now().toString(),
      room,
      content,
      sender: {
        id: user.id,
        username: user.username,
        avatar: user.avatar
      },
      timestamp: new Date().toISOString()
    };
    
    messages.push(message);
    
    // Also save to database if available
    if (dbConnected && tablesSynchronized && models.Message) {
      try {
        models.Message.create({
          room,
          content,
          sender_id: user.id,
          sender_username: user.username,
          sender_avatar: user.avatar
        }).catch(dbError => {
          console.error('Failed to save message to database:', dbError.message);
        });
      } catch (dbError) {
        console.error('Database message save error:', dbError.message);
      }
    }
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message,
      timestamp: new Date().toISOString(),
      storage: dbConnected ? 'memory+database' : 'memory'
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ADDITIONAL ROUTES ==========
app.get('/api/stats', authenticateToken, (req, res) => {
  res.json({
    success: true,
    stats: {
      totalUsers: users.length,
      totalMessages: messages.length,
      totalRooms: rooms.length,
      activeUsers: users.length,
      messagesPerRoom: rooms.reduce((acc, room) => {
        acc[room] = messages.filter(m => m.room === room).length;
        return acc;
      }, {})
    },
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized,
      automaticTables: 'ENABLED'
    }
  });
});

app.post('/api/test-json', (req, res) => {
  res.json({
    success: true,
    message: 'JSON received successfully',
    received: req.body,
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized
    }
  });
});

// ========== API CATCH-ALL ==========
app.all('/api/*', (req, res) => {
  console.warn(`⚠️  Unhandled API route: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: `API endpoint ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      '/api/health',
      '/api/status',
      '/api/debug',
      '/api/register',
      '/api/login',
      '/api/auth/me',
      '/api/chat/rooms',
      '/api/chat/messages/:room',
      '/api/chat/messages',
      '/api/stats',
      '/api/test-json'
    ],
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized,
      automaticTables: 'ENABLED'
    }
  });
});

// ========== STATIC PAGES ==========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error('🚨 Global error handler:', {
    message: err.message,
    path: req.path,
    method: req.method
  });
  
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS error: ' + err.message,
      timestamp: new Date().toISOString()
    });
  }
  
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
      timestamp: new Date().toISOString()
    });
  }
  
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
      timestamp: new Date().toISOString()
    });
  }
  
  res.status(err.status || 500).json({
    success: false,
    message: 'Internal server error',
    error: NODE_ENV === 'development' ? err.message : undefined,
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.url}`,
    timestamp: new Date().toISOString(),
    database: {
      connected: dbConnected,
      tablesSynchronized: tablesSynchronized,
      automaticTables: 'ENABLED'
    }
  });
});

// ========== START SERVER ==========
const startServer = async () => {
  console.log('🚀 Starting MoodChat Backend Server...');
  console.log(`📁 Environment: ${NODE_ENV}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🗄️  Database: Automatic table synchronization enabled`);
  console.log(`🔧 Render Mode: ${process.env.RENDER ? 'Yes' : 'No'}`);
  console.log(`🔨 Automatic Table Creation: ENABLED`);
  console.log(`📈 Render PostgreSQL Compatibility: OPTIMIZED`);
  
  // Initialize database and sync tables - CRITICAL FOR RENDER
  console.log('🔄 Initializing database and ensuring tables...');
  console.log('📊 This will automatically create missing PostgreSQL tables on Render...');
  await initializeDatabase();
  
  // Mount routes
  console.log('📡 Mounting routes...');
  mountRoutes();
  
  // Final verification
  if (tablesSynchronized) {
    console.log('✅ Database tables ensured for production.');
    console.log('✅ Tables are automatically created if missing on Render.');
    console.log('✅ Render PostgreSQL compatibility: OPTIMIZED');
  } else {
    console.warn('⚠️  Tables not synchronized, using in-memory storage');
    console.log('ℹ️  In-memory storage active for users, messages, and chat rooms');
  }
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`┌──────────────────────────────────────────────────────────┐`);
    console.log(`│                                                          │`);
    console.log(`│   🚀 MoodChat Backend Server Started                     │`);
    console.log(`│                                                          │`);
    console.log(`│   📍 Local:    http://localhost:${PORT}                  ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🌐 Env:      ${NODE_ENV}                               `);
    console.log(`│   ⏱️  Time:     ${new Date().toLocaleString()}           `);
    console.log(`│   🗄️  Database: ${dbConnected ? '✅ Connected' : '⚠️  Not Connected'}    `);
    console.log(`│   📊 Tables:   ${tablesSynchronized ? '✅ Synchronized' : '⚠️  Not Synced'}    `);
    console.log(`│   🔓 CORS:     ${NODE_ENV === 'development' ? 'ALLOW ALL' : 'RESTRICTED'}    `);
    console.log(`│   🛣️  Routes:   ${mountedRoutes.length} mounted           `);
    console.log(`│   🔧 Auto Tables: ${tablesSynchronized ? '✅ ENABLED' : '❌ DISABLED'}      `);
    console.log(`│   📈 Render PG: ${tablesSynchronized ? '✅ OPTIMIZED' : '⚠️  CHECK CONFIG'}  `);
    console.log(`│   🗂️  Models:    ${Object.keys(models).length} loaded      `);
    console.log(`│                                                          │`);
    console.log(`│   📊 Health:   http://localhost:${PORT}/api/health       ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🔐 Status:   http://localhost:${PORT}/api/status       ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   🐛 Debug:    http://localhost:${PORT}/api/debug        ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   💬 API Base: http://localhost:${PORT}/api              ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│                                                          │`);
    console.log(`│   📄 Pages:                                               │`);
    console.log(`│   • Home:      http://localhost:${PORT}/                 ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Login:     http://localhost:${PORT}/login            ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Register:  http://localhost:${PORT}/register         ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│   • Chat:      http://localhost:${PORT}/chat             ${PORT < 1000 ? ' ' : ''}`);
    console.log(`│                                                          │`);
    console.log(`│   PostgreSQL tables automatically created on Render       │`);
    console.log(`│   Press Ctrl+C to stop                                   │`);
    console.log(`│                                                          │`);
    console.log(`└──────────────────────────────────────────────────────────┘`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);
    
    server.close(() => {
      console.log('HTTP server closed.');
      
      if (dbConnected && sequelize) {
        sequelize.close()
          .then(() => console.log('Database connection closed.'))
          .catch(err => console.error('Error closing database:', err.message));
      }
      
      console.log('Shutdown complete. Goodbye!');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    if (NODE_ENV === 'production') {
      shutdown('UNCAUGHT_EXCEPTION');
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      console.error(`   Try: kill -9 $(lsof -t -i:${PORT}) or use a different port`);
      process.exit(1);
    } else {
      console.error('❌ Server error:', error);
      process.exit(1);
    }
  });

  return server;
};

// Start server
if (require.main === module) {
  startServer().catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { app, sequelize, startServer, tablesSynchronized };
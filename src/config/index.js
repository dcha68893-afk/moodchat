// config/index.js - FIXED
// Helper function to parse boolean from environment variables
const parseBool = (value, defaultValue = false) => {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (value === '1') return true;
    if (value === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
};

// Helper function to parse int from environment variables
const parseInteger = (value, defaultValue = 0) => {
  if (value === undefined || value === null) return defaultValue;
  const parsed = Number(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Main configuration object - using process.env directly
const config = {
  // Node environment
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Server configuration
  server: {
    port: parseInteger(process.env.PORT, 4000),
    host: process.env.HOST || '0.0.0.0',
  },
  
  // JWT configuration
  // FIX-018: Single canonical resolution order — JWT_ACCESS_SECRET takes priority,
  // falls back to JWT_SECRET for backwards compatibility with older deployments.
  // tokenService.js and auth.js both read from this config — no more secret mismatches.
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'change-this-in-production-min-32-chars!!',
    refreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-this-in-production-min-32-chars!!',
    // Alias 'secret' kept for legacy modules that read config.jwt.secret
    get secret() { return this.accessSecret; },
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '24h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  
  // Redis configuration
  redis: {
    enabled: parseBool(process.env.REDIS_ENABLED, true),
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInteger(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || '',
    db: parseInteger(process.env.REDIS_DB, 0),
    url: process.env.REDIS_URL,
  },
  
  // Database configuration
  database: {
    // Use DATABASE_URL if provided (Render, Heroku, etc.)
    url: process.env.DATABASE_URL,
    
    // Individual connection parameters
    name: process.env.DB_NAME || 'chat_app',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInteger(process.env.DB_PORT, 5432),
    dialect: 'postgres',
    
    // SSL configuration (required for Render PostgreSQL)
    ssl: parseBool(process.env.DB_SSL, process.env.NODE_ENV === 'production'),
    
    // Connection pool settings
    pool: {
      max: parseInteger(process.env.DB_POOL_MAX, 10),
      min: parseInteger(process.env.DB_POOL_MIN, 0),
      acquire: parseInteger(process.env.DB_POOL_ACQUIRE, 30000),
      idle: parseInteger(process.env.DB_POOL_IDLE, 10000),
    },
    
    // Logging
    logging: parseBool(process.env.DB_LOGGING, process.env.NODE_ENV !== 'production'),
  },
  
  // Upload configuration
  uploadPath: process.env.UPLOAD_DIR || './uploads',
  uploadTempDir: process.env.UPLOAD_TEMP_DIR || './uploads/temp',
  uploadMediaDir: process.env.UPLOAD_MEDIA_DIR || './uploads/media',
  uploadMaxSize: parseInteger(process.env.UPLOAD_MAX_SIZE, 10 * 1024 * 1024),
  uploadAllowedTypes: process.env.UPLOAD_ALLOWED_TYPES || 'image/jpeg,image/png,image/gif,image/webp,video/mp4,application/pdf',
  mediaBaseUrl: process.env.MEDIA_BASE_URL || '/api/media',

  // CORS allowed origins — reads ALLOWED_ORIGINS (comma-separated list) or FRONTEND_URL from env.
  // When neither is set, app.js falls back to localhost-only list (dev-safe).
  // On Render: set ALLOWED_ORIGINS=https://moodfronted.onrender.com in the backend service env vars.
  get corsOrigin() {
    const raw = process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL;
    if (!raw) return undefined;
    const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
    return origins.length === 1 ? origins[0] : origins;
  },
};

// Parse DATABASE_URL if present (for Render PostgreSQL)
if (config.database.url && !config.database.host) {
  try {
    // Parse DATABASE_URL (postgresql://user:password@host:port/database)
    const url = new URL(config.database.url);
    const dbName = url.pathname.substring(1); // Remove leading slash
    
    // Override individual settings with DATABASE_URL values
    config.database.host = url.hostname;
    config.database.port = parseInteger(url.port, 5432);
    config.database.name = dbName;
    config.database.user = url.username;
    config.database.password = url.password;
    
    // Render PostgreSQL requires SSL
    config.database.ssl = true;
    
    console.log(`[Config] Using DATABASE_URL for database connection`);
  } catch (error) {
    console.error(`[Config] Error parsing DATABASE_URL:`, error.message);
  }
}

// Ensure Redis config is loaded from .env without circular imports
module.exports = config;

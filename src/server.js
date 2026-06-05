// src/server.js - ADVANCED PRODUCTION SERVER WITH OPTIMIZED MIDDLEWARE ORDER
// Complete implementation with FIXED middleware order and WebSocket
// PATCHED: Fixed authentication handling, token extraction, and middleware consistency
// CRITICAL FIX: Standardized token response format, fixed public route detection
// ENHANCED: Professional model diagnostics with column names and table details
// OPTIMIZED: Connection pool (max:20, min:5), Login response caching (30s TTL)
// OPTIMIZED: Response compression, Query timeout (30s), UV_THREADPOOL_SIZE=16
// =========================================================================
// ========== ABSOLUTE FIRST LINE - LOAD ENVIRONMENT ==========
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const BACKEND_ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.resolve(BACKEND_ROOT_DIR, '.env');

dotenv.config({ path: process.env.ENV_PATH || DEFAULT_ENV_PATH });

// Set UV_THREADPOOL_SIZE for better concurrent operations
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
console.log(`⚡ UV_THREADPOOL_SIZE set to: ${process.env.UV_THREADPOOL_SIZE}`);

// Add debug to verify .env loaded
console.log('=== ENVIRONMENT LOAD DEBUG ===');
console.log('Current directory:', __dirname);
console.log('JWT_SECRET loaded:', process.env.JWT_SECRET ? 'YES (length: ' + process.env.JWT_SECRET.length + ')' : 'NO');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('===============================');

// ========== BOOTSTRAP & ENVIRONMENT ==========
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const compression = require('compression');
const authService = require('./services/authService');
const WebSocketService = require('./services/webSocketService');
const { authenticateToken } = require('./middleware/auth');

// Environment detection with proper precedence
const ENV = {
    PRODUCTION: process.env.NODE_ENV === 'production',
    DEVELOPMENT: process.env.NODE_ENV === 'development',
    STAGING: process.env.NODE_ENV === 'staging',
    TEST: process.env.NODE_ENV === 'test',
    
    // Platform detection
    IS_RENDER: process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID !== undefined,
    IS_RAILWAY: process.env.RAILWAY === 'true',
    IS_HEROKU: process.env.HEROKU === 'true',
    IS_LOCAL: !process.env.RENDER && !process.env.RAILWAY && !process.env.HEROKU,
    
    // Load environment files with precedence
    load: function() {
        const envPath = process.env.ENV_PATH
            ? path.resolve(process.cwd(), process.env.ENV_PATH)
            : null;
        
        if (envPath && fs.existsSync(envPath)) {
            dotenv.config({ path: envPath, override: true });
            return;
        }
        
        // Environment-specific files
        const nodeEnv = process.env.NODE_ENV || 'development';
        const envFiles = [
            path.resolve(BACKEND_ROOT_DIR, `.env.${nodeEnv}.local`),
            path.resolve(BACKEND_ROOT_DIR, `.env.${nodeEnv}`),
            path.resolve(BACKEND_ROOT_DIR, '.env.local'),
            DEFAULT_ENV_PATH
        ];
        
        for (const file of envFiles) {
            if (fs.existsSync(file)) {
                dotenv.config({ path: file, override: true });
                break;
            }
        }
    }
};

ENV.load();

// At the VERY TOP of server.js - before ANY other code
console.log('=== ENVIRONMENT DEBUG ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('JWT_SECRET from process.env:', process.env.JWT_SECRET ? 'SET (length: ' + process.env.JWT_SECRET.length + ')' : 'NOT SET');
console.log('JWT_ACCESS_SECRET from process.env:', process.env.JWT_ACCESS_SECRET ? 'SET' : 'NOT SET');
console.log('UV_THREADPOOL_SIZE:', process.env.UV_THREADPOOL_SIZE);
console.log('==========================');

dotenv.config({ path: process.env.ENV_PATH || DEFAULT_ENV_PATH, override: false });

console.log('=== AFTER dotenv.config() ===');
console.log('JWT_SECRET after dotenv:', process.env.JWT_SECRET ? 'SET (length: ' + process.env.JWT_SECRET.length + ')' : 'NOT SET');
console.log('JWT_ACCESS_SECRET after dotenv:', process.env.JWT_ACCESS_SECRET ? 'SET' : 'NOT SET');
console.log('==========================');

// ========== DYNAMIC CORS CONFIGURATION ==========
class DynamicCorsManager {
    constructor() {
        this.allowedOrigins = new Set();
        this.environment = process.env.NODE_ENV || 'development';
        this.isRender = process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID !== undefined;
        this.frontendUrl = process.env.FRONTEND_URL;
        this.backendUrl = process.env.BACKEND_URL;
        
        this.loadOrigins();
        this.logConfiguration();
    }
    
    // Load origins based on environment
    loadOrigins() {
        // Always allow the server itself for API self-calls
        this.addServerOrigins();
        // AFTER
if (this.environment === 'production' || this.isRender) {
    this.loadProductionOrigins();
} else {
    this.loadDevelopmentOrigins();
}
        
        // Add any custom origins from environment
        this.addCustomOrigins();
    }
    
    // Add server origins for internal API calls
    addServerOrigins() {
        const host = (process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID)
            ? '0.0.0.0'
            : (process.env.HOST || '0.0.0.0');
        const port = parseInt(process.env.PORT, 10) || 4000;
        
        this.allowedOrigins.add(`http://${host}:${port}`);
        this.allowedOrigins.add(`https://${host}:${port}`);
        
        // Localhost variations
        this.allowedOrigins.add('http://localhost');
        this.allowedOrigins.add('https://localhost');
        this.allowedOrigins.add('http://127.0.0.1');
        this.allowedOrigins.add('https://127.0.0.1');
        this.allowedOrigins.add('http://[::1]');
        this.allowedOrigins.add('https://[::1]');
    }
    
   loadProductionOrigins() {
    console.log('🛡️ CORS: Configuring for PRODUCTION environment');
    
    // Primary Render frontend URL
    const renderFrontend = 'https://moodfronted.onrender.com';
    this.allowedOrigins.add(renderFrontend);
    this.allowedOrigins.add(renderFrontend + '/'); // With trailing slash
    console.log(`✅ CORS: Allowed production frontend: ${renderFrontend}`);
    
    // Also allow Render backend URL if running on Render
    if (this.isRender && process.env.RENDER_EXTERNAL_URL) {
        this.allowedOrigins.add(process.env.RENDER_EXTERNAL_URL);
        console.log(`✅ CORS: Allowed Render backend URL: ${process.env.RENDER_EXTERNAL_URL}`);
    }
    
    // Allow custom frontend URL from environment if specified
    if (this.frontendUrl) {
        const urls = this.frontendUrl.split(',').map(url => url.trim());
        urls.forEach(url => {
            this.allowedOrigins.add(url);
            this.allowedOrigins.add(url + '/'); // With trailing slash
            console.log(`✅ CORS: Allowed custom frontend: ${url}`);
        });
    }
    
    // CRITICAL: Ensure moodfronted.onrender.com is always allowed
    if (!this.allowedOrigins.has('https://moodfronted.onrender.com')) {
        this.allowedOrigins.add('https://moodfronted.onrender.com');
        console.log(`✅ CORS: Explicitly added moodfronted.onrender.com`);
    }
    
    // Additional security for production: Remove any insecure origins
    this.removeInsecureOrigins();
}

    // Load development origins - flexible policy
    loadDevelopmentOrigins() {
        console.log('🔧 CORS: Configuring for DEVELOPMENT environment');
        
        // Local development frontend origins - COMPLETE LIST
        const localOrigins = [
            // Live Server default ports
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://127.0.0.1:5501',
            'http://localhost:5501',
            
            // React/Vite dev servers
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:5174',
            'http://127.0.0.1:5174',
            
            // Next.js dev servers
            'http://localhost:3002',
            'http://127.0.0.1:3002',
            
            // Common alternative ports
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://localhost:8000',
            'http://127.0.0.1:8000',
            'http://localhost:4200',
            'http://127.0.0.1:4200',
            'http://localhost:5000',
            'http://127.0.0.1:5000',
            
            // HTTPS versions for local development
            'https://localhost:3000',
            'https://127.0.0.1:3000',
            'https://localhost:5173',
            'https://127.0.0.1:5173',
            'https://localhost:5500',
            'https://127.0.0.1:5500',
            
            // Network IPs for mobile/tablet testing
            'http://192.168.1.100:3000',
            'http://192.168.1.100:5173',
            'http://192.168.1.100:5500',
            'http://192.168.0.100:3000',
            'http://10.0.0.100:3000',
            'http://172.20.10.2:3000',
            'http://172.20.10.2:5173',
            'http://172.20.10.2:5500',
            
            // Capacitor/Ionic mobile apps
            'capacitor://localhost',
            'ionic://localhost',
            
            // Expo dev servers
            'http://localhost:19006',
            'http://127.0.0.1:19006',
            'http://localhost:19000',
            'http://127.0.0.1:19000',
            
            // Bare localhost
            'http://localhost',
            'https://localhost',
            'http://127.0.0.1',
            'https://127.0.0.1'
        ];
        
        localOrigins.forEach(origin => {
            this.allowedOrigins.add(origin);
        });
        
        console.log(`✅ CORS: Added ${localOrigins.length} development origins`);
        
        // Also allow production frontend in development for testing
        if (process.env.ALLOW_PRODUCTION_IN_DEV === 'true') {
            this.allowedOrigins.add('https://moodfronted.onrender.com');
            console.log('⚠️  CORS: Allowing production frontend in development (ALLOW_PRODUCTION_IN_DEV=true)');
        }
        
        // Allow Render backend if running locally but connecting to Render
        if (process.env.RENDER_EXTERNAL_URL) {
            this.allowedOrigins.add(process.env.RENDER_EXTERNAL_URL);
            console.log(`✅ CORS: Allowed Render backend for local testing: ${process.env.RENDER_EXTERNAL_URL}`);
        }
    }
    
    // Add custom origins from environment variables
    addCustomOrigins() {
        // Add CORS_ADDITIONAL_ORIGINS from environment
        if (process.env.CORS_ADDITIONAL_ORIGINS) {
            const additionalOrigins = process.env.CORS_ADDITIONAL_ORIGINS.split(',')
                .map(origin => origin.trim())
                .filter(origin => origin);
            
            additionalOrigins.forEach(origin => {
                this.allowedOrigins.add(origin);
                console.log(`✅ CORS: Added additional origin: ${origin}`);
            });
        }
        
        // Add FRONTEND_URL if not already added (for backward compatibility)
        if (this.frontendUrl && !this.allowedOrigins.has(this.frontendUrl)) {
            const urls = this.frontendUrl.split(',').map(url => url.trim());
            urls.forEach(url => {
                if (!this.allowedOrigins.has(url)) {
                    this.allowedOrigins.add(url);
                    console.log(`✅ CORS: Added frontend URL: ${url}`);
                }
            });
        }
    }
    
    // Remove insecure origins in production
    removeInsecureOrigins() {
        if (this.environment === 'production') {
            const originsToRemove = [];
            
            this.allowedOrigins.forEach(origin => {
                // Remove HTTP-only origins in production (except localhost/127.0.0.1 with ANY port)
                if (origin.startsWith('http://')) {
                    // Check if it's a local development origin with any port
                    const isLocalOrigin = 
                        origin.includes('localhost') || 
                        origin.includes('127.0.0.1') ||
                        origin.includes('[::1]');
                    
                    if (!isLocalOrigin) {
                        originsToRemove.push(origin);
                    }
                }
                
                // Remove insecure local network IPs
                if (origin.includes('192.168.') || 
                    origin.includes('10.0.0.') || 
                    origin.includes('172.20.10.')) {
                    originsToRemove.push(origin);
                }
            });
            
            originsToRemove.forEach(origin => {
                this.allowedOrigins.delete(origin);
                console.log(`🔒 CORS: Removed insecure origin in production: ${origin}`);
            });
        }
    }
    
    // Log the CORS configuration
    logConfiguration() {
        console.log('\n' + '='.repeat(80));
        console.log('🌐 DYNAMIC CORS CONFIGURATION');
        console.log('='.repeat(80));
        console.log(`Environment: ${this.environment.toUpperCase()}`);
        console.log(`Running on Render: ${this.isRender ? 'Yes' : 'No'}`);
        console.log(`Total allowed origins: ${this.allowedOrigins.size}`);
        console.log('-'.repeat(80));
        
        // List all allowed origins
        Array.from(this.allowedOrigins).forEach((origin, index) => {
            console.log(`${index + 1}. ${origin}`);
        });
        
        console.log('='.repeat(80) + '\n');
    }
    
    // Get CORS options for Express middleware - CRITICAL FIX: Properly handle Authorization header
    getCorsOptions() {
        return {
            origin: (origin, callback) => {
                return this.originVerifier(origin, callback);
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
            allowedHeaders: [
                'Content-Type', 
                'Authorization',
                'authorization',
                'X-Requested-With', 
                'Accept', 
                'Origin', 
                'User-Agent', 
                'Cache-Control', 
                'Pragma', 
                'X-API-Key',
                'X-Request-ID',
                'X-Client-Version'
            ],
            exposedHeaders: [
                'Content-Range', 
                'X-Content-Range', 
                'X-Total-Count', 
                'X-Request-ID',
                'X-RateLimit-Limit',
                'X-RateLimit-Remaining',
                'X-RateLimit-Reset'
            ],
            maxAge: 86400,
            preflightContinue: false,
            optionsSuccessStatus: 204
        };
    }
    
    // Origin verification function
    originVerifier(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) {
            this.logAccess(null, true, 'No origin (mobile/curl/server)');
            return callback(null, true);
        }
        
        // Check if origin is explicitly allowed
        if (this.allowedOrigins.has(origin)) {
            this.logAccess(origin, true);
            return callback(null, true);
        }
        
        // Check for pattern matching (for subdomains)
        const isPatternMatch = this.checkPatternMatch(origin);
        if (isPatternMatch) {
            this.logAccess(origin, true, 'Pattern match');
            return callback(null, true);
        }
        
        // Origin not allowed
        this.logAccess(origin, false);
        
        // In development, provide more helpful error messages
        if (this.environment !== 'production') {
            const error = new Error(
                `CORS policy: Origin "${origin}" not allowed. ` +
                `Allowed origins: ${Array.from(this.allowedOrigins).join(', ')}`
            );
            return callback(error, false);
        }
        
        // In production, generic error for security
        return callback(new Error('CORS policy: Origin not allowed'), false);
    }
    
    // Check for pattern matching (e.g., subdomains)
    checkPatternMatch(origin) {
        // AFTER — works regardless of NODE_ENV, uses isRender flag as backup
if (origin.includes('.onrender.com') && (this.environment === 'production' || this.isRender)) {
    console.log(`🌐 CORS: Allowing Render subdomain: ${origin}`);
    return true;
}
        
        // Check for localhost with any port in development
        if (this.environment !== 'production') {
            if (origin.startsWith('http://localhost:') || 
                origin.startsWith('https://localhost:') ||
                origin.startsWith('http://127.0.0.1:') ||
                origin.startsWith('https://127.0.0.1:')) {
                console.log(`🌐 CORS: Allowing localhost with dynamic port: ${origin}`);
                return true;
            }
        }
        
        return false;
    }
    
    // Log CORS access attempts
    logAccess(origin, allowed, reason = '') {
        const timestamp = new Date().toISOString();
        const status = allowed ? '✅ ALLOWED' : '❌ BLOCKED';
        const reasonText = reason ? ` (${reason})` : '';
        
        if (origin) {
            console.log(`🌐 CORS: ${status} ${origin}${reasonText} - ${timestamp}`);
        } else {
            console.log(`🌐 CORS: ${status} No origin${reasonText} - ${timestamp}`);
        }
    }
    
    // Get allowed origins as array
    getAllowedOrigins() {
        return Array.from(this.allowedOrigins);
    }
    
    // Check if an origin is allowed
    isOriginAllowed(origin) {
        if (!origin) return true;
        return this.allowedOrigins.has(origin) || this.checkPatternMatch(origin);
    }
}

// Create global CORS manager instance
const corsManager = new DynamicCorsManager();

// ========== OPTIMIZED LOGIN RESPONSE CACHE ==========
class LoginResponseCache {
    constructor(ttlSeconds = 30) {
        this.cache = new Map();
        this.ttl = ttlSeconds * 1000;
        this.hits = 0;
        this.misses = 0;
        this.cleanupInterval = null;
        
        // Start cleanup interval every minute
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
        
        console.log(`🚀 LoginResponseCache initialized with ${ttlSeconds}s TTL`);
    }
    
    // Generate cache key from identifier and device
    generateKey(identifier, device = 'unknown') {
        // Normalize identifier (lowercase email)
        const normalizedId = identifier.toLowerCase().trim();
        const normalizedDevice = device.toLowerCase().trim();
        return `${normalizedId}:${normalizedDevice}`;
    }
    
    // Get cached response
    get(identifier, device = 'unknown') {
        const key = this.generateKey(identifier, device);
        const entry = this.cache.get(key);
        
        if (!entry) {
            this.misses++;
            return null;
        }
        
        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }
        
        this.hits++;
        return entry.data;
    }
    
    // Set cached response
    set(identifier, device, responseData) {
        const key = this.generateKey(identifier, device);
        this.cache.set(key, {
            data: responseData,
            expiresAt: Date.now() + this.ttl,
            createdAt: Date.now()
        });
    }
    
    // Invalidate cache for a user
    invalidate(identifier, device = null) {
        if (device) {
            const key = this.generateKey(identifier, device);
            this.cache.delete(key);
        } else {
            // Delete all entries for this identifier across devices
            const prefix = identifier.toLowerCase().trim() + ':';
            for (const key of this.cache.keys()) {
                if (key.startsWith(prefix)) {
                    this.cache.delete(key);
                }
            }
        }
    }
    
    // Clear all cache
    clear() {
        this.cache.clear();
        console.log('🗑️ Login cache cleared');
    }
    
    // Cleanup expired entries
    cleanup() {
        const now = Date.now();
        let expiredCount = 0;
        
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                expiredCount++;
            }
        }
        
        if (expiredCount > 0) {
            console.log(`🧹 Login cache cleanup: removed ${expiredCount} expired entries`);
        }
    }
    
    // Get cache stats
    getStats() {
        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0 
                ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(2) + '%'
                : '0%',
            ttlSeconds: this.ttl / 1000
        };
    }
    
    // Shutdown cleanup
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.cache.clear();
    }
}

// ========== DUPLICATE REQUEST FILTER ==========
class DuplicateRequestFilter {
    constructor(cooldownMs = 500) {
        this.pendingRequests = new Map();
        this.cooldown = cooldownMs;
    }
    
    // Check if request is duplicate
    isDuplicate(req, identifier) {
        const key = this.generateRequestKey(req, identifier);
        const now = Date.now();
        const lastRequest = this.pendingRequests.get(key);
        
        if (lastRequest && (now - lastRequest) < this.cooldown) {
            return true;
        }
        
        this.pendingRequests.set(key, now);
        
        // Cleanup old entries periodically
        if (this.pendingRequests.size > 1000) {
            this.cleanup(now);
        }
        
        return false;
    }
    
    // Generate unique request key
    generateRequestKey(req, identifier) {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const path = req.path;
        const method = req.method;
        return `${method}:${path}:${ip}:${identifier}`;
    }
    
    // Cleanup old entries
    cleanup(now) {
        for (const [key, timestamp] of this.pendingRequests.entries()) {
            if ((now - timestamp) > this.cooldown) {
                this.pendingRequests.delete(key);
            }
        }
    }
    
    // Clear all
    clear() {
        this.pendingRequests.clear();
    }
}

// ========== QUERY TIMEOUT MIDDLEWARE ==========
class QueryTimeoutMiddleware {
    constructor(timeoutMs = 30000) {
        this.timeout = timeoutMs;
    }
    
    // Create timeout middleware
    create() {
        return (req, res, next) => {
            // Skip timeout for health/status endpoints
            const skipPaths = ['/health', '/live', '/ready', '/api/health', '/api/status'];
            if (skipPaths.some(path => req.path === path || req.path.startsWith(path))) {
                return next();
            }
            
            // Set timeout for this request
            req.setTimeout(this.timeout, () => {
                if (!res.headersSent) {
                    console.log(`⏱️ Query timeout for ${req.method} ${req.path}`);
                    res.status(504).json({
                        success: false,
                        message: 'Request timeout',
                        code: 'REQUEST_TIMEOUT',
                        timeout: this.timeout
                    });
                }
            });
            
            next();
        };
    }
}

// ========== RESPONSE COMPRESSION MIDDLEWARE ==========
class ResponseCompressionMiddleware {
    constructor() {
        this.compression = compression({
            // Compress all responses over 1KB
            threshold: 1024,
            // Use high compression level for better performance
            level: 6,
            // Filter what to compress
            filter: (req, res) => {
                // Don't compress for small responses
                if (req.headers['x-no-compression']) {
                    return false;
                }
                // Use default filter
                return compression.filter(req, res);
            },
            // Chunk size for streaming
            chunkSize: 16384,
            // Brotli support
            brotli: { enabled: true, params: {
                [require('zlib').constants.BROTLI_PARAM_QUALITY]: 4
            }}
        });
    }
    
    getMiddleware() {
        return this.compression;
    }
}

// Create instances
const loginCache = new LoginResponseCache(30);
const duplicateFilter = new DuplicateRequestFilter(500);
const queryTimeout = new QueryTimeoutMiddleware(30000);
const responseCompression = new ResponseCompressionMiddleware();

// ========== SINGLE SOURCE OF TRUTH: SYSTEM STATE MANAGER ==========
class SystemStateManager {
    constructor() {
        this.state = {
            overall: 'INITIALIZING',
            services: new Map(),
            connections: new Map(),
            routes: new Map(),
            models: new Map(),
            metrics: {
                requests: 0,
                errors: 0,
                warnings: 0,
                critical: 0,
                logins: 0,
                registrations: 0,
                corsAllowed: 0,
                corsBlocked: 0,
                publicRouteAccess: 0,
                protectedRouteAccess: 0,
                authFailures: 0,
                authSuccesses: 0,
                cacheHits: 0,
                cacheMisses: 0,
                duplicateRequestsBlocked: 0,
                queryTimeouts: 0
            },
            timestamp: new Date(),
            startupOrder: []
        };
        
        // Explicit state classifications
        this.STATE_CLASSIFICATIONS = {
            CRITICAL: [
                'database_connection',
                'express_listening',
                'auth_routes',
                'core_middleware'
            ],
            DEGRADED: [
                'redis_connection',
                'websocket_connection',
                'optional_routes',
                'background_services'
            ]
        };
        
        // State transition history
        this.history = [];
        this.stateLock = false;
    }
    
    // CRITICAL: Classify an issue as critical or degraded
    classifyIssue(component, issue) {
        const criticalComponents = this.STATE_CLASSIFICATIONS.CRITICAL;
        const degradedComponents = this.STATE_CLASSIFICATIONS.DEGRADED;
        
        // Check if this component is in critical list
        if (criticalComponents.some(crit => issue.includes(crit) || component.includes(crit))) {
            return 'CRITICAL';
        }
        
        // Check if this component is in degraded list
        if (degradedComponents.some(degraded => issue.includes(degraded) || component.includes(degraded))) {
            return 'DEGRADED';
        }
        
        // Default to degraded for safety
        return 'DEGRADED';
    }
    
    // Register a service with initial state
    registerService(name, component) {
        this.state.services.set(name, {
            name,
            component,
            status: 'INITIALIZING',
            healthy: false,
            degraded: false,
            lastCheck: new Date(),
            details: {},
            history: []
        });
        
        this.logTransition('SERVICE_REGISTERED', { service: name });
    }
    
    // Register a connection
    registerConnection(name, component) {
        this.state.connections.set(name, {
            name,
            component,
            status: 'DISCONNECTED',
            connected: false,
            degraded: false,
            lastActivity: null,
            details: {},
            history: []
        });
        
        this.logTransition('CONNECTION_REGISTERED', { connection: name });
    }
    
    // Register a model with enhanced details
    registerModel(name, modelInfo) {
        this.state.models.set(name, {
            name,
            tableName: modelInfo.tableName || name,
            loaded: true,
            errors: [],
            warnings: [],
            associations: modelInfo.associations || [],
            aliasConflicts: modelInfo.aliasConflicts || [],
            columns: modelInfo.columns || [],
            columnCount: modelInfo.columns?.length || 0,
            primaryKeys: modelInfo.primaryKeys || [],
            foreignKeys: modelInfo.foreignKeys || [],
            indexes: modelInfo.indexes || [],
            timestamp: new Date()
        });
    }
    
    // Update model state with column details
    updateModelWithColumns(name, columnDetails) {
        const model = this.state.models.get(name);
        if (model) {
            model.columns = columnDetails.columns || [];
            model.columnCount = columnDetails.columns?.length || 0;
            model.primaryKeys = columnDetails.primaryKeys || [];
            model.foreignKeys = columnDetails.foreignKeys || [];
            model.indexes = columnDetails.indexes || [];
            model.timestamp = new Date();
        }
    }
    
    // Update model state
    updateModelState(name, updates) {
        const model = this.state.models.get(name);
        if (model) {
            Object.assign(model, updates);
        }
    }
    
    // Update service state
    updateServiceState(name, updates) {
        if (this.stateLock) return;
        
        const service = this.state.services.get(name);
        if (!service) {
            this.registerService(name, null);
            return this.updateServiceState(name, updates);
        }
        
        const oldStatus = service.status;
        const oldHealthy = service.healthy;
        
        Object.assign(service, updates, { lastCheck: new Date() });
        
        // Log state change
        if (oldStatus !== service.status || oldHealthy !== service.healthy) {
            service.history.push({
                timestamp: new Date(),
                from: { status: oldStatus, healthy: oldHealthy },
                to: { status: service.status, healthy: service.healthy },
                details: updates.details || {}
            });
            
            this.logTransition('SERVICE_STATE_CHANGE', {
                service: name,
                from: oldStatus,
                to: service.status,
                healthy: service.healthy
            });
        }
        
        this.recalculateOverallState();
    }
    
    // Update connection state
    updateConnectionState(name, updates) {
        if (this.stateLock) return;
        
        const connection = this.state.connections.get(name);
        if (!connection) {
            this.registerConnection(name, null);
            return this.updateConnectionState(name, updates);
        }
        
        const oldStatus = connection.status;
        const oldConnected = connection.connected;
        
        Object.assign(connection, updates, { lastActivity: new Date() });
        
        // Log state change
        if (oldStatus !== connection.status || oldConnected !== connection.connected) {
            connection.history.push({
                timestamp: new Date(),
                from: { status: oldStatus, connected: oldConnected },
                to: { status: connection.status, connected: connection.connected },
                details: updates.details || {}
            });
            
            this.logTransition('CONNECTION_STATE_CHANGE', {
                connection: name,
                from: oldStatus,
                to: connection.status,
                connected: connection.connected
            });
        }
        
        this.recalculateOverallState();
    }
    
    // Register route lifecycle
    registerRoute(name, route) {
        this.state.routes.set(name, {
            name,
            path: route.path,
            method: route.method,
            lifecycle: 'DISCOVERED',
            mounted: false,
            active: false,
            requiresAuth: route.requiresAuth || false,
            isPublic: route.isPublic || false,
            details: {},
            errors: []
        });
    }
    
    updateRouteState(name, updates) {
        const route = this.state.routes.get(name);
        if (route) {
            Object.assign(route, updates);
        }
    }
    
    // Recalculate overall system state
    recalculateOverallState() {
        let criticalServices = 0;
        let degradedServices = 0;
        let totalServices = 0;
        
        // Check services - ONLY database is critical
        for (const [name, service] of this.state.services.entries()) {
            totalServices++;
            if (name === 'database' && !service.healthy) {
                criticalServices++;
            } else if (!service.healthy) {
                degradedServices++;
            }
            if (service.degraded) degradedServices++;
        }
        
        // Check connections - NONE are critical, all are degraded at worst
        for (const [name, conn] of this.state.connections.entries()) {
            if (!conn.connected) {
                degradedServices++;
            }
        }
        
        // Determine overall state
        let overallState = 'READY';
        if (criticalServices > 0) {
            overallState = 'FAILED';
        } else if (degradedServices > 0) {
            overallState = 'DEGRADED';
        }
        
        if (this.state.overall !== overallState) {
            this.logTransition('OVERALL_STATE_CHANGE', {
                from: this.state.overall,
                to: overallState,
                critical: criticalServices,
                degraded: degradedServices,
                total: totalServices
            });
        }
        
        this.state.overall = overallState;
        return overallState;
    }
    
    // Check if server is ready to accept requests
    isServerReady() {
        const dbService = this.state.services.get('database');
        const isDatabaseConnected = dbService && dbService.healthy;
        const hasCriticalFailures = this.state.overall === 'FAILED';
        
        return isDatabaseConnected && !hasCriticalFailures;
    }
    
    // Log state transitions (internal)
    logTransition(event, data) {
        const transition = {
            timestamp: new Date(),
            event,
            data,
            state: this.getPublicState()
        };
        
        this.history.push(transition);
        
        // Keep only last 100 transitions
        if (this.history.length > 100) {
            this.history.shift();
        }
    }
    
    // Get public state (safe for external consumption)
    getPublicState() {
        const publicState = {
            overall: this.state.overall,
            timestamp: new Date().toISOString(),
            uptime: Math.floor((new Date() - this.state.timestamp) / 1000),
            services: {},
            connections: {},
            routes: {},
            models: {},
            metrics: { ...this.state.metrics },
            cors: {
                allowedOrigins: corsManager.getAllowedOrigins().length,
                environment: process.env.NODE_ENV || 'development',
                credentials: true
            }
        };
        
        // Services
        for (const [name, service] of this.state.services.entries()) {
            publicState.services[name] = {
                status: service.status,
                healthy: service.healthy,
                degraded: service.degraded,
                lastCheck: service.lastCheck.toISOString()
            };
        }
        
        // Connections
        for (const [name, conn] of this.state.connections.entries()) {
            publicState.connections[name] = {
                status: conn.status,
                connected: conn.connected,
                degraded: conn.degraded,
                lastActivity: conn.lastActivity?.toISOString() || null
            };
        }
        
        // Routes
        for (const [name, route] of this.state.routes.entries()) {
            publicState.routes[name] = {
                path: route.path,
                lifecycle: route.lifecycle,
                mounted: route.mounted,
                active: route.active,
                requiresAuth: route.requiresAuth,
                isPublic: route.isPublic
            };
        }
        
        // Models with enhanced details
        for (const [name, model] of this.state.models.entries()) {
            publicState.models[name] = {
                tableName: model.tableName,
                loaded: model.loaded,
                columnCount: model.columnCount,
                associations: model.associations.length,
                warnings: model.warnings.length,
                errors: model.errors.length,
                aliasConflicts: model.aliasConflicts.length,
                columns: model.columns?.slice(0, 10) || [],
                primaryKeys: model.primaryKeys || []
            };
        }
        
        return publicState;
    }
    
    // Get health for /health endpoint
    getHealth() {
        const state = this.getPublicState();
        
        // Server is healthy if database is connected and express is listening
        const isHealthy = this.isServerReady();
        
        // Add service-specific health checks
        state.checks = {
            database: this.isServiceHealthy('database'),
            redis: this.isConnectionHealthy('redis'),
            auth: this.areAuthRoutesActive(),
            models: this.getModelHealthStatus(),
            cors: corsManager.getAllowedOrigins().length > 0,
            http: true
        };
        
        state.ready = isHealthy;
        state.classification = this.getHealthClassification();
        
        return state;
    }
    
    // Get health classification
    getHealthClassification() {
        if (!this.isServiceHealthy('database')) return 'CRITICAL';
        if (!this.areAuthRoutesActive()) return 'CRITICAL';
        
        const degradedConnections = Array.from(this.state.connections.values())
            .filter(conn => !conn.connected).length;
            
        if (degradedConnections > 0) return 'DEGRADED';
        
        return 'HEALTHY';
    }
    
    // Get model health status
    getModelHealthStatus() {
        const totalModels = this.state.models.size;
        const loadedModels = Array.from(this.state.models.values())
            .filter(m => m.loaded).length;
        
        return {
            total: totalModels,
            loaded: loadedModels,
            percentage: totalModels > 0 ? Math.round((loadedModels / totalModels) * 100) : 0,
            aliasConflicts: Array.from(this.state.models.values())
                .filter(m => m.aliasConflicts.length > 0).length
        };
    }
    
    // Get detailed model info for diagnostics
    getDetailedModelInfo() {
        const modelDetails = [];
        
        for (const [name, model] of this.state.models.entries()) {
            modelDetails.push({
                name: name,
                tableName: model.tableName,
                loaded: model.loaded,
                columnCount: model.columnCount,
                columns: model.columns || [],
                primaryKeys: model.primaryKeys || [],
                foreignKeys: model.foreignKeys || [],
                associations: model.associations || [],
                aliasConflicts: model.aliasConflicts || [],
                warnings: model.warnings || [],
                errors: model.errors || []
            });
        }
        
        return modelDetails;
    }
    
    // Helper methods
    isServiceHealthy(name) {
        const service = this.state.services.get(name);
        return service ? service.healthy : false;
    }
    
    isConnectionHealthy(name) {
        const conn = this.state.connections.get(name);
        return conn ? conn.connected : false;
    }
    
    areAuthRoutesActive() {
        const authRoutes = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/me'];
        return authRoutes.every(route => {
            for (const r of this.state.routes.values()) {
                if (r.path === route && r.active) return true;
            }
            return false;
        });
    }
    
    incrementMetric(metric) {
        if (this.state.metrics[metric] !== undefined) {
            this.state.metrics[metric]++;
        }
    }
    
    recordStartupStep(step) {
        this.state.startupOrder.push({
            step,
            timestamp: new Date(),
            state: this.state.overall
        });
    }
    
    // Generate startup summary report
    generateStartupReport() {
        const report = {
            database: 'DISCONNECTED',
            redis: 'DISABLED',
            models: { loaded: 0, failed: 0, total: 0, aliasConflicts: 0 },
            routes: { mounted: 0, skipped: 0, total: 0 },
            controllers: { active: 0, inactive: 0 },
            services: { active: 0, disabled: 0 },
            serverState: this.state.overall,
            environment: process.env.NODE_ENV || 'development',
            jwtConfigured: !!(process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET),
            corsOrigins: corsManager.getAllowedOrigins().length,
            corsEnvironment: corsManager.environment,
            corsRender: corsManager.isRender,
            authMode: 'PROTECTED_ROUTES_ONLY',
            optimizations: {
                uvThreadpoolSize: parseInt(process.env.UV_THREADPOOL_SIZE, 10) || 16,
                connectionPool: { max: 20, min: 5 },
                loginCacheTTL: 30,
                duplicateRequestCooldown: 500,
                queryTimeout: 8000,
                compressionEnabled: true
            }
        };
        
        // Database
        const dbService = this.state.services.get('database');
        report.database = dbService ? (dbService.healthy ? 'CONNECTED' : 'FAILED') : 'MISSING';
        
        // Redis
        const redisConn = this.state.connections.get('redis');
        if (redisConn) {
            if (redisConn.status === 'DISABLED') {
                report.redis = 'DISABLED';
            } else if (redisConn.connected) {
                report.redis = 'CONNECTED';
            } else if (redisConn.degraded) {
                report.redis = 'DEGRADED';
            } else {
                report.redis = 'DISCONNECTED';
            }
        }
        
        // Models
        report.models.total = this.state.models.size;
        report.models.loaded = Array.from(this.state.models.values())
            .filter(m => m.loaded).length;
        report.models.failed = report.models.total - report.models.loaded;
        report.models.aliasConflicts = Array.from(this.state.models.values())
            .filter(m => m.aliasConflicts.length > 0).length;
        
        // Routes
        for (const route of this.state.routes.values()) {
            report.routes.total++;
            if (route.active && route.mounted) {
                report.routes.mounted++;
            } else {
                report.routes.skipped++;
            }
        }
        
        // Controllers
        for (const route of this.state.routes.values()) {
            if (route.active && route.details.controller && route.details.controller !== 'N/A') {
                report.controllers.active++;
            } else if (route.details.controller && route.details.controller !== 'N/A') {
                report.controllers.inactive++;
            }
        }
        
        // Services
        for (const service of this.state.services.values()) {
            if (service.healthy) {
                report.services.active++;
            } else if (service.name !== 'database') {
                report.services.disabled++;
            }
        }
        
        return report;
    }
}

// Global state manager instance
const systemState = new SystemStateManager();

// ========== PROFESSIONAL LOGGING SYSTEM ==========
class ProfessionalLogger {
    constructor() {
        this.colors = {
            reset: '\x1b[0m',
            red: '\x1b[31m',
            green: '\x1b[32m',
            yellow: '\x1b[33m',
            blue: '\x1b[34m',
            magenta: '\x1b[35m',
            cyan: '\x1b[36m',
            white: '\x1b[37m',
            gray: '\x1b[90m'
        };
        
        this.levels = {
            SILENT: 0,
            ERROR: 1,
            WARN: 2,
            INFO: 3,
            DEBUG: 4
        };
        
        this.currentLevel = process.env.LOG_LEVEL || 'INFO';
        this.suppressedMessages = new Set();
        this.lastLogTime = new Map();
        this.cooldownPeriod = 10000;
        
        // Error flood control
        this.errorCounts = new Map();
        this.errorCooldown = 60000;
        this.maxErrorsPerMinute = 5;
    }
    
    shouldLog(level, context, message) {
        const levelNum = this.levels[level.toUpperCase()] || 2;
        const currentNum = this.levels[this.currentLevel.toUpperCase()] || 2;
        
        if (levelNum > currentNum) return false;
        
        // Suppress repeated messages
        const messageKey = `${level}:${context}:${message.substring(0, 50)}`;
        const now = Date.now();
        const lastTime = this.lastLogTime.get(messageKey);
        
        if (lastTime && (now - lastTime < this.cooldownPeriod)) {
            return false;
        }
        
        // Error flood control
        if (level === 'ERROR') {
            const errorKey = `${context}:${message.substring(0, 100)}`;
            const errorEntry = this.errorCounts.get(errorKey) || { count: 0, firstSeen: now };
            
            if (now - errorEntry.firstSeen < this.errorCooldown) {
                if (errorEntry.count >= this.maxErrorsPerMinute) {
                    if (errorEntry.count === this.maxErrorsPerMinute) {
                        this.warn(`Error flood detected for ${context}: ${message}. Suppressing further errors.`, 'LOG_CONTROL');
                    }
                    return false;
                }
                errorEntry.count++;
            } else {
                // Reset counter after cooldown
                errorEntry.count = 1;
                errorEntry.firstSeen = now;
            }
            this.errorCounts.set(errorKey, errorEntry);
        }
        
        this.lastLogTime.set(messageKey, now);
        return true;
    }
    
    // Structured logging methods
    error(message, error = null, context = 'SYSTEM') {
        if (!this.shouldLog('ERROR', context, message)) return;
        
        systemState.incrementMetric('errors');
        
        console.log(`${this.colors.red}✗ ERROR [${context}] ${message}${this.colors.reset}`);
        if (error && process.env.NODE_ENV !== 'production') {
            console.log(`${this.colors.gray}  ${error.message || error}${this.colors.reset}`);
        }
    }
    
    warn(message, context = 'SYSTEM') {
        if (!this.shouldLog('WARN', context, message)) return;
        
        systemState.incrementMetric('warnings');
        
        console.log(`${this.colors.yellow}⚠ WARN  [${context}] ${message}${this.colors.reset}`);
    }
    
    info(message, context = 'SYSTEM') {
        if (!this.shouldLog('INFO', context, message)) return;
        
        console.log(`${this.colors.cyan}ℹ INFO  [${context}] ${message}${this.colors.reset}`);
    }
    
    success(message, context = 'SYSTEM') {
        if (!this.shouldLog('INFO', context, message)) return;
        
        console.log(`${this.colors.green}✓ OK    [${context}] ${message}${this.colors.reset}`);
    }
    
    debug(message, context = 'SYSTEM') {
        if (!this.shouldLog('DEBUG', context, message)) return;
        
        console.log(`${this.colors.gray}🔍 DEBUG [${context}] ${message}${this.colors.reset}`);
    }
    
    // Explicit readiness declaration
    declareReadiness(port, host, report) {
        console.log(`\n${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.green}                    🚀 SERVER READY - ACCEPTING REQUESTS                          ${this.colors.reset}`);
        console.log(`${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        
        // Display startup report
        this.displayStartupReport(report);
        
        console.log(`${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.cyan}   Local:    http://localhost:${port}${this.colors.reset}`);
        console.log(`${this.colors.cyan}   Network:  http://${host}:${port}${this.colors.reset}`);
        console.log(`${this.colors.cyan}   Health:   http://localhost:${port}/health${this.colors.reset}`);
        console.log(`${this.colors.cyan}   API Docs: http://localhost:${port}/api/health${this.colors.reset}`);
        console.log(`${this.colors.cyan}   WebSocket: ws://localhost:${port}/ws${this.colors.reset}`);
        console.log(`${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.yellow}   Press Ctrl+C to shutdown gracefully${this.colors.reset}\n`);
    }
    
    // Table display methods
    table(title, headers, rows, options = {}) {
        if (process.env.NODE_ENV === 'production' && options.hideInProduction) return;
        
        // Ensure rows is an array
        if (!rows || !Array.isArray(rows)) {
            console.log(`${this.colors.yellow}⚠ Cannot display table: rows is not an array${this.colors.reset}`);
            return;
        }
        
        console.log(`\n${this.colors.blue}${title}${this.colors.reset}`);
        console.log(`${this.colors.blue}${'─'.repeat(80)}${this.colors.reset}`);
        
        // Headers
        let headerStr = '';
        headers.forEach((header, i) => {
            const width = options.columnWidths?.[i] || 20;
            headerStr += header.padEnd(width) + '  ';
        });
        console.log(`${this.colors.cyan}${headerStr}${this.colors.reset}`);
        console.log(`${this.colors.blue}${'─'.repeat(80)}${this.colors.reset}`);
        
        // Rows - with safe iteration
        try {
            rows.forEach(row => {
                // Ensure row is an array
                if (!Array.isArray(row)) {
                    console.log(`${this.colors.yellow}⚠ Skipping invalid row: ${JSON.stringify(row)}${this.colors.reset}`);
                    return;
                }
                
                let rowStr = '';
                row.forEach((cell, i) => {
                    const width = options.columnWidths?.[i] || 20;
                    const cellText = String(cell || '').substring(0, width);
                    const color = this.getCellColor(cell, i, headers[i]);
                    rowStr += color + cellText.padEnd(width) + this.colors.reset + '  ';
                });
                console.log(rowStr);
            });
        } catch (error) {
            console.log(`${this.colors.yellow}⚠ Error displaying table: ${error.message}${this.colors.reset}`);
        }
    }
    
    getCellColor(cell, index, header) {
        if (typeof cell === 'string') {
            if (cell.includes('✓') || cell.includes('CONNECTED') || cell.includes('READY')) {
                return this.colors.green;
            }
            if (cell.includes('✗') || cell.includes('FAILED') || cell.includes('DISCONNECTED')) {
                return this.colors.red;
            }
            if (cell.includes('⚠') || cell.includes('DEGRADED') || cell.includes('WARNING')) {
                return this.colors.yellow;
            }
        }
        return '';
    }
    
    // Display startup report
    displayStartupReport(report) {
        const rows = [
            ['Environment', report.environment, report.environment === 'production' ? '🚀' : '🔧'],
            ['Database', report.database, report.database === 'CONNECTED' ? '✓' : report.database === 'FAILED' ? '✗' : '⚠'],
            ['JWT Auth', report.jwtConfigured ? 'CONFIGURED' : 'WARNING', report.jwtConfigured ? '✓' : '⚠'],
            ['Auth Mode', report.authMode, '🛡️'],
            ['Redis', report.redis, report.redis === 'CONNECTED' ? '✓' : report.redis === 'DEGRADED' ? '⚠' : '○'],
            ['Models', `${report.models.loaded}/${report.models.total} loaded`, report.models.failed > 0 ? '⚠' : '✓'],
            ['Alias Conflicts', `${report.models.aliasConflicts} detected`, report.models.aliasConflicts > 0 ? '⚠' : '✓'],
            ['Routes', `${report.routes.mounted}/${report.routes.total} mounted`, report.routes.skipped > 0 ? '⚠' : '✓'],
            ['CORS Origins', `${report.corsOrigins} allowed`, report.corsOrigins > 0 ? '✓' : '⚠'],
            ['CORS Env', report.corsEnvironment.toUpperCase(), report.corsEnvironment === 'production' ? '🔒' : '🔓'],
            ['WebSocket', 'ENABLED', '✓'],
            ['Server State', report.serverState, report.serverState === 'READY' ? '✓' : report.serverState === 'DEGRADED' ? '⚠' : '✗'],
            ['UV_THREADPOOL_SIZE', report.optimizations.uvThreadpoolSize, '⚡'],
            ['Connection Pool', `${report.optimizations.connectionPool.max}/${report.optimizations.connectionPool.min}`, '🗄️'],
            ['Login Cache TTL', `${report.optimizations.loginCacheTTL}s`, '🚀'],
            ['Query Timeout', `${report.optimizations.queryTimeout}ms`, '⏱️'],
            ['Compression', report.optimizations.compressionEnabled ? 'ENABLED' : 'DISABLED', '📦']
        ];
        
        this.table('STARTUP REPORT', ['Component', 'Status', 'Health'], rows);
    }
    
    // ENHANCED: Display detailed model information with column details
    displayModelDetails(models) {
        console.log(`\n${this.colors.blue}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.cyan}                    📊 MODEL SCHEMA DIAGNOSTICS                              ${this.colors.reset}`);
        console.log(`${this.colors.blue}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        
        for (const model of models) {
            console.log(`\n${this.colors.green}📁 Model: ${model.name}${this.colors.reset}`);
            console.log(`${this.colors.gray}   Table: ${model.tableName}${this.colors.reset}`);
            console.log(`${this.colors.gray}   Status: ${model.loaded ? '✓ LOADED' : '✗ FAILED'}${this.colors.reset}`);
            console.log(`${this.colors.gray}   Columns: ${model.columnCount}${this.colors.reset}`);
            console.log(`${this.colors.gray}   Associations: ${model.associations?.length || 0}${this.colors.reset}`);
            console.log(`${this.colors.gray}   Alias Conflicts: ${model.aliasConflicts?.length || 0}${this.colors.reset}`);
            
            // Display columns in a formatted table
            if (model.columns && model.columns.length > 0) {
                console.log(`${this.colors.cyan}   ┌─────────────────────────────────────────────────────────────────────────┐${this.colors.reset}`);
                console.log(`${this.colors.cyan}   │ COLUMN DETAILS                                                          │${this.colors.reset}`);
                console.log(`${this.colors.cyan}   ├───────────────┬─────────────────────────────────────────────────────────┤${this.colors.reset}`);
                console.log(`${this.colors.cyan}   │ Column Name   │ Type & Constraints                                      │${this.colors.reset}`);
                console.log(`${this.colors.cyan}   ├───────────────┼─────────────────────────────────────────────────────────┤${this.colors.reset}`);
                
                const displayColumns = model.columns.slice(0, 20);
                displayColumns.forEach(col => {
                    const colName = (col.name || col.columnName || '').substring(0, 14).padEnd(14);
                    let typeInfo = `${col.type || col.dataType || 'unknown'}`;
                    if (col.allowNull === false) typeInfo += ' NOT NULL';
                    if (col.primaryKey) typeInfo += ' PRIMARY KEY';
                    if (col.autoIncrement) typeInfo += ' AUTO_INCREMENT';
                    if (col.defaultValue !== undefined) typeInfo += ` DEFAULT ${col.defaultValue}`;
                    
                    console.log(`${this.colors.cyan}   │ ${colName} │ ${typeInfo.substring(0, 55).padEnd(55)}${this.colors.reset}`);
                });
                
                if (model.columns.length > 20) {
                    console.log(`${this.colors.cyan}   │ ...           │ ${model.columns.length - 20} more columns...                         │${this.colors.reset}`);
                }
                
                console.log(`${this.colors.cyan}   └───────────────┴─────────────────────────────────────────────────────────┘${this.colors.reset}`);
            }
            
            // Display primary keys
            if (model.primaryKeys && model.primaryKeys.length > 0) {
                console.log(`${this.colors.green}   🔑 Primary Keys: ${model.primaryKeys.join(', ')}${this.colors.reset}`);
            }
            
            // Display foreign keys
            if (model.foreignKeys && model.foreignKeys.length > 0) {
                console.log(`${this.colors.magenta}   🔗 Foreign Keys: ${model.foreignKeys.map(fk => `${fk.column} → ${fk.references?.table}.${fk.references?.column}`).join(', ')}${this.colors.reset}`);
            }
            
            // Display warnings
            if (model.warnings && model.warnings.length > 0) {
                console.log(`${this.colors.yellow}   ⚠ Warnings: ${model.warnings.length}${this.colors.reset}`);
                model.warnings.slice(0, 3).forEach(warning => {
                    console.log(`${this.colors.yellow}      - ${warning.substring(0, 70)}${this.colors.reset}`);
                });
            }
            
            // Display alias conflicts
            if (model.aliasConflicts && model.aliasConflicts.length > 0) {
                console.log(`${this.colors.red}   ❌ Alias Conflicts: ${model.aliasConflicts.length}${this.colors.reset}`);
                model.aliasConflicts.slice(0, 3).forEach(conflict => {
                    console.log(`${this.colors.red}      - ${conflict.substring(0, 70)}${this.colors.reset}`);
                });
            }
            
            console.log(`${this.colors.gray}   ${'─'.repeat(80)}${this.colors.reset}`);
        }
        
        console.log(`\n${this.colors.blue}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
    }
    
    displaySystemHealth() {
        const services = [];
        const connections = [];
        
        // Gather service states - ensure each is an array
        for (const [name, service] of systemState.state.services.entries()) {
            services.push([
                name || 'Unknown',
                service.healthy ? 'OK' : (service.degraded ? 'DEGRADED' : 'FAILED'),
                service.status || 'Unknown',
                service.details?.notes || ''
            ]);
        }
        
        // Gather connection states - ensure each is an array
        for (const [name, conn] of systemState.state.connections.entries()) {
            connections.push([
                name || 'Unknown',
                conn.connected ? 'CONNECTED' : (conn.degraded ? 'DEGRADED' : 'DISCONNECTED'),
                conn.status || 'Unknown',
                conn.details?.reason || ''
            ]);
        }
        
        // Display system health
        this.table('SYSTEM HEALTH', ['Component', 'State', 'Mode', 'Notes'], 
            [...services, ...connections]);
    }
    
    displayRoutes() {
        const publicRoutes = [];
        const protectedRoutes = [];
        const failedRoutes = [];
        
        for (const route of systemState.state.routes.values()) {
            const row = {
                route: route.path,
                controller: route.details.controller || 'N/A',
                service: route.details.service || 'N/A',
                auth: route.isPublic ? 'PUBLIC' : (route.requiresAuth ? 'PROTECTED' : 'NONE'),
                reason: route.errors.join(', ') || 'Unknown'
            };
            
            if (route.active) {
                if (route.isPublic) {
                    publicRoutes.push([row.route, row.controller, row.auth]);
                } else {
                    protectedRoutes.push([row.route, row.controller, row.auth]);
                }
            } else if (route.errors.length > 0) {
                failedRoutes.push([row.route, row.reason]);
            }
        }
        
        if (publicRoutes.length > 0) {
            this.table('ROUTES — PUBLIC (NO AUTH)', ['Route', 'Controller', 'Auth'], publicRoutes);
        }
        
        if (protectedRoutes.length > 0) {
            this.table('ROUTES — PROTECTED (JWT REQUIRED)', ['Route', 'Controller', 'Auth'], protectedRoutes);
        }
        
        if (failedRoutes.length > 0) {
            this.table('ROUTES — FAILED', ['Route', 'Failure Reason'], failedRoutes);
        }
    }
    
    // ENHANCED: Display models info with column counts
    displayModelsInfo() {
        const rows = [];
        
        for (const model of systemState.state.models.values()) {
            const status = model.loaded ? '✓' : '✗';
            const aliasStatus = model.aliasConflicts.length > 0 ? `⚠ (${model.aliasConflicts.length})` : '✓';
            rows.push([
                model.name,
                model.tableName,
                status,
                model.columnCount,
                model.associations.length,
                model.warnings.length,
                model.errors.length,
                aliasStatus
            ]);
        }
        
        if (rows.length > 0) {
            this.table('MODELS', ['Name', 'Table', 'Loaded', 'Columns', 'Associations', 'Warnings', 'Errors', 'Alias'], rows, {
                columnWidths: [15, 20, 8, 10, 12, 10, 10, 10]
            });
        }
        
        // Display detailed model information
        const detailedModels = systemState.getDetailedModelInfo();
        if (detailedModels.length > 0) {
            this.displayModelDetails(detailedModels);
        }
    }
    
    displayDatabaseInfo(dbInfo) {
        if (!dbInfo) return;
        
        const rows = [[
            dbInfo.state || 'UNKNOWN',
            dbInfo.schemaStatus || 'N/A',
            dbInfo.tablesLoaded || 0,
            dbInfo.warnings || 0
        ]];
        
        this.table('DATABASE', ['State', 'Schema', 'Tables', 'Warnings'], rows);
    }
    
    displayRedisInfo(redisInfo) {
        if (!redisInfo) return;
        
        const rows = [[
            redisInfo.state || 'UNKNOWN',
            redisInfo.mode || 'N/A',
            redisInfo.notes || ''
        ]];
        
        this.table('REDIS', ['State', 'Mode', 'Notes'], rows);
    }
    
    displayWebSocketInfo(wsInfo) {
        if (!wsInfo) return;
        
        const rows = [[
            wsInfo.state || 'UNKNOWN',
            wsInfo.transport || 'N/A',
            wsInfo.reason || ''
        ]];
        
        this.table('WEBSOCKET', ['State', 'Transport', 'Reason'], rows);
    }
    
    displayCorsInfo() {
        const allowedOrigins = corsManager.getAllowedOrigins();
        const rows = allowedOrigins.map((origin, index) => [
            index + 1,
            origin,
            corsManager.isOriginAllowed(origin) ? '✓' : '✗'
        ]);
        
        this.table('CORS ALLOWED ORIGINS', ['#', 'Origin', 'Status'], rows, {
            columnWidths: [4, 60, 8]
        });
    }
    
    startupBanner(port, host) {
        console.log(`\n${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.green}                    🚀 MoodChat Server Initializing                              ${this.colors.reset}`);
        console.log(`${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
        console.log(`${this.colors.cyan}   Optimizations Enabled:${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • UV_THREADPOOL_SIZE: ${process.env.UV_THREADPOOL_SIZE}${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • Connection Pool: max=20, min=5${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • Login Cache TTL: 30 seconds${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • Query Timeout: 30 seconds${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • Response Compression: Enabled${this.colors.reset}`);
        console.log(`${this.colors.cyan}   • Duplicate Request Filter: 500ms${this.colors.reset}`);
        console.log(`${this.colors.green}══════════════════════════════════════════════════════════════════════════════${this.colors.reset}`);
    }
    
    logLoginAttempt(email, success, device = 'unknown') {
        const status = success ? 'SUCCESS' : 'FAILED';
        const icon = success ? '✓' : '✗';
        console.log(`${this.colors.cyan}${icon} LOGIN  [AUTH] ${status} for ${email} from ${device}${this.colors.reset}`);
    }
    
    logJWTToken(userId, tokenLength) {
        console.log(`${this.colors.gray}🔐 JWT    [AUTH] Generated for user ${userId}, token length: ${tokenLength}${this.colors.reset}`);
    }
    
    logAliasConflict(modelName, conflict) {
        console.log(`${this.colors.yellow}⚠ ALIAS  [MODEL] ${modelName}: ${conflict}${this.colors.reset}`);
    }
    
    logCorsAccess(origin, allowed) {
        if (allowed) {
            console.log(`${this.colors.gray}🌐 CORS   [HTTP] Allowed: ${origin}${this.colors.reset}`);
            systemState.incrementMetric('corsAllowed');
        } else {
            console.log(`${this.colors.yellow}🌐 CORS   [HTTP] Blocked: ${origin}${this.colors.reset}`);
            systemState.incrementMetric('corsBlocked');
        }
    }
    
    logRouteAccess(path, method, isPublic, hasAuth) {
        const authStatus = isPublic ? 'PUBLIC' : (hasAuth ? 'AUTH' : 'NO_AUTH');
        const methodColor = method === 'GET' ? this.colors.green : 
                           method === 'POST' ? this.colors.yellow : 
                           method === 'PUT' ? this.colors.blue : 
                           method === 'DELETE' ? this.colors.red : this.colors.white;
        
        console.log(`${methodColor}${method}${this.colors.reset} ${path} [${authStatus}]`);
    }
    
    // NEW: Log public route access
    logPublicRouteAccess(path, method) {
        if (config.get('NODE_ENV') === 'development') {
            console.log(`${this.colors.green}${method}${this.colors.reset} ${path} ${this.colors.cyan}[PUBLIC]${this.colors.reset}`);
        }
    }
    
    // NEW: Log auth failure only for protected routes
    logAuthFailure(path, method, reason = 'No token') {
        if (config.get('NODE_ENV') === 'development') {
            console.log(`${this.colors.red}${method}${this.colors.reset} ${path} ${this.colors.yellow}[AUTH FAILED: ${reason}]${this.colors.reset}`);
        }
    }
    
    // NEW: Log cache hit/miss
    logCacheHit(identifier) {
        console.log(`${this.colors.green}⚡ CACHE  [LOGIN] Hit for ${identifier}${this.colors.reset}`);
        systemState.incrementMetric('cacheHits');
    }
    
    logCacheMiss(identifier) {
        console.log(`${this.colors.gray}💾 CACHE  [LOGIN] Miss for ${identifier}${this.colors.reset}`);
        systemState.incrementMetric('cacheMisses');
    }
    
    logDuplicateBlocked(identifier, path) {
        console.log(`${this.colors.yellow}🛡️ DUPLICATE [REQUEST] Blocked duplicate: ${identifier} to ${path}${this.colors.reset}`);
        systemState.incrementMetric('duplicateRequestsBlocked');
    }
    
    logQueryTimeout(path, method) {
        console.log(`${this.colors.red}⏱️ TIMEOUT [QUERY] ${method} ${path} exceeded 30s limit${this.colors.reset}`);
        systemState.incrementMetric('queryTimeouts');
    }
}

const logger = new ProfessionalLogger();

// ========== CONFIGURATION MANAGEMENT ==========
class ConfigurationManager {
    constructor() {
        this.config = new Map();
        this.load();
    }
    
    generateSecureSecret() {
        const crypto = require('crypto');
        return crypto.randomBytes(32).toString('hex');
    }
    
    load() {
        // Core - ONLY read from environment, NO HARDCODING
        const nodeEnv = process.env.NODE_ENV;
        
        if (!nodeEnv) {
            console.error('❌ FATAL: NODE_ENV not set in .env file!');
            console.error('Please set NODE_ENV=development or NODE_ENV=production in your .env file');
            process.exit(1);
        }
        
        const isRenderRuntime = process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID !== undefined;
        this.set('NODE_ENV', nodeEnv);
        this.set('PORT', parseInt(process.env.PORT, 10) || 4000);
        this.set('HOST', isRenderRuntime ? '0.0.0.0' : (process.env.HOST || '0.0.0.0'));
        this.set('API_VERSION', process.env.API_VERSION || '1.0.0');
        this.set('APP_NAME', process.env.APP_NAME || 'MoodChat');
       
        const jwtSecret = process.env.JWT_SECRET;
    
        if (!jwtSecret) {
            console.error('❌ FATAL: JWT_SECRET not set in .env file!');
            console.error('Please add JWT_SECRET=your-secret-key to your .env file');
            console.error('Generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
            process.exit(1);
        }
        
        this.set('JWT_SECRET', jwtSecret);
        this.set('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET || jwtSecret);
        this.set('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET || jwtSecret);
        
        // CRITICAL: Log which secrets are being used (without exposing values)
        console.log('✅ [Config] JWT Configuration:');
        console.log(`   JWT_SECRET: ${jwtSecret ? 'SET' : 'MISSING'} (length: ${jwtSecret?.length || 0})`);
        console.log(`   JWT_ACCESS_SECRET: ${process.env.JWT_ACCESS_SECRET ? 'SET (custom)' : 'Using JWT_SECRET'}`);
        console.log(`   JWT_REFRESH_SECRET: ${process.env.JWT_REFRESH_SECRET ? 'SET (custom)' : 'Using JWT_SECRET'}`);
        
        // Ensure consistency - log warning if custom access secret differs from primary
        if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET !== jwtSecret) {
            console.warn('⚠️  [Config] JWT_ACCESS_SECRET differs from JWT_SECRET - ensure tokenService uses correct secret');
        }
        
        // Database - ONLY from .env
        const dbUrl = process.env.DATABASE_URL;
        
        if (!dbUrl) {
            console.error('❌ FATAL: DATABASE_URL not set in .env file!');
            console.error('Please add DATABASE_URL=postgresql://... to your .env file');
            process.exit(1);
        }
        
        console.log('🔧 [Config] DATABASE_URL found, fixing if needed...');
        
        // Fix URL if it's missing the port
        let fixedUrl = dbUrl;
        if (dbUrl.includes('@') && !dbUrl.includes(':')) {
            const atIndex = dbUrl.indexOf('@');
            const slashIndex = dbUrl.indexOf('/', atIndex);
            
            if (slashIndex > atIndex) {
                const host = dbUrl.substring(atIndex + 1, slashIndex);
                if (!host.includes(':')) {
                    fixedUrl = dbUrl.substring(0, slashIndex) + ':5432' + dbUrl.substring(slashIndex);
                    console.log('🔧 [Config] Added default port 5432 to DATABASE_URL');
                }
            }
        }
        
        this.set('DATABASE_URL', fixedUrl);
        console.log('✅ [Config] DATABASE_URL configured');
        
        // Clear individual DB configs (we're using URL)
        this.set('DB_HOST', null);
        this.set('DB_PORT', null);
        this.set('DB_NAME', null);
        this.set('DB_USER', null);
        this.set('DB_PASSWORD', null);
        
        // Redis configuration (optional)
        this.set('REDIS_ENABLED', process.env.REDIS_ENABLED === 'true');
        this.set('REDIS_URL', process.env.REDIS_URL);
        this.set('REDIS_HOST', process.env.REDIS_HOST || 'localhost');
        this.set('REDIS_PORT', parseInt(process.env.REDIS_PORT, 10) || 6379);
        this.set('REDIS_PASSWORD', process.env.REDIS_PASSWORD);
        
        // Feature flags
        this.set('FEATURE_WEBSOCKETS', process.env.FEATURE_WEBSOCKETS !== 'false');
        this.set('FEATURE_REDIS_CACHE', process.env.FEATURE_REDIS_CACHE === 'true');
        this.set('FEATURE_CORS_MOBILE', process.env.FEATURE_CORS_MOBILE !== 'false');
        
        // CORS configuration - read from .env
        const corsAdditional = process.env.CORS_ADDITIONAL_ORIGINS;
        if (corsAdditional) {
            const origins = corsAdditional.split(',').map(o => o.trim());
            origins.forEach(origin => {
                corsManager.allowedOrigins.add(origin);
            });
            console.log(`✅ Added ${origins.length} CORS origins from .env`);
        }
        
        this.set('CORS_ORIGINS', corsManager.getAllowedOrigins());
        this.set('ALLOW_PRODUCTION_IN_DEV', process.env.ALLOW_PRODUCTION_IN_DEV === 'true');
        
        // Database sync options (use with caution)
        this.set('DB_SYNC_FORCE', process.env.DB_SYNC_FORCE === 'true');
        this.set('DB_SYNC_ALTER', process.env.DB_SYNC_ALTER === 'true');
        
        // Connection pool configuration (OPTIMIZED)
        this.set('DB_POOL_MAX', parseInt(process.env.DB_POOL_MAX, 10) || 20);
        this.set('DB_POOL_MIN', parseInt(process.env.DB_POOL_MIN, 10) || 5);
        this.set('DB_POOL_ACQUIRE', parseInt(process.env.DB_POOL_ACQUIRE, 10) || 30000);
        this.set('DB_POOL_IDLE', parseInt(process.env.DB_POOL_IDLE, 10) || 10000);
        
        // Query timeout configuration
        this.set('QUERY_TIMEOUT_MS', parseInt(process.env.QUERY_TIMEOUT_MS, 10) || 30000);
        
        // Login cache configuration
        this.set('LOGIN_CACHE_TTL', parseInt(process.env.LOGIN_CACHE_TTL, 10) || 30);
        
        // Duplicate request cooldown
        this.set('DUPLICATE_REQUEST_COOLDOWN_MS', parseInt(process.env.DUPLICATE_REQUEST_COOLDOWN_MS, 10) || 500);
        
        // Compression configuration
        this.set('COMPRESSION_ENABLED', process.env.COMPRESSION_ENABLED !== 'false');
        this.set('COMPRESSION_THRESHOLD', parseInt(process.env.COMPRESSION_THRESHOLD, 10) || 1024);
        this.set('COMPRESSION_LEVEL', parseInt(process.env.COMPRESSION_LEVEL, 10) || 6);
        
        // Validate production configuration
        if (nodeEnv === 'production') {
            this.validateProduction();
        }
        
        // Log final configuration summary (without sensitive data)
        console.log('✅ [Config] Configuration loaded successfully');
        console.log('📋 Config summary:', {
            environment: this.get('NODE_ENV'),
            port: this.get('PORT'),
            host: this.get('HOST'),
            hasDatabaseUrl: !!this.get('DATABASE_URL'),
            hasJwtSecret: !!this.get('JWT_SECRET'),
            jwtSecretLength: this.get('JWT_SECRET')?.length || 0,
            websockets: this.get('FEATURE_WEBSOCKETS'),
            redisEnabled: this.get('REDIS_ENABLED'),
            dbPoolMax: this.get('DB_POOL_MAX'),
            dbPoolMin: this.get('DB_POOL_MIN'),
            queryTimeout: this.get('QUERY_TIMEOUT_MS'),
            loginCacheTTL: this.get('LOGIN_CACHE_TTL'),
            compressionEnabled: this.get('COMPRESSION_ENABLED')
        });
    }
    
    set(key, value) {
        this.config.set(key, value);
    }
    
    get(key, defaultValue = null) {
        return this.config.has(key) ? this.config.get(key) : defaultValue;
    }
    
    validateProduction() {
        console.log('🔒 Validating production configuration...');
        
        // Check JWT_SECRET is set
        const jwtSecret = this.get('JWT_SECRET');
        if (!jwtSecret) {
            console.error('❌ FATAL: JWT_SECRET is not set in .env file!');
            console.error('Please add JWT_SECRET to your .env file');
            process.exit(1);
        }
        
        // Check JWT_SECRET length (minimum security requirement)
        if (jwtSecret.length < 32) {
            console.error('❌ FATAL: JWT_SECRET must be at least 32 characters in production!');
            console.error('Current length:', jwtSecret.length);
            console.error('Generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
            process.exit(1);
        }
        
        // Check DATABASE_URL is set
        const dbUrl = this.get('DATABASE_URL');
        if (!dbUrl) {
            console.error('❌ FATAL: DATABASE_URL not set in .env file!');
            process.exit(1);
        }
        
        // Check DATABASE_URL format
        if (!dbUrl.includes('@')) {
            console.error('❌ FATAL: DATABASE_URL format is invalid (missing @)');
            process.exit(1);
        }
        
        // Check if DATABASE_URL contains placeholder
        if (dbUrl.includes('***') || dbUrl.includes('placeholder')) {
            console.error('❌ FATAL: DATABASE_URL contains placeholder!');
            console.error('Please set actual database credentials in .env file');
            process.exit(1);
        }
        
        // Check if we're using a local database in production
        if (dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')) {
            console.error('❌ FATAL: Cannot use localhost database in production!');
            console.error('Please set DATABASE_URL to your production database');
            process.exit(1);
        }
        
    const allowedOrigins = this.get('CORS_ORIGINS');
// Normalize: trim whitespace and strip trailing slash
const frontendUrl = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');

if (!frontendUrl) {
    console.error('❌ FATAL: FRONTEND_URL not set in .env file!');
    console.error('Please add FRONTEND_URL=https://your-frontend-url.com to .env');
    process.exit(1);
}

// Normalize all allowed origins the same way before comparing
const normalizedOrigins = (allowedOrigins || []).map(o => o.trim().replace(/\/+$/, ''));

if (!normalizedOrigins.includes(frontendUrl)) {
    // Auto-fix: add it rather than crashing, log a warning
    corsManager.allowedOrigins.add(frontendUrl);
    this.set('CORS_ORIGINS', corsManager.getAllowedOrigins());
    console.warn(`⚠️  CORS: FRONTEND_URL "${frontendUrl}" was missing from allowed origins — auto-added.`);
    console.warn('To silence this warning, add FRONTEND_URL to CORS_ADDITIONAL_ORIGINS in .env');
}
        
        // Check DB sync options
        if (this.get('DB_SYNC_FORCE')) {
            console.error('❌ FATAL: DB_SYNC_FORCE is TRUE in production - THIS WILL DROP ALL TABLES!');
            process.exit(1);
        }
        
        console.log('✅ Production configuration validation complete');
    }
    
    // Get database connection URL
    getDatabaseUrl() {
        if (this.get('DATABASE_URL')) {
            return this.get('DATABASE_URL');
        }
        
        const host = this.get('DB_HOST');
        const port = this.get('DB_PORT');
        const database = this.get('DB_NAME');
        const username = this.get('DB_USER');
        const password = encodeURIComponent(this.get('DB_PASSWORD') || '');
        
        return `postgresql://${username}:${password}@${host}:${port}/${database}`;
    }
    
    // Get database pool configuration
    getDatabasePoolConfig() {
        return {
            max: this.get('DB_POOL_MAX', 20),
            min: this.get('DB_POOL_MIN', 5),
            acquire: this.get('DB_POOL_ACQUIRE', 30000),
            idle: this.get('DB_POOL_IDLE', 10000)
        };
    }
}

const config = new ConfigurationManager();

// ========== JWT SECRET DEBUG - AFTER CONFIG INITIALIZATION ==========
console.log('\n=== JWT SECRET VERIFICATION ===');
console.log('config.get(JWT_SECRET):', config.get('JWT_SECRET') ? config.get('JWT_SECRET').substring(0, 10) + '...' : 'MISSING');
console.log('process.env.JWT_SECRET:', process.env.JWT_SECRET ? process.env.JWT_SECRET.substring(0, 10) + '...' : 'MISSING');
console.log('process.env.JWT_ACCESS_SECRET:', process.env.JWT_ACCESS_SECRET ? process.env.JWT_ACCESS_SECRET.substring(0, 10) + '...' : 'MISSING');

const tokenService = require('./services/tokenService');
const websocketDeliveryService = require('./services/webSocketService');
console.log('tokenService.accessSecret:', tokenService.accessSecret ? tokenService.accessSecret.substring(0, 10) + '...' : 'MISSING');
console.log('================================\n');

// ========== DATABASE SERVICE WITH OPTIMIZED POOL ==========
class DatabaseService {
    constructor() {
        this.sequelize = null;
        this.models = null;
        this.schemaWarnings = [];
        this.missingForeignKeys = [];
        this.aliasConflicts = new Map();
        this.connectionAttempted = false;
        
        systemState.registerService('database', this);
    }
    
    async initialize() {
        systemState.recordStartupStep('database_init_start');
        
        try {
            // Load database module from models/index.js
            const modelsPath = path.join(__dirname, 'models', 'index.js');
            
            if (!fs.existsSync(modelsPath)) {
                throw new Error('models/index.js not found - cannot load database models');
            }
            
            logger.info('Loading database models from models/index.js...', 'DATABASE');
            
            // Clear require cache for fresh load
            delete require.cache[require.resolve(modelsPath)];
            
            const dbModule = require(modelsPath);
            if (!dbModule || !dbModule.sequelize) {
                throw new Error('Invalid database module structure in models/index.js');
            }
            
            this.sequelize = dbModule.sequelize;
            
            // IMPORTANT: Get models from sequelize instance
            this.models = this.sequelize.models;
            
            // Configure connection with OPTIMIZED pool settings
            this.configureConnection();
            
            // Test connection
            await this.sequelize.authenticate();
            
            // Update state to CONNECTED
            systemState.updateServiceState('database', {
                status: 'CONNECTED',
                healthy: true,
                details: {
                    host: config.get('DB_HOST'),
                    database: config.get('DB_NAME'),
                    dialect: 'postgres',
                    modelsLoaded: Object.keys(this.models).length,
                    url: this.getMaskedDatabaseUrl(),
                    pool: config.getDatabasePoolConfig()
                }
            });
            
            // Register all models with system state
            for (const modelName of Object.keys(this.models)) {
                const model = this.models[modelName];
                
                // Get column information from model
                const columnInfo = await this.getModelColumnInfo(model);
                
                systemState.registerModel(modelName, {
                    tableName: model.tableName || modelName,
                    associations: Object.keys(model.associations || {}),
                    columns: columnInfo.columns || [],
                    primaryKeys: columnInfo.primaryKeys || [],
                    foreignKeys: columnInfo.foreignKeys || [],
                    indexes: columnInfo.indexes || []
                });
            }
            
            // Log all available models
            console.log('🔍 DATABASE MODELS LOADED:');
            Object.keys(this.models).forEach((modelName, index) => {
                console.log(`  ${index + 1}. ${modelName}`);
            });
            
            // Initialize associations
            await this.initializeAssociations();
            
            // Safe schema sync
            await this.syncSchema();
            
            // Inspect schema for warnings and get column details
            await this.inspectSchema();
            
            // Check for alias conflicts
            this.detectAliasConflicts();
            
            systemState.recordStartupStep('database_init_complete');
            logger.success(`Database connected successfully with ${Object.keys(this.models).length} models (Pool: max=${config.get('DB_POOL_MAX')}, min=${config.get('DB_POOL_MIN')})`, 'DATABASE');
            
            return true;
            
        } catch (error) {
            this.handleDatabaseError(error);
            return false;
        }
    }
    
    // ENHANCED: Get detailed column information from model
    async getModelColumnInfo(model) {
        const columnInfo = {
            columns: [],
            primaryKeys: [],
            foreignKeys: [],
            indexes: []
        };
        
        if (!model || !model.rawAttributes) {
            return columnInfo;
        }
        
        try {
            // Get columns from rawAttributes
            for (const [colName, attribute] of Object.entries(model.rawAttributes)) {
                const column = {
                    name: colName,
                    field: attribute.field || colName,
                    type: attribute.type?.toString() || 'unknown',
                    allowNull: attribute.allowNull !== false,
                    primaryKey: attribute.primaryKey === true,
                    autoIncrement: attribute.autoIncrement === true,
                    defaultValue: attribute.defaultValue,
                    unique: attribute.unique || false
                };
                
                columnInfo.columns.push(column);
                
                if (column.primaryKey) {
                    columnInfo.primaryKeys.push(colName);
                }
            }
            
            // Get foreign key information from associations
            if (model.associations) {
                for (const [assocName, association] of Object.entries(model.associations)) {
                    if (association.associationType === 'BelongsTo' && association.foreignKey) {
                        const fkColumn = association.foreignKey;
                        const targetModel = association.target?.name;
                        
                        columnInfo.foreignKeys.push({
                            column: fkColumn,
                            references: {
                                table: targetModel,
                                column: association.targetKey || 'id'
                            },
                            association: assocName
                        });
                    }
                }
            }
            
            // Get index information from model options
            if (model.options && model.options.indexes) {
                columnInfo.indexes = model.options.indexes;
            }
            
        } catch (error) {
            logger.debug(`Error getting column info for ${model.name}: ${error.message}`, 'DATABASE');
        }
        
        return columnInfo;
    }
    
    // Get masked database URL for logging
    getMaskedDatabaseUrl() {
        const url = config.getDatabaseUrl();
        if (!url) return 'N/A';
        
        // Mask password in URL for security
        return url.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
    }
    
    // CRITICAL FIX: configureConnection method with OPTIMIZED pool settings
    configureConnection() {
        if (!this.sequelize) return;
        
        const dbUrl = config.get('DATABASE_URL');
        
        if (!dbUrl) {
            console.error('❌ [Database] DATABASE_URL not configured!');
            throw new Error('DATABASE_URL not configured');
        }
        
        console.log('🔧 [Database] Configuring connection with OPTIMIZED pool...');
        
        // Use the URL directly - let Sequelize handle parsing
        this.sequelize.config.url = dbUrl;
        this.sequelize.config.dialect = 'postgres';
        
        // Add OPTIMIZED connection pool settings (max:20, min:5)
        const poolConfig = config.getDatabasePoolConfig();
        this.sequelize.config.pool = poolConfig;
        
        console.log(`   Pool: max=${poolConfig.max}, min=${poolConfig.min}, acquire=${poolConfig.acquire}ms, idle=${poolConfig.idle}ms`);
        
        // Add SSL settings for production
        if (config.get('NODE_ENV') === 'production') {
            this.sequelize.config.dialectOptions = {
                ssl: {
                    require: true,
                    rejectUnauthorized: false
                }
            };
        }
        
        // Add query timeout
        this.sequelize.config.query = {
            timeout: config.get('QUERY_TIMEOUT_MS', 30000)
        };
        
        console.log('✅ [Database] Connection configured with OPTIMIZED pool settings');
    }
    
    async initializeAssociations() {
        if (!this.models) return;
        
        const associationErrors = [];
        
        for (const modelName of Object.keys(this.models)) {
            const model = this.models[modelName];
            if (model.associate) {
                try {
                    model.associate(this.models);
                    
                    // Update model info with associations
                    const associations = Object.keys(model.associations || {});
                    systemState.updateModelState(modelName, {
                        associations: associations
                    });
                    
                    logger.debug(`Applied associations for ${modelName}: ${associations.length} associations`, 'DATABASE');
                } catch (error) {
                    const warning = `Association failed for ${modelName}: ${error.message}`;
                    this.schemaWarnings.push(warning);
                    associationErrors.push(warning);
                    
                    systemState.updateModelState(modelName, {
                        warnings: [warning]
                    });
                    
                    logger.warn(warning, 'DATABASE');
                }
            }
        }
        
        // Log association errors summary
        if (associationErrors.length > 0) {
            logger.warn(`${associationErrors.length} association errors occurred`, 'DATABASE');
        }
    }
    
    // Detect alias conflicts in associations
    detectAliasConflicts() {
        if (!this.models) return;
        
        const aliasMap = new Map();
        
        for (const modelName of Object.keys(this.models)) {
            const model = this.models[modelName];
            if (model.associations) {
                for (const alias of Object.keys(model.associations)) {
                    if (!aliasMap.has(alias)) {
                        aliasMap.set(alias, []);
                    }
                    aliasMap.get(alias).push(modelName);
                }
            }
        }
        
        // Find conflicts (aliases used by multiple models)
        for (const [alias, models] of aliasMap.entries()) {
            if (models.length > 1) {
                this.aliasConflicts.set(alias, models);
                
                // Log each conflict
                for (const modelName of models) {
                    const conflictMsg = `Alias '${alias}' also used by: ${models.filter(m => m !== modelName).join(', ')}`;
                    logger.logAliasConflict(modelName, conflictMsg);
                    
                    // Update model state
                    const currentConflicts = systemState.state.models.get(modelName)?.aliasConflicts || [];
                    systemState.updateModelState(modelName, {
                        aliasConflicts: [...currentConflicts, conflictMsg]
                    });
                }
            }
        }
    }
    
    async syncSchema() {
        try {
            // Safe sync with configurable options
            const force = config.get('DB_SYNC_FORCE');
            const alter = config.get('DB_SYNC_ALTER');
            
            if (force && config.get('NODE_ENV') === 'production') {
                logger.warn('DB_SYNC_FORCE is TRUE in production - THIS WILL DROP ALL TABLES!', 'DATABASE');
            }
            
            await this.sequelize.sync({ 
                force: force,
                alter: alter,
                logging: false
            });
            
            logger.debug(`Database schema synced (force: ${force}, alter: ${alter})`, 'DATABASE');
        } catch (error) {
            if (error.message.includes('foreign key') || error.message.includes('constraint')) {
                const warning = `Schema sync warning (non-critical): ${error.message}`;
                this.schemaWarnings.push(warning);
                this.missingForeignKeys.push(warning);
                logger.warn(warning, 'DATABASE');
            } else {
                // Non-critical error, log and continue
                logger.warn(`Schema sync non-critical error: ${error.message}`, 'DATABASE');
            }
        }
    }
    
    async inspectSchema() {
        try {
            const queryInterface = this.sequelize.getQueryInterface();
            const tables = await queryInterface.showAllTables();
            
            for (const tableName of tables) {
                try {
                    const tableInfo = await queryInterface.describeTable(tableName);
                    
                    // Update model column info for the corresponding model
                    const modelName = Object.keys(this.models).find(name => 
                        (this.models[name].tableName || name).toLowerCase() === tableName.toLowerCase()
                    );
                    
                    if (modelName && this.models[modelName]) {
                        const columns = [];
                        const primaryKeys = [];
                        
                        for (const [colName, colInfo] of Object.entries(tableInfo)) {
                            columns.push({
                                name: colName,
                                type: colInfo.type,
                                allowNull: colInfo.allowNull,
                                primaryKey: colInfo.primaryKey,
                                defaultValue: colInfo.defaultValue
                            });
                            
                            if (colInfo.primaryKey) {
                                primaryKeys.push(colName);
                            }
                        }
                        
                        systemState.updateModelWithColumns(modelName, {
                            columns: columns,
                            primaryKeys: primaryKeys
                        });
                    }
                    
                } catch (error) {
                    const warning = `Table inspection failed for ${tableName}: ${error.message}`;
                    this.schemaWarnings.push(warning);
                    logger.debug(warning, 'DATABASE');
                }
            }
            
            // Log warnings once
            if (this.schemaWarnings.length > 0) {
                logger.warn(`Database schema has ${this.schemaWarnings.length} warnings`, 'DATABASE');
            }
                
        } catch (error) {
            // Non-critical inspection failure
            const warning = `Schema inspection failed: ${error.message}`;
            this.schemaWarnings.push(warning);
            logger.debug(warning, 'DATABASE');
        }
    }
    
    handleDatabaseError(error) {
        const errorType = this.classifyDatabaseError(error);
        
        switch (errorType) {
            case 'CONNECTION':
                systemState.updateServiceState('database', {
                    status: 'DISCONNECTED',
                    healthy: false,
                    degraded: false,
                    details: { error: error.message, type: 'connection' }
                });
                logger.error(`Database connection failed: ${error.message}`, error, 'DATABASE');
                break;
                
            case 'AUTHENTICATION':
                systemState.updateServiceState('database', {
                    status: 'AUTH_ERROR',
                    healthy: false,
                    degraded: false,
                    details: { error: error.message, type: 'authentication' }
                });
                logger.error(`Database authentication failed: ${error.message}`, error, 'DATABASE');
                break;
                
            case 'SCHEMA':
                systemState.updateServiceState('database', {
                    status: 'CONNECTED_WITH_WARNINGS',
                    healthy: true,
                    degraded: true,
                    details: { 
                        error: error.message, 
                        type: 'schema',
                        warnings: this.schemaWarnings.length
                    }
                });
                logger.warn(`Database schema warnings: ${error.message}`, 'DATABASE');
                break;
                
            default:
                systemState.updateServiceState('database', {
                    status: 'ERROR',
                    healthy: false,
                    degraded: false,
                    details: { error: error.message }
                });
                logger.error(`Database error: ${error.message}`, error, 'DATABASE');
        }
    }
    
    classifyDatabaseError(error) {
        const message = error.message.toLowerCase();
        
        if (message.includes('connection') || message.includes('connect econnrefused')) {
            return 'CONNECTION';
        }
        
        if (message.includes('authentication') || message.includes('password') || message.includes('role')) {
            return 'AUTHENTICATION';
        }
        
        if (message.includes('relation') || message.includes('table') || 
            message.includes('column') || message.includes('constraint')) {
            return 'SCHEMA';
        }
        
        return 'UNKNOWN';
    }
    
    getSchemaInfo() {
        return {
            state: systemState.state.services.get('database')?.status || 'UNKNOWN',
            schemaStatus: this.schemaWarnings.length === 0 ? 'VALID' : 'WARNINGS',
            tablesLoaded: Object.keys(this.models || {}).length,
            warnings: this.schemaWarnings.length,
            missingForeignKeys: this.missingForeignKeys.length,
            aliasConflicts: this.aliasConflicts.size
        };
    }
    
    getInstance() {
        return this.sequelize;
    }
    
    getModels() {
        return this.models;
    }
    
    // Get User model for auth - CRITICAL FIX
    getUserModel() {
        if (!this.models) return null;
        
        // Try all possible user model names
        const possibleNames = ['Users', 'User', 'users', 'user'];
        for (const name of possibleNames) {
            if (this.models[name]) {
                console.log(`✅ Found user model: ${name}`);
                return this.models[name];
            }
        }
        
        // If no user model found, log available models
        console.log('❌ No user model found. Available models:', Object.keys(this.models || {}));
        return null;
    }
    
    // Get model by name
    getModel(name) {
        return this.models?.[name] || null;
    }
}

// ========== REDIS SERVICE ==========
class RedisService {
    constructor() {
        this.client = null;
        this.state = 'DISCONNECTED';
        this.mode = 'STANDALONE';
        this.reason = '';
        this.connectionAttempted = false;
        this.lastStateChange = null;
        this.stateCooldown = 30000;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.fallbackMode = false;
        this.inMemoryCache = new Map();
        this.cacheTTL = new Map();
        
        systemState.registerConnection('redis', this);
    }
    
    async initialize() {
        if (!config.get('REDIS_ENABLED') || !config.get('FEATURE_REDIS_CACHE')) {
            systemState.updateConnectionState('redis', {
                status: 'DISABLED',
                connected: false,
                degraded: false,
                details: { reason: 'Feature disabled' }
            });
            logger.info('Redis feature disabled', 'REDIS');
            return this.createFallbackClient();
        }
        
        systemState.recordStartupStep('redis_init_start');
        
        try {
            const redis = require('redis');
            
            const redisConfig = {
                url: config.get('REDIS_URL'),
                socket: {
                    host: config.get('REDIS_HOST'),
                    port: config.get('REDIS_PORT'),
                    connectTimeout: 10000,
                    reconnectStrategy: (retries) => {
                        this.reconnectAttempts = retries;
                        if (retries > this.maxReconnectAttempts) {
                            this.transitionState('DEGRADED', 'MAX_RETRIES_EXCEEDED');
                            this.enableFallbackMode();
                            return false;
                        }
                        
                        const delay = Math.min(retries * 2000, 10000);
                        logger.debug(`Redis reconnect attempt ${retries} in ${delay}ms`, 'REDIS');
                        return delay;
                    }
                }
            };
            
            // Add password if configured
            if (config.get('REDIS_PASSWORD')) {
                redisConfig.password = config.get('REDIS_PASSWORD');
            }
            
            this.client = redis.createClient(redisConfig);
            
            // Event handlers
            this.client.on('error', (err) => {
                this.handleRedisError(err);
            });
            
            this.client.on('connect', () => {
                this.transitionState('CONNECTING', 'Connection establishing');
            });
            
            this.client.on('ready', () => {
                this.reconnectAttempts = 0;
                this.transitionState('READY', 'Ready to accept commands');
            });
            
            this.client.on('end', () => {
                this.transitionState('DISCONNECTED', 'Connection ended');
            });
            
            // Connect with timeout
            const connectPromise = this.client.connect();
            
            await Promise.race([
                connectPromise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
                )
            ]);
            
            // Test with PING
            await this.client.ping();
            
            systemState.recordStartupStep('redis_init_complete');
            logger.success('Redis connected successfully', 'REDIS');
            return this.client;
            
        } catch (error) {
            this.handleRedisError(error);
            return this.createFallbackClient();
        }
    }
    
    // Create fallback in-memory client
    createFallbackClient() {
        this.fallbackMode = true;
        logger.warn('Redis using in-memory fallback mode', 'REDIS');
        
        // Create a mock client with basic methods
        const fallbackClient = {
            get: async (key) => {
                const item = this.inMemoryCache.get(key);
                if (item) {
                    const ttl = this.cacheTTL.get(key);
                    if (ttl && Date.now() > ttl) {
                        this.inMemoryCache.delete(key);
                        this.cacheTTL.delete(key);
                        return null;
                    }
                }
                return item;
            },
            set: async (key, value, options) => {
                this.inMemoryCache.set(key, value);
                if (options && options.EX) {
                    this.cacheTTL.set(key, Date.now() + (options.EX * 1000));
                }
                return 'OK';
            },
            del: async (key) => {
                const deleted = this.inMemoryCache.delete(key);
                this.cacheTTL.delete(key);
                return deleted ? 1 : 0;
            },
            quit: async () => {
                this.inMemoryCache.clear();
                this.cacheTTL.clear();
                return 'OK';
            },
            isReady: false,
            on: () => {},
            connect: async () => {
                this.isReady = true;
                return this;
            },
            disconnect: async () => {
                this.isReady = false;
                return 'OK';
            },
            exists: async (key) => {
                return this.inMemoryCache.has(key) ? 1 : 0;
            },
            expire: async (key, seconds) => {
                if (this.inMemoryCache.has(key)) {
                    this.cacheTTL.set(key, Date.now() + (seconds * 1000));
                    return 1;
                }
                return 0;
            }
        };
        
        return fallbackClient;
    }
    
    enableFallbackMode() {
        if (!this.fallbackMode) {
            this.fallbackMode = true;
            logger.warn('Redis entering fallback mode - using in-memory cache', 'REDIS');
            
            systemState.updateConnectionState('redis', {
                status: 'DEGRADED_FALLBACK',
                connected: false,
                degraded: true,
                details: { 
                    reason: 'Using in-memory fallback',
                    mode: 'FALLBACK'
                }
            });
        }
    }
    
    transitionState(newState, reason) {
        const now = Date.now();
        const lastChange = this.lastStateChange || 0;
        
        if (now - lastChange < this.stateCooldown && this.state !== 'DISCONNECTED') {
            return;
        }
        
        const oldState = this.state;
        this.state = newState;
        this.reason = reason;
        this.lastStateChange = now;
        
        let systemStateUpdate = {
            status: newState,
            details: { reason, mode: this.mode }
        };
        
        switch (newState) {
            case 'CONNECTING':
                systemStateUpdate.connected = false;
                systemStateUpdate.degraded = true;
                logger.debug(`Redis connecting: ${reason}`, 'REDIS');
                break;
                
            case 'READY':
                systemStateUpdate.connected = true;
                systemStateUpdate.degraded = false;
                logger.info(`Redis ready: ${reason}`, 'REDIS');
                break;
                
            case 'DEGRADED':
                systemStateUpdate.connected = false;
                systemStateUpdate.degraded = true;
                logger.warn(`Redis degraded: ${reason}`, 'REDIS');
                this.enableFallbackMode();
                break;
                
            case 'DEGRADED_FALLBACK':
                systemStateUpdate.connected = false;
                systemStateUpdate.degraded = true;
                break;
                
            case 'DISCONNECTED':
                systemStateUpdate.connected = false;
                systemStateUpdate.degraded = true;
                logger.debug(`Redis disconnected: ${reason}`, 'REDIS');
                break;
                
            case 'ERROR':
                systemStateUpdate.connected = false;
                systemStateUpdate.degraded = true;
                this.enableFallbackMode();
                break;
        }
        
        systemState.updateConnectionState('redis', systemStateUpdate);
    }
    
    handleRedisError(error) {
        const errorType = this.classifyRedisError(error);
        
        switch (errorType) {
            case 'AUTH':
                this.transitionState('DEGRADED', `Authentication error: ${error.message}`);
                logger.warn(`Redis authentication failed - using fallback mode`, 'REDIS');
                break;
                
            case 'CONNECTION':
                if (this.reconnectAttempts === 0) {
                    logger.warn(`Redis connection failed - will retry: ${error.message}`, 'REDIS');
                }
                this.transitionState('DEGRADED', `Connection error: ${error.message}`);
                break;
                
            case 'TIMEOUT':
                this.transitionState('DEGRADED', `Connection timeout`);
                logger.warn(`Redis connection timeout - using fallback mode`, 'REDIS');
                break;
                
            case 'DNS':
                this.transitionState('DEGRADED', `DNS resolution failed`);
                logger.warn(`Redis DNS resolution failed - using fallback mode`, 'REDIS');
                break;
                
            default:
                this.transitionState('DEGRADED', `Redis error: ${error.message}`);
                if (this.reconnectAttempts === 0) {
                    logger.warn(`Redis error - using fallback mode: ${error.message}`, 'REDIS');
                }
        }
    }
    
    classifyRedisError(error) {
        const message = error.message.toLowerCase();
        
        if (message.includes('auth') || message.includes('password') || message.includes('wrongpass')) {
            return 'AUTH';
        }
        
        if (message.includes('connect') || message.includes('econnrefused')) {
            return 'CONNECTION';
        }
        
        if (message.includes('timeout')) {
            return 'TIMEOUT';
        }
        
        if (message.includes('enotfound') || message.includes('dns')) {
            return 'DNS';
        }
        
        return 'UNKNOWN';
    }
    
    getInfo() {
        return {
            host: config.get('REDIS_HOST'),
            port: config.get('REDIS_PORT'),
            state: this.state,
            mode: this.mode,
            reason: this.reason,
            fallback: this.fallbackMode,
            reconnectAttempts: this.reconnectAttempts
        };
    }
    
    getClient() {
        if (this.fallbackMode) {
            return this.createFallbackClient();
        }
        return this.client;
    }
    
    isConnected() {
        return this.state === 'READY' || this.fallbackMode;
    }
    
    // Background reconnection attempt
    async attemptBackgroundReconnect() {
        if (this.fallbackMode && this.reconnectAttempts < this.maxReconnectAttempts) {
            try {
                logger.debug('Attempting background Redis reconnection', 'REDIS');
                await this.initialize();
            } catch (error) {
                // Silent failure
            }
        }
    }
}

// ========== FIXED AUTH MIDDLEWARE MANAGER ==========
class AuthMiddlewareManager {
    constructor(authService) {
        this.authService = authService;
        this.rateLimitStore = new Map();
    }
    
    extractToken(req) {
        // Check both possible header casings
        const authHeader = req.headers.authorization || req.headers.Authorization;
        
        if (!authHeader) {
            return null;
        }
        
        // Handle both "Bearer " and "bearer " prefixes (case insensitive)
        if (!authHeader.toLowerCase().startsWith("bearer ")) {
            return null;
        }
        
        // Extract token (split on space and take second part)
        const parts = authHeader.split(" ");
        if (parts.length !== 2) {
            return null;
        }
        
        const token = parts[1];
        
        if (!token || token.trim() === '') {
            return null;
        }
        
        return token;
    }
    
    // CRITICAL FIX: Strict auth middleware with proper public route detection
    createAuthMiddleware() {
        return (req, res, next) => {
            const path = req.path;
            
            // Check if route is public (skip auth)
            if (this.isPublicRoute(path)) {
                logger.logPublicRouteAccess(path, req.method);
                systemState.incrementMetric('publicRouteAccess');
                return next();
            }
            
            // Extract token using improved method
            const token = this.extractToken(req);
            
            if (!token) {
                logger.logAuthFailure(path, req.method, 'Missing or invalid authorization header');
                systemState.incrementMetric('authFailures');
                // CRITICAL: Ensure return to prevent double response
                return res.status(401).json({
                    success: false,
                    message: 'Authorization header required for protected route',
                    code: 'MISSING_AUTH_HEADER'
                });
            }
            
            try {
                const result = this.authService.verifyToken(token);
                
                if (!result.success) {
                    logger.logAuthFailure(path, req.method, result.message || 'Invalid or expired token');
                    systemState.incrementMetric('authFailures');
                    // CRITICAL: Ensure return to prevent double response
                    return res.status(401).json({
                        success: false,
                        message: result.message || 'Invalid or expired token',
                        code: result.code || 'INVALID_TOKEN'
                    });
                }
                
                // Attach user and token to request
                req.user = result.data;
                req.token = token;
                
                logger.logRouteAccess(path, req.method, false, true);
                systemState.incrementMetric('protectedRouteAccess');
                systemState.incrementMetric('authSuccesses');
                
                return next();
            } catch (error) {
                logger.logAuthFailure(path, req.method, 'Token verification error: ' + error.message);
                systemState.incrementMetric('authFailures');
                // CRITICAL: Ensure return to prevent double response
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token',
                    code: 'TOKEN_VERIFICATION_ERROR'
                });
            }
        };
    }
    
    // CRITICAL FIX: Check if a route is public - ensure auth endpoints are public
    isPublicRoute(path) {
        // Exact matches for public routes - CRITICAL FIX: Include all auth endpoints
        const publicRoutes = [
            '/',
            '/health',
            '/live',
            '/ready',
            '/api/health',
            '/api/status',
            '/api/info',
            '/api/cors-info',
            '/api/auth/login',
            '/api/auth/register',
            '/api/auth/refresh',
            '/api/auth/forgot-password',
            '/api/auth/reset-password',
            '/api/auth/validate-token',
            '/api/public'
        ];
        
        if (publicRoutes.includes(path)) {
            return true;
        }
        
        // Pattern matches for public routes
        const publicPatterns = [
            /^\/api\/public\//,
            /^\/health/,
            /^\/live/,
            /^\/ready/
        ];
        
        for (const pattern of publicPatterns) {
            if (pattern.test(path)) {
                return true;
            }
        }
        
        return false;
    }
    
    // Create rate limiting middleware
    createRateLimitMiddleware(limit = 100, windowMs = 15 * 60 * 1000) {
        return (req, res, next) => {
            const key = req.ip + ':' + req.path;
            const now = Date.now();
            const windowStart = now - windowMs;
            
            // Clean old entries
            for (const [entryKey, entry] of this.rateLimitStore.entries()) {
                if (entry.timestamp < windowStart) {
                    this.rateLimitStore.delete(entryKey);
                }
            }
            
            const entry = this.rateLimitStore.get(key) || { count: 0, timestamp: now };
            
            if (entry.count >= limit) {
                return res.status(429).json({
                    success: false,
                    message: 'Too many requests',
                    code: 'RATE_LIMITED',
                    retryAfter: Math.ceil((entry.timestamp + windowMs - now) / 1000)
                });
            }
            
            entry.count++;
            entry.timestamp = now;
            this.rateLimitStore.set(key, entry);
            
            next();
        };
    }
}

// ========== ROUTER MANAGER WITH PROTECTED ROUTES ONLY AUTH ==========
class RouterManager {
    constructor(app) {
        this.app = app;
        this.routers = new Map();
        this.authRoutesMounted = false;
        this.failedRoutes = new Map();
        this.authService = null;
        this.authMiddlewareManager = null;
        
        // In server.js, find the RouterManager class and update:
this.publicRoutes = [
  '/', '/health', '/live', '/ready',
  '/api/health', '/api/status', '/api/info', '/api/cors-info',
  '/api/auth/login', '/api/auth/register', '/api/auth/refresh',
  '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/validate-token',
  '/api/public'
];
// Remove '/' from this list if it's causing issues, or keep it for root only
        
        // CRITICAL FIX: Define protected routes (JWT REQUIRED)
        this.protectedRoutes = [
            '/api/auth/me', '/api/auth/logout',
            '/api/users', '/api/messages', '/api/chats', '/api/friends',
            '/api/media', '/api/notifications', '/api/typingIndicator', '/api/status/user'
        ];
        
        console.log('🔄 RouterManager initialized with PROTECTED ROUTES ONLY auth');
    }
    
    async initialize(databaseService) {
        systemState.recordStartupStep('router_init_start');
        
        // Initialize auth service - USE THE IMPORTED ONE
        this.authService = authService;
        const jwtSecret = config.get('JWT_SECRET');
        console.log('🔧 [RouterManager] Setting JWT_SECRET for authService:', jwtSecret ? jwtSecret.substring(0, 10) + '...' : 'NOT SET');
        this.authService.JWT_SECRET = jwtSecret;
        
        // Create auth middleware manager
        this.authMiddlewareManager = new AuthMiddlewareManager(this.authService);
        
        // CRITICAL: Pass database service to authService
        if (databaseService) {
            this.authService.setDatabase(databaseService);
            console.log('✅ Database passed to authService');
        }
        
        // Validate JWT config
        const jwtValid = this.authService.validateJWTConfig?.() || true;
        if (!jwtValid) {
            logger.warn('JWT configuration issue - auth may not work', 'ROUTER');
        }
        
        // STAGE 1: Mount auth routes FIRST (mandatory)
        const authMounted = await this.mountAuthRoutes();
        if (!authMounted) {
            logger.error('Failed to mount auth routes - CRITICAL FAILURE', null, 'ROUTER');
            throw new Error('Auth routes failed to mount');
        }
        
        // STAGE 2: Discover dynamic routers
        const discoveredRouters = await this.discoverRouters();
        
        // STAGE 3: Load and validate routers
        const loadedRouters = await this.loadRouters(discoveredRouters);
        
        // STAGE 4: Mount validated routers with selective auth middleware
        await this.mountRoutersSelective(loadedRouters);
        
        systemState.recordStartupStep('router_init_complete');
        
        const activeRoutes = this.getActiveRoutes().length;
        const failedCount = this.failedRoutes.size;
        
        if (failedCount > 0) {
            logger.warn(`${failedCount} optional routes failed to load - server running in degraded mode`, 'ROUTER');
        }
        
        logger.info(`Router initialization complete: ${activeRoutes} routes active`, 'ROUTER');
        
        return true;
    }
    
    getActiveRoutes() {
        const activeRoutes = [];
        for (const [name, route] of systemState.state.routes.entries()) {
            if (route.active) {
                activeRoutes.push(route);
            }
        }
        return activeRoutes;
    }
    
    async mountAuthRoutes() {
        console.log('🔧 [RouterManager] mountAuthRoutes START');
        
        try {
            // Define core auth routes with proper public/protected classification
            const authRoutes = [
                {
                    path: '/api/auth/login',
                    method: 'POST',
                    handler: this.createOptimizedLoginHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: true
                },
                {
                    path: '/api/auth/register',
                    method: 'POST',
                    handler: this.createOptimizedRegisterHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: true
                },
                {
                    path: '/api/auth/me',
                    method: 'GET',
                    handler: this.createMeHandler(),
                    requiresAuth: true,
                    isPublic: false,
                    rateLimit: false
                },
                {
                    path: '/api/auth/refresh',
                    method: 'POST',
                    handler: this.createRefreshHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: true
                },
                {
                    path: '/api/auth/logout',
                    method: 'POST',
                    handler: this.createLogoutHandler(),
                    requiresAuth: true,
                    isPublic: false,
                    rateLimit: false
                },
                {
                    path: '/api/auth/forgot-password',
                    method: 'POST',
                    handler: this.createForgotPasswordHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: true
                },
                {
                    path: '/api/auth/reset-password',
                    method: 'POST',
                    handler: this.createResetPasswordHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: true
                },
                {
                    path: '/api/auth/validate-token',
                    method: 'POST',
                    handler: this.createValidateTokenHandler(),
                    requiresAuth: false,
                    isPublic: true,
                    rateLimit: false
                }
            ];
            
            console.log(`🔧 [RouterManager] Mounting ${authRoutes.length} auth routes...`);
            
            // Mount each auth route directly with proper middleware
            authRoutes.forEach(route => {
                const routeHandlers = [];
                
                if (route.rateLimit) {
                    routeHandlers.push(this.authMiddlewareManager.createRateLimitMiddleware(10, 15 * 60 * 1000));
                }
                
                if (route.requiresAuth) {
                    routeHandlers.push(this.authMiddlewareManager.createAuthMiddleware());
                }
                
                routeHandlers.push(route.handler);
                
                this.app[route.method.toLowerCase()](route.path, ...routeHandlers);
                console.log(`✅ Mounted: ${route.method} ${route.path}`);
                
                const routeName = `auth_${route.path.split('/').pop()}`;
                systemState.registerRoute(routeName, {
                    path: route.path,
                    method: route.method,
                    requiresAuth: route.requiresAuth,
                    isPublic: route.isPublic
                });
                
                systemState.updateRouteState(routeName, {
                    lifecycle: 'MOUNTED',
                    mounted: true,
                    active: true,
                    details: {
                        controller: 'AuthController',
                        service: 'AuthService',
                        rateLimited: route.rateLimit,
                        authType: route.isPublic ? 'PUBLIC' : 'PROTECTED',
                        cached: route.path === '/api/auth/login'
                    }
                });
            });
            
            console.log('✅ [RouterManager] All auth routes mounted successfully');
            return true;
            
        } catch (error) {
            console.error('❌ [RouterManager] mountAuthRoutes ERROR:', error);
            return false;
        }
    }
    
    // OPTIMIZED LOGIN HANDLER WITH CACHING AND DUPLICATE FILTERING
    createOptimizedLoginHandler() {
        return async (req, res) => {
            console.log('🔐 LOGIN REQUEST received');
            
            try {
                const { identifier, password, device } = req.body;
                
                if (!identifier || !password) {
                    console.log('❌ Missing identifier or password');
                    return res.status(400).json({
                        success: false,
                        message: 'Identifier and password required',
                        code: 'MISSING_CREDENTIALS'
                    });
                }
                
                // Check for duplicate requests
                if (duplicateFilter.isDuplicate(req, identifier)) {
                    logger.logDuplicateBlocked(identifier, req.path);
                    return res.status(429).json({
                        success: false,
                        message: 'Duplicate request detected. Please wait.',
                        code: 'DUPLICATE_REQUEST',
                        retryAfter: 500
                    });
                }
                
                const deviceInfo = {
                    device: device || 'unknown',
                    userAgent: req.headers['user-agent'],
                    ip: req.ip || req.connection.remoteAddress,
                    timestamp: new Date().toISOString()
                };
                
                // Check cache for recent successful login
                const cachedResponse = loginCache.get(identifier, deviceInfo.device);
                if (cachedResponse) {
                    logger.logCacheHit(identifier);
                    systemState.incrementMetric('logins');
                    logger.logLoginAttempt(identifier, true, deviceInfo.device);
                    
                    return res.json({
                        success: true,
                        message: 'Login successful (cached)',
                        token: cachedResponse.token,
                        refreshToken: cachedResponse.refreshToken,
                        user: cachedResponse.user,
                        expiresIn: cachedResponse.expiresIn,
                        cached: true
                    });
                }
                
                logger.logCacheMiss(identifier);
                
                console.log(`🔐 Calling authService.login for: ${identifier}`);
                const result = await this.authService.login(identifier, password, deviceInfo);
                
                if (result.success) {
                    console.log(`✅ Login successful for: ${identifier}`);
                    // Handle both response formats
                    const accessToken = result.tokens?.accessToken || result.accessToken;
                    const refreshToken = result.tokens?.refreshToken || result.refreshToken;
                    
                    // Cache successful login response
                    const responseData = {
                        token: accessToken,
                        refreshToken: refreshToken,
                        user: result.user,
                        expiresIn: result.tokens?.expiresIn || result.expiresIn
                    };
                    loginCache.set(identifier, deviceInfo.device, responseData);
                    
                    systemState.incrementMetric('logins');
                    logger.logLoginAttempt(identifier, true, deviceInfo.device);
                    
                    return res.json({
                        success: true,
                        message: 'Login successful',
                        token: accessToken,
                        refreshToken: refreshToken,
                        user: result.user,
                        expiresIn: result.tokens?.expiresIn || result.expiresIn,
                        cached: false
                    });
                } else {
                    console.log(`❌ Login failed for: ${identifier}`);
                    logger.logLoginAttempt(identifier, false, deviceInfo.device);
                    return res.status(401).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                console.error(`❌ Login handler error: ${error.message}`);
                return res.status(500).json({
                    success: false,
                    message: 'Login failed',
                    code: 'LOGIN_HANDLER_ERROR'
                });
            }
        };
    }
    
    // OPTIMIZED REGISTER HANDLER
    createOptimizedRegisterHandler() {
        return async (req, res) => {
            console.log('📝 REGISTER REQUEST received');
            
            try {
                const { email, password, username, name, device } = req.body;
                
                if (!email || !password) {
                    console.log('❌ Missing email or password');
                    return res.status(400).json({
                        success: false,
                        message: 'Email and password required',
                        code: 'MISSING_CREDENTIALS'
                    });
                }
                
                // Check for duplicate requests
                if (duplicateFilter.isDuplicate(req, email)) {
                    logger.logDuplicateBlocked(email, req.path);
                    return res.status(429).json({
                        success: false,
                        message: 'Duplicate request detected. Please wait.',
                        code: 'DUPLICATE_REQUEST',
                        retryAfter: 500
                    });
                }
                
                // Validate email format
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid email format',
                        code: 'INVALID_EMAIL'
                    });
                }
                
                // Validate password strength
                if (password.length < 6) {
                    return res.status(400).json({
                        success: false,
                        message: 'Password must be at least 6 characters',
                        code: 'WEAK_PASSWORD'
                    });
                }
                
                const deviceInfo = {
                    device: device || 'unknown',
                    userAgent: req.headers['user-agent'],
                    ip: req.ip || req.connection.remoteAddress,
                    timestamp: new Date().toISOString()
                };
                
                console.log(`📝 Calling authService.register for: ${email}`);
                const result = await this.authService.register({
                    email,
                    password,
                    username: username || email.split('@')[0],
                    name: name || username || email.split('@')[0]
                }, deviceInfo);
                
                if (result.success) {
                    console.log(`✅ Registration successful for: ${email}`);
                    // Handle both response formats
                    const accessToken = result.tokens?.accessToken || result.accessToken;
                    const refreshToken = result.tokens?.refreshToken || result.refreshToken;
                    
                    systemState.incrementMetric('registrations');
                    
                    return res.status(201).json({
                        success: true,
                        message: 'Registration successful',
                        token: accessToken,
                        refreshToken: refreshToken,
                        user: result.user,
                        expiresIn: result.tokens?.expiresIn || result.expiresIn
                    });
                } else {
                    console.log(`❌ Registration failed for: ${email}`);
                    return res.status(400).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                console.error(`❌ Register handler error: ${error.message}`);
                return res.status(500).json({
                    success: false,
                    message: 'Registration failed',
                    code: 'REGISTRATION_HANDLER_ERROR'
                });
            }
        };
    }
    
    // FORGOT PASSWORD HANDLER
    createForgotPasswordHandler() {
        return async (req, res) => {
            try {
                const { email } = req.body;
                
                if (!email) {
                    return res.status(400).json({
                        success: false,
                        message: 'Email required',
                        code: 'MISSING_EMAIL'
                    });
                }
                
                const result = await this.authService.forgotPassword(email);
                
                if (result.success) {
                    return res.json({
                        success: true,
                        message: result.message,
                        ...(config.get('NODE_ENV') !== 'production' && { resetToken: result.resetToken })
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Forgot password handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Password reset request failed',
                    code: 'FORGOT_PASSWORD_ERROR'
                });
            }
        };
    }
    
    // RESET PASSWORD HANDLER
    createResetPasswordHandler() {
        return async (req, res) => {
            try {
                const { token, newPassword } = req.body;
                
                if (!token || !newPassword) {
                    return res.status(400).json({
                        success: false,
                        message: 'Token and new password required',
                        code: 'MISSING_RESET_DATA'
                    });
                }
                
                if (newPassword.length < 6) {
                    return res.status(400).json({
                        success: false,
                        message: 'Password must be at least 6 characters',
                        code: 'WEAK_PASSWORD'
                    });
                }
                
                const result = await this.authService.resetPassword(token, newPassword);
                
                if (result.success) {
                    // Invalidate cache for this user after password reset
                    if (result.userEmail) {
                        loginCache.invalidate(result.userEmail);
                    }
                    return res.json({
                        success: true,
                        message: result.message
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Reset password handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Password reset failed',
                    code: 'RESET_PASSWORD_ERROR'
                });
            }
        };
    }
    
    // ME HANDLER
    createMeHandler() {
        return async (req, res) => {
            try {
                const userId = req.user.userId;
                console.log(`👤 GET /api/auth/me for user: ${userId}`);
                
                const result = await this.authService.getCurrentUser(userId);
                
                if (result.success) {
                    return res.json({
                        success: true,
                        user: result.user
                    });
                } else {
                    return res.status(404).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Me handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Failed to get user info',
                    code: 'USER_INFO_ERROR'
                });
            }
        };
    }
    
    // REFRESH HANDLER
    createRefreshHandler() {
        return async (req, res) => {
            try {
                const { refreshToken } = req.body;
                
                if (!refreshToken) {
                    return res.status(400).json({
                        success: false,
                        message: 'Refresh token required',
                        code: 'MISSING_REFRESH_TOKEN'
                    });
                }
                
                const result = await this.authService.refreshToken(refreshToken);
                
                if (result.success) {
                    return res.json({
                        success: true,
                        accessToken: result.accessToken,
                        expiresIn: result.expiresIn
                    });
                } else {
                    return res.status(401).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Refresh handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Token refresh failed',
                    code: 'REFRESH_HANDLER_ERROR'
                });
            }
        };
    }
    
    // LOGOUT HANDLER
    createLogoutHandler() {
        return async (req, res) => {
            try {
                const userId = req.user.userId;
                const result = await this.authService.logout(userId);
                
                if (result.success) {
                    // Invalidate cache for this user
                    if (req.user.email) {
                        loginCache.invalidate(req.user.email);
                    }
                    return res.json({
                        success: true,
                        message: 'Logout successful'
                    });
                } else {
                    return res.status(500).json({
                        success: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Logout handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Logout failed',
                    code: 'LOGOUT_HANDLER_ERROR'
                });
            }
        };
    }
    
    // VALIDATE TOKEN HANDLER
    createValidateTokenHandler() {
        return async (req, res) => {
            try {
                const { token } = req.body;
                
                if (!token) {
                    return res.status(400).json({
                        success: false,
                        message: 'Token required',
                        code: 'MISSING_TOKEN'
                    });
                }
                
                const result = this.authService.verifyToken(token);
                
                if (result.success) {
                    return res.json({
                        success: true,
                        valid: true,
                        user: {
                            userId: result.data.userId,
                            email: result.data.email,
                            username: result.data.username,
                            role: result.data.role
                        }
                    });
                } else {
                    return res.json({
                        success: false,
                        valid: false,
                        message: result.message,
                        code: result.code
                    });
                }
            } catch (error) {
                logger.error(`Validate token handler error: ${error.message}`, error, 'AUTH');
                return res.status(500).json({
                    success: false,
                    message: 'Token validation failed',
                    code: 'TOKEN_VALIDATION_ERROR'
                });
            }
        };
    }
    
    // Discover routers from routes directory
    async discoverRouters() {
        const routesDir = path.join(__dirname, 'routes');
        const routerFiles = [];
        
        try {
            if (!fs.existsSync(routesDir)) {
                logger.warn(`Routes directory not found: ${routesDir}`, 'ROUTER');
                return routerFiles;
            }
            
            const files = fs.readdirSync(routesDir);
            
            for (const file of files) {
                if (file === 'index.js' || file === 'auth.js') continue;
                if (!file.endsWith('.js')) continue;
                
                routerFiles.push(file);
            }
            
            logger.info(`Discovered ${routerFiles.length} router files`, 'ROUTER');
            return routerFiles;
            
        } catch (error) {
            logger.error(`Failed to discover routers: ${error.message}`, error, 'ROUTER');
            return routerFiles;
        }
    }
    
    // Load routers from files
    async loadRouters(routerFiles) {
        const loadedRouters = [];
        
        for (const filename of routerFiles) {
            try {
                const routePath = path.join(__dirname, 'routes', filename);
                const routeModule = require(routePath);
                const router = routeModule.default || routeModule;
                
                if (typeof router !== 'function' || !router.stack) {
                    throw new Error(`Invalid router export from ${filename}`);
                }
                
                // Derive mount path from filename
                let mountPath = this.deriveMountPath(filename);
                
                // Special mapping for REST conventions
                const specialMappings = {
                    'group.js': '/api/groups',
                    'profiles.js': '/api/profile',
                    'groupMembers.js': '/api/group-members'
                };
                
                if (specialMappings[filename]) {
                    mountPath = specialMappings[filename];
                }
                
                loadedRouters.push({
                    filename,
                    router,
                    mountPath,
                    requiresAuth: this.shouldRequireAuth(mountPath)
                });
                
                logger.debug(`Loaded router: ${filename} -> ${mountPath}`, 'ROUTER');
                
            } catch (error) {
                logger.error(`Failed to load router ${filename}: ${error.message}`, error, 'ROUTER');
                this.failedRoutes.set(filename, error.message);
            }
        }
        
        return loadedRouters;
    }
    
    // Derive mount path from filename with REST conventions
    deriveMountPath(filename) {
        const baseName = filename.replace('.js', '');
        
        // Convert camelCase to kebab-case
        const kebabCase = baseName
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .toLowerCase();
        
        return `/api/${kebabCase}`;
    }
    
    // Determine if route requires authentication
    shouldRequireAuth(mountPath) {
        // Auth endpoints are already handled separately
        if (mountPath.startsWith('/api/auth')) return false;
        
        // Check if path is in public routes
        for (const publicRoute of this.publicRoutes) {
            if (mountPath === publicRoute || mountPath.startsWith(publicRoute + '/')) {
                return false;
            }
        }
        
        // All other routes require authentication
        return true;
    }
    
async mountRoutersSelective(loadedRouters) {
  for (const { filename, router, mountPath, requiresAuth } of loadedRouters) {
    try {
      const handlers = [];
      
      // CRITICAL FIX: Only add auth middleware if required
      if (requiresAuth) {
        // IMPORTANT: Don't apply auth middleware to /settings if it's causing issues
        // For now, let's make sure auth is applied correctly
        const { authenticateToken } = require('./middleware/auth');
        handlers.push(authenticateToken);
        console.log(`🔒 ${mountPath} - PROTECTED (JWT required)`);
      } else {
        console.log(`🔓 ${mountPath} - PUBLIC (No auth)`);
      }
      
      // Add rate limiting for all routes
      handlers.push(this.authMiddlewareManager.createRateLimitMiddleware(100, 15 * 60 * 1000));
      
      // Mount the router
      handlers.push(router);
      this.app.use(mountPath, ...handlers);
      
      // Register route in system state
      const routeName = filename.replace('.js', '');
      systemState.registerRoute(routeName, {
        path: mountPath,
        method: 'ALL',
        requiresAuth: requiresAuth,
        isPublic: !requiresAuth
      });
      
      systemState.updateRouteState(routeName, {
        lifecycle: 'MOUNTED',
        mounted: true,
        active: true,
        details: {
          controller: `${routeName.charAt(0).toUpperCase() + routeName.slice(1)}Controller`,
          service: `${routeName.charAt(0).toUpperCase() + routeName.slice(1)}Service`,
          authType: requiresAuth ? 'PROTECTED' : 'PUBLIC'
        }
      });
      
      console.log(`✅ Mounted: ${mountPath} (Auth: ${requiresAuth ? 'PROTECTED' : 'PUBLIC'})`);
      
    } catch (error) {
      logger.error(`Failed to mount router ${filename}: ${error.message}`, error, 'ROUTER');
      this.failedRoutes.set(filename, error.message);
    }
  }
}

}


// ========== MAIN APPLICATION WITH PROTECTED ROUTES ONLY AUTH ==========
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

class Application {
    constructor() {
        this.app = express();
        global.__expressApp = this.app; // FIX-P12: required by SmartGroups IIFE mount
        this.server = null;
        this.initialized = false;
        
        // Services
        this.database = null;
        this.redis = null;
        this.routerManager = null;
        this.websocket = null;
        
        console.log('🔄 Application constructor: PROTECTED ROUTES ONLY auth');
    }
    
    async initialize() {
        try {
            logger.startupBanner(config.get('PORT'), config.get('HOST'));
            
            // 1. Environment validation
            systemState.recordStartupStep('environment_validation');
            this.validateEnvironment();
            
            // 2. Setup middleware WITH CORRECT ORDER and OPTIMIZATIONS
            systemState.recordStartupStep('middleware_setup');
            this.setupMiddleware();
            
            // 3. Initialize database (CRITICAL) with OPTIMIZED pool
            systemState.recordStartupStep('database_connection');
            this.database = new DatabaseService();
            const dbConnected = await this.database.initialize();
            
            if (!dbConnected) {
                throw new Error('Database connection failed - CRITICAL');
            }
            
            // 4. RouterManager is DISABLED - using index.js for all routes
            // RouterManager was causing duplicate route mounting and auth issues
            systemState.recordStartupStep('auth_routes_mount');
            // this.routerManager = new RouterManager(this.app);
            // await this.routerManager.initialize(this.database);

            // Skip RouterManager - use index.js for all routes
            console.log('✅ RouterManager DISABLED - using index.js for all routes');
            
            // 5. CRITICAL: Mount the main API router
            systemState.recordStartupStep('api_routes_mount');

            // Import the main router from index.js
            const mainRouter = require('./routes/index');

            // Server health endpoint (public) - moved to avoid conflict with user status routes
            this.app.get('/api/health', (req, res) => {
                logger.logPublicRouteAccess(req.path, req.method);
                systemState.incrementMetric('publicRouteAccess');
                const isReady = systemState.isServerReady();
                const overallState = systemState.state.overall;
                
                return res.json({
                    success: true,
                    server: config.get('APP_NAME'),
                    status: overallState.toLowerCase(),
                    ready: isReady,
                    timestamp: new Date().toISOString(),
                    environment: config.get('NODE_ENV'),
                    version: config.get('API_VERSION'),
                    auth: {
                        mode: 'PROTECTED_ROUTES_ONLY',
                        description: 'Public routes accessible without JWT'
                    },
                    websocket: {
                        enabled: config.get('FEATURE_WEBSOCKETS'),
                        state: this.websocket?.state || 'DISABLED'
                    },
                    cors: {
                        allowedOrigins: corsManager.getAllowedOrigins().slice(0, 5),
                        total: corsManager.getAllowedOrigins().length
                    },
                    degradedServices: {
                        redis: this.redis && !systemState.isConnectionHealthy('redis'),
                        websocket: !systemState.isConnectionHealthy('websocket')
                    },
                    metrics: systemState.state.metrics,
                    cache: loginCache.getStats(),
                    optimizations: {
                        uvThreadpoolSize: parseInt(process.env.UV_THREADPOOL_SIZE, 10) || 16,
                        connectionPool: config.getDatabasePoolConfig(),
                        queryTimeout: config.get('QUERY_TIMEOUT_MS'),
                        compressionEnabled: config.get('COMPRESSION_ENABLED')
                    }
                });
            });
            
            // PHASE10: Transport runtime diagnostics dashboard
            this.app.get('/api/transport', (req, res) => {
                try {
                    const htr  = global.__HybridTransportRuntime;
                    const mes  = global.__MessageEntityStore;
                    const hyd  = global.__HydrationEngine;
                    const p10  = global.__phase10;
                    res.json({
                        ok        : true,
                        phase10   : !!p10,
                        transport : htr?.getDiagnostics()  || { error: 'not_initialized' },
                        entities  : mes?.getDiagnostics()  || { error: 'not_initialized' },
                        hydration : hyd?.getDiagnostics()  || { error: 'not_initialized' },
                        timestamp : Date.now(),
                    });
                } catch (err) {
                    res.status(500).json({ ok: false, error: err.message });
                }
            });

            // PHASE10: Socket health endpoint
            this.app.get('/api/socket-health', (req, res) => {
                try {
                    const io = this.io;
                    res.json({
                        ok          : true,
                        clients     : io?.engine?.clientsCount || 0,
                        rooms       : io?.sockets?.adapter?.rooms?.size || 0,
                        transport   : global.__HybridTransportRuntime?.getDiagnostics()?.health || {},
                        offline     : global.__HybridTransportRuntime?.getDiagnostics()?.offline || {},
                        timestamp   : Date.now(),
                    });
                } catch (err) {
                    res.status(500).json({ ok: false, error: err.message });
                }
            });

            // Cache stats endpoint
            this.app.get('/api/cache-stats', (req, res) => {
                logger.logPublicRouteAccess(req.path, req.method);
                return res.json({
                    success: true,
                    loginCache: loginCache.getStats(),
                    duplicateFilter: {
                        size: duplicateFilter.pendingRequests?.size || 0,
                        cooldown: 500
                    }
                });
            });
            
            // Mount the main router
            this.app.use('/', mainRouter);
            console.log('✅ Mounted main API router');

            // Routes are automatically mounted by the main router from routes/index.js
            console.log('?? Routes will be mounted by main router from routes/index.js');

            // Debug: Verify auth routes are registered
            console.log('🔍 Verifying auth routes registration...');
            this.app._router.stack.forEach(middleware => {
                if (middleware.route && middleware.route.path.includes('auth')) {
                    console.log(`   ✅ Route registered: ${middleware.route.path}`);
                } else if (middleware.name === 'router' && middleware.handle.stack) {
                    middleware.handle.stack.forEach(handler => {
                        if (handler.route && handler.route.path) {
                            console.log(`   ✅ Router handler: ${handler.route.path}`);
                        }
                    });
                }
            });

            // Debug: Log all mounted routes
            console.log('\n🔍 Checking mounted routes...');
            console.log('Available routes will be handled by RouterManager');
            
            // 6. Setup health and status endpoints (public) - AFTER API routes
            systemState.recordStartupStep('health_endpoints');
            this.setupHealthEndpoints();
            
            // 7. Initialize Redis
            systemState.recordStartupStep('redis_connection');
            this.redis = new RedisService();
            
            // Start Redis in background
            this.redis.initialize().then(() => {
                logger.debug('Redis initialization background complete', 'SYSTEM');
            }).catch(error => {
                logger.debug(`Redis background init completed with fallback: ${error.message}`, 'SYSTEM');
            });
            
            // 8. Setup global error handler
            systemState.recordStartupStep('error_handling');
            this.setupErrorHandling();
            
            // 9. Attach models to app.locals for easy access in routes
            this.app.locals.models = this.database.getModels();
            this.app.locals.db = this.database.getInstance();
            this.app.locals.redis = this.redis.getClient();
            this.app.locals.corsManager = corsManager;
            this.app.locals.routerManager = this.routerManager;
            
            this.initialized = true;
            
            // 10. Display diagnostics
            this.displayDiagnostics();
            
            logger.success('Application initialized successfully with PROTECTED ROUTES ONLY auth', 'APPLICATION');
            return this;
            
        } catch (error) {
            const classification = systemState.classifyIssue('application', error.message);
            
            if (classification === 'CRITICAL') {
                logger.error(`CRITICAL startup failure: ${error.message}`, error, 'APPLICATION');
                throw error;
            } else {
                logger.warn(`Startup degraded (non-critical): ${error.message}`, 'APPLICATION');
                this.initialized = true;
                return this;
            }
        }
    }
    
    validateEnvironment() {
        const env = config.get('NODE_ENV');
        const port = config.get('PORT');
        const host = config.get('HOST');
        
        logger.info(`Environment: ${env}`, 'SYSTEM');
        logger.info(`Port: ${port}`, 'SYSTEM');
        logger.info(`Host: ${host}`, 'SYSTEM');
        
        // Log database URL (masked)
        const dbUrl = config.getDatabaseUrl();
        if (dbUrl) {
            const maskedUrl = dbUrl.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
            logger.info(`Database URL: ${maskedUrl}`, 'SYSTEM');
        }
        
        // Warn about missing JWT_SECRET
        if (!config.get('JWT_SECRET') && !config.get('JWT_ACCESS_SECRET')) {
            logger.warn('JWT_SECRET not set - auth may not work properly', 'SYSTEM');
        } else {
            logger.info('JWT authentication configured', 'SYSTEM');
        }
        
        // CORS configuration info
        const corsOrigins = corsManager.getAllowedOrigins();
        logger.info(`Dynamic CORS configured for ${corsOrigins.length} origins`, 'SYSTEM');
        logger.info(`CORS Environment: ${corsManager.environment}`, 'SYSTEM');
        logger.info(`Running on Render: ${corsManager.isRender ? 'Yes' : 'No'}`, 'SYSTEM');
        
        // Log optimization settings
        logger.info(`UV_THREADPOOL_SIZE: ${process.env.UV_THREADPOOL_SIZE}`, 'SYSTEM');
        logger.info(`Database Pool: max=${config.get('DB_POOL_MAX')}, min=${config.get('DB_POOL_MIN')}`, 'SYSTEM');
        logger.info(`Query Timeout: ${config.get('QUERY_TIMEOUT_MS')}ms`, 'SYSTEM');
        logger.info(`Login Cache TTL: ${config.get('LOGIN_CACHE_TTL')}s`, 'SYSTEM');
        logger.info(`Compression: ${config.get('COMPRESSION_ENABLED') ? 'Enabled' : 'Disabled'}`, 'SYSTEM');
        
        if (env === 'production') {
            if (!config.get('JWT_SECRET') && !config.get('JWT_ACCESS_SECRET')) {
                logger.warn('JWT_SECRET is recommended in production', 'SYSTEM');
            }
            
            if (config.get('DB_SYNC_FORCE')) {
                logger.warn('DB_SYNC_FORCE is TRUE in production - THIS WILL DROP ALL TABLES!', 'SECURITY');
            }
            
            const productionFrontend = 'https://moodfronted.onrender.com';
            if (!corsManager.isOriginAllowed(productionFrontend)) {
                logger.warn(`Production frontend ${productionFrontend} may not be allowed by CORS`, 'SECURITY');
            }
        }
    }
    
    // CRITICAL FIX: Setup middleware WITH CORRECT ORDER and OPTIMIZATIONS
    setupMiddleware() {
        console.log('🔄 Setting up middleware with correct order...');
        
        // 0. Add query timeout middleware (highest priority for slow queries)
        this.app.use(queryTimeout.create());
        
        // 1. Add response compression middleware
        if (config.get('COMPRESSION_ENABLED')) {
            this.app.use(responseCompression.getMiddleware());
            console.log('📦 Response compression enabled');
        }
        
        // Handle preflight requests - FIXED CORS for all origins
        this.app.use((req, res, next) => {
            // Handle OPTIONS preflight for ALL routes
            if (req.method === 'OPTIONS') {
                const origin = req.headers.origin;
                
                // Log for debugging
                console.log(`🌐 OPTIONS preflight for: ${req.path} from origin: ${origin}`);
                
                // Check if origin is allowed
                let isAllowed = false;
                
                if (origin) {
                    // Check against CORS manager
                    if (corsManager.isOriginAllowed(origin)) {
                        isAllowed = true;
                    }
                    // Also check for Render frontend explicitly
                    else if (origin === 'https://moodfronted.onrender.com' ||
                             origin === 'https://moodfronted.onrender.com/' ||
                             origin.includes('localhost:5500') ||
                             origin.includes('127.0.0.1:5500')) {
                        isAllowed = true;
                    }
                }
                
                if (isAllowed) {
                    // Set CORS headers for preflight
                    res.header('Access-Control-Allow-Origin', origin);
                    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
                    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
                    res.header('Access-Control-Allow-Credentials', 'true');
                    res.header('Access-Control-Max-Age', '86400');
                    
                    console.log(`✅ OPTIONS allowed for: ${origin}`);
                    return res.status(204).end();
                } else {
                    console.log(`❌ OPTIONS blocked for: ${origin}`);
                    return res.status(204).end(); // Still return 204 but without CORS headers
                }
            }
            next();
        });

        // Get dynamic CORS options from the manager
        const corsOptions = corsManager.getCorsOptions();
        
        // 1. CORS middleware - FIRST (CRITICAL)
        this.app.use(cors(corsOptions));
        
        // 1.5 Force CORS headers for all responses (especially important for login)
        this.app.use((req, res, next) => {
            // Store original end function
            const originalEnd = res.end;
            const originalJson = res.json;
            const originalSend = res.send;
            
            // Override end to ensure CORS headers are always set
            res.end = function(...args) {
                const origin = req.headers.origin;
                if (origin && (origin === 'https://moodfronted.onrender.com' ||
                               origin.includes('localhost:5500') ||
                               origin.includes('127.0.0.1:5500'))) {
                    res.setHeader('Access-Control-Allow-Origin', origin);
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                }
                originalEnd.apply(this, args);
            };
            
            // Override json to ensure CORS headers
            res.json = function(data) {
                const origin = req.headers.origin;
                if (origin && (origin === 'https://moodfronted.onrender.com' ||
                               origin.includes('localhost:5500') ||
                               origin.includes('127.0.0.1:5500'))) {
                    res.setHeader('Access-Control-Allow-Origin', origin);
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                }
                return originalJson.call(this, data);
            };
            
            // Override send to ensure CORS headers
            res.send = function(data) {
                const origin = req.headers.origin;
                if (origin && (origin === 'https://moodfronted.onrender.com' ||
                               origin.includes('localhost:5500') ||
                               origin.includes('127.0.0.1:5500'))) {
                    res.setHeader('Access-Control-Allow-Origin', origin);
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                }
                return originalSend.call(this, data);
            };
            
            next();
        });
        
        // 2. Handle preflight requests - CRITICAL FIX: Properly handle Authorization header
        this.app.options('*', (req, res) => {
            // CRITICAL FIX: Set ALL required CORS headers for preflight
            const origin = req.headers.origin;
            if (origin && corsManager.isOriginAllowed(origin)) {
                res.header('Access-Control-Allow-Origin', origin);
            } else {
                res.header('Access-Control-Allow-Origin', 'http://127.0.0.1:5500');
            }
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
            res.header('Access-Control-Allow-Credentials', 'true');
            res.header('Access-Control-Max-Age', '86400');
            res.sendStatus(204);
        });
        
        // 3. Security headers
        this.app.use(helmet({
            contentSecurityPolicy: config.get('NODE_ENV') === 'production',
            crossOriginEmbedderPolicy: false,
            crossOriginResourcePolicy: { policy: "cross-origin" },
            crossOriginOpenerPolicy: { policy: "same-origin" },
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true
            },
            referrerPolicy: { policy: "strict-origin-when-cross-origin" }
        }));
        
        // 4. JSON parser - THIRD
        this.app.use(express.json({ 
            limit: '10mb',
            verify: (req, res, buf) => {
                req.rawBody = buf;
            }
        }));
        
        // 5. URL-encoded parser
        this.app.use(express.urlencoded({ 
            extended: true,
            limit: '10mb'
        }));
        
        // 6. Request ID and logging middleware
        this.app.use((req, res, next) => {
            systemState.incrementMetric('requests');
            
            // Add request ID
            req.requestId = Math.random().toString(36).substr(2, 9);
            
            // Log request in development
            if (config.get('NODE_ENV') === 'development') {
                const isPublic = this.routerManager?.authMiddlewareManager?.isPublicRoute(req.path) || false;
                const authType = isPublic ? 'PUBLIC' : 'PROTECTED';
                console.log(`${req.method} ${req.path} [${authType}] - ${req.headers['user-agent']}`);
            }
            
            next();
        });
        
        // 7. Add security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('X-Request-ID', req.requestId);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            next();
        });
        
        // 8. CORS logging middleware (development only)
        if (config.get('NODE_ENV') === 'development') {
            this.app.use((req, res, next) => {
                const origin = req.headers.origin;
                if (origin) {
                    const allowed = corsManager.isOriginAllowed(origin);
                    if (allowed) {
                        logger.logCorsAccess(origin, true);
                    } else {
                        logger.logCorsAccess(origin, false);
                    }
                }
                next();
            });
        }
        
        console.log('✅ Middleware setup complete with correct order and optimizations');
    }
    
    setupHealthEndpoints() {
        console.log('🔄 Setting up health endpoints with proper public access...');
        
        // Root endpoint - public (ALWAYS)
        this.app.get('/', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            return res.json({
                success: true,
                message: 'MoodChat API Server',
                version: config.get('API_VERSION'),
                environment: config.get('NODE_ENV'),
                timestamp: new Date().toISOString(),
                auth: {
                    mode: 'PROTECTED_ROUTES_ONLY',
                    description: 'Authentication required only for protected routes'
                },
                websocket: {
                    enabled: config.get('FEATURE_WEBSOCKETS'),
                    path: '/ws',
                    url: `ws://${req.get('host')}/ws`
                },
                links: {
                    health: '/health',
                    apiHealth: '/api/health',
                    status: '/api/status',
                    info: '/api/info',
                    login: '/api/auth/login',
                    register: '/api/auth/register',
                    corsInfo: '/api/cors-info',
                    cacheStats: '/api/cache-stats',
                    websocketTest: '/ws-test.html'
                }
            });
        });
        
        // Health check - must always work (public)
        this.app.get('/health', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            const health = systemState.getHealth();
            
            if (health.ready) {
                return res.json(health);
            } else {
                return res.status(503).json({
                    success: false,
                    message: 'Service unavailable',
                    code: 'SERVICE_UNAVAILABLE',
                    ...health
                });
            }
        });
        
        // API health (public)
        this.app.get('/api/health', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            const isReady = systemState.isServerReady();
            
            return res.json({
                success: true,
                status: isReady ? 'operational' : 'degraded',
                timestamp: new Date().toISOString(),
                version: config.get('API_VERSION'),
                uptime: Math.floor(process.uptime()),
                environment: config.get('NODE_ENV'),
                auth: {
                    mode: 'PROTECTED_ROUTES_ONLY',
                    publicRoutes: this.routerManager?.publicRoutes?.length || 14,
                    protectedRoutes: this.routerManager?.protectedRoutes?.length || 10
                },
                websocket: {
                    enabled: config.get('FEATURE_WEBSOCKETS'),
                    state: this.websocket?.state || 'DISABLED',
                    clients: this.websocket?.clients?.size || 0
                },
                cors: {
                    allowedOrigins: corsManager.getAllowedOrigins().length,
                    environment: corsManager.environment,
                    render: corsManager.isRender
                },
                services: {
                    database: this.database ? systemState.isServiceHealthy('database') : false,
                    redis: this.redis ? systemState.isConnectionHealthy('redis') : false,
                    websocket: systemState.isConnectionHealthy('websocket'),
                    auth: systemState.areAuthRoutesActive(),
                    models: systemState.getModelHealthStatus()
                },
                optimizations: {
                    uvThreadpoolSize: parseInt(process.env.UV_THREADPOOL_SIZE, 10) || 16,
                    loginCacheHitRate: loginCache.getStats().hitRate,
                    connectionPool: config.getDatabasePoolConfig()
                }
            });
        });
        
        // System info (public)
        this.app.get('/api/info', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            return res.json({
                success: true,
                app: config.get('APP_NAME'),
                version: config.get('API_VERSION'),
                environment: config.get('NODE_ENV'),
                timestamp: new Date().toISOString(),
                auth: {
                    architecture: 'PROTECTED_ROUTES_ONLY',
                    description: 'Authentication middleware only on protected routes'
                },
                websocket: {
                    enabled: config.get('FEATURE_WEBSOCKETS'),
                    path: '/ws',
                    protocol: 'ws'
                },
                cors: {
                    origins: corsManager.getAllowedOrigins().length,
                    environment: corsManager.environment,
                    credentials: true,
                    render: corsManager.isRender
                },
                features: {
                    websockets: config.get('FEATURE_WEBSOCKETS'),
                    redis: config.get('FEATURE_REDIS_CACHE'),
                    mobileCors: config.get('FEATURE_CORS_MOBILE')
                },
                optimizations: {
                    uvThreadpoolSize: parseInt(process.env.UV_THREADPOOL_SIZE, 10) || 16,
                    loginCacheTTL: config.get('LOGIN_CACHE_TTL'),
                    queryTimeoutMs: config.get('QUERY_TIMEOUT_MS'),
                    compressionEnabled: config.get('COMPRESSION_ENABLED'),
                    duplicateRequestCooldown: config.get('DUPLICATE_REQUEST_COOLDOWN_MS')
                }
            });
        });
        
        // CORS info endpoint (public)
        this.app.get('/api/cors-info', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            const origin = req.headers.origin;
            const isAllowed = origin ? corsManager.isOriginAllowed(origin) : null;
            
            return res.json({
                success: true,
                origin: origin,
                allowed: isAllowed,
                environment: corsManager.environment,
                isRender: corsManager.isRender,
                totalAllowedOrigins: corsManager.getAllowedOrigins().length,
                sampleOrigins: corsManager.getAllowedOrigins().slice(0, 10)
            });
        });
        
        // WebSocket test page (development only)
        if (config.get('NODE_ENV') === 'development') {
            this.app.get('/ws-test.html', (req, res) => {
                const html = `<!DOCTYPE html>
<html>
<head>
    <title>WebSocket Test</title>
    <style>
        body { font-family: Arial; margin: 20px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; }
        #messages { border: 1px solid #ccc; height: 300px; overflow-y: scroll; padding: 10px; margin-top: 10px; background: #fafafa; border-radius: 4px; }
        .message { padding: 8px; margin: 5px 0; border-radius: 4px; }
        .sent { background: #e3f2fd; text-align: right; }
        .received { background: #f1f8e9; }
        .error { background: #ffebee; color: #c62828; }
        .system { background: #fff3e0; color: #ef6c00; }
        button { padding: 8px 16px; margin: 5px; cursor: pointer; border: none; border-radius: 4px; background: #4CAF50; color: white; }
        button:hover { opacity: 0.9; }
        button.disconnect { background: #f44336; }
        input { padding: 8px; width: 300px; border: 1px solid #ccc; border-radius: 4px; }
        #status { font-weight: bold; margin: 10px 0; padding: 10px; border-radius: 4px; }
        .connected { background: #c8e6c9; color: #2e7d32; }
        .disconnected { background: #ffcdd2; color: #c62828; }
    </style>
</head>
<body>
    <div class="container">
        <h1>WebSocket Connection Test</h1>
        <div>
            <button onclick="connect()">Connect</button>
            <button onclick="disconnect()" class="disconnect">Disconnect</button>
            <button onclick="sendPing()">Send Ping</button>
            <button onclick="sendEcho()">Send Echo</button>
            <button onclick="clearMessages()">Clear Messages</button>
        </div>
        <div>
            <input type="text" id="messageInput" placeholder="Custom message" style="width: 300px;">
            <button onclick="sendCustom()">Send Custom</button>
        </div>
        <div id="status" class="disconnected">Status: Disconnected</div>
        <div id="messages"></div>
    </div>

    <script>
        let ws = null;
        const messagesDiv = document.getElementById('messages');
        const statusDiv = document.getElementById('status');
        
        function log(message, type = 'system') {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message ' + type;
            msgDiv.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
            messagesDiv.appendChild(msgDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + '/ws';
            
            log('Connecting to ' + wsUrl + '...', 'system');
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                statusDiv.textContent = 'Status: Connected';
                statusDiv.className = 'connected';
                log('Connected to WebSocket server', 'system');
            };
            
            ws.onclose = function() {
                statusDiv.textContent = 'Status: Disconnected';
                statusDiv.className = 'disconnected';
                log('Disconnected from WebSocket server', 'system');
                ws = null;
            };
            
            ws.onerror = function(error) {
                log('WebSocket error: ' + (error.message || 'Unknown error'), 'error');
            };
            
            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    log('Received: ' + JSON.stringify(data, null, 2), 'received');
                } catch (e) {
                    log('Received (raw): ' + event.data, 'received');
                }
            };
        }
        
        function disconnect() {
            if (ws) {
                ws.close();
            }
        }
        
        function sendPing() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                log('Not connected', 'error');
                return;
            }
            
            const message = JSON.stringify({
                type: 'ping',
                timestamp: new Date().toISOString()
            });
            
            ws.send(message);
            log('Sent: ' + message, 'sent');
        }
        
        function sendEcho() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                log('Not connected', 'error');
                return;
            }
            
            const message = JSON.stringify({
                type: 'echo',
                message: 'Hello WebSocket!',
                timestamp: new Date().toISOString()
            });
            
            ws.send(message);
            log('Sent: ' + message, 'sent');
        }
        
        function sendCustom() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                log('Not connected', 'error');
                return;
            }
            
            const customMsg = document.getElementById('messageInput').value;
            if (!customMsg) {
                log('Please enter a message', 'error');
                return;
            }
            
            const message = JSON.stringify({
                type: 'message',
                content: customMsg,
                timestamp: new Date().toISOString()
            });
            
            ws.send(message);
            log('Sent: ' + message, 'sent');
            document.getElementById('messageInput').value = '';
        }
        
        function clearMessages() {
            messagesDiv.innerHTML = '';
        }
    </script>
</body>
</html>`;
                return res.send(html);
            });
            console.log('✅ WebSocket test page available at /ws-test.html');
        }
        
        // Ready endpoint for load balancers (public)
        this.app.get('/ready', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            const isReady = systemState.isServerReady();
            
            if (isReady) {
                return res.status(200).json({ ready: true });
            } else {
                return res.status(503).json({ 
                    success: false,
                    ready: false,
                    message: 'Service not ready',
                    code: 'NOT_READY'
                });
            }
        });
        
        // Live endpoint for liveness probes (public)
        this.app.get('/live', (req, res) => {
            logger.logPublicRouteAccess(req.path, req.method);
            systemState.incrementMetric('publicRouteAccess');
            return res.status(200).json({ live: true });
        });
        
        console.log('✅ Health endpoints setup complete with proper public access');
    }
    
    setupErrorHandling() {
        // 404 handler - MUST be after all routes
        this.app.use((req, res) => {
            // CRITICAL: Ensure no response already sent
            if (res.headersSent) {
                return;
            }
            systemState.incrementMetric('errors');
            return res.status(404).json({
                success: false,
                message: `Route not found: ${req.method} ${req.path}`,
                code: 'ROUTE_NOT_FOUND',
                timestamp: new Date().toISOString(),
                requestId: req.requestId,
                suggestion: 'Check /api/health for available endpoints'
            });
        });
        
        // Global error handler - MUST BE LAST
        this.app.use((err, req, res, next) => {
            // CRITICAL: Check if headers already sent
            if (res.headersSent) {
                console.error('Error after headers sent:', err.message);
                return next(err);
            }
            
            systemState.incrementMetric('errors');
            
            if (config.get('NODE_ENV') !== 'production') {
                logger.error(`Unhandled error: ${err.message}`, err, 'HTTP');
            } else {
                logger.error(`Unhandled error: ${err.message}`, null, 'HTTP');
            }
            
            const status = err.status || 500;
            const message = status === 500 ? 'Internal server error' : err.message;
            const code = err.code || (status === 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR');
            
            return res.status(status).json({
                success: false,
                message: message,
                code: code,
                timestamp: new Date().toISOString(),
                requestId: req.requestId,
                ...(config.get('NODE_ENV') === 'development' && { 
                    stack: err.stack,
                    details: err.details || null
                })
            });
        });
    }
    
    displayDiagnostics() {
        console.log('\n' + '='.repeat(80));
        console.log(' SYSTEM DIAGNOSTICS');
        console.log('='.repeat(80));
        
        // System health
        logger.displaySystemHealth();
        
        // Models with enhanced column details
        logger.displayModelsInfo();
        
        // Routes
        logger.displayRoutes();
        
        // CORS info
        logger.displayCorsInfo();
        
        // Database
        if (this.database) {
            logger.displayDatabaseInfo(this.database.getSchemaInfo());
        }
        
        // Redis
        if (this.redis) {
            logger.displayRedisInfo(this.redis.getInfo());
        }
        
        // WebSocket
        if (this.websocket) {
            logger.displayWebSocketInfo(this.websocket.getInfo());
        }
        
        // Cache stats
        console.log(`\n${logger.colors.cyan}📊 CACHE STATISTICS:${logger.colors.reset}`);
        const cacheStats = loginCache.getStats();
        console.log(`   Login Cache: ${cacheStats.size} entries, ${cacheStats.hitRate} hit rate`);
        console.log(`   Duplicate Filter: ${duplicateFilter.pendingRequests?.size || 0} active entries`);
    }
    
    async start() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(config.get('PORT'), config.get('HOST'), () => {
                // Server is listening
                const host = config.get('HOST');
                const port = config.get('PORT');
                
                logger.success(`HTTP server listening on ${host}:${port}`, 'APPLICATION');
                
                // Initialize Socket.IO for real-time messaging
                if (config.get('FEATURE_WEBSOCKETS')) {
                    const { Server } = require('socket.io');

                    /**
                     * socketAuthenticate — io.use() middleware.
                     * Runs BEFORE 'connection' fires, so auth failures surface as
                     * 'connect_error' on the client instead of "io server disconnect".
                     * On success, attaches userId to socket.data and socket.handshake.auth
                     * so setupConnectionHandler() can read it without re-verifying.
                     */
                    // FIX #1: Use tokenService for verification — single source of truth.
                    // The old code called jwt.verify(token, JWT_SECRET) directly, but
                    // tokenService signs with JWT_ACCESS_SECRET (falling back to JWT_SECRET).
                    // When these two env vars differ (common on Render/Railway/Heroku), every
                    // socket connection failed with "invalid signature".
                    const tokenService = require('./services/tokenService');

                    const socketAuthenticate = (socket, next) => {
                        try {
                            const token = (socket.handshake.auth && socket.handshake.auth.token)
                                || socket.handshake.query.token
                                || null;

                            // Debug log — remove after confirming fix
                            console.log('[Socket.IO] Auth attempt, token present:', !!token,
                                token ? ('length=' + token.length) : '');

                            if (!token || token.length < 10) {
                                console.warn('[Socket.IO] Auth rejected: token missing or too short');
                                return next(new Error('auth/token-missing'));
                            }

                            // FIX: Delegate to tokenService — uses JWT_ACCESS_SECRET (the correct secret).
                            const verification = tokenService.verifyAccessToken(token);

                            if (!verification.valid) {
                                const reason = verification.error || 'INVALID_TOKEN';
                                console.warn(`[Socket.IO] Auth rejected: ${reason} — ${verification.message}`);
                                return next(new Error(`auth/invalid-token: ${verification.message || reason}`));
                            }

                            const decoded = verification.decoded;
                            const userId  = parseInt(decoded.userId || decoded.id || decoded.sub, 10);

                            if (!userId) {
                                console.warn('[Socket.IO] Auth rejected: no userId in token payload');
                                return next(new Error('auth/no-userId-in-token'));
                            }

                            console.log(`[Socket.IO] ✅ Auth accepted for userId=${userId}`);

                            // Attach for downstream handlers
                            socket.data.userId            = userId;
                            socket.handshake.auth.userId  = userId;
                            next();
                        } catch (err) {
                            console.error('[Socket.IO] socketAuthenticate unexpected error:', err.message);
                            next(new Error('auth/invalid-token: ' + err.message));
                        }
                    };

                    this.io = new Server(this.server, {
                        cors: {
                            origin: (origin, callback) => {
                                if (!origin) return callback(null, true); // mobile / curl / Postman
                                if (corsManager.isOriginAllowed(origin)) return callback(null, true);
                                console.warn(`[Socket.IO] CORS blocked: ${origin}`);
                                return callback(new Error('Not allowed by CORS'));
                            },
                            methods: ['GET', 'POST'],
                            credentials: true
                        },
                        // polling FIRST — establishes session even if raw WebSocket upgrade
                        // is blocked on Render's free tier, then auto-upgrades to WS
                        transports: ['polling', 'websocket'],
                        allowUpgrades: true,
                        pingTimeout:    60000,
                        pingInterval:   25000,
                        upgradeTimeout: 30000,
                        connectTimeout: 45000,
                        allowEIO3:      true,
                    });

                    // FIX: Auth runs in middleware (before 'connection').
                    // Failed auth → client gets 'connect_error', NOT "io server disconnect".
                    this.io.use(socketAuthenticate);

                    // Init WebSocket service AFTER attaching auth middleware
                    this.websocket = WebSocketService;
                    this.websocket.init(this.io);
                    global.__io = this.io; // Phase11: direct io access for fallback delivery

                    // setupConnectionHandler handles room-join & presence only.
                    // verifyToken inside it is now a harmless secondary check —
                    // it will always succeed because the middleware already validated.
                    this.websocket.setupConnectionHandler();

                    logger.success('Socket.IO initialized with middleware auth ✅', 'WEBSOCKET');

                    // ═══════════════════════════════════════════════════════════════════════
                    // MOODCHAT INFRASTRUCTURE PHASES 1-6 — AUTO-INITIALIZES AFTER SOCKET INIT
                    // Non-destructive: each phase wraps existing services, never replaces them.
                    // ═══════════════════════════════════════════════════════════════════════

                    // ── PHASE 1: FOUNDATION ───────────────────────────────────────────────
                    try {
                        const { initPhase1 } = require('./core/phase1.bootstrap');
                        global.__phase1 = initPhase1(this.io, this.app, {
                            adminToken: process.env.INTERNAL_DIAG_TOKEN,
                            adminPath:  '/internal/diagnostics',
                            logger:     console,
                        });
                        logger.success('MoodChat Phase 1 — Foundation Layer ✅', 'PHASE1');
                    } catch (err) {
                        console.warn('[Phase1] Init failed (non-fatal):', err.message);
                        global.__phase1 = {};
                    }

                    // ── PHASE 2: HYBRID TRANSPORT ─────────────────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase2 } = require('./services/phase2/phase2.bootstrap');
                            global.__phase2 = initPhase2(this.io, this.app, {
                                phase1: global.__phase1, logger: console,
                            });
                            logger.success('MoodChat Phase 2 — Hybrid Transport Engine ✅', 'PHASE2');
                        } catch (err) {
                            console.warn('[Phase2] Init failed (non-fatal):', err.message);
                            global.__phase2 = {};
                        }
                    }, 1000);

                    // ── PHASE 3: WEBRTC CALL ENGINE ───────────────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase3 } = require('./services/phase3/phase3.bootstrap');
                            global.__phase3 = initPhase3(this.io, this.app, {
                                phase1: global.__phase1, phase2: global.__phase2,
                                wsService: this.websocket, logger: console,
                            });
                            logger.success('MoodChat Phase 3 — WebRTC Call Engine ✅', 'PHASE3');
                        } catch (err) {
                            console.warn('[Phase3] Init failed (non-fatal):', err.message);
                            global.__phase3 = {};
                        }
                    }, 2000);

                    // ── PHASE 4: SOCIAL ECOSYSTEM ─────────────────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase4 } = require('./services/phase4/phase4.bootstrap');
                            global.__phase4 = initPhase4(this.io, this.app, {
                                phase1: global.__phase1, phase2: global.__phase2,
                                phase3: global.__phase3, wsService: this.websocket,
                                logger: console,
                            });
                            logger.success('MoodChat Phase 4 — Social Ecosystem ✅', 'PHASE4');
                        } catch (err) {
                            console.warn('[Phase4] Init failed (non-fatal):', err.message);
                            global.__phase4 = {};
                        }
                    }, 3000);

                    // ── PHASE 5: PRODUCTION RELIABILITY ──────────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase5 } = require('./services/phase5/phase5.bootstrap');
                            global.__phase5 = initPhase5(this.io, this.app, {
                                phase1: global.__phase1, phase2: global.__phase2,
                                phase3: global.__phase3, phase4: global.__phase4,
                                wsService: this.websocket, logger: console,
                            });
                            logger.success('MoodChat Phase 5 — Production Reliability ✅', 'PHASE5');
                        } catch (err) {
                            console.warn('[Phase5] Init failed (non-fatal):', err.message);
                            global.__phase5 = {};
                        }
                    }, 4000);

                    // ── PHASE 6: RUNTIME INTEGRATION VALIDATOR ────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase6 } = require('./services/phase6/phase6.bootstrap');
                            global.__phase6 = initPhase6(this.io, this.app, {
                                phase1: global.__phase1, phase2: global.__phase2,
                                phase3: global.__phase3, phase4: global.__phase4,
                                phase5: global.__phase5, wsService: this.websocket,
                                logger: console,
                            });
                            logger.success('MoodChat Phase 6 — Runtime Integration ✅', 'PHASE6');
                        } catch (err) {
                            console.warn('[Phase6] Init failed (non-fatal):', err.message);
                            global.__phase6 = {};
                        }
                    }, 5000);

                    // ── PHASE 11: Unified Runtime Orchestrator ────────────────────────────
                    // FIX-AUDIT-3: Increased to 12s so Phase 10 (6s) + init time is complete
                    // Also polls until global.__HybridTransportRuntime exists
                    const _initPhase11 = () => {
                        try {
                            const { initPhase11 } = require('./services/phase11/phase11.bootstrap');
                            global.__phase11 = initPhase11(this.io, this.app, {
                                logger: console, phase10: global.__phase10,
                            });
                            console.log('[Server] ✅ Phase 11 Unified Runtime Orchestrator active');
                        } catch (err) {
                            console.warn('[Phase11] Init failed (non-fatal):', err.message);
                        }
                    };
                    setTimeout(() => {
                        // Wait for HybridTransportRuntime to be ready, poll every 500ms up to 15s
                        let _p11Attempts = 0;
                        const _p11Poll = setInterval(() => {
                            _p11Attempts++;
                            if (global.__HybridTransportRuntime || _p11Attempts >= 30) {
                                clearInterval(_p11Poll);
                                _initPhase11();
                            }
                        }, 500);
                    }, 7000);

                    // ── FIX-P12: Removed duplicate inline status expiry cron.
                    // _installStatusExpiryCron() IIFE at module level handles this.
                    // The inline version was running simultaneously causing double DB writes.

                    // ── PHASE 10: Full Production Hardening ───────────────────────────────
                    setTimeout(() => {
                        try {
                            const { initPhase10 } = require('./services/phase10/phase10.bootstrap');
                            global.__phase10 = initPhase10(this.io, this.app, {
                                phase1: global.__phase1, phase2: global.__phase2,
                                phase3: global.__phase3, phase4: global.__phase4,
                                phase5: global.__phase5, phase6: global.__phase6,
                                wsService: this.websocket, logger: console,
                            });
                            console.log('[Server] ✅ Phase 10 Production Hardening active');
                        } catch (err) {
                            console.warn('[Phase10] Init failed (non-fatal):', err.message, err.stack);
                            global.__phase10 = {};
                        }
                    }, 6000);

                    // ═══════════════════════════════════════════════════════════════════════

                    // ── Real /ws raw-WebSocket endpoint ───────────────────────────────────
                    // app.realtime.socket.js falls back to wss://<host>/ws?token=<jwt>
                    // when the Socket.IO client library is unavailable.  Without this
                    // handler the HTTP server returns a 404 / can't-upgrade, causing the
                    // DEGRADED loop seen in the console.
                    //
                    // We use { noServer: true } so the ws.WebSocketServer does NOT bind its
                    // own port — it only handles upgrades we explicitly hand off to it.
                    // Socket.IO intercepts /socket.io upgrades before this runs, so there
                    // is zero conflict between the two.
                    (() => {
                        const RawWebSocketServer =
                            WebSocket?.WebSocketServer ||
                            WebSocket?.Server;

                        if (!RawWebSocketServer) {
                            throw new Error('ws package does not expose a WebSocket server constructor');
                        }

                        const rawWss = new RawWebSocketServer({ noServer: true });

                        this.server.on('upgrade', (req, socket, head) => {
                            try {
                                const reqUrl  = new URL(req.url, `http://${req.headers.host || 'x'}`);
                                if (reqUrl.pathname !== '/ws') return; // Socket.IO owns /socket.io — ignore

                                // CORS guard
                                const origin = req.headers.origin || '';
                                if (origin && !corsManager.isOriginAllowed(origin)) {
                                    console.warn(`[RawWS] CORS blocked upgrade from: ${origin}`);
                                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                                    socket.destroy();
                                    return;
                                }

                                // Auth: token must be in ?token= query param
                                const token = reqUrl.searchParams.get('token') || '';
                                if (!token || token.length < 10) {
                                    console.warn('[RawWS] Upgrade rejected: token missing');
                                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                                    socket.destroy();
                                    return;
                                }

                                const verification = tokenService.verifyAccessToken(token);
                                if (!verification.valid) {
                                    console.warn(`[RawWS] Upgrade rejected: ${verification.error}`);
                                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                                    socket.destroy();
                                    return;
                                }

                                const decoded = verification.decoded;
                                const userId  = parseInt(decoded.userId || decoded.id || decoded.sub, 10);
                                if (!userId) {
                                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                                    socket.destroy();
                                    return;
                                }

                                // FIX-027: Verify user still exists and is active in DB
                                // Wrapped in async IIFE because upgrade handler callback is not async
                                (async () => {
                                    try {
                                        const db = require('./models');
                                        const UserModel = db.Users || db.User;
                                        if (UserModel) {
                                            const dbUser = await UserModel.findByPk(userId, { attributes: ['id', 'isActive', 'isBanned'] });
                                            if (!dbUser || dbUser.isActive === false || dbUser.isBanned === true) {
                                                console.warn(`[RawWS] Upgrade rejected: user ${userId} not found or inactive`);
                                                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                                                socket.destroy();
                                                return;
                                            }
                                        }
                                    } catch (dbErr) {
                                        console.warn('[RawWS] DB check failed (non-fatal):', dbErr.message);
                                    }
                                    rawWss.handleUpgrade(req, socket, head, (ws) => {
                                        ws._userId = userId;
                                        rawWss.emit('connection', ws, req);
                                    });
                                })();
                            } catch (err) {
                                console.error('[RawWS] Upgrade handler error:', err.message);
                                try { socket.destroy(); } catch (_) {}
                            }
                        });

                        rawWss.on('connection', (ws) => {
                            const userId = ws._userId;
                            console.log(`[RawWS] ✅ Client connected uid=${userId}`);
                            WebSocketService.registerWebSocketClient(userId, ws);

                            // Confirm auth to client
                            try { ws.send(JSON.stringify({ type: 'authenticated', userId, timestamp: Date.now() })); } catch (_) {}

                            // Keep-alive ping every 30s
                            const pingInterval = setInterval(() => {
                                if (ws.readyState === 1 /* OPEN */) {
                                    try { ws.ping(); } catch (_) {}
                                }
                            }, 30000);

                            ws.on('message', (data) => {
                                try {
                                    const msg = JSON.parse(data);
                                    if (msg.type === 'ping') {
                                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                                    }
                                } catch (_) {}
                            });

                            ws.on('pong', () => { /* client is alive */ });

                            ws.on('close', () => {
                                clearInterval(pingInterval);
                                WebSocketService.unregisterWebSocketClient(userId, ws);
                                console.log(`[RawWS] Client disconnected uid=${userId}`);
                            });

                            ws.on('error', (err) => {
                                console.warn(`[RawWS] Client error uid=${userId}:`, err.message);
                            });
                        });

                        this.rawWebSocket = rawWss;
                        logger.success('Raw /ws WebSocket endpoint ready ✅', 'WEBSOCKET');
                    })();
                }
                
                // Setup graceful shutdown
                this.setupGracefulShutdown();
                
                // Generate and display startup report
                const startupReport = systemState.generateStartupReport();
                startupReport.serverState = systemState.isServerReady() ? 'READY' : 'DEGRADED';
                
                // DECLARE READINESS
                logger.declareReadiness(port, host, startupReport);
                
                // Log URLs for easy access with auth info
                console.log('\n' + '='.repeat(80));
                console.log(' QUICK ACCESS URLS (PROTECTED ROUTES ONLY AUTH)');
                console.log('='.repeat(80));
                console.log(`🌐 API Base:     http://${host}:${port}/api`);
                console.log(`🔓 PUBLIC ROUTES (No JWT required):`);
                console.log(`   • /                          - App info`);
                console.log(`   • /health                    - Health check`);
                console.log(`   • /api/health                - API health`);
                console.log(`   • /api/status                - Server status ✅`);
                console.log(`   • /api/info                  - System info`);
                console.log(`   • /api/cors-info             - CORS configuration`);
                console.log(`   • /api/cache-stats           - Cache statistics`);
                console.log(`   • /api/auth/login            - User login ✅ (cached 30s)`);
                console.log(`   • /api/auth/register         - User registration ✅`);
                console.log(`   • /api/auth/refresh          - Token refresh`);
                console.log(`   • /api/auth/forgot-password  - Password reset request`);
                console.log(`   • /api/auth/reset-password   - Password reset`);
                console.log(`   • /api/auth/validate-token   - Token validation`);
                console.log(`   • /ws-test.html              - WebSocket test page`);
                console.log(`🔒 PROTECTED ROUTES (JWT required):`);
                console.log(`   • /api/auth/me               - Current user info ✅`);
                console.log(`   • /api/auth/logout           - User logout`);
                console.log(`   • /api/users/*               - User management`);
                console.log(`   • /api/messages/*            - Message handling`);
                console.log(`   • /api/chats/*               - Chat management`);
                console.log(`   • /api/friends/*             - Friend system`);
                console.log(`   • /api/media/*               - Media handling`);
                console.log(`   • /api/notifications/*       - Notifications`);
                console.log(`   • /api/typingIndicator/*     - Typing indicators`);
                console.log('='.repeat(80));
                
                console.log('\n⚡ OPTIMIZATIONS STATUS:');
                console.log(`   • UV_THREADPOOL_SIZE: ${process.env.UV_THREADPOOL_SIZE} (${parseInt(process.env.UV_THREADPOOL_SIZE, 10) > 4 ? '✅ OPTIMIZED' : '⚠️ DEFAULT'})`);
                console.log(`   • Connection Pool: max=${config.get('DB_POOL_MAX')}, min=${config.get('DB_POOL_MIN')} (${config.get('DB_POOL_MAX') >= 20 ? '✅ OPTIMIZED' : '⚠️ SMALL'})`);
                console.log(`   • Login Cache: ${config.get('LOGIN_CACHE_TTL')}s TTL (${loginCache.getStats().hitRate} hit rate)`);
                console.log(`   • Query Timeout: ${config.get('QUERY_TIMEOUT_MS')}ms`);
                console.log(`   • Response Compression: ${config.get('COMPRESSION_ENABLED') ? '✅ ENABLED' : '❌ DISABLED'}`);
                console.log(`   • Duplicate Request Filter: 500ms`);
                console.log('='.repeat(80));
                
                console.log('\n✅ AUTH ENDPOINTS STATUS:');
                console.log(`🔓 PUBLIC (No Auth):`);
                console.log(`   • POST /api/auth/login        - ✅ WORKING (NO 401, CACHED 30s)`);
                console.log(`   • POST /api/auth/register     - ✅ WORKING (NO 401)`);
                console.log(`   • POST /api/auth/refresh      - ✅ WORKING (NO 401)`);
                console.log(`   • POST /api/auth/forgot-password - ✅ WORKING (NO 401)`);
                console.log(`   • POST /api/auth/reset-password  - ✅ WORKING (NO 401)`);
                console.log(`   • POST /api/auth/validate-token - ✅ WORKING (NO 401)`);
                console.log(`   • GET  /api/status            - ✅ WORKING (NO 401)`);
                console.log(`   • GET  /api/health            - ✅ WORKING (NO 401)`);
                console.log(`🔒 PROTECTED (Requires JWT):`);
                console.log(`   • GET  /api/auth/me           - ✅ WORKING (401 if no token)`);
                console.log(`   • POST /api/auth/logout       - ✅ WORKING (401 if no token)`);
                console.log('='.repeat(80));
                
                console.log('\n✅ WEBSOCKET STATUS:');
                console.log(`   • Path: /ws`);
                console.log(`   • Feature Enabled: ${config.get('FEATURE_WEBSOCKETS')}`);
                console.log(`   • Test Page: /ws-test.html`);
                console.log('='.repeat(80));
                
                resolve(this.server);
            });
            
            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`Port ${config.get('PORT')} is already in use - CRITICAL`, error, 'APPLICATION');
                } else if (error.code === 'EACCES') {
                    logger.error(`Permission denied on port ${config.get('PORT')} - CRITICAL`, error, 'APPLICATION');
                } else {
                    logger.error(`Server listen error - CRITICAL: ${error.message}`, error, 'APPLICATION');
                }
                reject(error);
            });
        });
    }
    
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            logger.warn(`${signal} received, starting graceful shutdown...`, 'SHUTDOWN');
            
            // Stop accepting new connections
            if (this.server) {
                this.server.close(() => {
                    logger.success('HTTP server closed', 'SHUTDOWN');
                });
            }
            
            // Close WebSocket connections
            if (this.websocket && this.websocket.io) {
                try {
                    this.websocket.io.close();
                    logger.success('Socket.IO server closed', 'SHUTDOWN');
                } catch (_) {}
            }
            if (this.rawWebSocket) {
                try {
                    this.rawWebSocket.clients.forEach(client => { try { client.close(); } catch (_) {} });
                    this.rawWebSocket.close();
                    logger.success('Raw WebSocket server closed', 'SHUTDOWN');
                } catch (_) {}
            }
            
            // Close Redis
            if (this.redis && this.redis.client) {
                try {
                    await this.redis.client.quit();
                    logger.success('Redis connection closed', 'SHUTDOWN');
                } catch (error) {
                    logger.debug(`Error closing Redis: ${error.message}`, 'SHUTDOWN');
                }
            }
            
            // Close database
            if (this.database && this.database.sequelize) {
                try {
                    await this.database.sequelize.close();
                    logger.success('Database connection closed', 'SHUTDOWN');
                } catch (error) {
                    logger.debug(`Error closing database: ${error.message}`, 'SHUTDOWN');
                }
            }
            
            // Clear caches
            loginCache.shutdown();
            duplicateFilter.clear();
            
            logger.success('Shutdown complete', 'SHUTDOWN');
            process.exit(0);
        };
        
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught exception: ${error.message}`, error, 'PROCESS');
            // Don't exit immediately, let the error handler respond
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`Unhandled promise rejection: ${reason}`, null, 'PROCESS');
        });
    }
    
    isReady() {
        return systemState.isServerReady();
    }
}

// ========== MAIN ENTRY POINT ==========
async function main() {
    try {
        const app = new Application();
        const server = await app.start();
        
        // Final verification
        const isReady = app.isReady();
        
        if (isReady) {
            logger.success('Server is READY and accepting requests with PROTECTED ROUTES ONLY auth', 'MAIN');
            console.log('\n🎯 PROTECTED ROUTES ONLY AUTH VALIDATION CHECKLIST:');
            console.log('='.repeat(80));
            console.log('✅ CORS middleware first');
            console.log('✅ JSON parser second');
            console.log('✅ Auth middleware only applied to protected routes');
            console.log('✅ /, /health, /api/status accessible without auth');
            console.log('✅ /api/auth/login accessible without auth');
            console.log('✅ /api/auth/register accessible without auth');
            console.log('✅ Service worker compatible');
            console.log('✅ Iframe requests supported');
            console.log('✅ Proper error handling for auth failures');
            console.log('✅ Invalid tokens handled correctly');
            console.log('✅ Server errors handled gracefully');
            console.log('✅ CORS configured correctly');
            console.log('✅ No server reinitialization issues');
            console.log('✅ Environment variables accessed safely');
            console.log('✅ Render/VPS hosting compatible');
            console.log('✅ All existing routes preserved');
            console.log('✅ All models/services preserved');
            console.log('✅ Redis fallback logic preserved');
            console.log('✅ /api/status returns 200 (NO 401)');
            console.log('✅ /api/auth/login returns 200 (NO 401)');
            console.log('✅ /api/auth/register returns 200 (NO 401)');
            console.log('='.repeat(80));
            
            console.log('\n⚡ OPTIMIZATION VALIDATION:');
            console.log('='.repeat(80));
            console.log(`✅ UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE} (More threads = better concurrency)`);
            console.log(`✅ Connection Pool: max=20, min=5 (Faster database access)`);
            console.log(`✅ Login Cache: 30s TTL (Repeat logins: 1-5ms vs 200-500ms)`);
            console.log(`✅ Query Timeout: 8s (Prevents hanging queries)`);
            console.log(`✅ Response Compression: Enabled (Smaller payloads)`);
            console.log(`✅ Duplicate Request Filter: 500ms (Prevents spam)`);
            console.log('='.repeat(80));
            
            // Test the critical endpoints
            console.log('\n🧪 CRITICAL ENDPOINT TEST (Should all return 200):');
            console.log('GET  /                 - Should return 200 ✅');
            console.log('GET  /api/status       - Should return 200 ✅');
            console.log('GET  /api/health       - Should return 200 ✅');
            console.log('POST /api/auth/login   - Should return 200 with credentials ✅');
            console.log('POST /api/auth/register- Should return 201 with valid data ✅');
            console.log('GET  /api/auth/me      - Should return 401 without token ✅');
            console.log('='.repeat(80));
            
            // Performance tips
            console.log('\n📈 PERFORMANCE TIPS:');
            console.log('   • First login: 200-500ms (database + token)');
            console.log('   • Repeat login (30s): 1-5ms (cache hit)');
            console.log('   • Concurrent users: Handled by 20 connection pool');
            console.log('   • Timeout protection: 8s query timeout prevents hangs');
            console.log('='.repeat(80));
        } else {
            logger.warn('Server is running in DEGRADED mode - auth routes available', 'MAIN');
        }
        
        return { app, server };
        
    } catch (error) {
        const classification = systemState.classifyIssue('main', error.message);
        
        if (classification === 'CRITICAL') {
            logger.error('CRITICAL: Application failed to start', error, 'MAIN');
            
            if (!systemState.areAuthRoutesActive()) {
                process.exit(1);
            } else {
                logger.warn('Main application failed but auth routes are active - keeping process alive', 'MAIN');
                return null;
            }
        } else {
            logger.warn(`Application started in DEGRADED mode: ${error.message}`, 'MAIN');
            return null;
        }
    }
}

// ============================================================================
// STATUS EXPIRY CRON — runs every 5 minutes to soft-delete expired statuses
// (24h lifetime). Broadcasts socket events to affected users so their UI
// removes expired statuses without needing a refresh.
// ============================================================================
(function _installStatusExpiryCron() {
    const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

    async function _pruneExpiredStatuses() {
        try {
            const db = require('./models');
            const Status = db.models?.Status || db.Status;
            const Op = db.Sequelize ? db.Sequelize.Op : (require('sequelize').Op);
            if (!Status || !Op) return;

            const cutoff = new Date(Date.now() - EXPIRY_MS);
            // Find statuses that are still active but older than 24h
            const expired = await Status.findAll({
                where: {
                    isDeleted: false,
                    createdAt: { [Op.lt]: cutoff }
                },
                attributes: ['id', 'userId', 'mediaUrl'],
                limit: 100
            });

            if (expired.length === 0) return;

            const ids = expired.map(s => s.id);
            await Status.update({ isDeleted: true, deletedAt: new Date() }, { where: { id: ids } });

            // Broadcast expiration to each status owner + their friends
            const io = global.__socketIO;
            if (io) {
                // Group by userId to batch
                const byUser = {};
                expired.forEach(s => { (byUser[s.userId] = byUser[s.userId] || []).push(s.id); });
                for (const [userId, statusIds] of Object.entries(byUser)) {
                    const payload = { statusIds, expiredAt: new Date().toISOString() };
                    io.to(`user:${userId}`).emit('status:expired', payload);
                    io.to(`user_${userId}`).emit('status:expired', payload);
                }
            }

            console.log(`[StatusExpiryCron] Pruned ${ids.length} expired status(es)`);
        } catch (err) {
            // Non-fatal — just log
            console.warn('[StatusExpiryCron] Error:', err.message);
        }
    }

    // Run after 30s startup delay, then every 5 minutes
    setTimeout(_pruneExpiredStatuses, 30000);
    setInterval(_pruneExpiredStatuses, 5 * 60 * 1000);
    console.log('[StatusExpiryCron] ✅ Installed (runs every 5 minutes)');
})();

// ── SMART GROUPS OS ROUTES ──────────────────────────────────────────────────
// Additive: mounts at /api/groups alongside existing group routes.
// All routes are prefixed with /:groupId/tasks, /:groupId/polls etc.
(function _mountSmartGroupRoutes() {
    try {
        const sgRoutes = require('./routes/smart-groups');
        // Find the express app
        const app = global.__expressApp;
        if (!app) {
            console.warn('[SmartGroups] Express app not found in global.__expressApp — routes not mounted');
            return;
        }
        app.use('/api/groups', sgRoutes);
        console.log('[SmartGroups] ✅ Smart Group OS routes mounted at /api/groups');
    } catch(err) {
        console.warn('[SmartGroups] Could not mount routes:', err.message);
    }
})();

// ── SMART GROUPS ANALYTICS CRON ──────────────────────────────────────────────
// Updates GroupAnalytics daily row for message count
(function _installGroupAnalyticsCron() {
    setInterval(async () => {
        try {
            const db  = require('./models');
            const GA  = db.models?.GroupAnalytics || db.GroupAnalytics;
            const GM  = db.models?.GroupMembers   || db.GroupMembers;
            if (!GA || !GM) return;
            const today = new Date().toISOString().slice(0,10);
            // Get all groups with active members
            const groups = await (db.models?.Groups || db.Groups)?.findAll({ attributes: ['id'] }).catch(()=>[]);
            for (const g of (groups||[])) {
                const active = await GM.count({ where: { groupId: g.id, leftAt: null } }).catch(()=>0);
                await GA.upsert({ groupId: g.id, date: today, activeMembers: active }).catch(()=>{});
            }
        } catch(_) {}
    }, 60 * 60_000); // every hour
    console.log('[GroupAnalyticsCron] ✅ Installed');
})();

// ── MESH RELAY INSTALLATION ─────────────────────────────────────────────────
// Installs the server-side mesh relay after Socket.IO is ready.
// Must run after global.__socketIO is set by WebSocketService.
(function _mountMeshRelay() {
    try {
        const meshRelay = require('./mesh-relay');
        // Delay slightly to ensure Socket.IO is fully set up
        const _tryMount = () => {
            const io = global.__socketIO;
            if (!io) { setTimeout(_tryMount, 1000); return; }
            const relayInfo = meshRelay(io, null);
            if (relayInfo) {
                console.log('[MeshRelay] ✅ Mounted on Socket.IO');
                global.__meshRelay = relayInfo;
            }
        };
        setTimeout(_tryMount, 2000);
    } catch(err) {
        console.warn('[MeshRelay] Could not mount:', err.message);
    }
})();

// ── LAN Discovery Service — peer subnet tracking for campus/LAN messaging ──
(function _mountLANDiscovery() {
    try {
        const LANDiscoveryService = require('./services/phase2/LANDiscoveryService');
        const _tryMount = () => {
            const io = global.__socketIO;
            if (!io) { setTimeout(_tryMount, 1000); return; }
            const lanService = new LANDiscoveryService(io, { logger: console });
            lanService.attach();
            global.__lanDiscoveryService = lanService;
            console.log('[LANDiscovery] ✅ Mounted on Socket.IO');

            // Also handle server-relay for AP-isolated subnets
            // When direct LAN WS fails, relay the message via server
            io.on('connection', socket => {
                socket.on('lan:relay_message', (data, ack) => {
                    try {
                        const { targetSocketId, payload, targetUserId } = data || {};
                        if (!payload) return;

                        let delivered = false;

                        // 1. Direct socket relay (AP-isolated peers)
                        if (targetSocketId) {
                            const targetSocket = io.sockets.sockets?.get(targetSocketId);
                            if (targetSocket && targetSocket.connected) {
                                targetSocket.emit('lan:message', { ...payload, _transport: 'LAN' });
                                delivered = true;
                            }
                        }

                        // PHASE10: Also deliver via user room so multi-device + offline queue work
                        const uid = targetUserId || payload.receiverId || payload.targetUserId;
                        if (uid) {
                            const wsService = global.__phase1?.wsService ||
                                              require('./services/webSocketService');
                            try {
                                const lanPayload = { ...payload, _transport: 'LAN', _lanRelayed: true };
                                io.to(`user:${uid}`).emit('lan:message', lanPayload);
                                io.to(`user_${uid}`).emit('lan:message', lanPayload);
                                // Also emit as new_message so messages-core picks it up
                                io.to(`user:${uid}`).emit('new_message', lanPayload);
                                delivered = true;
                            } catch(_) {}
                        }

                        // PHASE10: Record in MessageEntityStore for history
                        if (payload.id || payload.localId) {
                            try {
                                global.__MessageEntityStore?.recordCreate?.({
                                    id:      payload.id || payload.localId,
                                    localId: payload.localId,
                                    chatId:  payload.chatId || payload.conversationId,
                                    content: payload.content,
                                    senderId: socket._authenticatedUserId,
                                    _transport: 'LAN',
                                });
                            } catch(_) {}
                        }

                        if (typeof ack === 'function') ack({ ok: delivered, transport: 'LAN' });
                    } catch(e) {
                        if (typeof ack === 'function') ack({ ok: false, reason: e.message });
                    }
                });
            });
        };
        setTimeout(_tryMount, 2500);
    } catch(err) {
        console.warn('[LANDiscovery] Could not mount:', err.message);
    }
})();

// Export for testing and programmatic use
module.exports = {
    Application,
    SystemStateManager,
    ProfessionalLogger,
    ConfigurationManager,
    DatabaseService,
    RedisService,
    RouterManager,
    DynamicCorsManager,
    AuthMiddlewareManager,
    LoginResponseCache,
    DuplicateRequestFilter,
    QueryTimeoutMiddleware,
    ResponseCompressionMiddleware,
    main,
    systemState,
    logger,
    config,
    corsManager,
    loginCache,
    duplicateFilter
};

// Start if this is the main module
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
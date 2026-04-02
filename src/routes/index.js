// src/routes/index.js - MAIN ROUTER AGGREGATION
// FIXED: Auth routes are now properly mounted (removed from ignored files)
// FIXED: All routes are correctly mounted with proper auth

const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

console.log('🔄 Loading all application routers...');

// ===== CONFIGURATION =====
const ROUTES_DIR = path.join(__dirname);
// IMPORTANT: auth.js should NOT be ignored - it needs to be loaded
const IGNORED_FILES = new Set(['index.js', '.DS_Store', 'Thumbs.db']);

// ===== PUBLIC PATHS (No authentication required) =====
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/validate-token',
  '/api/health',
  '/api/status',
  '/api/status/health',
  '/api/status/public',
  '/api/status/trending',
  '/api/status/search',
  '/api/status/mood',
  '/api/info',
  '/api/cors-info',
  '/api/public',
  '/test',
  '/ping',
  '/'
];

// ===== CUSTOM ROUTE MAPPING =====
const ROUTE_MAPPING = {
  'auth.js': '/api/auth',
  'users.js': '/api/users',
  'profiles.js': '/api/profile',
  'group.js': '/api/groups',
  'groupMembers.js': '/api/group-members',
  'friends.js': '/api/friends',
  'chats.js': '/api/chats',
  'messages.js': '/api/messages',
  'status.js': '/api/status',
  'notifications.js': '/api/notifications',
  'settings.js': '/api/settings',
  'search.js': '/api/search',
  'moods.js': '/api/moods',
  'notes.js': '/api/notes',
  'media.js': '/api/media',
  'calls.js': '/api/calls',
  'readReceipt.js': '/api/read-receipts',
  'sharedMood.js': '/api/shared-moods',
  'tools.js': '/api/tools',
  'typingIndicator.js': '/api/typing-indicators',
  'userStatus.js': '/api/user-status',
  'chatsParticipant.js': '/api/chats-participant',
  'features.js': '/api/features',
  'templates.js': '/api/templates',
  'categories.js': '/api/categories',
  'files.js': '/api/files',
  'tokens.js': '/api/tokens'
};

// ===== HELPER FUNCTIONS =====

function shouldProcessFile(filename) {
  if (IGNORED_FILES.has(filename)) return false;
  if (!filename.endsWith('.js')) return false;
  if (filename.includes('.test.js') || filename.includes('.spec.js')) return false;
  return true;
}

function deriveMountPath(filename) {
  if (ROUTE_MAPPING[filename]) return ROUTE_MAPPING[filename];
  
  const baseName = filename.replace('.js', '');
  
  // Special mappings for plural forms
  const specialMappings = {
    'groupMembers': '/api/group-members',
    'profiles': '/api/profile',
    'chatsParticipant': '/api/chats-participant',
    'typingIndicator': '/api/typing-indicators',
    'userStatus': '/api/user-status',
    'readReceipt': '/api/read-receipts',
    'sharedMood': '/api/shared-moods'
  };
  
  if (specialMappings[baseName]) return specialMappings[baseName];
  if (baseName.includes('-')) return `/api/${baseName}`;
  
  const kebabCase = baseName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  
  const pluralMap = {
    'group': '/api/groups',
    'friend': '/api/friends',
    'chat': '/api/chats',
    'message': '/api/messages',
    'notification': '/api/notifications',
    'setting': '/api/settings',
    'mood': '/api/moods',
    'note': '/api/notes',
    'media': '/api/media',
    'call': '/api/calls',
    'status': '/api/status',
    'user': '/api/users',
    'profile': '/api/profile',
    'token': '/api/tokens',
    'file': '/api/files',
    'template': '/api/templates',
    'category': '/api/categories',
    'feature': '/api/features'
  };
  
  return pluralMap[kebabCase] || `/api/${kebabCase}`;
}

function isPublicRoute(mountPath, filename) {
  // Auth routes are always public
  if (filename === 'auth.js') {
    return true;
  }
  
  // Check exact matches
  if (PUBLIC_PATHS.includes(mountPath)) {
    return true;
  }
  
  // Check if path starts with any public path
  for (const publicPath of PUBLIC_PATHS) {
    if (mountPath === publicPath) {
      return true;
    }
    if (mountPath.startsWith(publicPath + '/') && publicPath !== '/') {
      return true;
    }
  }
  
  // Health and status endpoints are public
  if (mountPath === '/api/health' || mountPath === '/api/status' || 
      mountPath === '/api/info' || mountPath === '/api/cors-info' ||
      mountPath === '/api/public') {
    return true;
  }
  
  // Status route has public endpoints, but protected ones need auth
  // We handle this by mounting the entire status router with auth,
  // but the status router itself will handle public endpoints internally
  if (mountPath === '/api/status') {
    return false; // Status router handles its own auth internally
  }
  
  return false;
}

// ===== SCAN AND MOUNT ROUTERS =====
function scanAndMountRouters() {
  try {
    const files = fs.readdirSync(ROUTES_DIR);
    const routeFiles = files.filter(shouldProcessFile);
    
    console.log(`📁 Found ${routeFiles.length} route file(s)`);
    
    const results = {
      total: routeFiles.length,
      mounted: 0,
      failed: 0,
      mountedRoutes: [],
      failedRoutes: [],
      publicRoutes: [],
      protectedRoutes: []
    };
    
    routeFiles.sort().forEach(filename => {
      const mountPath = deriveMountPath(filename);
      const filePath = path.join(ROUTES_DIR, filename);
      
      try {
        // Clear require cache in development
        if (process.env.NODE_ENV !== 'production') {
          delete require.cache[require.resolve(filePath)];
        }
        
        const routeModule = require(filePath);
        const routeHandler = routeModule.default || routeModule;
        
        let routerInstance = routeHandler;
        if (typeof routeHandler === 'function' && !routeHandler.stack) {
          routerInstance = routeHandler();
        }
        
        if (!routerInstance || typeof routerInstance !== 'function') {
          throw new Error(`Invalid router export from ${filename}`);
        }
        
        // Determine if this route should have auth applied at the root level
        const isPublic = isPublicRoute(mountPath, filename);
        
        // Auth routes - mount without auth middleware (always public)
        if (filename === 'auth.js') {
          console.log(`🔓 ${mountPath} - PUBLIC (Auth routes - no auth required)`);
          router.use(mountPath, routerInstance);
          results.publicRoutes.push({ filename, path: mountPath });
        }
        // Status routes - mount without auth middleware (handles its own auth)
        else if (filename === 'status.js') {
          console.log(`🔓 ${mountPath} - PUBLIC/INTERNAL AUTH (Status router handles its own auth)`);
          router.use(mountPath, routerInstance);
          results.publicRoutes.push({ filename, path: mountPath });
        }
        // Other routes - apply auth middleware for protected routes
        else if (!isPublic) {
          console.log(`🔒 ${mountPath} - PROTECTED (JWT required)`);
          // Create a new router that applies auth middleware first
          const protectedRouter = express.Router();
          protectedRouter.use(authenticateToken);
          protectedRouter.use(routerInstance);
          router.use(mountPath, protectedRouter);
          results.protectedRoutes.push({ filename, path: mountPath });
        } 
        // Public routes (non-auth)
        else {
          console.log(`🔓 ${mountPath} - PUBLIC (No auth required)`);
          router.use(mountPath, routerInstance);
          results.publicRoutes.push({ filename, path: mountPath });
        }
        
        results.mounted++;
        results.mountedRoutes.push({
          filename,
          path: mountPath,
          routes: routerInstance.stack ? routerInstance.stack.length : 'unknown',
          authRequired: !isPublic && filename !== 'auth.js' && filename !== 'status.js',
          isPublic: isPublic || filename === 'auth.js'
        });
        
        console.log(`✅ Mounted: ${mountPath} from ${filename}`);
        
      } catch (error) {
        results.failed++;
        results.failedRoutes.push({
          filename,
          path: mountPath,
          error: error.message
        });
        console.error(`❌ Failed to mount ${filename}: ${error.message}`);
      }
    });
    
    return results;
    
  } catch (error) {
    console.error('❌ Failed to scan routes directory:', error.message);
    return { total: 0, mounted: 0, failed: 0, mountedRoutes: [], failedRoutes: [], publicRoutes: [], protectedRoutes: [] };
  }
}

// ===== EXECUTE ROUTER MOUNTING =====
const mountResults = scanAndMountRouters();

// ===== PRINT SUMMARY =====
console.log('\n' + '='.repeat(80));
console.log('📊 ROUTER MOUNT SUMMARY');
console.log('='.repeat(80));
console.log(`✅ Successfully mounted: ${mountResults.mounted}`);
console.log(`❌ Failed: ${mountResults.failed}`);
console.log('='.repeat(80) + '\n');

if (mountResults.failedRoutes.length > 0) {
  console.log('❌ Failed routes:');
  mountResults.failedRoutes.forEach(f => {
    console.log(`   - ${f.filename} -> ${f.path}: ${f.error}`);
  });
  console.log('');
}

// Print protected vs public routes
console.log('🔐 ROUTE AUTHENTICATION STATUS:');
console.log('-'.repeat(80));
console.log('   🔓 PUBLIC ROUTES (No auth required):');
mountResults.publicRoutes.forEach(route => {
  console.log(`      - ${route.path}`);
});
console.log('');
console.log('   🔒 PROTECTED ROUTES (JWT required):');
mountResults.protectedRoutes.forEach(route => {
  console.log(`      - ${route.path}`);
});
console.log('='.repeat(80) + '\n');

// ===== TEST ENDPOINT =====
router.get('/api/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API router is working',
    timestamp: new Date().toISOString(),
    mountedRoutes: mountResults.mountedRoutes.map(r => ({
      path: r.path,
      source: r.filename,
      routes: r.routes,
      authRequired: r.authRequired
    })),
    publicRoutes: mountResults.publicRoutes.map(r => r.path),
    protectedRoutes: mountResults.protectedRoutes.map(r => r.path),
    note: 'Auth is applied at route level. Protected routes require JWT token.'
  });
});

// ===== ROOT INFO ENDPOINT =====
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API Server is running',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    mountedRoutesCount: mountResults.mounted,
    routes: mountResults.mountedRoutes.map(r => ({
      path: r.path,
      authRequired: r.authRequired
    })),
    authentication: {
      mode: 'Route-level auth middleware',
      description: 'Auth middleware applied to protected routes in index.js',
      publicPaths: [
        '/api/auth/*',
        '/api/health',
        '/api/status',
        '/api/status/* (public endpoints)',
        '/api/info',
        '/api/cors-info',
        '/'
      ],
      protectedRoutes: mountResults.protectedRoutes.map(r => r.path),
      note: 'Status router handles its own auth internally for public/protected distinction'
    }
  });
});

// ===== HEALTH CHECK =====
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    routes: {
      total: mountResults.mounted,
      public: mountResults.publicRoutes.length,
      protected: mountResults.protectedRoutes.length
    }
  });
});

// ===== API INFO =====
router.get('/api/info', (req, res) => {
  res.status(200).json({
    success: true,
    name: 'MoodChat API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    endpoints: {
      public: mountResults.publicRoutes.map(r => r.path),
      protected: mountResults.protectedRoutes.map(r => r.path)
    },
    authentication: {
      type: 'JWT Bearer Token',
      header: 'Authorization: Bearer <token>',
      publicEndpoints: [
        'POST /api/auth/login',
        'POST /api/auth/register',
        'POST /api/auth/refresh',
        'POST /api/auth/forgot-password',
        'POST /api/auth/reset-password',
        'GET /api/health',
        'GET /api/status',
        'GET /api/status/public',
        'GET /api/status/trending',
        'GET /api/status/search',
        'GET /api/status/mood/:moodType',
        'GET /api/info',
        'GET /api/cors-info'
      ]
    }
  });
});

// ===== CORS INFO =====
router.get('/api/cors-info', (req, res) => {
  const corsManager = req.app.locals.corsManager;
  res.status(200).json({
    success: true,
    environment: process.env.NODE_ENV || 'development',
    allowedOrigins: corsManager ? corsManager.getAllowedOrigins() : [],
    totalOrigins: corsManager ? corsManager.getAllowedOrigins().length : 0,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  });
});

// ===== 404 HANDLER FOR UNKNOWN ROUTES =====
router.use('*', (req, res) => {
  const availableRoutes = [
    ...mountResults.publicRoutes.map(r => r.path),
    ...mountResults.protectedRoutes.map(r => r.path)
  ];
  
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
    availableRoutes: availableRoutes,
    note: 'All routes are auto-discovered from src/routes directory',
    authInfo: {
      mode: 'Route-level authentication',
      publicPaths: [
        '/api/auth/login',
        '/api/auth/register',
        '/api/health',
        '/api/status',
        '/api/info',
        '/'
      ],
      protectedRoutes: mountResults.protectedRoutes.map(r => r.path)
    }
  });
});

module.exports = router;
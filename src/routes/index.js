// src/routes/index.js - MAIN ROUTER AGGREGATION
// FIXED: Auth routes are now properly mounted (removed from ignored files)
// FIXED: All routes are correctly mounted with proper auth
// UPDATED: Status routes now have explicit public/protected endpoint documentation

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
  '/api/status/mood/:moodType',
  '/api/status/:statusId',
  '/api/status/:statusId/comments',
  '/api/status/:statusId/likes',
  '/api/status/view',
  '/api/status/:statusId/view',
  '/api/info',
  '/api/cors-info',
  '/api/public',
  '/test',
  '/ping',
  '/'
];

// ===== STATUS ROUTE PUBLIC/PROTECTED BREAKDOWN =====
// Status router handles its own auth internally. Here's the breakdown:
// 
// 🔓 PUBLIC endpoints (no auth required):
//    GET  /api/status/health
//    GET  /api/status/
//    GET  /api/status/public
//    GET  /api/status/trending
//    GET  /api/status/search
//    GET  /api/status/mood/:moodType
//    GET  /api/status/:statusId
//    GET  /api/status/:statusId/comments
//    GET  /api/status/:statusId/likes
//    POST /api/status/view
//    POST /api/status/:statusId/view
//
// 🔒 PROTECTED endpoints (JWT required):
//    POST   /api/status/
//    GET    /api/status/my
//    GET    /api/status/friends
//    GET    /api/status/stats
//    GET    /api/status/user/:userId
//    PUT    /api/status/:statusId
//    DELETE /api/status/:statusId
//    POST   /api/status/:statusId/like
//    DELETE /api/status/:statusId/like
//    POST   /api/status/:statusId/comment
//    DELETE /api/status/:statusId/comment/:commentId

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
  'messagingFeatures.js': '/api/messaging',
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
  'tokens.js': '/api/tokens',
  // FIX B-01: marketplace.routes.js was missing — all marketplace endpoints returned 404
  'marketplace.routes.js': '/api/marketplace',
  // PHASE14 FIX: payments.js — frontend calls /api/payments/* (mpesa, card, wallet)
  'payments.js': '/api/payments',
  // FIX: smart-groups.js was missing — ALL Group OS tabs returned 404
  'smart-groups.js': '/api/groups',
  // FIX: invites.js was missing — group invite links returned 404
  'invites.js': '/api/invites',
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
  // We handle this by mounting the entire status router WITHOUT auth middleware,
  // because the status router itself handles auth internally for protected endpoints
  if (mountPath === '/api/status') {
    return true; // Mount without auth - status router handles its own auth
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
          results.publicRoutes.push({ 
            filename, 
            path: mountPath,
            note: 'All auth endpoints are public (login, register, refresh, etc.)'
          });
        }
        // Status routes - mount WITHOUT auth middleware (handles its own auth internally)
        else if (filename === 'status.js') {
          console.log(`🔓 ${mountPath} - HYBRID (Status router handles its own auth - see breakdown below)`);
          router.use(mountPath, routerInstance);
          results.publicRoutes.push({ 
            filename, 
            path: mountPath,
            note: 'HYBRID ROUTER - Some endpoints public, some protected. See /api/status/auth-info for details.'
          });
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
  console.log(`      - ${route.path}${route.note ? ` (${route.note})` : ''}`);
});
console.log('');
console.log('   🔒 PROTECTED ROUTES (JWT required):');
mountResults.protectedRoutes.forEach(route => {
  console.log(`      - ${route.path}`);
});
console.log('');

// Print detailed status route breakdown
console.log('📋 DETAILED STATUS ROUTE AUTH BREAKDOWN:');
console.log('-'.repeat(80));
console.log('   🔓 PUBLIC Status Endpoints (no auth required):');
console.log('      GET    /api/status/health');
console.log('      GET    /api/status/');
console.log('      GET    /api/status/public');
console.log('      GET    /api/status/trending');
console.log('      GET    /api/status/search');
console.log('      GET    /api/status/mood/:moodType');
console.log('      GET    /api/status/:statusId');
console.log('      GET    /api/status/:statusId/comments');
console.log('      GET    /api/status/:statusId/likes');
console.log('      POST   /api/status/view');
console.log('      POST   /api/status/:statusId/view');
console.log('');
console.log('   🔒 PROTECTED Status Endpoints (JWT required):');
console.log('      POST   /api/status/');
console.log('      GET    /api/status/my');
console.log('      GET    /api/status/friends');
console.log('      GET    /api/status/stats');
console.log('      GET    /api/status/user/:userId');
console.log('      PUT    /api/status/:statusId');
console.log('      DELETE /api/status/:statusId');
console.log('      POST   /api/status/:statusId/like');
console.log('      DELETE /api/status/:statusId/like');
console.log('      POST   /api/status/:statusId/comment');
console.log('      DELETE /api/status/:statusId/comment/:commentId');
console.log('='.repeat(80) + '\n');

// ===== STATUS AUTH INFO ENDPOINT =====
router.get('/api/status/auth-info', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Status API Authentication Information',
    routerAuthMode: 'INTERNAL - Status router handles its own authentication',
    note: 'No auth middleware is applied at the router level in index.js',
    publicEndpoints: [
      { method: 'GET', path: '/api/status/health', description: 'Health check' },
      { method: 'GET', path: '/api/status/', description: 'Get all active public statuses' },
      { method: 'GET', path: '/api/status/public', description: 'Alias for public statuses' },
      { method: 'GET', path: '/api/status/trending', description: 'Get trending statuses (last 24h)' },
      { method: 'GET', path: '/api/status/search', description: 'Search public statuses', queryParams: ['q'] },
      { method: 'GET', path: '/api/status/mood/:moodType', description: 'Filter statuses by mood' },
      { method: 'GET', path: '/api/status/:statusId', description: 'Get single status (public if isPublic=true)' },
      { method: 'GET', path: '/api/status/:statusId/comments', description: 'Get comments on a status' },
      { method: 'GET', path: '/api/status/:statusId/likes', description: 'Get likes on a status' },
      { method: 'POST', path: '/api/status/view', description: 'Record a view (body: { statusId })' },
      { method: 'POST', path: '/api/status/:statusId/view', description: 'Record a view via URL param' }
    ],
    protectedEndpoints: [
      { method: 'POST', path: '/api/status/', description: 'Create a new status', auth: 'JWT Required' },
      { method: 'GET', path: '/api/status/my', description: 'Get current user\'s statuses', auth: 'JWT Required' },
      { method: 'GET', path: '/api/status/friends', description: 'Get friends\' statuses', auth: 'JWT Required' },
      { method: 'GET', path: '/api/status/stats', description: 'Get user status statistics', auth: 'JWT Required' },
      { method: 'GET', path: '/api/status/user/:userId', description: 'Get specific user\'s statuses', auth: 'JWT Required' },
      { method: 'PUT', path: '/api/status/:statusId', description: 'Update a status', auth: 'JWT Required (owner only)' },
      { method: 'DELETE', path: '/api/status/:statusId', description: 'Delete a status', auth: 'JWT Required (owner only)' },
      { method: 'POST', path: '/api/status/:statusId/like', description: 'Like a status', auth: 'JWT Required' },
      { method: 'DELETE', path: '/api/status/:statusId/like', description: 'Unlike a status', auth: 'JWT Required' },
      { method: 'POST', path: '/api/status/:statusId/comment', description: 'Comment on a status', auth: 'JWT Required' },
      { method: 'DELETE', path: '/api/status/:statusId/comment/:commentId', description: 'Delete a comment', auth: 'JWT Required (owner only)' }
    ],
    authenticationMethod: 'JWT Bearer Token in Authorization header',
    headerExample: 'Authorization: Bearer <your_jwt_token>'
  });
});

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
    statusAuthInfo: '/api/status/auth-info',
    note: 'Auth is applied at route level. Protected routes require JWT token. Status router handles its own auth internally.'
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
        '/api/status (HYBRID - see /api/status/auth-info)',
        '/api/info',
        '/api/cors-info',
        '/'
      ],
      protectedRoutes: mountResults.protectedRoutes.map(r => r.path),
      statusAuthInfo: '/api/status/auth-info - Detailed breakdown of public/protected status endpoints',
      note: 'Status router handles its own auth internally for public/protected distinction. No auth middleware applied at router level.'
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
    statusEndpoints: {
      info: '/api/status/auth-info',
      note: 'Status API has mixed public/protected endpoints - check the auth-info endpoint for details'
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
        'GET /api/status/* (public endpoints only - see auth-info)',
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


// ===== FIX: /api/deletions — early stub, Phase10 populates once ready =====
// Added to prevent 404 storm on Render cold-start. CacheFoundationLayer.js
// polls this endpoint. Without this stub every request during Phase10 init
// returned 404, spamming logs and triggering the circuit-breaker prematurely.
router.get('/api/deletions', (req, res) => {
  const phase10 = req.app.locals.phase10Registry;
  const deletions = (phase10 && typeof phase10.getDeletions === 'function')
    ? phase10.getDeletions()
    : [];
  res.status(200).json({ ok: true, deletions });
});

// ===== 404 HANDLER FOR UNKNOWN ROUTES =====
router.use('*', (req, res) => {
  const availableRoutes = [
    ...mountResults.publicRoutes.map(r => r.path),
    ...mountResults.protectedRoutes.map(r => r.path),
    '/api/status/auth-info'
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
        '/api/status (HYBRID)',
        '/api/status/auth-info',
        '/api/info',
        '/'
      ],
      protectedRoutes: mountResults.protectedRoutes.map(r => r.path),
      statusAuthInfo: 'GET /api/status/auth-info for detailed status endpoint breakdown'
    }
  });
});

module.exports = router;
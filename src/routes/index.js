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
// NOTE: app.js mounts this router at /api, so paths here must NOT include /api prefix
const PUBLIC_PATHS = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/validate-token',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/2fa/challenge',
  '/health',
  '/status',
  '/status/health',
  '/status/public',
  '/status/trending',
  '/status/search',
  '/status/mood/:moodType',
  '/status/:statusId',
  '/status/:statusId/comments',
  '/status/:statusId/likes',
  '/status/view',
  '/status/:statusId/view',
  '/info',
  '/cors-info',
  '/public',
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
// NOTE: No /api prefix — app.js already mounts this router at /api
const ROUTE_MAPPING = {
  'auth.js': '/auth',
  'users.js': '/users',
  'profiles.js': '/profile',
  'group.js': '/groups',
  'sealed-groups.routes.js': '/groups', // Phase 4
  'groupMembers.js': '/group-members',
  'friends.js': '/friends',
  'chats.js': '/chats',
  'messages.js': '/messages',
  'messagingFeatures.js': '/messaging',
  'encryption.js': '/encryption',
  'groupEncryption.js': '/group-encryption',
  'push.js': '/push',
  'twoFactor.js': '/2fa',
  'devices.js': '/devices',
  'status.js': '/status',
  'notifications.js': '/notifications',
  'settings.js': '/settings',
  'search.js': '/search',
  'moods.js': '/moods',
  'notes.js': '/notes',
  'media.js': '/media',
  'calls.js': '/calls',
  'readReceipt.js': '/read-receipts',
  'sharedMood.js': '/shared-moods',
  'tools.js': '/tools',
  'typingIndicator.js': '/typing-indicators',
  'userStatus.js': '/user-status',
  'chatsParticipant.js': '/chats-participant',
  'features.js': '/features',
  'templates.js': '/templates',
  'categories.js': '/categories',
  'files.js': '/files',
  'analytics.js': '/analytics',
  'conversations.js': '/conversations',
  'teams.js': '/teams',
  'offline.js': '/offline',
  'account.js': '/account',
  'tokens.js': '/tokens',
  // FIX B-01: marketplace.routes.js was missing — all marketplace endpoints returned 404
  'marketplace.routes.js': '/marketplace',
  // PHASE14 FIX: payments.js — frontend calls /api/payments/* (mpesa, card, wallet)
  'payments.js': '/payments',
  // FIX: smart-groups.js was missing — ALL Group OS tabs returned 404
  // AUTH-X FIX: smart-groups.js has its own internal auth middleware.
  // Mounting it at /groups alongside group.js (which gets a separate auth
  // wrapper) is correct, but must NOT get an additional wrapper here.
  // Mark it as public so index.js doesn't add authenticateToken on top.
  'smart-groups.js': '/groups',
  // FIX: invites.js was missing — group invite links returned 404
  'invites.js': '/invites',
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
    'groupMembers': '/group-members',
    'profiles': '/profile',
    'chatsParticipant': '/chats-participant',
    'typingIndicator': '/typing-indicators',
    'userStatus': '/user-status',
    'readReceipt': '/read-receipts',
    'sharedMood': '/shared-moods'
  };
  
  if (specialMappings[baseName]) return specialMappings[baseName];
  if (baseName.includes('-')) return `/${baseName}`;
  
  const kebabCase = baseName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  
  const pluralMap = {
    'group': '/groups',
    'friend': '/friends',
    'chat': '/chats',
    'message': '/messages',
    'notification': '/notifications',
    'setting': '/settings',
    'mood': '/moods',
    'note': '/notes',
    'media': '/media',
    'call': '/calls',
    'status': '/status',
    'user': '/users',
    'profile': '/profile',
    'token': '/tokens',
    'file': '/files',
    'template': '/templates',
    'category': '/categories',
    'feature': '/features'
  };
  
  return pluralMap[kebabCase] || `/${kebabCase}`;
}

function isPublicRoute(mountPath, filename) {
  // Auth routes are always public
  if (filename === 'auth.js') {
    return true;
  }

  // AUTH-X FIX: smart-groups.js has its own internal auth middleware
  // (the `auth()` function at the top of the file). Wrapping it in
  // authenticateToken here adds a double-auth that breaks every request
  // to Group OS endpoints. Mount without wrapper — internal auth is sufficient.
  if (filename === 'smart-groups.js') {
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
  if (mountPath === '/health' || mountPath === '/status' || 
      mountPath === '/info' || mountPath === '/cors-info' ||
      mountPath === '/public') {
    return true;
  }
  
  // Status route has public endpoints, but protected ones need auth
  // We handle this by mounting the entire status router WITHOUT auth middleware,
  // because the status router itself handles auth internally for protected endpoints
  if (mountPath === '/status') {
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
router.get('/status/auth-info', (req, res) => {
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
router.get('/test', (req, res) => {
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
router.get('/info', (req, res) => {
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
router.get('/cors-info', (req, res) => {
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
router.get('/deletions', (req, res) => {
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
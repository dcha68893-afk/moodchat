// src/routes/index.js - MAIN ROUTER AGGREGATION (AUTO-DISCOVERY VERSION)
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

console.log('🔄 Auto-discovering and mounting all application routers...');

// ===== CONFIGURATION =====
const ROUTES_DIR = path.join(__dirname); // Current directory
const CONTROLLERS_DIR = path.join(__dirname, '..', 'controllers');
const SERVICES_DIR = path.join(__dirname, '..', 'services');

const IGNORED_FILES = new Set(['index.js', 'auth.js', '.DS_Store', 'Thumbs.db']);
const RESERVED_PATHS = new Set(['auth']); // Already mounted in server.js

// ===== HELPER FUNCTIONS =====

/**
 * Scan directory for files
 */
function scanDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      return [];
    }
    return fs.readdirSync(dirPath).filter(file => file.endsWith('.js'));
  } catch (error) {
    console.warn(`⚠️  Could not scan directory ${dirPath}:`, error.message);
    return [];
  }
}

/**
 * Get associated controller and service names for a route file
 */
function getAssociatedComponents(routeFilename) {
  const baseName = routeFilename.replace('.js', '');
  const controllerName = baseName.charAt(0).toUpperCase() + baseName.slice(1) + 'Controller';
  const serviceName = baseName.charAt(0).toUpperCase() + baseName.slice(1) + 'Service';
  
  const controllers = scanDirectory(CONTROLLERS_DIR);
  const services = scanDirectory(SERVICES_DIR);
  
  const hasController = controllers.some(c => 
    c.toLowerCase().includes(baseName.toLowerCase()) || 
    c === `${controllerName}.js`
  );
  
  const hasService = services.some(s => 
    s.toLowerCase().includes(baseName.toLowerCase()) || 
    s === `${serviceName}.js`
  );
  
  return {
    controller: hasController ? controllerName : '❌ Not found',
    service: hasService ? serviceName : '❌ Not found',
    controllerExists: hasController,
    serviceExists: hasService
  };
}

/**
 * Check if a file should be processed
 */
function shouldProcessFile(filename) {
  if (IGNORED_FILES.has(filename)) {
    return false;
  }
  
  if (!filename.endsWith('.js')) {
    return false;
  }
  
  // Skip test files
  if (filename.includes('.test.js') || filename.includes('.spec.js')) {
    return false;
  }
  
  return true;
}

/**
 * Derive mount path from filename
 */
function deriveMountPath(filename) {
  const baseName = filename.replace('.js', '');
  
  // If filename already has hyphens, preserve them
  if (baseName.includes('-')) {
    return `/${baseName}`;
  }
  
  // Convert camelCase to kebab-case
  const kebabCase = baseName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
  
  // Handle special cases
  if (baseName === 'chatsParticipant') {
    return '/chats-participants';
  }
  
  return `/${kebabCase}`;
}

/**
 * Validate router instance with clearer error messages
 */
function validateRouter(routerInstance, filename) {
  if (!routerInstance) {
    throw new Error(`Invalid router: ${filename} exports null or undefined`);
  }
  
  // Check if it's an Express Router
  if (typeof routerInstance !== 'function') {
    throw new Error(`Invalid router: ${filename} does not export an Express Router function`);
  }
  
  if (!routerInstance.stack && !routerInstance.use) {
    throw new Error(`Invalid router: ${filename} exports a function but not an Express Router`);
  }
  
  // Check if router has at least one route handler
  const hasRoutes = routerInstance.stack && routerInstance.stack.length > 0;
  if (!hasRoutes) {
    console.warn(`⚠️  Warning: Router in ${filename} has no routes defined`);
  }
  
  return true;
}

/**
 * Scan directory for route files
 */
function scanForRouteFiles() {
  try {
    const files = fs.readdirSync(ROUTES_DIR);
    return files.filter(shouldProcessFile);
  } catch (error) {
    console.error('❌ Failed to scan routes directory:', error.message);
    return [];
  }
}

// ===== MAIN DISCOVERY AND MOUNTING LOGIC =====
function autoDiscoverAndMountRouters() {
  const routeFiles = scanForRouteFiles();
  console.log(`📁 Found ${routeFiles.length} route file(s) in ${ROUTES_DIR}`);
  
  const results = {
    total: routeFiles.length,
    mounted: 0,
    skipped: 0,
    errors: [],
    mountedRoutes: [],
    skippedRoutes: []
  };
  
  // Mount routers in alphabetical order for consistency
  routeFiles.sort().forEach(filename => {
    const mountPath = deriveMountPath(filename);
    const filePath = path.join(ROUTES_DIR, filename);
    
    // Skip if reserved path
    if (RESERVED_PATHS.has(mountPath.replace('/', ''))) {
      results.skipped++;
      results.skippedRoutes.push({
        filename,
        path: mountPath,
        reason: 'Reserved path (already mounted in server.js)',
        controller: 'N/A',
        service: 'N/A'
      });
      return;
    }
    
    try {
      // Clear require cache to ensure fresh load in development
      if (process.env.NODE_ENV !== 'production') {
        delete require.cache[require.resolve(filePath)];
      }
      
      // Load the router
      const routeModule = require(filePath);
      
      // Get the router (handle both module.exports and exports.default)
      const routeHandler = routeModule.default || routeModule;
      
      // If it's a function that returns a router, call it
      let routerInstance = routeHandler;
      if (typeof routeHandler === 'function' && !routeHandler.stack) {
        console.warn(`⚠️  ${filename} exports a function, attempting to call it...`);
        routerInstance = routeHandler();
      }
      
      // Validate the router
      validateRouter(routerInstance, filename);
      
      // Get associated components
      const components = getAssociatedComponents(filename);
      
      // Mount the router
      router.use(mountPath, routerInstance);
      
      results.mounted++;
      results.mountedRoutes.push({
        filename,
        path: mountPath,
        routes: routerInstance.stack ? routerInstance.stack.length : 'unknown',
        controller: components.controller,
        service: components.service,
        controllerExists: components.controllerExists,
        serviceExists: components.serviceExists
      });
      
    } catch (error) {
      results.skipped++;
      
      const components = getAssociatedComponents(filename);
      
      results.errors.push({
        filename,
        path: mountPath,
        error: error.message,
        controller: components.controller,
        service: components.service
      });
      
      results.skippedRoutes.push({
        filename,
        path: mountPath,
        reason: `Error: ${error.message}`,
        controller: components.controller,
        service: components.service
      });
    }
  });
  
  return results;
}

// ===== EXECUTE AUTO-DISCOVERY =====
const discoveryResults = autoDiscoverAndMountRouters();

// ===== PRINT PROFESSIONAL STARTUP REPORT =====
console.log('\n' + '='.repeat(100));
console.log('🚀 ROUTER AUTO-DISCOVERY REPORT');
console.log('='.repeat(100));

// Print summary
console.log(`📊 Total route files found: ${discoveryResults.total}`);
console.log(`✅ Successfully mounted: ${discoveryResults.mounted}`);
console.log(`⏭️  Skipped/Failed: ${discoveryResults.skipped}`);

// Print detailed table
if (discoveryResults.mountedRoutes.length > 0 || discoveryResults.skippedRoutes.length > 0) {
  console.log('\n' + '-'.repeat(100));
  console.log(
    `${'Route File'.padEnd(20)} ` +
    `${'Mounted Path'.padEnd(25)} ` +
    `${'Status'.padEnd(12)} ` +
    `${'Routes'.padEnd(10)} ` +
    `${'Controller'.padEnd(20)} ` +
    `${'Service'.padEnd(20)}`
  );
  console.log('-'.repeat(100));
  
  // Print mounted routes
  discoveryResults.mountedRoutes.forEach(route => {
    const status = '✅ Mounted';
    const controller = route.controllerExists ? route.controller : `⚠️ ${route.controller}`;
    const service = route.serviceExists ? route.service : `⚠️ ${route.service}`;
    
    console.log(
      `${route.filename.padEnd(20)} ` +
      `${route.path.padEnd(25)} ` +
      `${status.padEnd(12)} ` +
      `${route.routes.toString().padEnd(10)} ` +
      `${controller.padEnd(20)} ` +
      `${service.padEnd(20)}`
    );
  });
  
  // Print skipped routes
  discoveryResults.skippedRoutes.forEach(route => {
    const status = '❌ Skipped';
    
    console.log(
      `${route.filename.padEnd(20)} ` +
      `${route.path.padEnd(25)} ` +
      `${status.padEnd(12)} ` +
      `${'N/A'.padEnd(10)} ` +
      `${route.controller.padEnd(20)} ` +
      `${route.service.padEnd(20)}`
    );
    
    // Print reason for skipping
    console.log(`     ↳ Reason: ${route.reason}`);
  });
  
  console.log('-'.repeat(100));
}

// Print errors separately
if (discoveryResults.errors.length > 0) {
  console.log('\n❌ MOUNTING ERRORS:');
  console.log('-'.repeat(100));
  discoveryResults.errors.forEach((error, index) => {
    console.log(`${index + 1}. ${error.filename} (${error.path})`);
    console.log(`   Error: ${error.error}`);
    console.log(`   Controller: ${error.controller}, Service: ${error.service}`);
    console.log();
  });
}

// Print statistics
const controllersFound = discoveryResults.mountedRoutes
  .filter(r => r.controllerExists).length;
const servicesFound = discoveryResults.mountedRoutes
  .filter(r => r.serviceExists).length;

console.log('\n📈 STATISTICS:');
console.log('-'.repeat(100));
console.log(`• Controllers available: ${controllersFound}/${discoveryResults.mounted}`);
console.log(`• Services available: ${servicesFound}/${discoveryResults.mounted}`);
console.log(`• Missing controllers: ${discoveryResults.mounted - controllersFound}`);
console.log(`• Missing services: ${discoveryResults.mounted - servicesFound}`);

console.log('='.repeat(100));
console.log(`✨ Discovery completed: ${discoveryResults.mounted}/${discoveryResults.total} routers mounted`);
console.log('='.repeat(100) + '\n');

// ===== TEST ENDPOINT FOR MAIN ROUTER =====
router.get('/test', (req, res) => {
  const mountedRoutes = discoveryResults.mountedRoutes.map(r => ({
    path: r.path,
    source: r.filename,
    routes: r.routes,
    controller: r.controller,
    service: r.service
  }));
  
  res.status(200).json({
    success: true,
    message: 'Main API router is working (auto-discovery mode)',
    timestamp: new Date().toISOString(),
    discovery: {
      totalFiles: discoveryResults.total,
      mounted: discoveryResults.mounted,
      skipped: discoveryResults.skipped
    },
    mountedRoutes,
    specialRoutes: {
      auth: '/api/auth/* (handled by auth router in server.js)',
      root: '/api/* (this router)'
    }
  });
});

// ===== ROOT HEALTH CHECK =====
router.get('/', (req, res) => {
  const routesList = discoveryResults.mountedRoutes.reduce((acc, route) => {
    acc[route.filename.replace('.js', '')] = {
      path: `/api${route.path}/*`,
      routes: route.routes,
      controller: route.controller,
      service: route.service
    };
    return acc;
  }, {});
  
  res.status(200).json({
    status: 'success',
    message: 'API Server is running (auto-discovery mode)',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    discovery: {
      total: discoveryResults.total,
      mounted: discoveryResults.mounted,
      skipped: discoveryResults.skipped
    },
    routes: routesList,
    specialRoutes: {
      auth: '/auth (mounted in server.js)',
      api: '/api/* (this router)'
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// ===== 404 HANDLER FOR UNKNOWN ROUTES =====
router.use('*', (req, res) => {
  const availableRoutes = discoveryResults.mountedRoutes.reduce((acc, route) => {
    acc[route.filename.replace('.js', '')] = `/api${route.path}/*`;
    return acc;
  }, {});
  
  res.status(404).json({
    status: 'error',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
    availableRoutes,
    specialRoutes: {
      auth: '/api/auth/* (mounted in server.js)'
    },
    tip: 'All routes are auto-discovered from src/routes directory'
  });
});

// CRITICAL: Export router only
module.exports = router;
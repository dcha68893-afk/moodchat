/**
 * phase6.bootstrap.js (Backend)
 * Phase 6 — Runtime Integration Bootstrap
 *
 * Final phase — validates and repairs all previous phase integrations.
 * Already injected into server.js via the patch (5 seconds after socket init).
 *
 * @version 6.0.0
 */

'use strict';

const RuntimeIntegrationService = require('./RuntimeIntegrationService');

let _initialized = false;
let _modules     = {};

function initPhase6(io, app, options = {}) {
  if (_initialized) {
    (options.logger || console).warn('[Phase6Bootstrap] Already initialized.');
    return _modules;
  }

  const logger    = options.logger   || console;
  const wsService = options.wsService;
  const allPhases = {
    phase1: options.phase1 || {},
    phase2: options.phase2 || {},
    phase3: options.phase3 || {},
    phase4: options.phase4 || {},
    phase5: options.phase5 || {},
  };

  logger.log('[Phase6Bootstrap] 🚀 Initializing Phase 6 Runtime Integration…');
  const startMs = Date.now();

  const integration = new RuntimeIntegrationService(io, wsService, {
    logger,
    modules: allPhases,
  });
  integration.attach();

  if (app) {
    integration.registerHealthRoute(app);
  }

  // Wire to Phase 1 monitoring if available
  const monitoring = allPhases.phase1?.monitoring;
  if (monitoring) {
    const orig = monitoring.snapshot.bind(monitoring);
    monitoring.snapshot = function () {
      const snap = orig();
      snap.phase6 = integration.getDiagnostics();
      return snap;
    };
  }

  integration.on('validation:complete', report => {
    monitoring?.recordMetric?.('integration', 'validation', 1, {
      healthy: report.modules?.healthy,
      repairs: report.repairs?.length,
    });
  });

  _modules     = { integration };
  _initialized = true;

  logger.log(`[Phase6Bootstrap] ✅ Phase 6 initialized in ${Date.now() - startMs}ms`);
  return _modules;
}

function getModules() {
  if (!_initialized) throw new Error('[Phase6Bootstrap] Not initialized.');
  return _modules;
}

module.exports = { initPhase6, getModules };

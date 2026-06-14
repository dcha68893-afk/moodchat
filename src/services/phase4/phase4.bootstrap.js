/**
 * phase4.bootstrap.js (Backend)
 * Phase 4 — Group + Social Ecosystem Bootstrap
 *
 * Add to server.js AFTER Phase 3 block:
 *
 *   const { initPhase4 } = require('./phase4.bootstrap');
 *   setTimeout(() => {
 *     global.__phase4 = initPhase4(io, app, {
 *       phase1: global.__phase1, phase2: global.__phase2, phase3: global.__phase3,
 *       wsService: require('../webSocketService'), logger: console,
 *     });
 *   }, 3000);
 *
 * @version 4.0.0
 */

'use strict';

const GroupStoryRealtimeService = require('./GroupStoryRealtimeService');

let _initialized = false;
let _modules     = {};

function initPhase4(io, app, options = {}) {
  if (_initialized) {
    (options.logger || console).warn('[Phase4Bootstrap] Already initialized.');
    return _modules;
  }

  const logger    = options.logger   || console;
  const wsService = options.wsService;
  const phase1    = options.phase1   || {};

  if (!wsService) {
    logger.error('[Phase4Bootstrap] wsService required');
    return {};
  }

  logger.log('[Phase4Bootstrap] 🚀 Initializing Phase 4 Social Ecosystem…');
  const startMs = Date.now();

  // ── Group + Story Realtime Service ────────────────────────────────────────
  const groupStory = new GroupStoryRealtimeService(io, wsService, { logger });
  groupStory.attach();

  // ── Register API routes ───────────────────────────────────────────────────
  if (app) _registerRoutes(app, groupStory, wsService, logger);

  // ── Cross-module wiring ───────────────────────────────────────────────────

  // When Phase 1 marks entity deleted → story engine removes from tracker
  phase1.persistence?.on('entity:deleted', ({ type, id }) => {
    if (type === 'status' || type === 'story') {
      groupStory._storyViews.removeStory(id);
    }
    phase1.monitoring?.recordMetric('social', 'entity_deleted', 1, { type, id });
  });

  groupStory.on('group:message', d => {
    phase1.monitoring?.incrementCounter('group.messages_sent');
  });
  groupStory.on('story:new', d => {
    phase1.monitoring?.incrementCounter('story.created');
  });
  groupStory.on('story:viewed', d => {
    phase1.monitoring?.incrementCounter('story.views');
  });
  groupStory.on('group:kicked', d => {
    phase1.monitoring?.incrementCounter('group.kicks');
  });

  // Extend /internal/diagnostics with Phase 4 data
  if (phase1.monitoring) {
    const origSnap = phase1.monitoring.snapshot.bind(phase1.monitoring);
    phase1.monitoring.snapshot = function () {
      const snap   = origSnap();
      snap.phase4  = { groupStory: groupStory.getDiagnostics() };
      return snap;
    };
  }

  _modules = { groupStory };
  _initialized = true;

  logger.log(`[Phase4Bootstrap] ✅ Phase 4 initialized in ${Date.now() - startMs}ms`);
  return _modules;
}

function _registerRoutes(app, groupStory, wsService, logger) {
  // Community discovery
  app.get('/api/groups/discover', async (req, res) => {
    try {
      const db     = require('../../models');
      const Groups = db.models?.Groups || db.Group || db.groups;
      if (!Groups) return res.json({ groups: [] });

      const { limit = 20, offset = 0, search } = req.query;
      const where = { isPublic: true };
      if (search) where.name = { [db.Sequelize.Op.like]: `%${search}%` };

      const groups = await Groups.findAll({
        where, limit: parseInt(limit), offset: parseInt(offset),
        attributes: ['id', 'name', 'description', 'avatar', 'memberCount', 'category'],
        order: [['memberCount', 'DESC']],
      });
      res.json({ groups });
    } catch (err) {
      logger.warn('[Phase4] GET /api/groups/discover error:', err.message);
      res.json({ groups: [] });
    }
  });

  // Story viewers list
  app.get('/api/status/:storyId/viewers', (req, res) => {
    const viewers = groupStory._storyViews.getViewers(req.params.storyId);
    res.json({ viewers, viewCount: viewers.length });
  });

  // Group online count
  app.get('/api/groups/:groupId/online', (req, res) => {
    const count = groupStory._rooms.memberCount(req.params.groupId);
    res.json({ groupId: req.params.groupId, onlineCount: count });
  });

  logger.log('[Phase4Bootstrap] Routes registered: /api/groups/discover, /api/status/:id/viewers');
}

function getModules() {
  if (!_initialized) throw new Error('[Phase4Bootstrap] Not initialized.');
  return _modules;
}

module.exports = { initPhase4, getModules };

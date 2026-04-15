const path = require('path');
const asyncHandler = require('express-async-handler');
const express = require('express');
const router = express.Router();

// Import database models
const db = require('../models');
const User = db.Users || db.User;
const Chat = db.Chats || db.Chat;
const Call = db.Calls || db.Call;

// Import middleware
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Get Sequelize operators
const Sequelize = require('sequelize');
const { Op, fn, col, literal } = Sequelize;

const CALL_HISTORY_RETENTION_DAYS = parseInt(process.env.CALL_HISTORY_RETENTION_DAYS) || 365;
const MAX_CALL_DURATION = parseInt(process.env.MAX_CALL_DURATION) || 14400;

console.log('✅ Calls routes initialized');

// Helper function to check authentication
const checkAuth = (req, res) => {
  if (!req.user || (!req.user.userId && !req.user.id)) {
    res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
    return null; // signal failure with null
  }
  const userId = req.user.userId || req.user.id;
  return { userId };
};

// Helper function to check database models
const checkModels = (res) => {
  if (!db || !Call || !User) {
    return res.status(503).json({
      status: 'error',
      message: 'Database service not available'
    });
  }
  return true;
};

// Helper function to send notifications via WebSocketService
const notifyUser = async (io, userId, event, data) => {
  try {
    // Try using WebSocketService if available
    if (io && io.WebSocketService) {
      await io.WebSocketService.sendToUser(userId, event, data);
      return true;
    }
    
    // Fallback: emit to user's room
    if (io) {
      io.to(`user:${userId}`).emit(event, data);
      return true;
    }
  } catch (error) {
    console.error(`Error sending notification to user ${userId}:`, error.message);
  }
  return false;
};

// Helper to check if user is participant in call
const isUserParticipant = (call, userId) => {
  if (!call || !call.participants) return false;
  return call.participants.includes(userId);
};

// Helper to safely update array fields
const updateArrayField = async (call, fieldName, userId, action = 'add') => {
  const currentArray = call[fieldName] || [];
  
  if (action === 'add' && !currentArray.includes(userId)) {
    currentArray.push(userId);
    call[fieldName] = currentArray;
    await call.save();
    return true;
  } else if (action === 'remove' && currentArray.includes(userId)) {
    const index = currentArray.indexOf(userId);
    currentArray.splice(index, 1);
    call[fieldName] = currentArray;
    await call.save();
    return true;
  }
  return false;
};

// ========== SPECIFIC ROUTES (BEFORE wildcard) ==========

router.get(
  '/missed/count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      // FIXED: Use Op.contains for ARRAY column
      const missedCount = await Call.count({
        where: {
          participants: { [Op.contains]: [userId] },
          callerId: { [Op.ne]: userId },
          status: 'missed',
          startedAt: { [Op.gte]: twentyFourHoursAgo }
        }
      });

      res.status(200).json({
        status: 'success',
        data: { missedCount: missedCount || 0 },
      });
    } catch (error) {
      console.error('Error getting missed calls count:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch missed calls count'
      });
    }
  })
);

router.post(
  '/missed/read',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callIds } = req.body;

      if (callIds && Array.isArray(callIds)) {
        // FIXED: Fetch calls and update in JS
        const calls = await Call.findAll({
          where: {
            id: callIds,
            participants: { [Op.contains]: [userId] },
            status: 'missed'
          }
        });

        for (const call of calls) {
          await updateArrayField(call, 'readBy', userId, 'add');
        }
      } else {
        const twentyFourHoursAgo = new Date();
        twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

        const calls = await Call.findAll({
          where: {
            participants: { [Op.contains]: [userId] },
            callerId: { [Op.ne]: userId },
            status: 'missed',
            startedAt: { [Op.gte]: twentyFourHoursAgo }
          }
        });

        for (const call of calls) {
          const readBy = call.readBy || [];
          if (!readBy.includes(userId)) {
            await updateArrayField(call, 'readBy', userId, 'add');
          }
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Missed calls marked as read',
      });
    } catch (error) {
      console.error('Error marking missed calls as read:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to mark missed calls as read'
      });
    }
  })
);

// ========== ROOT POST / — called by chat.html CALL_INITIATE handler ==========
// chat.html does: POST /calls  (no sub-path).  This handler is the entry point
// for every outgoing call started from the friends / messages modules.
router.post(
  '/',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      // Normalise call type: frontend sends 'voice' but DB stores 'audio'
      const rawType  = req.body.callType || req.body.type || 'audio';
      const callType = rawType === 'voice' ? 'audio' : rawType;

      const isGroupCall    = req.body.isGroupCall || false;
      const participantIds = req.body.participantIds;              // array sent by parent
      const calleeId       = req.body.calleeId ||
        (Array.isArray(participantIds) && participantIds.length === 1
          ? participantIds[0]
          : null);

      if (!calleeId && !isGroupCall) {
        return res.status(400).json({
          success: false,
          message: 'calleeId or participantIds is required'
        });
      }

      // Lazy-require to avoid circular-dependency issues at startup
      const wsService   = require('../services/webSocketService');
      const callService = require('../services/callService');

      // ── Group call path ──────────────────────────────────────────────────
      if (isGroupCall && Array.isArray(participantIds) && participantIds.length > 1) {
        const call = await callService.initiateGroupCall(
          userId,
          participantIds.map(Number),
          callType,
          null
        );

        participantIds.forEach(id => {
          wsService.notifyCallInitiated(parseInt(id), {
            callId:       call.id,
            callerId:     userId,
            callerName:   req.user.username || 'Unknown',
            callerAvatar: req.user.avatar   || null,
            isGroupCall:  true,
            callType,
            timestamp:    Date.now()
          });
        });

        return res.status(201).json({
          success: true,
          message: 'Group call initiated successfully',
          data: { call }
        });
      }

      // ── 1-to-1 call path ────────────────────────────────────────────────
      const targetId = parseInt(calleeId);
      const isOnline = wsService.isUserOnline(targetId);

      const call = await callService.initiateCall(userId, targetId, callType, null);

      if (!isOnline) {
        // Receiver offline — record as missed so history still shows it
        if (call && call.update) {
          await call.update({ status: 'missed', endedAt: new Date() });
        }
        return res.status(200).json({
          success: false,
          offline: true,
          message: 'User is currently offline. They will be notified when they reconnect.',
          data: { call }
        });
      }

      wsService.notifyCallInitiated(targetId, {
        callId:       call.id,
        callerId:     userId,
        callerName:   call.callInitiatorUser?.username || req.user.username || 'Unknown',
        callerAvatar: call.callInitiatorUser?.avatar   || req.user.avatar   || null,
        callType,
        timestamp:    Date.now()
      });

      return res.status(201).json({
        success: true,
        message: 'Call initiated successfully',
        data: { call }
      });

    } catch (error) {
      console.error('[POST /calls] Error:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to initiate call'
      });
    }
  })
);

// ========== FIXED /history ROUTE ==========
router.get(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const {
        page = 1,
        limit = 20,
        callType,
        direction,
        participantId,
        startDate,
        endDate,
        status,
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      const parsedLimit = parseInt(limit);

      // Include all terminated calls (endedAt set OR terminal status)
      const where = {
        participants: { [Op.contains]: [userId] },
        status: { [Op.in]: ['completed', 'missed', 'cancelled', 'rejected', 'failed'] },
      };

      if (callType && callType !== 'all') {
        where.type = callType;
      }

      if (direction) {
        if (direction === 'incoming') {
          where.callerId = { [Op.ne]: userId };
        } else if (direction === 'outgoing') {
          where.callerId = userId;
        } else if (direction === 'missed') {
          where.status = 'missed';
        }
      }

      if (participantId) {
        where[Op.and] = [
          { participants: { [Op.contains]: [parseInt(participantId)] } },
          { participants: { [Op.contains]: [userId] } }
        ];
      }

      if (status && status !== 'all') {
        where.status = status;
      }

      if (startDate || endDate) {
        where.startedAt = {};
        if (startDate) where.startedAt[Op.gte] = new Date(startDate);
        if (endDate) where.startedAt[Op.lte] = new Date(endDate);
      }

      // FIXED: Simplified query - removed broken association includes
      const { count, rows: calls } = await Call.findAndCountAll({
        where,
        order: [['startedAt', 'DESC']],
        offset,
        limit: parsedLimit,
        distinct: true
      });

      // Collect all unique participant IDs across all calls
      const allParticipantIds = [...new Set(
        (calls || []).flatMap(c => c.participants || [])
      )];
      const participantMap = {};
      if (allParticipantIds.length > 0) {
        const users = await User.findAll({
          where: { id: allParticipantIds },
          attributes: ['id', 'username', 'avatar']
        });
        users.forEach(u => { participantMap[u.id] = u; });
      }

      // FIXED: Safe duration calculation with participantMap enrichment
      const enrichedCalls = (calls || []).map(call => {
        try {
          const callObj = call.toJSON ? call.toJSON() : { ...call.dataValues };

          callObj.direction = call.callerId === userId ? 'outgoing' : 'incoming';

          if (call.startedAt && call.endedAt) {
            const durationMs = new Date(call.endedAt) - new Date(call.startedAt);
            callObj.duration = durationMs > 0 ? Math.floor(durationMs / 1000) : 0;
          } else {
            callObj.duration = 0;
          }

          // Format duration as mm:ss
          const mins = Math.floor(callObj.duration / 60);
          const secs = callObj.duration % 60;
          callObj.displayDuration = `${mins}:${secs.toString().padStart(2, '0')}`;

          // Enrich participants with user objects
          const participantIds = callObj.participants || [];
          callObj.participantUsers = participantIds.map(id => participantMap[id] || { id, username: 'Unknown' });
          callObj.otherParticipants = callObj.participantUsers.filter(p => p.id !== userId);
          callObj.caller = participantMap[call.callerId] || { id: call.callerId, username: 'Unknown' };
          callObj.isMissed = callObj.status === 'missed';

          return callObj;
        } catch (err) {
          console.error('Error enriching call:', err.message);
          return call;
        }
      });

      // FIXED: Separate statistics query - safer and more reliable
      let stats = {
        totalCalls: 0,
        totalDuration: 0,
        completedCalls: 0,
        missedCalls: 0,
      };

      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const allCalls = await Call.findAll({
          where: {
            participants: { [Op.contains]: [userId] },
            startedAt: { [Op.gte]: thirtyDaysAgo },
            endedAt: { [Op.ne]: null }
          },
          attributes: ['status', 'startedAt', 'endedAt']
        });

        if (allCalls && allCalls.length > 0) {
          stats.totalCalls = allCalls.length;
          stats.completedCalls = allCalls.filter(c => c.status === 'completed').length;
          stats.missedCalls = allCalls.filter(c => c.status === 'missed').length;
          
          let totalDuration = 0;
          for (const call of allCalls) {
            if (call.startedAt && call.endedAt && call.status === 'completed') {
              const durationMs = new Date(call.endedAt) - new Date(call.startedAt);
              if (durationMs > 0) {
                totalDuration += Math.floor(durationMs / 1000);
              }
            }
          }
          stats.totalDuration = totalDuration;
        }
      } catch (statsError) {
        console.error('Error calculating statistics:', statsError.message);
        // Continue with empty stats
      }

      res.status(200).json({
        status: 'success',
        data: {
          calls: enrichedCalls,
          statistics: stats,
          pagination: {
            total: count || 0,
            page: parseInt(page),
            limit: parsedLimit,
            pages: count ? Math.ceil(count / parsedLimit) : 0,
          },
        },
      });
    } catch (error) {
      console.error('Error getting call history:', error.message);
      console.error('Stack:', error.stack);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch call history',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  })
);

router.get(
  '/stats/summary',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { period = '30d' } = req.query;

      let startDate = new Date();
      switch (period) {
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(startDate.getDate() - 90);
          break;
        case '365d':
          startDate.setDate(startDate.getDate() - 365);
          break;
        default:
          return res.status(400).json({
            status: 'error',
            message: 'Invalid period. Use: 7d, 30d, 90d, 365d'
          });
      }

      // FIXED: Simplified statistics query
      const calls = await Call.findAll({
        where: {
          participants: { [Op.contains]: [userId] },
          startedAt: { [Op.gte]: startDate },
          endedAt: { [Op.ne]: null }
        },
        attributes: ['status', 'type', 'startedAt', 'endedAt']
      });

      const overallStats = {
        totalCalls: calls.length,
        totalDuration: 0,
        avgDuration: 0,
        longestCall: 0,
        shortestCall: Infinity
      };

      let typeMap = new Map();

      for (const call of calls) {
        let duration = 0;
        if (call.startedAt && call.endedAt) {
          duration = Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
          if (duration > 0) {
            overallStats.totalDuration += duration;
            overallStats.longestCall = Math.max(overallStats.longestCall, duration);
            overallStats.shortestCall = Math.min(overallStats.shortestCall, duration);
          }
        }

        // Type breakdown
        const callType = call.type || 'audio';
        if (!typeMap.has(callType)) {
          typeMap.set(callType, { count: 0, totalDuration: 0 });
        }
        const typeStats = typeMap.get(callType);
        typeStats.count++;
        if (duration > 0) {
          typeStats.totalDuration += duration;
        }
      }

      if (overallStats.totalCalls > 0) {
        overallStats.avgDuration = Math.floor(overallStats.totalDuration / overallStats.totalCalls);
      }
      if (overallStats.shortestCall === Infinity) {
        overallStats.shortestCall = 0;
      }

      const typeBreakdown = Array.from(typeMap.entries()).map(([type, stats]) => ({
        type,
        count: stats.count,
        avgDuration: stats.count > 0 ? Math.floor(stats.totalDuration / stats.count) : 0
      }));

      res.status(200).json({
        status: 'success',
        data: {
          period,
          overall: overallStats,
          typeBreakdown: typeBreakdown,
        },
      });
    } catch (error) {
      console.error('Error getting call statistics:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch call statistics'
      });
    }
  })
);

router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { format = 'json', startDate, endDate } = req.query;

      const where = {
        participants: { [Op.contains]: [userId] }
      };

      if (startDate) {
        where.startedAt = { ...where.startedAt, [Op.gte]: new Date(startDate) };
      }

      if (endDate) {
        where.startedAt = { ...where.startedAt, [Op.lte]: new Date(endDate) };
      }

      const calls = await Call.findAll({
        where,
        order: [['startedAt', 'DESC']]
      });

      // Fetch all participant users separately
      const allExportIds = [...new Set((calls || []).flatMap(c => c.participants || []))];
      const exportUserMap = {};
      if (allExportIds.length > 0) {
        const users = await User.findAll({ where: { id: allExportIds }, attributes: ['id', 'username', 'email'] });
        users.forEach(u => { exportUserMap[u.id] = u; });
      }

      const exportData = (calls || []).map(call => {
        const callJSON = call.toJSON ? call.toJSON() : { ...call.dataValues };
        const participantIds = callJSON.participants || [];
        const participants = participantIds.map(id => ({
          id,
          username: exportUserMap[id]?.username || 'Unknown',
          email: exportUserMap[id]?.email || '',
        }));

        const answeredBy = (callJSON.answeredBy || [])
          .map(id => participants.find(p => p.id === id))
          .filter(Boolean);
        const declinedBy = (callJSON.declinedBy || [])
          .map(id => participants.find(p => p.id === id))
          .filter(Boolean);
        const callerUser = exportUserMap[callJSON.callerId];

        return {
          callId: callJSON.id,
          callType: callJSON.type,
          status: callJSON.status,
          startedAt: callJSON.startedAt,
          endedAt: callJSON.endedAt,
          duration: callJSON.duration,
          caller: {
            id: callJSON.callerId,
            username: callerUser?.username || 'Unknown',
            email: callerUser?.email || '',
          },
          participants,
          answeredBy,
          declinedBy,
          readBy: callJSON.readBy || [],
        };
      });

      if (format === 'csv') {
        const fields = [
          'callId',
          'callType',
          'status',
          'startedAt',
          'endedAt',
          'duration',
          'caller',
          'participants',
        ];
        const csvRows = exportData.map(call => [
          call.callId,
          call.callType,
          call.status,
          call.startedAt,
          call.endedAt,
          call.duration,
          call.caller?.username || '',
          (call.participants || []).map(p => p.username).join('; '),
        ]);

        const csv = [
          fields.join(','),
          ...csvRows.map(row => row.map(field => `"${field || ''}"`).join(',')),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename=call_history_${new Date().toISOString().split('T')[0]}.csv`
        );
        return res.send(csv);
      }

      res.status(200).json({
        status: 'success',
        data: {
          exportedAt: new Date(),
          totalCalls: exportData.length,
          calls: exportData,
        },
      });
    } catch (error) {
      console.error('Error exporting call history:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to export call history'
      });
    }
  })
);

router.delete(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callIds, deleteAll = false, olderThanDays } = req.body;

      if (deleteAll) {
        const result = await Call.destroy({
          where: {
            participants: { [Op.contains]: [userId] }
          }
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result || 0} calls`,
          data: { deletedCount: result || 0 },
        });
      }

      if (olderThanDays) {
        const days = parseInt(olderThanDays);
        if (isNaN(days) || days < 1) {
          return res.status(400).json({
            status: 'error',
            message: 'olderThanDays must be a positive number'
          });
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const result = await Call.destroy({
          where: {
            participants: { [Op.contains]: [userId] },
            startedAt: { [Op.lt]: cutoffDate }
          }
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result || 0} calls older than ${days} days`,
          data: { deletedCount: result || 0 },
        });
      }

      if (callIds && Array.isArray(callIds)) {
        const result = await Call.destroy({
          where: {
            id: callIds,
            participants: { [Op.contains]: [userId] }
          }
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result || 0} calls`,
          data: { deletedCount: result || 0 },
        });
      }

      return res.status(400).json({
        status: 'error',
        message: 'Provide callIds, deleteAll=true, or olderThanDays'
      });
    } catch (error) {
      console.error('Error deleting call history:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete call history'
      });
    }
  })
);

// ========== PARAMETERIZED ROUTES (WILDCARD) ==========

router.post(
  '/start',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { participantIds, chatId, callType = 'audio', isGroupCall = false } = req.body;

      if (!Array.isArray(participantIds) && !chatId) {
        return res.status(400).json({
          status: 'error',
          message: 'Either participantIds or chatId is required'
        });
      }

      if (callType !== 'audio' && callType !== 'video') {
        return res.status(400).json({
          status: 'error',
          message: 'Call type must be audio or video'
        });
      }

      let participants = [];
      let chat = null;

      if (chatId) {
        chat = await Chat.findOne({
          where: {
            id: chatId,
            participants: { [Op.contains]: [userId] },
            isArchived: false
          },
          include: [{
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'socketIds']
          }]
        });

        if (!chat) {
          return res.status(404).json({
            status: 'error',
            message: 'Chat not found or access denied'
          });
        }

        if (chat.chatType === 'direct' && isGroupCall) {
          return res.status(400).json({
            status: 'error',
            message: 'Cannot start group call in direct chat'
          });
        }

        participants = (chat.participants || [])
          .filter(p => p.id !== userId)
          .map(p => p.id);

        if (isGroupCall && participants.length > 10) {
          return res.status(400).json({
            status: 'error',
            message: 'Group calls are limited to 10 participants'
          });
        }
      } else {
        if (!participantIds || participantIds.length === 0) {
          return res.status(400).json({
            status: 'error',
            message: 'At least one participant is required'
          });
        }

        if (!isGroupCall && participantIds.length > 1) {
          return res.status(400).json({
            status: 'error',
            message: 'Audio/Video calls support only one participant'
          });
        }

        const participantUsers = await User.findAll({
          where: { id: participantIds },
          attributes: ['id', 'username', 'socketIds']
        });

        if (participantUsers.length !== participantIds.length) {
          return res.status(404).json({
            status: 'error',
            message: 'One or more participants not found'
          });
        }

        participants = participantUsers.map(p => p.id);
      }

      const call = await Call.create({
        callerId: userId,
        receiverId: participants.length === 1 ? participants[0] : null,
        chatId: chatId || null,
        type: callType,
        status: 'ringing',
        participants: [userId, ...participants],
        startedAt: new Date(),
        answeredBy: [],
        declinedBy: [],
        readBy: []
      });

      if (!call) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to create call'
        });
      }

      // Fetch caller info separately (no broken association)
      const caller = await User.findByPk(userId, {
        attributes: ['id', 'username', 'avatar']
      });

      // Fetch all participant user objects
      const participantUsers = await User.findAll({
        where: { id: [userId, ...participants] },
        attributes: ['id', 'username', 'avatar']
      });

      const callData = {
        id: call.id,
        callerId: call.callerId,
        receiverId: call.receiverId,
        chatId: call.chatId,
        type: call.type,
        status: call.status,
        isGroupCall: call.isGroupCall,
        participants: participantUsers,
        startedAt: call.startedAt,
        answeredBy: call.answeredBy || [],
        declinedBy: call.declinedBy || [],
        readBy: call.readBy || [],
        caller: caller ? { id: caller.id, username: caller.username, avatar: caller.avatar } : null
      };

      if (req.io) {
        const incomingData = {
          callId: call.id,
          caller: callData.caller,
          callType,
          isGroupCall,
          chatId: chatId,
          timestamp: new Date(),
        };

        for (const pid of participants) {
          await notifyUser(req.io, pid, 'call:incoming', incomingData);
        }
      }

      res.status(201).json({
        status: 'success',
        message: 'Call started',
        data: {
          call: callData,
          callId: call.id,
        },
      });
    } catch (error) {
      console.error('Error starting call:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to start call'
      });
    }
  })
);

router.get(
  '/:callId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callId } = req.params;

      if (!callId) {
        return res.status(400).json({
          status: 'error',
          message: 'Call ID is required'
        });
      }

      const call = await Call.findOne({
        where: {
          id: callId,
          participants: { [Op.contains]: [userId] }
        }
      });

      if (!call) {
        return res.status(404).json({
          status: 'error',
          message: 'Call not found or access denied'
        });
      }

      // Fetch participant users separately
      const participantIds = call.participants || [];
      const participantUsers = participantIds.length > 0 ? await User.findAll({
        where: { id: participantIds },
        attributes: ['id', 'username', 'avatar']
      }) : [];
      const pMap = {};
      participantUsers.forEach(u => { pMap[u.id] = { id: u.id, username: u.username, avatar: u.avatar }; });

      const callData = call.toJSON ? call.toJSON() : { ...call.dataValues };
      callData.direction = call.callerId === userId ? 'outgoing' : 'incoming';
      callData.caller = pMap[call.callerId] || { id: call.callerId, username: 'Unknown' };
      callData.participantUsers = participantIds.map(id => pMap[id] || { id, username: 'Unknown' });
      callData.otherParticipants = callData.participantUsers.filter(p => p.id !== userId);

      if (call.startedAt && call.endedAt) {
        callData.duration = Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000);
      } else {
        callData.duration = 0;
      }
      const mins = Math.floor(callData.duration / 60);
      const secs = callData.duration % 60;
      callData.displayDuration = `${mins}:${secs.toString().padStart(2, '0')}`;
      callData.isMissed = callData.status === 'missed';
      callData.answeredParticipants = (call.answeredBy || []).map(id => pMap[id] || { id });
      callData.declinedParticipants = (call.declinedBy || []).map(id => pMap[id] || { id });

      res.status(200).json({
        status: 'success',
        data: { call: callData },
      });
    } catch (error) {
      console.error('Error getting call details:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch call details'
      });
    }
  })
);

router.post(
  '/:callId/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callId } = req.params;

      if (!callId) {
        return res.status(400).json({
          status: 'error',
          message: 'Call ID is required'
        });
      }

      const call = await Call.findOne({
        where: {
          id: callId,
          participants: { [Op.contains]: [userId] },
          status: 'ringing'
        }
      });

      if (!call) {
        return res.status(404).json({
          status: 'error',
          message: 'Call not found or already answered'
        });
      }

      await updateArrayField(call, 'answeredBy', userId, 'add');

      if ((call.answeredBy || []).length === 1) {
        call.status = 'in-progress';
        await call.save();
      }

      const user = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });

      // Notify all participants via WebSocket
      if (req.io) {
        for (const pid of (call.participants || [])) {
          await notifyUser(req.io, pid, 'call:answered', {
            callId: call.id,
            answeredBy: { id: user.id, username: user.username, avatar: user.avatar },
            status: call.status,
            timestamp: new Date(),
          });
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Call accepted',
        data: { call: { id: call.id, status: call.status, callId: call.id } },
      });
    } catch (error) {
      console.error('Error accepting call:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to accept call'
      });
    }
  })
);

router.post(
  '/:callId/reject',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callId } = req.params;
      const { reason = 'declined' } = req.body;

      if (!callId) {
        return res.status(400).json({
          status: 'error',
          message: 'Call ID is required'
        });
      }

      const call = await Call.findOne({
        where: {
          id: callId,
          participants: { [Op.contains]: [userId] },
          status: { [Op.in]: ['ringing', 'ongoing', 'in-progress'] }
        }
      });

      if (!call) {
        return res.status(404).json({
          status: 'error',
          message: 'Call not found or already ended'
        });
      }

      await updateArrayField(call, 'declinedBy', userId, 'add');

      if (call.callerId === userId) {
        call.status = 'cancelled';
        call.endedAt = new Date();
        await call.save();
      } else {
        const answeredBy = call.answeredBy || [];
        const declinedBy = call.declinedBy || [];
        const allParticipants = call.participants || [];
        
        const remainingParticipants = allParticipants.filter(
          p => !answeredBy.includes(p) && !declinedBy.includes(p) && p !== userId
        );

        if (remainingParticipants.length === 0 && answeredBy.length === 0) {
          call.status = 'missed';
          call.endedAt = new Date();
          await call.save();
        }
      }

      const user = await User.findByPk(userId);

      if (req.io) {
        for (const pid of (call.participants || [])) {
          await notifyUser(req.io, pid, 'call:rejected', {
            callId: call.id,
            rejectedBy: { id: user.id, username: user.username },
            reason,
            status: call.status,
            timestamp: new Date(),
          });
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Call rejected',
        data: { status: call.status },
      });
    } catch (error) {
      console.error('Error rejecting call:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to reject call'
      });
    }
  })
);

// ========== UPDATED POST /:callId/end WITH FORCE END NOTIFICATIONS ==========
router.post(
  '/:callId/end',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const auth = checkAuth(req, res);
      if (!auth) return;
      const userId = auth.userId;

      if (!checkModels(res)) return;

      const { callId } = req.params;
      const { duration, status: callEndStatus } = req.body;

      if (!callId) {
        return res.status(400).json({
          status: 'error',
          message: 'Call ID is required'
        });
      }

      // Allow any status for ending - not just ringing/ongoing
      const call = await Call.findOne({
        where: {
          id: callId,
          participants: { [Op.contains]: [userId] }
        }
      });

      if (!call) {
        return res.status(404).json({
          status: 'error',
          message: 'Call not found'
        });
      }

      // Calculate actual duration
      let actualDuration = duration;
      if (!actualDuration && call.startedAt) {
        const endTime = call.endedAt || new Date();
        actualDuration = Math.floor((new Date(endTime) - new Date(call.startedAt)) / 1000);
        if (actualDuration < 0) actualDuration = 0;
      }

      // Determine final status
      let finalStatus = call.status;
      
      if (callEndStatus) {
        finalStatus = callEndStatus;
      } else if (call.status === 'ringing' && (!call.answeredBy || call.answeredBy.length === 0)) {
        // Check if enough time passed to mark as missed
        const callAge = Date.now() - new Date(call.startedAt).getTime();
        finalStatus = callAge > 60000 ? 'missed' : 'cancelled';
      } else if (call.status === 'ongoing' || call.status === 'in-progress') {
        finalStatus = actualDuration > 0 ? 'completed' : 'failed';
      }

      // Update call record
      call.status = finalStatus;
      call.endedAt = new Date();
      if (actualDuration > 0) {
        call.duration = actualDuration;
      }

      await call.save();

      // Get the user who ended the call
      const user = await User.findByPk(userId, { attributes: ['id', 'username'] });
      const allParticipants = call.participants || [];

      // CRITICAL: Notify ALL participants about call end with both regular and force end events
      if (req.io) {
        for (const pid of allParticipants) {
          // Send regular call:ended event
          await notifyUser(req.io, pid, 'call:ended', {
            callId: call.id,
            endedBy: { id: user.id, username: user.username },
            duration: actualDuration,
            status: finalStatus,
            timestamp: new Date(),
          });

          // ALSO send force end event to ensure UI resets immediately on all clients
          await notifyUser(req.io, pid, 'call_force_ended', {
            callId: call.id,
            endedBy: { id: user.id, username: user.username },
            duration: actualDuration,
            status: finalStatus,
            forceEnd: true,
            timestamp: new Date(),
          });
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Call ended',
        data: {
          callId: call.id,
          duration: actualDuration,
          status: finalStatus,
        },
      });
    } catch (error) {
      console.error('Error ending call:', error.message);
      res.status(500).json({
        status: 'error',
        message: 'Failed to end call'
      });
    }
  })
);

module.exports = router;
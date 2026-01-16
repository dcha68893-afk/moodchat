const express = require('express');
const router = express.Router();
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const { User, Chat, Call, Message } = require('../models');
const sequelize = require('sequelize');

const CALL_HISTORY_RETENTION_DAYS = parseInt(process.env.CALL_HISTORY_RETENTION_DAYS) || 365;
const MAX_CALL_DURATION = parseInt(process.env.MAX_CALL_DURATION) || 14400;

router.use(authenticate);

console.log('✅ Calls routes initialized');

router.get(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
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

      const where = {
        [sequelize.Op.or]: [
          { callerId: req.user.id },
          { '$participants.id$': req.user.id }
        ],
        endedAt: { [sequelize.Op.ne]: null },
      };

      if (callType) {
        where.callType = callType;
      }

      if (direction) {
        if (direction === 'incoming') {
          where.callerId = { [sequelize.Op.ne]: req.user.id };
          where['$participants.id$'] = req.user.id;
        } else if (direction === 'outgoing') {
          where.callerId = req.user.id;
        } else if (direction === 'missed') {
          where.status = 'missed';
          where['$participants.id$'] = req.user.id;
        }
      }

      if (participantId) {
        where[sequelize.Op.and] = [
          {
            [sequelize.Op.or]: [
              { callerId: participantId },
              { '$participants.id$': participantId }
            ]
          },
          {
            [sequelize.Op.or]: [
              { callerId: req.user.id },
              { '$participants.id$': req.user.id }
            ]
          }
        ];
      }

      if (status) {
        where.status = status;
      }

      if (startDate || endDate) {
        where.startedAt = {};
        if (startDate) where.startedAt[sequelize.Op.gte] = new Date(startDate);
        if (endDate) where.startedAt[sequelize.Op.lte] = new Date(endDate);
      }

      const { count, rows: calls } = await Call.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['username', 'avatar', 'displayName']
          },
          {
            model: User,
            as: 'participants',
            attributes: ['username', 'avatar', 'displayName'],
            through: { attributes: [] },
            where: { id: { [sequelize.Op.ne]: req.user.id } },
            required: false
          },
          {
            model: Chat,
            as: 'chat',
            attributes: ['chatName', 'chatType']
          }
        ],
        order: [['startedAt', 'DESC']],
        offset,
        limit: parseInt(limit),
        distinct: true
      });

      const enrichedCalls = calls.map(call => {
        const callObj = call.toJSON();
        
        if (call.callerId === req.user.id) {
          callObj.direction = 'outgoing';
        } else {
          callObj.direction = 'incoming';
        }

        if (call.startedAt && call.endedAt) {
          callObj.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
        } else {
          callObj.duration = 0;
        }

        callObj.otherParticipants = call.participants.filter(p => p.id !== req.user.id);
        return callObj;
      });

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const stats = await Call.findAll({
        where: {
          [sequelize.Op.or]: [
            { callerId: req.user.id },
            { '$participants.id$': req.user.id }
          ],
          startedAt: { [sequelize.Op.gte]: thirtyDaysAgo }
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: [],
          through: { attributes: [] },
          required: false
        }],
        raw: true,
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('Call.id')), 'totalCalls'],
          [
            sequelize.fn('SUM',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'totalDuration'
          ],
          [
            sequelize.fn('SUM',
              sequelize.literal("CASE WHEN status = 'completed' THEN 1 ELSE 0 END")
            ),
            'completedCalls'
          ],
          [
            sequelize.fn('SUM',
              sequelize.literal("CASE WHEN status = 'missed' THEN 1 ELSE 0 END")
            ),
            'missedCalls'
          ]
        ]
      });

      res.status(200).json({
        status: 'success',
        data: {
          calls: enrichedCalls,
          statistics: stats[0] || {
            totalCalls: 0,
            totalDuration: 0,
            completedCalls: 0,
            missedCalls: 0,
          },
          pagination: {
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(count / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      console.error('Error getting call history:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch call history'
      });
    }
  })
);

router.get(
  '/:callId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { callId } = req.params;

      const call = await Call.findOne({
        where: {
          id: callId,
          [sequelize.Op.or]: [
            { callerId: req.user.id },
            { '$participants.id$': req.user.id }
          ]
        },
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['username', 'avatar', 'displayName']
          },
          {
            model: User,
            as: 'participants',
            attributes: ['username', 'avatar', 'displayName'],
            through: { attributes: [] }
          },
          {
            model: Chat,
            as: 'chat',
            attributes: ['chatName', 'chatType'],
            include: [{
              model: User,
              as: 'participants',
              attributes: ['id', 'username'],
              through: { attributes: [] }
            }]
          }
        ]
      });

      if (!call) {
        throw new NotFoundError('Call not found or access denied');
      }

      const callData = call.toJSON();
      callData.direction = call.callerId === req.user.id ? 'outgoing' : 'incoming';

      if (call.startedAt && call.endedAt) {
        callData.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
      } else {
        callData.duration = 0;
      }

      callData.answeredParticipants = call.participants.filter(
        p => call.answeredBy && call.answeredBy.includes(p.id)
      );

      callData.declinedParticipants = call.participants.filter(
        p => call.declinedBy && call.declinedBy.includes(p.id)
      );

      res.status(200).json({
        status: 'success',
        data: { call: callData },
      });
    } catch (error) {
      console.error('Error getting call details:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch call details'
      });
    }
  })
);

router.post(
  '/start',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { participantIds, chatId, callType = 'audio', isGroupCall = false } = req.body;

      if (!Array.isArray(participantIds) && !chatId) {
        throw new ValidationError('Either participantIds or chatId is required');
      }

      if (callType !== 'audio' && callType !== 'video') {
        throw new ValidationError('Call type must be audio or video');
      }

      let participants = [];
      let chat = null;

      if (chatId) {
        chat = await Chat.findOne({
          where: {
            id: chatId,
            '$participants.id$': req.user.id,
            isArchived: false
          },
          include: [{
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'socketIds', 'blockedUsers']
          }]
        });

        if (!chat) {
          throw new NotFoundError('Chat not found or access denied');
        }

        if (chat.chatType === 'direct' && isGroupCall) {
          throw new ValidationError('Cannot start group call in direct chat');
        }

        participants = chat.participants
          .filter(p => p.id !== req.user.id)
          .map(p => p.id);

        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'blockedUsers',
            attributes: ['id']
          }]
        });

        const blockedParticipants = chat.participants.filter(p => 
          currentUser.blockedUsers.some(bu => bu.id === p.id) ||
          p.blockedUsers.some(bu => bu.id === req.user.id)
        );

        if (blockedParticipants.length > 0) {
          throw new AuthorizationError('Cannot call blocked users');
        }

        if (isGroupCall && participants.length > 10) {
          throw new ValidationError('Group calls are limited to 10 participants');
        }
      } else {
        if (participantIds.length === 0) {
          throw new ValidationError('At least one participant is required');
        }

        if (!isGroupCall && participantIds.length > 1) {
          throw new ValidationError('Audio/Video calls support only one participant');
        }

        const participantUsers = await User.findAll({
          where: { id: participantIds },
          attributes: ['id', 'username', 'socketIds', 'blockedUsers']
        });

        if (participantUsers.length !== participantIds.length) {
          throw new NotFoundError('One or more participants not found');
        }

        const currentUser = await User.findByPk(req.user.id, {
          include: [{
            model: User,
            as: 'blockedUsers',
            attributes: ['id']
          }]
        });

        const blockedParticipants = participantUsers.filter(p =>
          currentUser.blockedUsers.some(bu => bu.id === p.id) ||
          p.blockedUsers.some(bu => bu.id === req.user.id)
        );

        if (blockedParticipants.length > 0) {
          throw new AuthorizationError('Cannot call blocked users');
        }

        participants = participantUsers.map(p => p.id);
      }

      const call = await Call.create({
        callerId: req.user.id,
        chatId: chatId || null,
        callType,
        isGroupCall,
        status: 'ringing',
        startedAt: new Date(),
      });

      await call.setParticipants([req.user.id, ...participants]);

      const populatedCall = await Call.findByPk(call.id, {
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['username', 'avatar', 'displayName']
          },
          {
            model: User,
            as: 'participants',
            attributes: ['username', 'avatar', 'displayName', 'socketIds'],
            through: { attributes: [] }
          }
        ]
      });

      const caller = await User.findByPk(req.user.id);

      if (req.io) {
        const callData = {
          callId: call.id,
          caller: {
            id: caller.id,
            username: caller.username,
            avatar: caller.avatar,
          },
          callType,
          isGroupCall,
          chatId: chatId,
          timestamp: new Date(),
        };

        populatedCall.participants.forEach(participant => {
          if (participant.id !== req.user.id && participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('call:incoming', callData);
            });
          }
        });

        if (caller.socketIds) {
          caller.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('call:ringing', {
              callId: call.id,
              participants: participants.length,
            });
          });
        }
      }

      res.status(201).json({
        status: 'success',
        message: 'Call started',
        data: {
          call: populatedCall,
          callId: call.id,
        },
      });
    } catch (error) {
      console.error('Error starting call:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to start call'
      });
    }
  })
);

router.post(
  '/:callId/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { callId } = req.params;

      const call = await Call.findOne({
        where: {
          id: callId,
          '$participants.id$': req.user.id,
          status: 'ringing'
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!call) {
        throw new NotFoundError('Call not found or already answered');
      }

      const answeredBy = call.answeredBy || [];
      answeredBy.push(req.user.id);
      call.answeredBy = answeredBy;

      if (answeredBy.length === 1) {
        call.status = 'ongoing';
      }

      await call.save();

      const updatedCall = await Call.findByPk(callId, {
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['username', 'avatar', 'socketIds']
          },
          {
            model: User,
            as: 'participants',
            attributes: ['username', 'avatar', 'socketIds'],
            through: { attributes: [] }
          }
        ]
      });

      const user = await User.findByPk(req.user.id);

      if (req.io) {
        updatedCall.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('call:answered', {
                callId: call.id,
                answeredBy: {
                  id: user.id,
                  username: user.username,
                  avatar: user.avatar,
                },
                status: call.status,
                timestamp: new Date(),
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Call accepted',
        data: { call: updatedCall },
      });
    } catch (error) {
      console.error('Error accepting call:', error);
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
      const { callId } = req.params;
      const { reason = 'declined' } = req.body;

      const call = await Call.findOne({
        where: {
          id: callId,
          '$participants.id$': req.user.id,
          status: { [sequelize.Op.in]: ['ringing', 'ongoing'] }
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: ['id'],
          through: { attributes: [] }
        }]
      });

      if (!call) {
        throw new NotFoundError('Call not found or already ended');
      }

      const declinedBy = call.declinedBy || [];
      declinedBy.push(req.user.id);
      call.declinedBy = declinedBy;

      if (call.callerId === req.user.id) {
        call.status = 'cancelled';
        call.endedAt = new Date();
      } else {
        const answeredBy = call.answeredBy || [];
        const declinedBySet = new Set(call.declinedBy || []);
        const remainingParticipants = call.participants.filter(
          p => !answeredBy.includes(p.id) && !declinedBySet.has(p.id)
        );

        if (remainingParticipants.length === 0) {
          call.status = 'missed';
          call.endedAt = new Date();
        }
      }

      await call.save();

      const user = await User.findByPk(req.user.id);

      if (req.io) {
        const callData = await Call.findByPk(callId, {
          include: [{
            model: User,
            as: 'participants',
            attributes: ['socketIds'],
            through: { attributes: [] }
          }]
        });

        if (callData) {
          callData.participants.forEach(participant => {
            if (participant.socketIds) {
              participant.socketIds.forEach(socketId => {
                req.io.to(socketId).emit('call:rejected', {
                  callId: call.id,
                  rejectedBy: {
                    id: user.id,
                    username: user.username,
                  },
                  reason,
                  status: call.status,
                  timestamp: new Date(),
                });
              });
            }
          });
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Call rejected',
        data: { status: call.status },
      });
    } catch (error) {
      console.error('Error rejecting call:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to reject call'
      });
    }
  })
);

router.post(
  '/:callId/end',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { callId } = req.params;
      const { duration } = req.body;

      const call = await Call.findOne({
        where: {
          id: callId,
          [sequelize.Op.or]: [
            { callerId: req.user.id },
            { '$participants.id$': req.user.id }
          ],
          status: { [sequelize.Op.in]: ['ringing', 'ongoing'] }
        }
      });

      if (!call) {
        throw new NotFoundError('Call not found or already ended');
      }

      if (duration && (duration < 0 || duration > MAX_CALL_DURATION)) {
        throw new ValidationError(`Duration must be between 0 and ${MAX_CALL_DURATION} seconds`);
      }

      const actualDuration = duration || 
        (call.startedAt ? Math.floor((new Date() - call.startedAt) / 1000) : 0);

      call.status = 'completed';
      call.endedAt = new Date();
      call.duration = actualDuration;

      if (call.status === 'ringing' && (!call.answeredBy || call.answeredBy.length === 0)) {
        call.status = 'missed';
      }

      await call.save();

      const populatedCall = await Call.findByPk(callId, {
        include: [{
          model: User,
          as: 'participants',
          attributes: ['username', 'avatar', 'socketIds'],
          through: { attributes: [] }
        }]
      });

      if (req.io) {
        const user = await User.findByPk(req.user.id);

        populatedCall.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('call:ended', {
                callId: call.id,
                endedBy: {
                  id: user.id,
                  username: user.username,
                },
                duration: actualDuration,
                status: call.status,
                timestamp: new Date(),
              });
            });
          }
        });
      }

      res.status(200).json({
        status: 'success',
        message: 'Call ended',
        data: {
          callId: call.id,
          duration: actualDuration,
          status: call.status,
        },
      });
    } catch (error) {
      console.error('Error ending call:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to end call'
      });
    }
  })
);

router.get(
  '/missed/count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      const missedCount = await Call.count({
        where: {
          '$participants.id$': req.user.id,
          callerId: { [sequelize.Op.ne]: req.user.id },
          status: 'missed',
          startedAt: { [sequelize.Op.gte]: twentyFourHoursAgo }
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: [],
          through: { attributes: [] },
          required: true
        }],
        distinct: true
      });

      res.status(200).json({
        status: 'success',
        data: { missedCount },
      });
    } catch (error) {
      console.error('Error getting missed calls count:', error);
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
      const { callIds } = req.body;

      if (callIds && Array.isArray(callIds)) {
        await Call.update(
          { readBy: sequelize.fn('array_append', sequelize.col('readBy'), req.user.id) },
          {
            where: {
              id: callIds,
              '$participants.id$': req.user.id,
              status: 'missed'
            },
            include: [{
              model: User,
              as: 'participants',
              attributes: [],
              through: { attributes: [] },
              required: true
            }]
          }
        );
      } else {
        const twentyFourHoursAgo = new Date();
        twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

        await Call.update(
          { readBy: sequelize.fn('array_append', sequelize.col('readBy'), req.user.id) },
          {
            where: {
              '$participants.id$': req.user.id,
              callerId: { [sequelize.Op.ne]: req.user.id },
              status: 'missed',
              startedAt: { [sequelize.Op.gte]: twentyFourHoursAgo },
              readBy: { [sequelize.Op.not]: sequelize.literal(`'${req.user.id}' = ANY(readBy)`) }
            },
            include: [{
              model: User,
              as: 'participants',
              attributes: [],
              through: { attributes: [] },
              required: true
            }]
          }
        );
      }

      res.status(200).json({
        status: 'success',
        message: 'Missed calls marked as read',
      });
    } catch (error) {
      console.error('Error marking missed calls as read:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to mark missed calls as read'
      });
    }
  })
);

router.delete(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
      const { callIds, deleteAll = false, olderThanDays } = req.body;

      if (deleteAll) {
        const result = await Call.destroy({
          where: {
            [sequelize.Op.or]: [
              { callerId: req.user.id },
              { '$participants.id$': req.user.id }
            ]
          },
          include: [{
            model: User,
            as: 'participants',
            attributes: [],
            through: { attributes: [] },
            required: true
          }]
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result} calls`,
          data: { deletedCount: result },
        });
      }

      if (olderThanDays) {
        const days = parseInt(olderThanDays);
        if (isNaN(days) || days < 1) {
          throw new ValidationError('olderThanDays must be a positive number');
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const result = await Call.destroy({
          where: {
            [sequelize.Op.or]: [
              { callerId: req.user.id },
              { '$participants.id$': req.user.id }
            ],
            startedAt: { [sequelize.Op.lt]: cutoffDate }
          },
          include: [{
            model: User,
            as: 'participants',
            attributes: [],
            through: { attributes: [] },
            required: true
          }]
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result} calls older than ${days} days`,
          data: { deletedCount: result },
        });
      }

      if (callIds && Array.isArray(callIds)) {
        const result = await Call.destroy({
          where: {
            id: callIds,
            [sequelize.Op.or]: [
              { callerId: req.user.id },
              { '$participants.id$': req.user.id }
            ]
          },
          include: [{
            model: User,
            as: 'participants',
            attributes: [],
            through: { attributes: [] },
            required: true
          }]
        });

        return res.status(200).json({
          status: 'success',
          message: `Deleted ${result} calls`,
          data: { deletedCount: result },
        });
      }

      throw new ValidationError('Provide callIds, deleteAll=true, or olderThanDays');
    } catch (error) {
      console.error('Error deleting call history:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete call history'
      });
    }
  })
);

router.get(
  '/stats/summary',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    try {
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
          throw new ValidationError('Invalid period. Use: 7d, 30d, 90d, 365d');
      }

      const stats = await Call.findAll({
        where: {
          [sequelize.Op.or]: [
            { callerId: req.user.id },
            { '$participants.id$': req.user.id }
          ],
          startedAt: { [sequelize.Op.gte]: startDate }
        },
        include: [
          {
            model: User,
            as: 'participants',
            attributes: [],
            through: { attributes: [] },
            required: true
          },
          {
            model: Chat,
            as: 'chat',
            attributes: []
          }
        ],
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('Call.id')), 'totalCalls'],
          [
            sequelize.fn('SUM',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'totalDuration'
          ],
          [
            sequelize.fn('AVG',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'avgDuration'
          ],
          [
            sequelize.fn('MAX',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'longestCall'
          ],
          [
            sequelize.fn('MIN',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'shortestCall'
          ]
        ],
        group: ['Call.id'],
        raw: true
      });

      const overallStats = {
        totalCalls: stats.length,
        totalDuration: Math.floor(stats.reduce((sum, stat) => sum + (stat.totalDuration || 0), 0)),
        avgDuration: Math.floor(stats.reduce((sum, stat) => sum + (stat.avgDuration || 0), 0) / stats.length),
        longestCall: Math.floor(Math.max(...stats.map(stat => stat.longestCall || 0))),
        shortestCall: Math.floor(Math.min(...stats.map(stat => stat.shortestCall || 0)))
      };

      const typeBreakdown = await Call.findAll({
        where: {
          [sequelize.Op.or]: [
            { callerId: req.user.id },
            { '$participants.id$': req.user.id }
          ],
          startedAt: { [sequelize.Op.gte]: startDate }
        },
        include: [{
          model: User,
          as: 'participants',
          attributes: [],
          through: { attributes: [] },
          required: true
        }],
        attributes: [
          'callType',
          [sequelize.fn('COUNT', sequelize.col('Call.id')), 'count'],
          [
            sequelize.fn('AVG',
              sequelize.literal("EXTRACT(EPOCH FROM (endedAt - startedAt))")
            ),
            'avgDuration'
          ]
        ],
        group: ['callType'],
        raw: true
      });

      res.status(200).json({
        status: 'success',
        data: {
          period,
          overall: overallStats,
          typeBreakdown,
        },
      });
    } catch (error) {
      console.error('Error getting call statistics:', error);
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
      const { format = 'json', startDate, endDate } = req.query;

      const where = {
        [sequelize.Op.or]: [
          { callerId: req.user.id },
          { '$participants.id$': req.user.id }
        ]
      };

      if (startDate) {
        where.startedAt = { ...where.startedAt, [sequelize.Op.gte]: new Date(startDate) };
      }

      if (endDate) {
        where.startedAt = { ...where.startedAt, [sequelize.Op.lte]: new Date(endDate) };
      }

      const calls = await Call.findAll({
        where,
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['username', 'email']
          },
          {
            model: User,
            as: 'participants',
            attributes: ['username', 'email'],
            through: { attributes: [] }
          }
        ],
        order: [['startedAt', 'DESC']]
      });

      const exportData = calls.map(call => {
        const callJSON = call.toJSON();
        const participants = callJSON.participants.map(p => ({
          id: p.id,
          username: p.username,
          email: p.email,
        }));

        const answeredBy = callJSON.answeredBy
          ?.map(id => participants.find(p => p.id === id))
          .filter(Boolean) || [];

        const declinedBy = callJSON.declinedBy
          ?.map(id => participants.find(p => p.id === id))
          .filter(Boolean) || [];

        return {
          callId: callJSON.id,
          callType: callJSON.callType,
          isGroupCall: callJSON.isGroupCall,
          status: callJSON.status,
          startedAt: callJSON.startedAt,
          endedAt: callJSON.endedAt,
          duration: callJSON.duration,
          caller: {
            id: callJSON.caller.id,
            username: callJSON.caller.username,
            email: callJSON.caller.email,
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
          call.caller.username,
          call.participants.map(p => p.username).join('; '),
        ]);

        const csv = [
          fields.join(','),
          ...csvRows.map(row => row.map(field => `"${field}"`).join(',')),
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
      console.error('Error exporting call history:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to export call history'
      });
    }
  })
);

module.exports = router;
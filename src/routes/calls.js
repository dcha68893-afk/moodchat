const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Import middleware and utilities
const {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');
const { apiRateLimiter } = require('../middleware/rateLimiter');
const Call = require('../models/Call');
const User = require('../models/User');
const Chat = require('../models/Chat');

// Environment variables
const CALL_HISTORY_RETENTION_DAYS = parseInt(process.env.CALL_HISTORY_RETENTION_DAYS) || 365;
const MAX_CALL_DURATION = parseInt(process.env.MAX_CALL_DURATION) || 14400; // 4 hours in seconds

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get user's call history with filtering
 */
router.get(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      callType, // 'audio', 'video', 'group'
      direction, // 'incoming', 'outgoing', 'missed'
      participantId,
      startDate,
      endDate,
      status, // 'completed', 'missed', 'rejected', 'cancelled'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build query for calls involving the user
    const query = {
      $or: [{ caller: req.user.id }, { participants: req.user.id }],
      endedAt: { $ne: null }, // Only show completed calls
    };

    // Apply filters
    if (callType) {
      query.callType = callType;
    }

    if (direction) {
      if (direction === 'incoming') {
        query.caller = { $ne: req.user.id };
        query.participants = req.user.id;
      } else if (direction === 'outgoing') {
        query.caller = req.user.id;
      } else if (direction === 'missed') {
        query.status = 'missed';
        query.participants = req.user.id;
      }
    }

    if (participantId && mongoose.Types.ObjectId.isValid(participantId)) {
      // Find calls with this specific participant
      query.$and = [
        {
          $or: [{ caller: participantId }, { participants: participantId }],
        },
        {
          $or: [{ caller: req.user.id }, { participants: req.user.id }],
        },
      ];
    }

    if (status) {
      query.status = status;
    }

    // Date range filter
    if (startDate || endDate) {
      query.startedAt = {};
      if (startDate) query.startedAt.$gte = new Date(startDate);
      if (endDate) query.startedAt.$lte = new Date(endDate);
    }

    // Get calls with pagination
    const [calls, total] = await Promise.all([
      Call.find(query)
        .populate({
          path: 'caller',
          select: 'username avatar displayName',
        })
        .populate({
          path: 'participants',
          select: 'username avatar displayName',
          match: { _id: { $ne: req.user.id } },
        })
        .populate({
          path: 'chat',
          select: 'chatName chatType',
        })
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Call.countDocuments(query),
    ]);

    // Enrich call data
    const enrichedCalls = calls.map(call => {
      const callObj = { ...call };

      // Determine call direction for current user
      if (call.caller._id.toString() === req.user.id) {
        callObj.direction = 'outgoing';
      } else {
        callObj.direction = 'incoming';
      }

      // Calculate duration
      if (call.startedAt && call.endedAt) {
        callObj.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
      } else {
        callObj.duration = 0;
      }

      // Get other participants (excluding current user)
      callObj.otherParticipants = call.participants.filter(p => p._id.toString() !== req.user.id);

      return callObj;
    });

    // Get call statistics
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const stats = await Call.aggregate([
      {
        $match: {
          $or: [
            { caller: mongoose.Types.ObjectId(req.user.id) },
            { participants: mongoose.Types.ObjectId(req.user.id) },
          ],
          startedAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: { $subtract: ['$endedAt', '$startedAt'] } },
          completedCalls: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
          missedCalls: {
            $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] },
          },
        },
      },
    ]);

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
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  })
);

/**
 * Get call details
 */
router.get(
  '/:callId',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callId } = req.params;

    const call = await Call.findOne({
      _id: callId,
      $or: [{ caller: req.user.id }, { participants: req.user.id }],
    })
      .populate({
        path: 'caller',
        select: 'username avatar displayName',
      })
      .populate({
        path: 'participants',
        select: 'username avatar displayName',
      })
      .populate({
        path: 'chat',
        select: 'chatName chatType participants',
      });

    if (!call) {
      throw new NotFoundError('Call not found or access denied');
    }

    // Enrich call data
    const callData = call.toObject();

    // Determine call direction
    callData.direction = call.caller._id.toString() === req.user.id ? 'outgoing' : 'incoming';

    // Calculate duration
    if (call.startedAt && call.endedAt) {
      callData.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
    } else {
      callData.duration = 0;
    }

    // Get call participants who answered
    callData.answeredParticipants = call.participants.filter(
      p => call.answeredBy && call.answeredBy.includes(p._id)
    );

    // Get call participants who declined
    callData.declinedParticipants = call.participants.filter(
      p => call.declinedBy && call.declinedBy.includes(p._id)
    );

    res.status(200).json({
      status: 'success',
      data: { call: callData },
    });
  })
);

/**
 * Start a new call (audio/video)
 */
router.post(
  '/start',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { participantIds, chatId, callType = 'audio', isGroupCall = false } = req.body;

    // Validate input
    if (!Array.isArray(participantIds) && !chatId) {
      throw new ValidationError('Either participantIds or chatId is required');
    }

    if (callType !== 'audio' && callType !== 'video') {
      throw new ValidationError('Call type must be audio or video');
    }

    let participants = [];
    let chat = null;

    // Determine participants based on input
    if (chatId) {
      // Get participants from chat
      chat = await Chat.findOne({
        _id: chatId,
        participants: req.user.id,
        isArchived: false,
      }).populate('participants', '_id username socketIds blockedUsers');

      if (!chat) {
        throw new NotFoundError('Chat not found or access denied');
      }

      // For direct chats, ensure it's not a group call
      if (chat.chatType === 'direct' && isGroupCall) {
        throw new ValidationError('Cannot start group call in direct chat');
      }

      // Get all participants except caller
      participants = chat.participants
        .filter(p => p._id.toString() !== req.user.id)
        .map(p => p._id);

      // Check for blocked users
      const currentUser = await User.findById(req.user.id);
      const blockedParticipants = chat.participants.filter(
        p => currentUser.blockedUsers?.includes(p._id) || p.blockedUsers?.includes(req.user.id)
      );

      if (blockedParticipants.length > 0) {
        throw new AuthorizationError('Cannot call blocked users');
      }

      // For group calls, limit participants
      if (isGroupCall && participants.length > 10) {
        throw new ValidationError('Group calls are limited to 10 participants');
      }
    } else {
      // Validate participant IDs
      if (participantIds.length === 0) {
        throw new ValidationError('At least one participant is required');
      }

      if (!isGroupCall && participantIds.length > 1) {
        throw new ValidationError('Audio/Video calls support only one participant');
      }

      // Get participants
      const participantUsers = await User.find({
        _id: { $in: participantIds },
      }).select('_id username socketIds blockedUsers');

      if (participantUsers.length !== participantIds.length) {
        throw new NotFoundError('One or more participants not found');
      }

      // Check for blocked users
      const currentUser = await User.findById(req.user.id);
      const blockedParticipants = participantUsers.filter(
        p => currentUser.blockedUsers?.includes(p._id) || p.blockedUsers?.includes(req.user.id)
      );

      if (blockedParticipants.length > 0) {
        throw new AuthorizationError('Cannot call blocked users');
      }

      participants = participantUsers.map(p => p._id);
    }

    // Create call record
    const call = await Call.create({
      caller: req.user.id,
      participants: [req.user.id, ...participants],
      chat: chatId || null,
      callType,
      isGroupCall,
      status: 'ringing',
      startedAt: new Date(),
    });

    // Populate call data
    const populatedCall = await Call.findById(call._id)
      .populate({
        path: 'caller',
        select: 'username avatar displayName',
      })
      .populate({
        path: 'participants',
        select: 'username avatar displayName socketIds',
      });

    // Get caller info
    const caller = await User.findById(req.user.id);

    // Send WebSocket call invitations to participants
    if (req.io) {
      const callData = {
        callId: call._id,
        caller: {
          id: caller._id,
          username: caller.username,
          avatar: caller.avatar,
        },
        callType,
        isGroupCall,
        chatId: chatId,
        timestamp: new Date(),
      };

      // Send to each participant
      populatedCall.participants.forEach(participant => {
        if (participant._id.toString() !== req.user.id && participant.socketIds) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('call:incoming', callData);
          });
        }
      });

      // Also notify caller that call is ringing
      if (caller.socketIds) {
        caller.socketIds.forEach(socketId => {
          req.io.to(socketId).emit('call:ringing', {
            callId: call._id,
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
        callId: call._id,
      },
    });
  })
);

/**
 * Accept an incoming call
 */
router.post(
  '/:callId/accept',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callId } = req.params;

    const call = await Call.findOne({
      _id: callId,
      participants: req.user.id,
      status: 'ringing',
    });

    if (!call) {
      throw new NotFoundError('Call not found or already answered');
    }

    // Update call status
    call.answeredBy = [...(call.answeredBy || []), req.user.id];

    // If this is the first answer, update status to ongoing
    if (call.answeredBy.length === 1) {
      call.status = 'ongoing';
    }

    await call.save();

    // Populate updated call
    const updatedCall = await Call.findById(callId)
      .populate({
        path: 'caller',
        select: 'username avatar socketIds',
      })
      .populate({
        path: 'participants',
        select: 'username avatar socketIds',
      });

    // Get user info
    const user = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      // Notify caller and all participants
      updatedCall.participants.forEach(participant => {
        if (participant.socketIds) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('call:answered', {
              callId: call._id,
              answeredBy: {
                id: user._id,
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
  })
);

/**
 * Reject/decline a call
 */
router.post(
  '/:callId/reject',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callId } = req.params;
    const { reason = 'declined' } = req.body;

    const call = await Call.findOne({
      _id: callId,
      participants: req.user.id,
      status: { $in: ['ringing', 'ongoing'] },
    });

    if (!call) {
      throw new NotFoundError('Call not found or already ended');
    }

    // Update call
    call.declinedBy = [...(call.declinedBy || []), req.user.id];

    // If caller is rejecting their own call, cancel it
    if (call.caller.toString() === req.user.id) {
      call.status = 'cancelled';
      call.endedAt = new Date();
    } else {
      // Check if all participants have rejected
      const remainingParticipants = call.participants.filter(
        p => !call.answeredBy?.includes(p) && !call.declinedBy?.includes(p)
      );

      if (remainingParticipants.length === 0) {
        call.status = 'missed';
        call.endedAt = new Date();
      }
    }

    await call.save();

    // Get user info
    const user = await User.findById(req.user.id);

    // Send WebSocket notifications
    if (req.io) {
      const callData = await Call.findById(callId).populate('participants', 'socketIds');

      if (callData) {
        callData.participants.forEach(participant => {
          if (participant.socketIds) {
            participant.socketIds.forEach(socketId => {
              req.io.to(socketId).emit('call:rejected', {
                callId: call._id,
                rejectedBy: {
                  id: user._id,
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
  })
);

/**
 * End a call
 */
router.post(
  '/:callId/end',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callId } = req.params;
    const { duration } = req.body;

    const call = await Call.findOne({
      _id: callId,
      $or: [{ caller: req.user.id }, { participants: req.user.id }],
      status: { $in: ['ringing', 'ongoing'] },
    });

    if (!call) {
      throw new NotFoundError('Call not found or already ended');
    }

    // Validate duration if provided
    if (duration && (duration < 0 || duration > MAX_CALL_DURATION)) {
      throw new ValidationError(`Duration must be between 0 and ${MAX_CALL_DURATION} seconds`);
    }

    // Calculate actual duration
    const actualDuration =
      duration || (call.startedAt ? Math.floor((new Date() - call.startedAt) / 1000) : 0);

    // Update call record
    call.status = 'completed';
    call.endedAt = new Date();
    call.duration = actualDuration;

    // If call was ringing and never answered, mark as missed
    if (call.status === 'ringing' && (!call.answeredBy || call.answeredBy.length === 0)) {
      call.status = 'missed';
    }

    await call.save();

    // Get participants
    const populatedCall = await Call.findById(callId).populate(
      'participants',
      'username avatar socketIds'
    );

    // Send WebSocket notifications
    if (req.io) {
      const user = await User.findById(req.user.id);

      populatedCall.participants.forEach(participant => {
        if (participant.socketIds) {
          participant.socketIds.forEach(socketId => {
            req.io.to(socketId).emit('call:ended', {
              callId: call._id,
              endedBy: {
                id: user._id,
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
        callId: call._id,
        duration: actualDuration,
        status: call.status,
      },
    });
  })
);

/**
 * Get missed calls count
 */
router.get(
  '/missed/count',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const missedCount = await Call.countDocuments({
      participants: req.user.id,
      caller: { $ne: req.user.id },
      status: 'missed',
      startedAt: { $gte: twentyFourHoursAgo },
    });

    res.status(200).json({
      status: 'success',
      data: { missedCount },
    });
  })
);

/**
 * Mark missed calls as read
 */
router.post(
  '/missed/read',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callIds } = req.body;

    if (callIds && Array.isArray(callIds)) {
      // Mark specific calls as read
      await Call.updateMany(
        {
          _id: { $in: callIds },
          participants: req.user.id,
          status: 'missed',
        },
        { $addToSet: { readBy: req.user.id } }
      );
    } else {
      // Mark all recent missed calls as read
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      await Call.updateMany(
        {
          participants: req.user.id,
          caller: { $ne: req.user.id },
          status: 'missed',
          startedAt: { $gte: twentyFourHoursAgo },
          readBy: { $ne: req.user.id },
        },
        { $addToSet: { readBy: req.user.id } }
      );
    }

    res.status(200).json({
      status: 'success',
      message: 'Missed calls marked as read',
    });
  })
);

/**
 * Delete call history
 */
router.delete(
  '/history',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { callIds, deleteAll = false, olderThanDays } = req.body;

    if (deleteAll) {
      // Delete all user's call history
      const result = await Call.deleteMany({
        $or: [{ caller: req.user.id }, { participants: req.user.id }],
      });

      return res.status(200).json({
        status: 'success',
        message: `Deleted ${result.deletedCount} calls`,
        data: { deletedCount: result.deletedCount },
      });
    }

    if (olderThanDays) {
      const days = parseInt(olderThanDays);
      if (isNaN(days) || days < 1) {
        throw new ValidationError('olderThanDays must be a positive number');
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await Call.deleteMany({
        $or: [{ caller: req.user.id }, { participants: req.user.id }],
        startedAt: { $lt: cutoffDate },
      });

      return res.status(200).json({
        status: 'success',
        message: `Deleted ${result.deletedCount} calls older than ${days} days`,
        data: { deletedCount: result.deletedCount },
      });
    }

    if (callIds && Array.isArray(callIds)) {
      // Delete specific calls
      const result = await Call.deleteMany({
        _id: { $in: callIds },
        $or: [{ caller: req.user.id }, { participants: req.user.id }],
      });

      return res.status(200).json({
        status: 'success',
        message: `Deleted ${result.deletedCount} calls`,
        data: { deletedCount: result.deletedCount },
      });
    }

    throw new ValidationError('Provide callIds, deleteAll=true, or olderThanDays');
  })
);

/**
 * Get call statistics
 */
router.get(
  '/stats/summary',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;

    // Calculate date range
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

    // Get call statistics
    const stats = await Call.aggregate([
      {
        $match: {
          $or: [
            { caller: mongoose.Types.ObjectId(req.user.id) },
            { participants: mongoose.Types.ObjectId(req.user.id) },
          ],
          startedAt: { $gte: startDate },
        },
      },
      {
        $facet: {
          // Daily statistics
          dailyStats: [
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$startedAt' },
                },
                count: { $sum: 1 },
                totalDuration: { $sum: { $subtract: ['$endedAt', '$startedAt'] } },
                audioCalls: {
                  $sum: { $cond: [{ $eq: ['$callType', 'audio'] }, 1, 0] },
                },
                videoCalls: {
                  $sum: { $cond: [{ $eq: ['$callType', 'video'] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          // Status breakdown
          statusBreakdown: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
              },
            },
          ],
          // Call type breakdown
          typeBreakdown: [
            {
              $group: {
                _id: '$callType',
                count: { $sum: 1 },
                avgDuration: {
                  $avg: { $subtract: ['$endedAt', '$startedAt'] },
                },
              },
            },
          ],
          // Direction breakdown
          directionBreakdown: [
            {
              $project: {
                isOutgoing: {
                  $cond: [{ $eq: ['$caller', mongoose.Types.ObjectId(req.user.id)] }, 1, 0],
                },
                isIncoming: {
                  $cond: [{ $ne: ['$caller', mongoose.Types.ObjectId(req.user.id)] }, 1, 0],
                },
              },
            },
            {
              $group: {
                _id: null,
                outgoing: { $sum: '$isOutgoing' },
                incoming: { $sum: '$isIncoming' },
              },
            },
          ],
          // Most contacted users
          topContacts: [
            {
              $project: {
                otherUsers: {
                  $filter: {
                    input: '$participants',
                    as: 'participant',
                    cond: { $ne: ['$$participant', mongoose.Types.ObjectId(req.user.id)] },
                  },
                },
              },
            },
            { $unwind: '$otherUsers' },
            {
              $group: {
                _id: '$otherUsers',
                callCount: { $sum: 1 },
                totalDuration: { $sum: { $subtract: ['$endedAt', '$startedAt'] } },
              },
            },
            { $sort: { callCount: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'user',
              },
            },
            { $unwind: '$user' },
            {
              $project: {
                userId: '$_id',
                username: '$user.username',
                avatar: '$user.avatar',
                callCount: 1,
                totalDuration: 1,
              },
            },
          ],
          // Overall statistics
          overall: [
            {
              $group: {
                _id: null,
                totalCalls: { $sum: 1 },
                totalDuration: { $sum: { $subtract: ['$endedAt', '$startedAt'] } },
                avgDuration: { $avg: { $subtract: ['$endedAt', '$startedAt'] } },
                longestCall: { $max: { $subtract: ['$endedAt', '$startedAt'] } },
                shortestCall: { $min: { $subtract: ['$endedAt', '$startedAt'] } },
              },
            },
          ],
        },
      },
    ]);

    const result = stats[0];

    // Format durations
    if (result.overall && result.overall.length > 0) {
      const overall = result.overall[0];
      overall.totalDuration = Math.floor(overall.totalDuration / 1000);
      overall.avgDuration = Math.floor(overall.avgDuration / 1000);
      overall.longestCall = Math.floor(overall.longestCall / 1000);
      overall.shortestCall = overall.shortestCall ? Math.floor(overall.shortestCall / 1000) : 0;
    }

    // Format top contacts durations
    result.topContacts.forEach(contact => {
      contact.totalDuration = Math.floor(contact.totalDuration / 1000);
    });

    res.status(200).json({
      status: 'success',
      data: {
        period,
        ...result,
      },
    });
  })
);

/**
 * Export call history
 */
router.get(
  '/export',
  apiRateLimiter,
  asyncHandler(async (req, res) => {
    const { format = 'json', startDate, endDate } = req.query;

    // Build query
    const query = {
      $or: [{ caller: req.user.id }, { participants: req.user.id }],
    };

    if (startDate) {
      query.startedAt = { ...query.startedAt, $gte: new Date(startDate) };
    }

    if (endDate) {
      query.startedAt = { ...query.startedAt, $lte: new Date(endDate) };
    }

    // Get calls for export
    const calls = await Call.find(query)
      .populate({
        path: 'caller',
        select: 'username email',
      })
      .populate({
        path: 'participants',
        select: 'username email',
      })
      .sort({ startedAt: -1 })
      .lean();

    // Format data for export
    const exportData = calls.map(call => {
      const participants = call.participants.map(p => ({
        id: p._id,
        username: p.username,
        email: p.email,
      }));

      const answeredBy =
        call.answeredBy
          ?.map(id => participants.find(p => p.id.toString() === id.toString()))
          .filter(Boolean) || [];

      const declinedBy =
        call.declinedBy
          ?.map(id => participants.find(p => p.id.toString() === id.toString()))
          .filter(Boolean) || [];

      return {
        callId: call._id,
        callType: call.callType,
        isGroupCall: call.isGroupCall,
        status: call.status,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        duration: call.duration,
        caller: {
          id: call.caller._id,
          username: call.caller.username,
          email: call.caller.email,
        },
        participants,
        answeredBy,
        declinedBy,
        readBy: call.readBy || [],
      };
    });

    if (format === 'csv') {
      // Convert to CSV
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

    // Default JSON format
    res.status(200).json({
      status: 'success',
      data: {
        exportedAt: new Date(),
        totalCalls: exportData.length,
        calls: exportData,
      },
    });
  })
);

module.exports = router;

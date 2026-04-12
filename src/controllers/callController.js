const callService = require('../services/callService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class CallController {
  async initiateCall(req, res, next) {
    try {
      const callerId = req.user.id;
      const rawType = req.body.callType || req.body.type || 'audio';
      const type = rawType === 'voice' ? 'audio' : rawType;
      const chatId = req.body.chatId;
      const calleeIds = req.body.calleeIds || (Array.isArray(req.body.participantIds) && req.body.participantIds.length > 1 ? req.body.participantIds : null);
      const calleeId = req.body.calleeId || (Array.isArray(req.body.participantIds) && req.body.participantIds.length === 1 ? req.body.participantIds[0] : null);
      
      // Group call path
      if (Array.isArray(calleeIds) && calleeIds.length > 1) {
        const call = await callService.initiateGroupCall(
          callerId, 
          calleeIds.map(Number), 
          type, 
          chatId ? parseInt(chatId) : null
        );
        
        // Notify all participants
        const wsService = require('../services/webSocketService');
        calleeIds.forEach(id => {
          wsService.notifyCallInitiated(parseInt(id), {
            callId: call.id,
            callerId: callerId,
            callerName: req.user.username || 'Unknown',
            callerAvatar: req.user.avatar || null,
            isGroupCall: true,
            callType: type,
            chatId: chatId ? parseInt(chatId) : null,
            timestamp: Date.now()
          });
        });
        
        return res.status(201).json({
          success: true,
          message: 'Group call initiated successfully',
          data: { call }
        });
      }
      
      // Validate required fields for 1:1 call
      if (!calleeId) {
        throw new AppError('calleeId is required', 400);
      }

      const wsService = require('../services/webSocketService');
      const isOnline = wsService.isUserOnline(parseInt(calleeId));
      
      if (!isOnline) {
        // Still create the call record as 'missed' for history
        const call = await callService.initiateCall(
          callerId, 
          parseInt(calleeId), 
          type, 
          chatId ? parseInt(chatId) : null
        );
        
        // Immediately mark as missed since receiver is offline
        if (call.update) {
          await call.update({ status: 'missed', endedAt: new Date() });
        }
        
        return res.status(200).json({
          success: false,
          offline: true,
          message: 'User is currently offline. They will be notified when they come back online.',
          data: { call }
        });
      }

      const call = await callService.initiateCall(
        callerId, 
        parseInt(calleeId), 
        type, 
        chatId ? parseInt(chatId) : null
      );
      
      // Notify callee via WebSocket
      wsService.notifyCallInitiated(parseInt(calleeId), {
        callId: call.id,
        callerId: callerId,
        callerName: call.callInitiatorUser?.username || req.user.username,
        callerAvatar: call.callInitiatorUser?.avatar || req.user.avatar || null,
        callType: type,
        chatId: chatId ? parseInt(chatId) : null,
        timestamp: Date.now()
      });

      res.status(201).json({
        success: true,
        message: 'Call initiated successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Initiate call controller error:', error);
      next(error);
    }
  }

  async answerCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;
      const { sdpAnswer } = req.body;

      const call = await callService.answerCall(callId, userId, sdpAnswer);

      res.json({
        success: true,
        message: 'Call answered successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Answer call controller error:', error);
      next(error);
    }
  }

  async rejectCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;

      const call = await callService.rejectCall(callId, userId);

      res.json({
        success: true,
        message: 'Call rejected successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Reject call controller error:', error);
      next(error);
    }
  }

  async cancelCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;

      const call = await callService.cancelCall(callId, userId);

      res.json({
        success: true,
        message: 'Call cancelled successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Cancel call controller error:', error);
      next(error);
    }
  }

  async endCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;

      const call = await callService.endCall(callId, userId);

      res.json({
        success: true,
        message: 'Call ended successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('End call controller error:', error);
      next(error);
    }
  }

  async joinCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;
      const { sdpOffer } = req.body;

      const call = await callService.joinCall(callId, userId, sdpOffer);

      res.json({
        success: true,
        message: 'Joined call successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Join call controller error:', error);
      next(error);
    }
  }

  async leaveCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;

      const call = await callService.leaveCall(callId, userId);

      res.json({
        success: true,
        message: 'Left call successfully',
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Leave call controller error:', error);
      next(error);
    }
  }

  async addIceCandidate(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;
      const { candidate } = req.body;

      await callService.addIceCandidate(callId, userId, candidate);

      res.json({
        success: true,
        message: 'ICE candidate added successfully',
      });
    } catch (error) {
      logger.error('Add ICE candidate controller error:', error);
      next(error);
    }
  }

  async getCallDetails(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;

      const call = await callService.getCallDetails(callId);

      // Check if user is participant
      if (!call.participants || !call.participants.includes(userId)) {
        // Also check initiatorId as fallback
        if (call.initiatorId !== userId) {
          throw new AppError('Not authorized to view this call', 403);
        }
      }

      res.json({
        success: true,
        data: {
          call,
        },
      });
    } catch (error) {
      logger.error('Get call details controller error:', error);
      next(error);
    }
  }

  async getActiveCalls(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId } = req.query;

      const calls = await callService.getActiveCalls(chatId ? parseInt(chatId) : null);

      // Filter calls where user is participant
      const userCalls = calls.filter(
        call => (call.participants && call.participants.includes(userId)) || call.initiatorId === userId
      );

      res.json({
        success: true,
        data: {
          calls: userCalls,
          count: userCalls.length,
        },
      });
    } catch (error) {
      logger.error('Get active calls controller error:', error);
      next(error);
    }
  }

  async getUserCalls(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, status, type } = req.query;

      const options = {
        offset: (parseInt(page) - 1) * parseInt(limit),
        limit: parseInt(limit),
      };

      if (status) {
        options.status = status;
      }

      if (type) {
        options.type = type;
      }

      const result = await callService.getUserCalls(userId, options);
      const callsList = Array.isArray(result) ? result : (result.calls || []);
      const total = result.total || callsList.length;

      res.json({
        success: true,
        data: {
          calls: callsList,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: total,
            pages: Math.ceil(total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error('Get user calls controller error:', error);
      next(error);
    }
  }

  async getCallLink(req, res, next) {
    try {
      const { callId } = req.params;
      const call = await callService.getCallById(callId, req.user.id);
      
      const linkToken = Buffer.from(`${callId}:${Date.now()}:${req.user.id}`).toString('base64');
      const callLink = `${process.env.FRONTEND_URL || window.location.origin}/join-call?token=${linkToken}&callId=${callId}`;
      
      res.json({ 
        success: true, 
        data: { 
          callLink, 
          callId,
          expiresIn: 3600 // 1 hour
        } 
      });
    } catch (error) {
      logger.error('Get call link controller error:', error);
      next(error);
    }
  }

  async joinViaLink(req, res, next) {
    try {
      const { callId, token } = req.query;
      const userId = req.user.id;
      
      if (!callId) {
        throw new AppError('callId is required', 400);
      }
      
      // Verify token
      if (token) {
        try {
          const decoded = Buffer.from(token, 'base64').toString();
          const [tokenCallId, timestamp, tokenUserId] = decoded.split(':');
          
          if (tokenCallId !== callId) {
            throw new AppError('Invalid call link', 403);
          }
          
          // Check if link expired (1 hour)
          const linkTime = parseInt(timestamp);
          if (Date.now() - linkTime > 3600000) {
            throw new AppError('Call link has expired', 403);
          }
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw new AppError('Invalid call link token', 403);
        }
      }
      
      const call = await callService.joinCall(callId, userId);
      
      res.json({ 
        success: true, 
        data: { 
          call,
          message: 'Successfully joined call via link'
        } 
      });
    } catch (error) {
      logger.error('Join via link controller error:', error);
      next(error);
    }
  }

  async getMissedCalls(req, res, next) {
    try {
      const userId = req.user.id;
      const { limit = 50 } = req.query;
      
      const missedCalls = await callService.getMissedCalls(userId, parseInt(limit));
      
      res.json({
        success: true,
        data: {
          calls: missedCalls,
          count: missedCalls.length
        }
      });
    } catch (error) {
      logger.error('Get missed calls controller error:', error);
      next(error);
    }
  }

  async markCallAsRead(req, res, next) {
    try {
      const userId = req.user.id;
      const { callId } = req.params;
      
      await callService.markCallAsRead(callId, userId);
      
      res.json({
        success: true,
        message: 'Call marked as read successfully'
      });
    } catch (error) {
      logger.error('Mark call as read controller error:', error);
      next(error);
    }
  }

  async getCallHistory(req, res, next) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 50 } = req.query;
      const result = await callService.getCallHistory
        ? await callService.getCallHistory(userId, parseInt(page), parseInt(limit))
        : await callService.getUserCalls(userId, { offset: (parseInt(page) - 1) * parseInt(limit), limit: parseInt(limit) });
      const callsList = Array.isArray(result) ? result : (result.calls || []);
      res.json({ success: true, data: { calls: callsList } });
    } catch (error) {
      logger.error('Get call history controller error:', error);
      next(error);
    }
  }
}

module.exports = new CallController();
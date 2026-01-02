const callService = require('../services/callService');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

class CallController {
  async initiateCall(req, res, next) {
    try {
      const userId = req.user.id;
      const { chatId, type = 'audio' } = req.body;

      const call = await callService.initiateCall(parseInt(chatId), userId, type);

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
      if (!call.participants.includes(userId)) {
        throw new AppError('Not authorized to view this call', 403);
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
        call => call.participants.includes(userId) || call.initiatorId === userId
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
        offset: (page - 1) * limit,
        limit: parseInt(limit),
      };

      if (status) {
        options.status = status;
      }

      if (type) {
        options.type = type;
      }

      const calls = await callService.getUserCalls(userId, options);

      res.json({
        success: true,
        data: {
          calls,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: calls.length,
          },
        },
      });
    } catch (error) {
      logger.error('Get user calls controller error:', error);
      next(error);
    }
  }
}

module.exports = new CallController();

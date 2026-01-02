const mongoose = require('mongoose');
const Call = require('../models/Call');
const User = require('../models/User');
const Conversation = require('../models/Chat');
const { ServerError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');
const {
  MAX_CALL_DURATION = 3600,
  CALL_TIMEOUT_SECONDS = 30,
  MAX_GROUP_CALL_PARTICIPANTS = 10,
} = process.env;

/**
 * Call Service
 * Handles voice/video call management and signaling
 */
class CallService {
  /**
   * Initiate a new call
   * @param {Object} callData - Call data including caller, callee, and type
   * @returns {Promise<Object>} Created call session
   */
  async initiateCall(callData) {
    try {
      const { callerId, calleeId, callType = 'voice', conversationId } = callData;

      // Validate required fields
      if (!callerId || !calleeId) {
        throw new ValidationError('Caller ID and callee ID are required');
      }

      // Validate call type
      const validCallTypes = ['voice', 'video'];
      if (!validCallTypes.includes(callType)) {
        throw new ValidationError('Invalid call type');
      }

      // Check if users exist
      const [caller, callee] = await Promise.all([
        User.findById(callerId).select('_id username isOnline'),
        User.findById(calleeId).select('_id username isOnline'),
      ]);

      if (!caller || !callee) {
        throw new NotFoundError('Caller or callee not found');
      }

      // Check if conversation exists and users are participants
      let conversation = null;
      if (conversationId) {
        conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          throw new NotFoundError('Conversation not found');
        }

        const participants = conversation.participants.map(p => p.toString());
        if (!participants.includes(callerId) || !participants.includes(calleeId)) {
          throw new ForbiddenError('Users are not participants in this conversation');
        }
      }

      // Check if callee has an active call
      const activeCall = await Call.findOne({
        participants: calleeId,
        status: { $in: ['ringing', 'ongoing'] },
        endedAt: null,
      });

      if (activeCall) {
        throw new ValidationError('Callee is already in a call');
      }

      // Create call record
      const call = new Call({
        caller: new mongoose.Types.ObjectId(callerId),
        participants: [
          new mongoose.Types.ObjectId(callerId),
          new mongoose.Types.ObjectId(calleeId),
        ],
        callType,
        status: 'ringing',
        conversationId: conversationId ? new mongoose.Types.ObjectId(conversationId) : null,
        startedAt: new Date(),
        timeoutAt: new Date(Date.now() + parseInt(CALL_TIMEOUT_SECONDS) * 1000),
      });

      await call.save();

      // Populate user details for response
      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error initiating call:', error);
      throw new ServerError('Failed to initiate call');
    }
  }

  /**
   * Answer an incoming call
   * @param {string} callId - Call ID
   * @param {string} userId - User ID answering the call
   * @returns {Promise<Object>} Updated call
   */
  async answerCall(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId);
      if (!call) {
        throw new NotFoundError('Call not found');
      }

      // Check if user is a participant
      const isParticipant = call.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('User is not a participant in this call');
      }

      // Check if call is still ringing
      if (call.status !== 'ringing') {
        throw new ValidationError('Call is not in ringing state');
      }

      // Check if call has timed out
      if (call.timeoutAt && call.timeoutAt < new Date()) {
        call.status = 'missed';
        call.endedAt = new Date();
        await call.save();
        throw new ValidationError('Call has timed out');
      }

      // Update call status
      call.status = 'ongoing';
      call.answeredAt = new Date();
      call.timeoutAt = null; // Clear timeout
      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error answering call:', error);
      throw new ServerError('Failed to answer call');
    }
  }

  /**
   * Reject or decline a call
   * @param {string} callId - Call ID
   * @param {string} userId - User ID rejecting the call
   * @returns {Promise<Object>} Updated call
   */
  async rejectCall(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId);
      if (!call) {
        throw new NotFoundError('Call not found');
      }

      // Check if user is a participant
      const isParticipant = call.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('User is not a participant in this call');
      }

      // Check if user is the callee (only callee can reject)
      const isCaller = call.caller.toString() === userId;
      if (isCaller) {
        throw new ForbiddenError('Caller cannot reject their own call');
      }

      // Update call status
      call.status = 'rejected';
      call.endedAt = new Date();
      call.timeoutAt = null;
      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error rejecting call:', error);
      throw new ServerError('Failed to reject call');
    }
  }

  /**
   * End an ongoing call
   * @param {string} callId - Call ID
   * @param {string} userId - User ID ending the call
   * @returns {Promise<Object>} Updated call with duration
   */
  async endCall(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId);
      if (!call) {
        throw new NotFoundError('Call not found');
      }

      // Check if user is a participant
      const isParticipant = call.participants.some(p => p.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('User is not a participant in this call');
      }

      // Check if call is ongoing
      if (call.status !== 'ongoing') {
        throw new ValidationError('Call is not in progress');
      }

      // Calculate call duration
      const endedAt = new Date();
      const startedAt = call.answeredAt || call.startedAt;
      const duration = Math.floor((endedAt - startedAt) / 1000);

      // Check maximum duration
      const maxDuration = parseInt(MAX_CALL_DURATION);
      if (duration > maxDuration) {
        throw new ValidationError(`Call exceeded maximum duration of ${maxDuration} seconds`);
      }

      // Update call record
      call.status = 'completed';
      call.endedAt = endedAt;
      call.duration = duration;
      call.timeoutAt = null;
      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error ending call:', error);
      throw new ServerError('Failed to end call');
    }
  }

  /**
   * Initiate a group call
   * @param {Object} callData - Group call data
   * @returns {Promise<Object>} Created group call
   */
  async initiateGroupCall(callData) {
    try {
      const { callerId, participantIds, callType = 'voice', conversationId } = callData;

      if (!callerId || !participantIds || !Array.isArray(participantIds)) {
        throw new ValidationError('Caller ID and participant IDs are required');
      }

      // Include caller in participants
      const allParticipants = [...new Set([callerId, ...participantIds])];

      // Check participant limit
      const maxParticipants = parseInt(MAX_GROUP_CALL_PARTICIPANTS);
      if (allParticipants.length > maxParticipants) {
        throw new ValidationError(
          `Group call cannot have more than ${maxParticipants} participants`
        );
      }

      // Validate call type
      const validCallTypes = ['voice', 'video'];
      if (!validCallTypes.includes(callType)) {
        throw new ValidationError('Invalid call type');
      }

      // Check if conversation exists
      let conversation = null;
      if (conversationId) {
        conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          throw new NotFoundError('Conversation not found');
        }
      }

      // Check if any participant is already in a call
      const activeCalls = await Call.find({
        participants: { $in: allParticipants },
        status: { $in: ['ringing', 'ongoing'] },
        endedAt: null,
      });

      if (activeCalls.length > 0) {
        throw new ValidationError('One or more participants are already in a call');
      }

      // Create group call
      const call = new Call({
        caller: new mongoose.Types.ObjectId(callerId),
        participants: allParticipants.map(id => new mongoose.Types.ObjectId(id)),
        callType,
        status: 'ringing',
        conversationId: conversationId ? new mongoose.Types.ObjectId(conversationId) : null,
        isGroupCall: true,
        startedAt: new Date(),
        timeoutAt: new Date(Date.now() + parseInt(CALL_TIMEOUT_SECONDS) * 1000),
      });

      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error initiating group call:', error);
      throw new ServerError('Failed to initiate group call');
    }
  }

  /**
   * Join a group call
   * @param {string} callId - Call ID
   * @param {string} userId - User ID joining the call
   * @returns {Promise<Object>} Updated call
   */
  async joinGroupCall(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId);
      if (!call) {
        throw new NotFoundError('Call not found');
      }

      if (!call.isGroupCall) {
        throw new ValidationError('Not a group call');
      }

      // Check if user is already a participant
      const isAlreadyParticipant = call.participants.some(p => p.toString() === userId);
      if (!isAlreadyParticipant) {
        // Check participant limit
        const maxParticipants = parseInt(MAX_GROUP_CALL_PARTICIPANTS);
        if (call.participants.length >= maxParticipants) {
          throw new ValidationError('Group call is full');
        }

        // Add user to participants
        call.participants.push(new mongoose.Types.ObjectId(userId));
      }

      // Update user's join time if not already in call
      if (!call.joinedParticipants?.includes(userId)) {
        if (!call.joinedParticipants) {
          call.joinedParticipants = [];
        }
        call.joinedParticipants.push({
          userId: new mongoose.Types.ObjectId(userId),
          joinedAt: new Date(),
        });
      }

      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
        { path: 'joinedParticipants.userId', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error joining group call:', error);
      throw new ServerError('Failed to join group call');
    }
  }

  /**
   * Leave a group call
   * @param {string} callId - Call ID
   * @param {string} userId - User ID leaving the call
   * @returns {Promise<Object>} Updated call
   */
  async leaveGroupCall(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId);
      if (!call) {
        throw new NotFoundError('Call not found');
      }

      if (!call.isGroupCall) {
        throw new ValidationError('Not a group call');
      }

      // Remove from joined participants
      if (call.joinedParticipants) {
        call.joinedParticipants = call.joinedParticipants.filter(
          p => p.userId.toString() !== userId
        );
      }

      // Update call status if no participants left
      if (call.joinedParticipants && call.joinedParticipants.length === 0) {
        call.status = 'completed';
        call.endedAt = new Date();

        // Calculate duration
        if (call.startedAt) {
          call.duration = Math.floor((new Date() - call.startedAt) / 1000);
        }
      }

      await call.save();

      await call.populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
        { path: 'joinedParticipants.userId', select: '_id username profilePicture' },
      ]);

      return this._formatCallResponse(call);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      console.error('Error leaving group call:', error);
      throw new ServerError('Failed to leave group call');
    }
  }

  /**
   * Get active calls for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Active calls
   */
  async getActiveCalls(userId) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      // Clean up timed out calls
      await this._cleanupTimedOutCalls();

      const activeCalls = await Call.find({
        participants: userId,
        status: { $in: ['ringing', 'ongoing'] },
        endedAt: null,
      })
        .populate([
          { path: 'caller', select: '_id username profilePicture' },
          { path: 'participants', select: '_id username profilePicture' },
        ])
        .sort({ startedAt: -1 });

      return activeCalls.map(call => this._formatCallResponse(call));
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching active calls:', error);
      throw new ServerError('Failed to fetch active calls');
    }
  }

  /**
   * Get call history for a user
   * @param {string} userId - User ID
   * @param {number} page - Page number
   * @param {number} limit - Items per page
   * @returns {Promise<Object>} Call history with pagination
   */
  async getCallHistory(userId, page = 1, limit = 20) {
    try {
      if (!userId) {
        throw new ValidationError('User ID is required');
      }

      page = parseInt(page);
      limit = parseInt(limit);

      if (page < 1 || limit < 1 || limit > 100) {
        throw new ValidationError('Invalid pagination parameters');
      }

      const skip = (page - 1) * limit;

      const [calls, total] = await Promise.all([
        Call.find({
          participants: userId,
          endedAt: { $ne: null },
        })
          .populate([
            { path: 'caller', select: '_id username profilePicture' },
            { path: 'participants', select: '_id username profilePicture' },
          ])
          .sort({ endedAt: -1 })
          .skip(skip)
          .limit(limit),
        Call.countDocuments({
          participants: userId,
          endedAt: { $ne: null },
        }),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        calls: calls.map(call => this._formatCallResponse(call)),
        pagination: {
          currentPage: page,
          totalPages,
          totalCalls: total,
          hasNext: page < totalPages,
          hasPrevious: page > 1,
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      console.error('Error fetching call history:', error);
      throw new ServerError('Failed to fetch call history');
    }
  }

  /**
   * Get call by ID
   * @param {string} callId - Call ID
   * @param {string} userId - User ID for authorization
   * @returns {Promise<Object>} Call details
   */
  async getCallById(callId, userId) {
    try {
      if (!callId || !userId) {
        throw new ValidationError('Call ID and user ID are required');
      }

      const call = await Call.findById(callId).populate([
        { path: 'caller', select: '_id username profilePicture' },
        { path: 'participants', select: '_id username profilePicture' },
        { path: 'joinedParticipants.userId', select: '_id username profilePicture' },
      ]);

      if (!call) {
        throw new NotFoundError('Call not found');
      }

      // Check if user is a participant
      const isParticipant = call.participants.some(p => p._id.toString() === userId);
      if (!isParticipant) {
        throw new ForbiddenError('User is not a participant in this call');
      }

      return this._formatCallResponse(call);
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError
      ) {
        throw error;
      }
      console.error('Error fetching call by ID:', error);
      throw new ServerError('Failed to fetch call details');
    }
  }

  /**
   * Clean up timed out calls
   * @private
   */
  async _cleanupTimedOutCalls() {
    try {
      const result = await Call.updateMany(
        {
          status: 'ringing',
          timeoutAt: { $lt: new Date() },
          endedAt: null,
        },
        {
          $set: {
            status: 'missed',
            endedAt: new Date(),
          },
        }
      );

      if (result.modifiedCount > 0) {
        console.log(`Cleaned up ${result.modifiedCount} timed out calls`);
      }
    } catch (error) {
      console.error('Error cleaning up timed out calls:', error);
    }
  }

  /**
   * Format call response
   * @private
   * @param {Object} call - Call document
   * @returns {Object} Formatted call response
   */
  _formatCallResponse(call) {
    const response = {
      id: call._id,
      caller: call.caller,
      participants: call.participants,
      callType: call.callType,
      status: call.status,
      isGroupCall: call.isGroupCall || false,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      duration: call.duration,
      conversationId: call.conversationId,
      timeoutAt: call.timeoutAt,
    };

    if (call.isGroupCall && call.joinedParticipants) {
      response.joinedParticipants = call.joinedParticipants;
      response.activeParticipants = call.joinedParticipants.length;
    }

    return response;
  }
}

module.exports = new CallService();

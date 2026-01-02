import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import callService from '../../../src/services/callService';
import Call from '../../../src/models/Call';
import User from '../../../src/models/User';
import Chat from '../../../src/models/Chat';
import redisClient from '../../../src/config/redis';
import webSocketService from '../../../src/services/webSocketService';

jest.mock('../../../src/models/Call');
jest.mock('../../../src/models/User');
jest.mock('../../../src/models/Chat');
jest.mock('../../../src/config/redis');
jest.mock('../../../src/services/webSocketService');

describe('Call Service', () => {
  let mockCall;
  let mockUser;
  let mockChat;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };

    mockUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'user1',
    };

    mockChat = {
      _id: '507f1f77bcf86cd799439021',
      participants: [
        { user: '507f1f77bcf86cd799439011' },
        { user: '507f1f77bcf86cd799439012' },
      ],
      type: 'private',
    };

    mockCall = {
      _id: '507f1f77bcf86cd799439041',
      chat: '507f1f77bcf86cd799439021',
      type: 'video',
      initiator: '507f1f77bcf86cd799439011',
      participants: [
        { user: '507f1f77bcf86cd799439011', joinedAt: new Date() },
      ],
      status: 'initiated',
      startedAt: null,
      endedAt: null,
      duration: 0,
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({
        ...mockCall,
        chat: mockChat,
        initiator: mockUser,
      }),
    };
  });

  describe('initiateCall', () => {
    it('should initiate call successfully', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const type = 'video';

      Chat.findById.mockResolvedValue(mockChat);
      User.findById.mockResolvedValue(mockUser);
      Call.create.mockResolvedValue(mockCall);
      webSocketService.notifyUser.mockResolvedValue(true);

      const result = await callService.initiateCall(chatId, userId, type);

      expect(Chat.findById).toHaveBeenCalledWith(chatId);
      expect(Call.create).toHaveBeenCalledWith({
        chat: chatId,
        type,
        initiator: userId,
        participants: [{ user: userId, joinedAt: expect.any(Date) }],
        status: 'initiated',
      });
      expect(webSocketService.notifyUser).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.call).toBeDefined();
    });

    it('should fail if chat not found', async () => {
      const chatId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439011';
      const type = 'video';

      Chat.findById.mockResolvedValue(null);

      const result = await callService.initiateCall(chatId, userId, type);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not in chat', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = 'unauthorizedUser';
      const type = 'video';

      const unauthorizedChat = {
        ...mockChat,
        participants: [{ user: '507f1f77bcf86cd799439012' }],
      };

      Chat.findById.mockResolvedValue(unauthorizedChat);

      const result = await callService.initiateCall(chatId, userId, type);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a participant');
    });

    it('should fail if another call is active', async () => {
      const chatId = '507f1f77bcf86cd799439021';
      const userId = '507f1f77bcf86cd799439011';
      const type = 'video';

      Chat.findById.mockResolvedValue(mockChat);
      Call.findOne.mockResolvedValue(mockCall);

      const result = await callService.initiateCall(chatId, userId, type);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');
    });
  });

  describe('acceptCall', () => {
    it('should accept call successfully', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439012';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.acceptCall(callId, userId);

      expect(Call.findById).toHaveBeenCalledWith(callId);
      expect(mockCall.participants).toHaveLength(2);
      expect(mockCall.status).toBe('active');
      expect(mockCall.startedAt).toBeDefined();
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if call not found', async () => {
      const callId = 'nonexistent';
      const userId = '507f1f77bcf86cd799439012';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      });

      const result = await callService.acceptCall(callId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail if user not in chat', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = 'unauthorizedUser';

      const callWithDifferentChat = {
        ...mockCall,
        chat: {
          ...mockChat,
          participants: [{ user: '507f1f77bcf86cd799439011' }],
        },
      };

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(callWithDifferentChat),
      });

      const result = await callService.acceptCall(callId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in chat');
    });
  });

  describe('rejectCall', () => {
    it('should reject call successfully', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439012';
      const reason = 'Busy';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.rejectCall(callId, userId, reason);

      expect(mockCall.status).toBe('rejected');
      expect(mockCall.endedAt).toBeDefined();
      expect(mockCall.rejectionReason).toBe(reason);
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('joinCall', () => {
    it('should join call successfully', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439012';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.joinCall(callId, userId);

      expect(mockCall.participants).toHaveLength(2);
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if call not active', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439012';

      const endedCall = {
        ...mockCall,
        status: 'ended',
      };

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(endedCall),
      });

      const result = await callService.joinCall(callId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not active');
    });
  });

  describe('leaveCall', () => {
    it('should leave call successfully', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';

      const activeCall = {
        ...mockCall,
        status: 'active',
        participants: [
          { user: '507f1f77bcf86cd799439011', joinedAt: new Date(), leftAt: null },
          { user: '507f1f77bcf86cd799439012', joinedAt: new Date(), leftAt: null },
        ],
      };

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(activeCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.leaveCall(callId, userId);

      const participant = activeCall.participants.find(p => p.user === userId);
      expect(participant.leftAt).toBeDefined();
      expect(activeCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should end call if last participant leaves', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';

      const soloCall = {
        ...mockCall,
        status: 'active',
        participants: [
          { user: '507f1f77bcf86cd799439011', joinedAt: new Date(), leftAt: null },
        ],
      };

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(soloCall),
      });

      const result = await callService.leaveCall(callId, userId);

      expect(soloCall.status).toBe('ended');
      expect(soloCall.endedAt).toBeDefined();
      expect(result.success).toBe(true);
    });
  });

  describe('endCall', () => {
    it('should end call successfully', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.endCall(callId, userId);

      expect(mockCall.status).toBe('ended');
      expect(mockCall.endedAt).toBeDefined();
      expect(mockCall.duration).toBeGreaterThan(0);
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if user not authorized', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = 'unauthorizedUser';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      const result = await callService.endCall(callId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorized');
    });
  });

  describe('toggleAudio', () => {
    it('should toggle audio mute status', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';
      const muted = true;

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.toggleAudio(callId, userId, muted);

      const participant = mockCall.participants.find(p => p.user === userId);
      expect(participant.audioMuted).toBe(muted);
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('toggleVideo', () => {
    it('should toggle video status', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';
      const videoOff = true;

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      webSocketService.broadcastToChat.mockResolvedValue(true);

      const result = await callService.toggleVideo(callId, userId, videoOff);

      const participant = mockCall.participants.find(p => p.user === userId);
      expect(participant.videoOff).toBe(videoOff);
      expect(mockCall.save).toHaveBeenCalled();
      expect(webSocketService.broadcastToChat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('getCallDetails', () => {
    it('should get call details', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      const result = await callService.getCallDetails(callId, userId);

      expect(Call.findById).toHaveBeenCalledWith(callId);
      expect(result.success).toBe(true);
      expect(result.call).toBeDefined();
    });
  });

  describe('getCallHistory', () => {
    it('should get call history for user', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const page = 1;
      const limit = 10;

      Call.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([mockCall]),
      });

      Call.countDocuments.mockResolvedValue(1);

      const result = await callService.getCallHistory(userId, page, limit);

      expect(Call.find).toHaveBeenCalledWith({
        'participants.user': userId,
        status: 'ended',
      });
      expect(result.success).toBe(true);
      expect(result.calls).toHaveLength(1);
    });

    it('should filter by chat', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439021';

      Call.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      await callService.getCallHistory(userId, 1, 10, chatId);

      expect(Call.find).toHaveBeenCalledWith({
        'participants.user': userId,
        chat: chatId,
        status: 'ended',
      });
    });
  });

  describe('updateCallRecording', () => {
    it('should update call recording URL', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';
      const recordingUrl = 'https://example.com/recording.mp4';

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockCall),
      });

      const result = await callService.updateCallRecording(callId, userId, recordingUrl);

      expect(mockCall.recordingUrl).toBe(recordingUrl);
      expect(mockCall.save).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fail if call not ended', async () => {
      const callId = '507f1f77bcf86cd799439041';
      const userId = '507f1f77bcf86cd799439011';
      const recordingUrl = 'https://example.com/recording.mp4';

      const activeCall = {
        ...mockCall,
        status: 'active',
      };

      Call.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue(activeCall),
      });

      const result = await callService.updateCallRecording(callId, userId, recordingUrl);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not ended');
    });
  });
});
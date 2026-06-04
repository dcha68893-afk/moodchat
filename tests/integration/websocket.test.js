const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const User = require('../../src/models/User');
const Chat = require('../../src/models/Chat');
const Message = require('../../src/models/Message');
const { connectDB, disconnectDB, clearDB } = require('../utils/testDB');

const TEST_PORT = process.env.TEST_PORT || 5001;
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

describe('Chat Integration Tests', () => {
  let server;
  let user1, user2, user3, adminUser;
  let user1Token, user2Token, user3Token, adminToken;
  let dmChat, groupChat;

  const userData = [
    {
      email: 'user1@example.com',
      password: 'SecurePass123!',
      firstName: 'Alice',
      lastName: 'Smith',
      username: 'alice123'
    },
    {
      email: 'user2@example.com',
      password: 'SecurePass456!',
      firstName: 'Bob',
      lastName: 'Johnson',
      username: 'bob456'
    },
    {
      email: 'user3@example.com',
      password: 'SecurePass789!',
      firstName: 'Charlie',
      lastName: 'Brown',
      username: 'charlie789'
    },
    {
      email: 'admin@example.com',
      password: 'AdminPass123!',
      firstName: 'Admin',
      lastName: 'User',
      username: 'admin_user',
      role: 'admin'
    }
  ];

  const testMessage = {
    content: 'Hello, this is a test message!',
    type: 'text'
  };

  const testGroupChat = {
    name: 'Test Group Chat',
    description: 'A group for testing purposes',
    isGroup: true
  };

  beforeAll(async () => {
    await connectDB();
    server = app.listen(TEST_PORT);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearDB();

    const tokens = [];
    for (const user of userData) {
      const registerResponse = await request(app)
        .post(`${API_PREFIX}/auth/register`)
        .send(user);
      
      if (user.role === 'admin') {
        await User.findOneAndUpdate(
          { email: user.email },
          { role: 'admin' }
        );
      }
      
      const loginResponse = await request(app)
        .post(`${API_PREFIX}/auth/login`)
        .send({
          email: user.email,
          password: user.password
        });
      
      tokens.push(loginResponse.body.tokens.access);
    }
    
    [user1Token, user2Token, user3Token, adminToken] = tokens;
    
    user1 = await User.findOne({ email: userData[0].email });
    user2 = await User.findOne({ email: userData[1].email });
    user3 = await User.findOne({ email: userData[2].email });
    adminUser = await User.findOne({ email: userData[3].email });
    
    dmChat = null;
    groupChat = null;
  });

  const createDMChat = async (token = user1Token, participantId = user2._id) => {
    return request(app)
      .post(`${API_PREFIX}/chats/dm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ participantId });
  };

  const createGroupChat = async (token = user1Token, groupData = testGroupChat, participants = [user2._id, user3._id]) => {
    return request(app)
      .post(`${API_PREFIX}/chats/group`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...groupData,
        participants
      });
  };

  const sendMessage = async (chatId, messageData = testMessage, token = user1Token) => {
    return request(app)
      .post(`${API_PREFIX}/chats/${chatId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send(messageData);
  };

  const validateChatStructure = (chat, isGroup = false) => {
    expect(chat).toHaveProperty('id');
    expect(chat).toHaveProperty('isGroup', isGroup);
    expect(chat).toHaveProperty('createdAt');
    expect(chat).toHaveProperty('updatedAt');
    expect(chat).toHaveProperty('participants');
    expect(Array.isArray(chat.participants)).toBe(true);
    
    if (isGroup) {
      expect(chat).toHaveProperty('name');
      expect(chat).toHaveProperty('description');
      expect(chat).toHaveProperty('admin');
      expect(chat).toHaveProperty('groupAvatar');
    } else {
      expect(chat).toHaveProperty('latestMessage');
    }
  };

  const validateMessageStructure = (message, expectedContent = testMessage.content) => {
    expect(message).toHaveProperty('id');
    expect(message).toHaveProperty('content', expectedContent);
    expect(message).toHaveProperty('type', 'text');
    expect(message).toHaveProperty('sender');
    expect(message.sender).toHaveProperty('id');
    expect(message.sender).toHaveProperty('firstName');
    expect(message.sender).toHaveProperty('lastName');
    expect(message.sender).toHaveProperty('username');
    expect(message).toHaveProperty('chat');
    expect(message).toHaveProperty('readBy');
    expect(Array.isArray(message.readBy)).toBe(true);
    expect(message).toHaveProperty('createdAt');
    expect(message).toHaveProperty('updatedAt');
  };

  describe('Direct Message Chat Tests', () => {
    test('should create DM chat between two users', async () => {
      const response = await createDMChat();

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chat');
      
      const chat = response.body.chat;
      validateChatStructure(chat, false);
      
      expect(chat.participants).toHaveLength(2);
      expect(chat.participants.map(p => p.id)).toContain(user1._id.toString());
      expect(chat.participants.map(p => p.id)).toContain(user2._id.toString());
      
      dmChat = chat;
    });

    test('should return existing DM chat if already exists', async () => {
      const firstResponse = await createDMChat();
      expect(firstResponse.status).toBe(201);
      
      const secondResponse = await createDMChat();
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.chat.id).toBe(firstResponse.body.chat.id);
    });

    test('should return 400 when creating DM with self', async () => {
      const response = await createDMChat(user1Token, user1._id);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Cannot create DM with yourself');
    });

    test('should return 404 when participant does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const response = await createDMChat(user1Token, nonExistentId);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Participant not found');
    });

    test('should return 403 when participant blocks the user', async () => {
      await User.findByIdAndUpdate(user2._id, {
        $addToSet: { blockedUsers: user1._id }
      });

      const response = await createDMChat(user1Token, user2._id);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'You are blocked by this user');
    });
  });

  describe('Group Chat Tests', () => {
    test('should create group chat with multiple participants', async () => {
      const response = await createGroupChat();

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chat');
      
      const chat = response.body.chat;
      validateChatStructure(chat, true);
      
      expect(chat.name).toBe(testGroupChat.name);
      expect(chat.description).toBe(testGroupChat.description);
      expect(chat.admin.id).toBe(user1._id.toString());
      expect(chat.participants).toHaveLength(3);
      expect(chat.participants.map(p => p.id)).toEqual(
        expect.arrayContaining([
          user1._id.toString(),
          user2._id.toString(),
          user3._id.toString()
        ])
      );
      
      groupChat = chat;
    });

    test('should return 400 when creating group with less than 3 participants', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/chats/group`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          ...testGroupChat,
          participants: [user2._id]
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Group chat must have at least 3 participants including admin');
    });

    test('should return 400 when duplicate participants provided', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/chats/group`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          ...testGroupChat,
          participants: [user2._id, user2._id, user3._id]
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Duplicate participants found');
    });

    test('should return 404 when participant does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .post(`${API_PREFIX}/chats/group`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send({
          ...testGroupChat,
          participants: [user2._id, user3._id, nonExistentId]
        });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toMatch(/Participant.*not found/);
    });
  });

  describe('Fetch Chats Tests', () => {
    beforeEach(async () => {
      const dmResponse = await createDMChat();
      dmChat = dmResponse.body.chat;
      
      const groupResponse = await createGroupChat();
      groupChat = groupResponse.body.chat;
    });

    test('should fetch user chats with pagination', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats`)
        .set('Authorization', `Bearer ${user1Token}`)
        .query({ page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chats');
      expect(response.body).toHaveProperty('pagination');
      
      const { chats, pagination } = response.body;
      expect(Array.isArray(chats)).toBe(true);
      expect(chats.length).toBeGreaterThan(0);
      
      chats.forEach(chat => {
        validateChatStructure(chat, chat.isGroup);
      });
      
      expect(pagination).toHaveProperty('page', 1);
      expect(pagination).toHaveProperty('limit', 10);
      expect(pagination).toHaveProperty('totalPages');
      expect(pagination).toHaveProperty('totalItems');
    });

    test('should filter chats by type', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats`)
        .set('Authorization', `Bearer ${user1Token}`)
        .query({ isGroup: true });

      expect(response.status).toBe(200);
      expect(response.body.chats).toHaveLength(1);
      expect(response.body.chats[0].isGroup).toBe(true);
      expect(response.body.chats[0].id).toBe(groupChat.id);
    });

    test('should search chats by participant name', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats`)
        .set('Authorization', `Bearer ${user1Token}`)
        .query({ search: 'Bob' });

      expect(response.status).toBe(200);
      expect(response.body.chats.length).toBeGreaterThan(0);
      
      const dmChatFound = response.body.chats.find(
        chat => !chat.isGroup && chat.participants.some(
          p => p.firstName === 'Bob' || p.lastName === 'Johnson'
        )
      );
      expect(dmChatFound).toBeDefined();
    });

    test('should return empty array when no chats found', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.chats).toHaveLength(0);
    });
  });

  describe('Chat Details Tests', () => {
    beforeEach(async () => {
      const dmResponse = await createDMChat();
      dmChat = dmResponse.body.chat;
      
      const groupResponse = await createGroupChat();
      groupChat = groupResponse.body.chat;
    });

    test('should fetch DM chat details', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chat');
      
      const chat = response.body.chat;
      validateChatStructure(chat, false);
      expect(chat.id).toBe(dmChat.id);
      expect(chat.participants).toHaveLength(2);
    });

    test('should fetch group chat details with participants', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats/${groupChat.id}`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chat');
      
      const chat = response.body.chat;
      validateChatStructure(chat, true);
      expect(chat.id).toBe(groupChat.id);
      expect(chat.participants).toHaveLength(3);
      expect(chat.admin.id).toBe(user1._id.toString());
    });

    test('should return 403 when user not in chat', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}`)
        .set('Authorization', `Bearer ${user3Token}`);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Access denied');
    });

    test('should return 404 when chat does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const response = await request(app)
        .get(`${API_PREFIX}/chats/${nonExistentId}`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Chat not found');
    });
  });

  describe('Message Management Tests', () => {
    beforeEach(async () => {
      const dmResponse = await createDMChat();
      dmChat = dmResponse.body.chat;
    });

    test('should send message in chat', async () => {
      const response = await sendMessage(dmChat.id);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message');
      
      const message = response.body.message;
      validateMessageStructure(message);
      expect(message.sender.id).toBe(user1._id.toString());
      expect(message.chat.id).toBe(dmChat.id);
    });

    test('should send different message types', async () => {
      const mediaMessage = {
        content: 'https://example.com/image.jpg',
        type: 'image',
        metadata: {
          url: 'https://example.com/image.jpg',
          size: 1024,
          dimensions: { width: 800, height: 600 }
        }
      };

      const response = await request(app)
        .post(`${API_PREFIX}/chats/${dmChat.id}/messages`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send(mediaMessage);

      expect(response.status).toBe(201);
      expect(response.body.message.type).toBe('image');
      expect(response.body.message.metadata).toEqual(mediaMessage.metadata);
    });

    test('should return 400 for empty message content', async () => {
      const response = await sendMessage(dmChat.id, { content: '', type: 'text' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Message content is required');
    });

    test('should return 403 when sending message to chat user not in', async () => {
      const response = await sendMessage(dmChat.id, testMessage, user3Token);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Not a participant in this chat');
    });

    test('should fetch chat messages with pagination', async () => {
      await sendMessage(dmChat.id);
      await sendMessage(dmChat.id, { content: 'Second message', type: 'text' });

      const response = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}/messages`)
        .set('Authorization', `Bearer ${user1Token}`)
        .query({ page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('messages');
      expect(response.body).toHaveProperty('pagination');
      
      const { messages } = response.body;
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(2);
      
      messages.forEach(message => {
        validateMessageStructure(message);
      });
      
      expect(messages[0].content).toBe('Second message');
      expect(messages[1].content).toBe('Hello, this is a test message!');
    });

    test('should mark messages as read', async () => {
      await sendMessage(dmChat.id);
      
      const response = await request(app)
        .post(`${API_PREFIX}/chats/${dmChat.id}/messages/read`)
        .set('Authorization', `Bearer ${user2Token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('count');
      expect(response.body.count).toBe(1);
    });
  });

  describe('Group Management Tests', () => {
    beforeEach(async () => {
      const groupResponse = await createGroupChat();
      groupChat = groupResponse.body.chat;
    });

    test('should add participant to group', async () => {
      const newUser = await User.create({
        email: 'newuser@example.com',
        password: 'Pass123!',
        firstName: 'New',
        lastName: 'User',
        username: 'newuser'
      });

      const response = await request(app)
        .post(`${API_PREFIX}/chats/${groupChat.id}/participants`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send({ userId: newUser._id });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Participant added successfully');
      
      const updatedChat = await Chat.findById(groupChat.id);
      expect(updatedChat.participants).toHaveLength(4);
      expect(updatedChat.participants.map(p => p.toString())).toContain(newUser._id.toString());
    });

    test('should remove participant from group', async () => {
      const response = await request(app)
        .delete(`${API_PREFIX}/chats/${groupChat.id}/participants/${user2._id}`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      
      const updatedChat = await Chat.findById(groupChat.id);
      expect(updatedChat.participants).toHaveLength(2);
      expect(updatedChat.participants.map(p => p.toString())).not.toContain(user2._id.toString());
    });

    test('should transfer admin role', async () => {
      const response = await request(app)
        .patch(`${API_PREFIX}/chats/${groupChat.id}/admin`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send({ newAdminId: user2._id });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('message', 'Admin transferred successfully');
      
      const updatedChat = await Chat.findById(groupChat.id);
      expect(updatedChat.admin.toString()).toBe(user2._id.toString());
    });

    test('should return 403 when non-admin tries to manage group', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/chats/${groupChat.id}/participants`)
        .set('Authorization', `Bearer ${user2Token}`)
        .send({ userId: user3._id });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Only group admin can perform this action');
    });

    test('should leave group chat', async () => {
      const response = await request(app)
        .post(`${API_PREFIX}/chats/${groupChat.id}/leave`)
        .set('Authorization', `Bearer ${user2Token}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      
      const updatedChat = await Chat.findById(groupChat.id);
      expect(updatedChat.participants.map(p => p.toString())).not.toContain(user2._id.toString());
    });

    test('should update group info', async () => {
      const updateData = {
        name: 'Updated Group Name',
        description: 'Updated description',
        groupAvatar: 'https://example.com/new-avatar.jpg'
      };

      const response = await request(app)
        .put(`${API_PREFIX}/chats/${groupChat.id}`)
        .set('Authorization', `Bearer ${user1Token}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('chat');
      
      const chat = response.body.chat;
      expect(chat.name).toBe(updateData.name);
      expect(chat.description).toBe(updateData.description);
      expect(chat.groupAvatar).toBe(updateData.groupAvatar);
    });
  });

  describe('Security and Validation Tests', () => {
    beforeEach(async () => {
      const dmResponse = await createDMChat();
      dmChat = dmResponse.body.chat;
    });

    test('should sanitize message content to prevent XSS', async () => {
      const maliciousMessage = {
        content: '<script>alert("xss")</script>Hello',
        type: 'text'
      };

      const response = await sendMessage(dmChat.id, maliciousMessage);

      expect(response.status).toBe(201);
      expect(response.body.message.content).not.toContain('<script>');
      expect(response.body.message.content).toBe('Hello');
    });

    test('should handle very long messages gracefully', async () => {
      const longMessage = {
        content: 'A'.repeat(5000),
        type: 'text'
      };

      const response = await sendMessage(dmChat.id, longMessage);

      expect([201, 400]).toContain(response.status);
      if (response.status === 201) {
        expect(response.body.message.content.length).toBeLessThan(10000);
      }
    });

    test('should prevent SQL injection in search', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats`)
        .set('Authorization', `Bearer ${user1Token}`)
        .query({ search: "'; DROP TABLE users; --" });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.chats)).toBe(true);
    });

    test('should validate chat ID format', async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/chats/invalid-id`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toMatch(/Invalid chat ID/);
    });
  });

  describe('Real-time Chat Scenarios', () => {
    test('should handle multiple messages in quick succession', async () => {
      const messages = Array(5).fill().map((_, i) => ({
        content: `Message ${i + 1}`,
        type: 'text'
      }));

      const promises = messages.map(msg => sendMessage(dmChat.id, msg));
      const responses = await Promise.all(promises);

      responses.forEach(response => {
        expect(response.status).toBe(201);
      });

      const chatResponse = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}/messages`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(chatResponse.body.messages).toHaveLength(5);
    });

    test('should maintain message order correctly', async () => {
      const messages = [
        { content: 'First', type: 'text' },
        { content: 'Second', type: 'text' },
        { content: 'Third', type: 'text' }
      ];

      for (const msg of messages) {
        await sendMessage(dmChat.id, msg);
      }

      const response = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}/messages`)
        .set('Authorization', `Bearer ${user1Token}`);

      const receivedMessages = response.body.messages;
      expect(receivedMessages[0].content).toBe('Third');
      expect(receivedMessages[1].content).toBe('Second');
      expect(receivedMessages[2].content).toBe('First');
    });
  });

  describe('Edge Cases', () => {
    test('should handle deleted users in chats', async () => {
      const dmResponse = await createDMChat();
      dmChat = dmResponse.body.chat;

      await User.findByIdAndDelete(user2._id);

      const response = await request(app)
        .get(`${API_PREFIX}/chats/${dmChat.id}`)
        .set('Authorization', `Bearer ${user1Token}`);

      expect(response.status).toBe(200);
      const participants = response.body.chat.participants.filter(p => p !== null);
      expect(participants.length).toBe(1);
    });

    test('should handle concurrent group joins', async () => {
      const groupResponse = await createGroupChat();
      groupChat = groupResponse.body.chat;

      const newUser = await User.create({
        email: 'joiner@example.com',
        password: 'Pass123!',
        firstName: 'Joiner',
        lastName: 'Test',
        username: 'joiner'
      });

      const joinRequests = Array(3).fill().map(() =>
        request(app)
          .post(`${API_PREFIX}/chats/${groupChat.id}/participants`)
          .set('Authorization', `Bearer ${user1Token}`)
          .send({ userId: newUser._id })
      );

      const responses = await Promise.allSettled(joinRequests);
      const successful = responses.filter(r => r.status === 'fulfilled' && r.value.status === 200);
      const failed = responses.filter(r => r.status === 'fulfilled' && r.value.status !== 200);

      expect(successful.length).toBe(1);
      expect(failed.length).toBe(2);

      const updatedChat = await Chat.findById(groupChat.id);
      expect(updatedChat.participants.map(p => p.toString()).filter(id => id === newUser._id.toString())).toHaveLength(1);
    });
  });
});
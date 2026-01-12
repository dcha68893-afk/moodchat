require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// In-memory storage
const users = [];

// JWT verification middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token required' 
    });
  }
  
  jwt.verify(token, 'test-secret-key-123', (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid or expired token' 
      });
    }
    req.user = user;
    next();
  });
}

// ========== PUBLIC ENDPOINTS ==========

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    server: 'temp-auth',
    usersCount: users.length 
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({ 
    message: 'Test server is running!', 
    usersCount: users.length 
  });
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and username are required'
      });
    }
    
    if (users.find(u => u.email === email)) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = {
      id: users.length + 1,
      email,
      username,
      password: hashedPassword,
      createdAt: new Date(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random`
    };
    
    users.push(user);
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      'test-secret-key-123',
      { expiresIn: '24h' }
    );
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed'
    });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }
    
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, username: user.username },
      'test-secret-key-123',
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

// ========== PROTECTED ENDPOINTS (require token) ==========

// Get user profile
app.get('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile'
    });
  }
});

// Update profile
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { username, avatar } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (username) user.username = username;
    if (avatar) user.avatar = avatar;
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Change password
app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }
    
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    
    res.json({
      success: true,
      message: 'Password changed successfully'
    });
    
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
});

// Logout (client-side - just returns success)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// ========== CHAT ENDPOINTS ==========

const messages = [];
const rooms = ['general', 'random', 'help', 'tech-support'];

// Get all chat rooms
app.get('/api/chat/rooms', authenticateToken, (req, res) => {
  res.json({
    success: true,
    rooms: rooms.map(room => ({
      name: room,
      messageCount: messages.filter(m => m.room === room).length,
      lastMessage: messages
        .filter(m => m.room === room)
        .slice(-1)[0] || null
    }))
  });
});

// Get messages for a room
app.get('/api/chat/messages/:room', authenticateToken, (req, res) => {
  const roomMessages = messages
    .filter(m => m.room === req.params.room)
    .slice(-50); // Last 50 messages
  
  res.json({
    success: true,
    room: req.params.room,
    messages: roomMessages
  });
});

// Send a message
app.post('/api/chat/messages', authenticateToken, (req, res) => {
  try {
    const { room, content } = req.body;
    const user = users.find(u => u.id === req.user.userId);
    
    if (!room || !content) {
      return res.status(400).json({ 
        success: false, 
        message: 'Room and message content are required' 
      });
    }
    
    if (!rooms.includes(room)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid room' 
      });
    }
    
    const message = {
      id: messages.length + 1,
      room,
      content,
      sender: {
        id: user.id,
        username: user.username,
        avatar: user.avatar
      },
      timestamp: new Date().toISOString()
    };
    
    messages.push(message);
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message'
    });
  }
});

// Get all users (for chat)
app.get('/api/chat/users', authenticateToken, (req, res) => {
  const onlineUsers = users.map(user => ({
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    lastActive: new Date().toISOString(),
    isOnline: true
  }));
  
  res.json({
    success: true,
    users: onlineUsers
  });
});

// ========== START SERVER ==========

app.listen(PORT, () => {
  console.log(`🚀 TEMP AUTH SERVER on http://localhost:${PORT}`);
  console.log(`📌 Test endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /test`);
  console.log(`   POST /api/auth/register`);
  console.log(`   POST /api/auth/login`);
  console.log(`   GET  /api/auth/profile (protected)`);
  console.log(`   GET  /api/chat/rooms (protected)`);
  console.log(`\n🔒 Protected endpoints require: Authorization: Bearer <token>`);
});
// src/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  path: '/socket.io/',
});

// In-memory storage for development (no DB required)
const users = new Map();
const messages = [];

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'MoodChat API',
    version: '1.0.0',
    status: 'running',
    endpoints: [
      { path: '/', method: 'GET', description: 'API info' },
      { path: '/health', method: 'GET', description: 'Health check' },
      { path: '/api/status', method: 'GET', description: 'Server status' },
      { path: '/api/users', method: 'GET', description: 'Get online users' },
      { path: '/socket.io/', method: 'WS', description: 'WebSocket endpoint' },
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: io.engine.clientsCount,
  });
});

app.get('/api/status', (req, res) => {
  const activeConnections = Array.from(io.sockets.sockets.keys());

  res.json({
    server: {
      started: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptime: process.uptime(),
      port: process.env.PORT || 3001,
    },
    connections: {
      total: io.engine.clientsCount,
      active: activeConnections.length,
      socketIds: activeConnections,
    },
    users: {
      online: users.size,
      list: Array.from(users.values()),
    },
    messages: {
      total: messages.length,
      recent: messages.slice(-10),
    },
  });
});

app.get('/api/users', (req, res) => {
  res.json({
    online: users.size,
    users: Array.from(users.values()),
  });
});

// Socket.IO middleware for authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization;

  if (token) {
    // In production, verify JWT here
    try {
      // For demo, just accept any token
      const username = socket.handshake.auth.username || `User_${socket.id.slice(0, 6)}`;
      socket.user = {
        id: socket.id,
        username: username,
        connectedAt: new Date().toISOString(),
      };
      users.set(socket.id, socket.user);
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  } else {
    // Allow anonymous connections for demo
    socket.user = {
      id: socket.id,
      username: `Guest_${socket.id.slice(0, 6)}`,
      connectedAt: new Date().toISOString(),
    };
    users.set(socket.id, socket.user);
    next();
  }
});

// Socket.IO event handlers
io.on('connection', socket => {
  console.log(`✅ New connection: ${socket.id} (${socket.user.username})`);

  // Notify everyone about new user
  socket.broadcast.emit('user_connected', {
    user: socket.user,
    timestamp: new Date().toISOString(),
    onlineCount: users.size,
  });

  // Send welcome message
  socket.emit('welcome', {
    message: `Welcome to MoodChat, ${socket.user.username}!`,
    user: socket.user,
    onlineUsers: Array.from(users.values()),
    serverInfo: {
      name: 'MoodChat',
      version: '1.0.0',
      uptime: process.uptime(),
    },
  });

  // Send recent messages
  if (messages.length > 0) {
    socket.emit('recent_messages', {
      messages: messages.slice(-50),
    });
  }

  // Handle chat messages
  socket.on('send_message', data => {
    const message = {
      id: Date.now().toString(),
      user: socket.user,
      text: data.text,
      mood: data.mood || 'neutral',
      timestamp: new Date().toISOString(),
      room: data.room || 'general',
    };

    console.log(`💬 Message from ${socket.user.username}: ${data.text}`);

    // Store message
    messages.push(message);
    if (messages.length > 1000) messages.shift(); // Keep only 1000 messages

    // Broadcast to everyone
    io.emit('receive_message', message);
  });

  // Handle mood updates
  socket.on('update_mood', data => {
    console.log(`🎭 Mood update from ${socket.user.username}: ${data.mood}`);

    // Update user's mood
    socket.user.mood = data.mood;
    socket.user.moodUpdatedAt = new Date().toISOString();
    users.set(socket.id, socket.user);

    // Notify everyone
    io.emit('mood_updated', {
      user: socket.user,
      mood: data.mood,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle typing indicator
  socket.on('typing', data => {
    socket.broadcast.emit('user_typing', {
      user: socket.user,
      isTyping: data.isTyping || false,
    });
  });

  // Handle join/leave room
  socket.on('join_room', data => {
    if (socket.room) {
      socket.leave(socket.room);
    }
    socket.join(data.room);
    socket.room = data.room;

    socket.emit('room_joined', {
      room: data.room,
      timestamp: new Date().toISOString(),
    });

    socket.to(data.room).emit('user_joined_room', {
      user: socket.user,
      room: data.room,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle private messages
  socket.on('private_message', data => {
    const targetSocket = io.sockets.sockets.get(data.toUserId);
    if (targetSocket) {
      const privateMessage = {
        id: Date.now().toString(),
        from: socket.user,
        to: targetSocket.user,
        text: data.text,
        timestamp: new Date().toISOString(),
      };

      targetSocket.emit('private_message', privateMessage);
      socket.emit('private_message_sent', privateMessage);
    }
  });

  // Handle disconnect
  socket.on('disconnect', reason => {
    console.log(`❌ Disconnected: ${socket.id} (${socket.user.username}) - Reason: ${reason}`);

    // Remove from users
    users.delete(socket.id);

    // Notify everyone
    socket.broadcast.emit('user_disconnected', {
      user: socket.user,
      timestamp: new Date().toISOString(),
      onlineCount: users.size,
      reason: reason,
    });
  });

  // Handle error
  socket.on('error', error => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Handle server errors
server.on('error', error => {
  console.error('Server error:', error);
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   🚀 MoodChat Server started successfully!               │
  │                                                          │
  │   📍 HTTP Server:    http://localhost:${PORT}              │
  │   🔌 WebSocket:      ws://localhost:${PORT}/socket.io/     │
  │                                                          │
  │   📊 Health Check:   http://localhost:${PORT}/health       │
  │   📋 API Status:     http://localhost:${PORT}/api/status   │
  │   👤 Online Users:   http://localhost:${PORT}/api/users    │
  │                                                          │
  │   Press Ctrl+C to stop the server                        │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
  `);
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Disconnect all sockets
  io.sockets.sockets.forEach(socket => {
    socket.emit('server_shutdown', {
      message: 'Server is shutting down. Please reconnect later.',
      timestamp: new Date().toISOString(),
    });
    socket.disconnect(true);
  });

  // Close server
  server.close(() => {
    console.log('✅ HTTP server closed');
    console.log('👋 Server shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

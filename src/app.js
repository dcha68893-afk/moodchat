const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const config = require('./config');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const mongoose = require('mongoose');

const app = express();

// Database connection
const connectDB = async () => {
  try {
    if (config.database && config.database.url) {
      await mongoose.connect(config.database.url, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      logger.info('MongoDB connected successfully');
    } else {
      logger.warn('Database URL not configured. Running without database connection.');
    }
  } catch (error) {
    logger.error('MongoDB connection error:', error.message);
    // Don't crash the app on DB connection failure
    // Allow the app to run in read-only mode or with fallback
  }
};

// Initialize database connection
connectDB();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
}));
app.use(compression());

// CORS configuration - more flexible for frontend access
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = config.corsOrigin 
      ? (Array.isArray(config.corsOrigin) ? config.corsOrigin : [config.corsOrigin])
      : ['http://localhost:3000', 'http://localhost:5173']; // Default dev origins
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Rate limiting with different limits for different endpoints
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { 
    success: false, 
    message: 'Too many requests from this IP, please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Only 20 attempts per 15 minutes for auth
  message: { 
    success: false, 
    message: 'Too many authentication attempts, please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use('/api', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Logging middleware
const morganFormat = config.nodeEnv === 'production' ? 'combined' : 'dev';
app.use(
  morgan(morganFormat, {
    stream: {
      write: (message) => logger.http(message.trim()),
    },
    skip: (req) => req.url === '/health', // Skip logging for health checks
  })
);

// Body parsing middleware with error handling
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString());
    } catch (e) {
      res.status(400).json({
        success: false,
        message: 'Invalid JSON payload',
        error: 'Malformed JSON'
      });
      throw new Error('Invalid JSON');
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb',
  parameterLimit: 100 // Limit number of parameters
}));

// Static files with caching headers
app.use('/uploads', express.static('uploads', {
  maxAge: config.nodeEnv === 'production' ? '7d' : '0',
  setHeaders: (res, path) => {
    if (path.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json');
    }
  }
}));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Health check endpoint with DB status
app.get('/health', async (req, res) => {
  try {
    const healthCheck = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'MoodChat API',
      nodeEnv: config.nodeEnv,
      uptime: process.uptime(),
    };

    // Check database connection if configured
    if (config.database && config.database.url) {
      healthCheck.database = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    }

    const statusCode = healthCheck.database === 'disconnected' ? 503 : 200;
    res.status(statusCode).json(healthCheck);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      service: 'MoodChat API',
      error: error.message
    });
  }
});

// API routes with global error wrapper
const wrappedRoutes = (router) => {
  // Wrap each route handler with try/catch
  const wrapAsync = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  // Apply to all route handlers
  router.stack.forEach((layer) => {
    if (layer.route) {
      layer.route.stack.forEach((routeHandler) => {
        routeHandler.handle = wrapAsync(routeHandler.handle.bind(routeHandler));
      });
    }
  });

  return router;
};

app.use('/api', wrappedRoutes(routes));

// 404 handler - more detailed
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      '/api/auth/login',
      '/api/auth/register',
      '/api/status',
      '/api/friends',
      '/health'
    ]
  });
});

// Global error handler - ensure JSON response
app.use((err, req, res, next) => {
  // If headers already sent, delegate to default error handler
  if (res.headersSent) {
    return next(err);
  }

  // Use custom error handler if available
  if (errorHandler) {
    return errorHandler(err, req, res, next);
  }

  // Default error handler
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';
  
  // Log the error
  logger.error(`Error ${statusCode}: ${message}`, {
    path: req.path,
    method: req.method,
    ip: req.ip,
    stack: config.nodeEnv === 'development' ? err.stack : undefined
  });

  // Return JSON response
  res.status(statusCode).json({
    success: false,
    message: config.nodeEnv === 'production' && statusCode === 500 
      ? 'Something went wrong. Please try again later.' 
      : message,
    ...(config.nodeEnv === 'development' && { stack: err.stack }),
    timestamp: new Date().toISOString()
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit in production, let the process manager handle it
  if (config.nodeEnv !== 'production') {
    process.exit(1);
  }
});

module.exports = app;
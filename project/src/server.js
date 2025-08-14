const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const winston = require('winston');

// Load environment variables
dotenv.config();

// Import route handlers
const agentRoutes = require('./routes/agents');
const notificationRoutes = require('./routes/notifications');
const healthRoutes = require('./routes/health');

// Import middleware
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5678'],
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Authentication middleware for protected routes
app.use('/agent', authMiddleware);

// Routes
app.use('/health', healthRoutes);
app.use('/agent', agentRoutes);
app.use('/notifications', notificationRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`MCP DevOps Server running on port ${PORT}`);
  logger.info('Available endpoints:');
  logger.info('  POST /agent/code-review');
  logger.info('  POST /agent/test-writer');
  logger.info('  POST /agent/build-predictor');
  logger.info('  POST /agent/docker-handler');
  logger.info('  POST /agent/deploy');
  logger.info('  POST /agent/monitor');
  logger.info('  GET  /health');
});

module.exports = app;
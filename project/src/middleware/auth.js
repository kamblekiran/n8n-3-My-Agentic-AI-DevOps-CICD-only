const jwt = require('jsonwebtoken');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header required'
      });
    }

    const token = authHeader.split(' ')[1]; // Bearer <token>
    
    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token required'
      });
    }

    // For development, accept a simple bearer token
    if (process.env.NODE_ENV === 'development' && token === process.env.MCP_SERVER_TOKEN) {
      req.user = { id: 'system', role: 'admin' };
      return next();
    }

    // For production, verify JWT token
    const secret = process.env.JWT_SECRET || 'your-secret-key';
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    
    next();
  } catch (error) {
    logger.error('Authentication failed:', error);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid token'
    });
  }
};

module.exports = authMiddleware;
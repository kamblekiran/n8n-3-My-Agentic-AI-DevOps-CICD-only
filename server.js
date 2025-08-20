const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');

// Setup logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

// Import routes
const agentRoutes = require('./routes/agents');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Use agent routes
app.use('/agent', agentRoutes);

// Start server
app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);
  
  // Log all registered routes - simplify this to avoid regex issues
  logger.info('Available endpoints:');
  
  // Simple approach to just get the routes from the agent router
  agentRoutes.stack.forEach(layer => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter(method => layer.route.methods[method])
        .map(method => method.toUpperCase())
        .join(',');
      logger.info(`  ${methods.padEnd(5)} /agent${layer.route.path}`);
    }
  });
  
  // Add the health endpoint
  logger.info('  GET  /health');
});

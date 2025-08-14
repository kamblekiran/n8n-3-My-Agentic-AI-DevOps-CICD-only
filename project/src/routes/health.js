const express = require('express');
const router = express.Router();

// Health check endpoint
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Readiness check
router.get('/ready', (req, res) => {
  // Add any readiness checks here (database connections, external services, etc.)
  const checks = {
    llm_service: process.env.OPENAI_API_KEY ? 'ready' : 'not_configured',
    github_integration: process.env.GITHUB_TOKEN ? 'ready' : 'not_configured',
    docker_service: 'ready', // Add actual Docker connectivity check
    kubernetes_service: 'ready' // Add actual K8s connectivity check
  };

  const allReady = Object.values(checks).every(status => status === 'ready');

  res.status(allReady ? 200 : 503).json({
    status: allReady ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
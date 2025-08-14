const express = require('express');
const router = express.Router();
const winston = require('winston');

// Import agent controllers
const codeReviewAgent = require('../agents/codeReviewAgent');
const testWriterAgent = require('../agents/testWriterAgent');
const buildPredictorAgent = require('../agents/buildPredictorAgent');
const dockerHandlerAgent = require('../agents/dockerHandlerAgent');
const deployAgent = require('../agents/deployAgent');
const monitorAgent = require('../agents/monitorAgent');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

// Code Review Agent
router.post('/code-review', async (req, res) => {
  try {
    logger.info('Code review request received', { repository: req.body.repository });
    const result = await codeReviewAgent.analyze(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Code review failed:', error);
    res.status(500).json({
      error: 'Code review failed',
      message: error.message
    });
  }
});

// Test Writer Agent
router.post('/test-writer', async (req, res) => {
  try {
    logger.info('Test writer request received', { repository: req.body.repository });
    const result = await testWriterAgent.generateTests(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Test generation failed:', error);
    res.status(500).json({
      error: 'Test generation failed',
      message: error.message
    });
  }
});

// Build Predictor Agent
router.post('/build-predictor', async (req, res) => {
  try {
    logger.info('Build prediction request received', { repository: req.body.repository });
    const result = await buildPredictorAgent.predict(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Build prediction failed:', error);
    res.status(500).json({
      error: 'Build prediction failed',
      message: error.message
    });
  }
});

// Docker/K8s Handler Agent
router.post('/docker-handler', async (req, res) => {
  try {
    logger.info('Docker handler request received', { repository: req.body.repository });
    const result = await dockerHandlerAgent.handle(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Docker handling failed:', error);
    res.status(500).json({
      error: 'Docker handling failed',
      message: error.message
    });
  }
});

// Deploy Agent
router.post('/deploy', async (req, res) => {
  try {
    logger.info('Deploy request received', { repository: req.body.repository });
    const result = await deployAgent.deploy(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Deployment failed:', error);
    res.status(500).json({
      error: 'Deployment failed',
      message: error.message
    });
  }
});

// Monitor Agent
router.post('/monitor', async (req, res) => {
  try {
    logger.info('Monitor request received', { deployment_id: req.body.deployment_id });
    const result = await monitorAgent.monitor(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Monitoring failed:', error);
    res.status(500).json({
      error: 'Monitoring failed',
      message: error.message
    });
  }
});

module.exports = router;
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
    const { repository, pr_number, diff_url, base_sha, head_sha, llm_model } = req.body;

    logger.info('Code review request received', { repository });
    const result = await codeReviewAgent.analyze(req.body);
    
    // Add required fields for the next agent in the pipeline
    result.repository = repository;
    result.commit_sha = head_sha; // Crucial for build predictor
    result.branch = req.body.branch || 'main';
    
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
    const repository = req.body.repository;
    const commit_sha = req.body.commit_sha;
    const branch = req.body.branch || 'main';
    const changed_files = req.body.changed_files || [];
    const code_review_result = req.body.code_review_result || {};
    const llm_model = req.body.llm_model || 'gpt-4';

    // Validate required parameters
    if (!repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
      });
    }
    
    if (!commit_sha) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Commit SHA parameter is required'
      });
    }

    const result = await buildPredictorAgent.predict(
      repository,
      commit_sha,
      branch,
      changed_files,
      code_review_result,
      llm_model
    );

    res.json(result);
  } catch (err) {
    logger.error('Build prediction failed:', err);
    res.status(500).json({
      error: 'Build prediction failed',
      message: err.message,
      details: err.toString()
    });
  }
});

// Docker/K8s Handler Agent
router.post('/docker-handler', async (req, res) => {
  try {
    const { repository, commit_sha, build_prediction, action } = req.body;
    
    // For debugging
    logger.debug('Docker handler request params:', { 
      repository, 
      commit_sha: commit_sha || 'MISSING', 
      build_prediction: build_prediction ? 'PROVIDED' : 'MISSING',
      action
    });
    
    // Try to extract commit_sha from build_prediction if not provided directly
    let finalCommitSha = commit_sha;
    if (!finalCommitSha && build_prediction && build_prediction.commit_sha) {
      finalCommitSha = build_prediction.commit_sha;
      logger.info('Using commit_sha from build_prediction:', finalCommitSha);
    }
    
    // Validate required parameters
    if (!repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
      });
    }
    
    if (!finalCommitSha) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Commit SHA parameter is required'
      });
    }
    
    const result = await dockerHandlerAgent.handle({
      repository,
      commit_sha: finalCommitSha,
      build_prediction,
      action
    });
    
    res.json(result);
  } catch (err) {
    logger.error('Docker handling failed:', err);
    res.status(500).json({
      error: 'Docker handling failed',
      message: err.message
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

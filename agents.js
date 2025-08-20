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
const aksProvisioner = require('../utils/aksProvisioner');

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
    const params = req.body;
    
    // For debugging
    logger.debug('Deploy agent request params:', { 
      repository: params.repository, 
      image: params.image,
      environment: params.environment || 'staging',
      create_cluster: params.create_cluster || false
    });
    
    // Validate required parameters
    if (!params.repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
      });
    }
    
    const result = await deployAgent.deploy(params);
    
    res.json(result);
  } catch (err) {
    logger.error('Deployment failed:', err);
    res.status(500).json({
      error: 'Deployment failed',
      message: err.message
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

// AKS Provisioner
router.post('/provision-aks', async (req, res) => {
  try {
    const params = req.body;
    
    // Extract parameters and ensure correct types
    const repository = params.repository;
    const environment = params.environment || 'staging';
    const node_count = parseInt(params.node_count || 1, 10); // Convert to integer
    const vm_size = params.vm_size || 'Standard_D2s_v3';
    const wait_for_ready = params.wait_for_ready === 'true' || params.wait_for_ready === true;
    
    // Validate required parameters
    if (!repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
      });
    }
    
    // Validate node_count is a valid number
    if (isNaN(node_count)) {
      return res.status(400).json({
        error: 'Invalid parameter',
        message: 'node_count must be a valid number'
      });
    }
    
    // Parse repository
    const [owner, repo] = repository.split('/');
    
    if (!owner || !repo) {
      return res.status(400).json({
        error: 'Invalid repository format',
        message: 'Repository must be in format owner/repo'
      });
    }
    
    // Create a valid cluster name based on environment and repo
    const clusterName = `${environment}-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    
    logger.info(`Provisioning AKS cluster: ${clusterName} with ${node_count} nodes of size ${vm_size}`);
    
    // Start cluster creation
    const clusterResult = await aksProvisioner.createAksCluster(clusterName, node_count, vm_size);
    
    // Wait for cluster to be ready if requested
    if (wait_for_ready && !clusterResult.mock) {
      try {
        logger.info(`Waiting for AKS cluster ${clusterName} to be ready...`);
        // Wait for cluster readiness (timeout after 5 minutes for POC)
        await aksProvisioner.waitForClusterReady(clusterName, 5);
        
        // Get cluster credentials
        const credentialsResult = await aksProvisioner.getAksCredentials(clusterName);
        
        return res.json({
          status: 'success',
          cluster_name: clusterName,
          repository: repository,
          environment: environment,
          provisioning_state: 'Succeeded',
          kubeconfig_available: !!credentialsResult.kubeconfig,
          deployment_ready: true,
          mock: credentialsResult.mock
        });
      } catch (waitError) {
        logger.error(`Cluster readiness timeout: ${waitError.message}`);
        return res.status(202).json({
          status: 'pending',
          cluster_name: clusterName,
          repository: repository,
          environment: environment,
          message: `Cluster creation initiated but not yet ready: ${waitError.message}`,
          error: waitError.message,
          deployment_ready: false
        });
      }
    }
    
    // Return immediate response if not waiting for readiness
    return res.status(202).json({
      status: clusterResult.mock ? 'success' : 'pending',
      cluster_name: clusterName,
      repository: repository,
      environment: environment,
      provisioning_state: clusterResult.provisioning_state,
      estimated_time_minutes: clusterResult.estimated_time_minutes,
      mock: clusterResult.mock,
      deployment_ready: clusterResult.mock // Only mark as ready if using mock mode
    });
  } catch (err) {
    logger.error('AKS provisioning failed:', err);
    return res.status(500).json({
      error: 'AKS provisioning failed',
      message: err.message
    });
  }
});

module.exports = router;

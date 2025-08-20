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

// Configure logger - simplified for POC
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console()
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

// AKS Provisioning endpoint
app.post('/agent/provision-aks', async (req, res) => {
  try {
    const params = req.body;
    
    // Extract parameters
    const { repository, environment = 'staging', node_count = 1, vm_size = 'Standard_D2s_v3', wait_for_ready = true } = params;
    
    // Validate required parameters
    if (!repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
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
    
    logger.info(`Provisioning AKS cluster: ${clusterName}`);
    
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

// Update your existing /agent/deploy endpoint
app.post('/agent/deploy', async (req, res) => {
  try {
    const params = req.body;
    
    // Extract cluster information
    const { repository, image, environment = 'staging', k8s_manifests, cluster_name } = params;
    
    // For debugging
    logger.debug('Deploy agent request params:', { 
      repository: params.repository, 
      image: params.image,
      environment: environment,
      cluster_name: cluster_name,
      has_k8s_manifests: !!params.k8s_manifests,
      manifest_keys: params.k8s_manifests ? Object.keys(params.k8s_manifests) : []
    });
    
    // Validate required parameters
    if (!repository) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Repository parameter is required'
      });
    }
    
    // Use the passed cluster name or generate one
    const [owner, repo] = repository.split('/');
    const actualClusterName = cluster_name || `${environment}-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    
    // Skip cluster creation since it was done in previous step
    params.create_cluster = false;
    params.existing_cluster = actualClusterName;
    
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

// Error handling middleware
app.use(errorHandler);

// Start the server
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  
  // Log all registered routes
  logger.info('Available endpoints:');
  app._router.stack
    .filter(r => r.route)
    .forEach(route => {
      Object.keys(route.route.methods)
        .filter(method => route.route.methods[method])
        .forEach(method => {
          logger.info(`  ${method.toUpperCase().padEnd(5)} ${route.route.path}`);
        });
    });
});

module.exports = app;
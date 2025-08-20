const winston = require('winston');
const k8s = require('@kubernetes/client-node');
const fs = require('fs').promises;
const path = require('path');
const aksProvisioner = require('../utils/aksProvisioner');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class DeployAgent {
  constructor() {
    this.k8sAvailable = false;
    this.k8sClient = null;
  }
  
  async deploy(params) {
    const { repository, image, environment = 'staging', k8s_manifests, create_cluster = false, existing_cluster } = params;
    
    try {
      // Check for required parameters
      if (!repository) {
        throw new Error('Repository parameter is required');
      }
      
      // Parse repository
      const [owner, repo] = repository.split('/');
      
      if (!owner || !repo) {
        throw new Error('Repository must be in format owner/repo');
      }
      
      logger.info(`Deploying ${repository} to ${environment}`);
      
      // Use the provided cluster name or create one
      let clusterName;
      
      if (existing_cluster) {
        clusterName = existing_cluster;
        logger.info(`Using existing cluster: ${clusterName}`);
        
        // Configure Kubernetes client with the existing cluster
        try {
          // Get credentials for the existing cluster
          const credentialsResult = await aksProvisioner.getAksCredentials(clusterName);
          
          if (!credentialsResult.mock) {
            // Initialize Kubernetes client with the existing cluster
            this.kc = new k8s.KubeConfig();
            this.kc.loadFromString(credentialsResult.kubeconfig);
            this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
            this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
            this.k8sAvailable = true;
            
            logger.info(`Kubernetes client configured with existing cluster: ${clusterName}`);
          }
        } catch (error) {
          logger.error(`Failed to get credentials for existing cluster ${clusterName}:`, error);
          return this.mockDeploy(params, clusterName);
        }
      } else if (create_cluster) {
        // Create a valid cluster name based on environment and repo
        clusterName = `${environment}-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        
        logger.info(`Provisioning new AKS cluster: ${clusterName}`);
        const clusterResult = await aksProvisioner.createAksCluster(clusterName, 1);
        
        // IMPORTANT: Wait for the cluster to be ready before proceeding
        try {
          logger.info(`Waiting for AKS cluster ${clusterName} to be ready...`);
          // For POC, use a shorter timeout (3 minutes) instead of the default 10 minutes
          await aksProvisioner.waitForClusterReady(clusterName, 3);
        } catch (waitError) {
          logger.error(`Cluster readiness timeout: ${waitError.message}`);
          // Fall back to mock deployment if waiting times out
          return this.mockDeploy(params, clusterName);
        }
        
        // Get the kubeconfig for the cluster
        const credentialsResult = await aksProvisioner.getAksCredentials(clusterName);
        
        if (!credentialsResult.mock) {
          // Initialize Kubernetes client with the new config
          this.kc = new k8s.KubeConfig();
          this.kc.loadFromString(credentialsResult.kubeconfig);
          this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
          this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
          this.k8sAvailable = true;
          
          logger.info(`Kubernetes client configured with new AKS cluster: ${clusterName}`);
        }
      } else {
        // Generate a cluster name but don't create it
        clusterName = `${environment}-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        logger.info(`Using cluster name without creating: ${clusterName}`);
      }
      
      // Deploy to the cluster
      if (this.k8sAvailable) {
        return await this.deployToK8s(params, clusterName);
      } else {
        return this.mockDeploy(params, clusterName);
      }
    } catch (error) {
      logger.error('Deployment failed:', error);
      throw error;
    }
  }
  
  async deployToK8s(params, clusterName) {
    const { repository, image, environment = 'staging', k8s_manifests } = params;
    const namespace = environment;
    
    try {
      // Create namespace
      try {
        await this.k8sClient.createNamespace({
          metadata: {
            name: namespace
          }
        });
        logger.info(`Created namespace ${namespace}`);
      } catch (error) {
        // Namespace might already exist
        if (error.response?.statusCode !== 409) {
          logger.error(`Failed to create namespace ${namespace}:`, error);
        } else {
          logger.info(`Namespace ${namespace} already exists`);
        }
      }
      
      // Deploy manifests
      const results = [];
      
      if (k8s_manifests?.deployment) {
        try {
          await this.k8sAppsClient.createNamespacedDeployment(
            namespace,
            k8s_manifests.deployment
          );
          results.push({ type: 'deployment', status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            await this.k8sAppsClient.replaceNamespacedDeployment(
              k8s_manifests.deployment.metadata.name,
              namespace,
              k8s_manifests.deployment
            );
            results.push({ type: 'deployment', status: 'updated' });
          } else {
            throw error;
          }
        }
      }
      
      if (k8s_manifests?.service) {
        try {
          await this.k8sClient.createNamespacedService(
            namespace,
            k8s_manifests.service
          );
          results.push({ type: 'service', status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            results.push({ type: 'service', status: 'exists' });
          } else {
            throw error;
          }
        }
      }
      
      // Return deployment details
      return {
        status: 'success',
        repository: repository,
        environment: environment,
        cluster_name: clusterName,
        deployment_url: `https://${environment}-${clusterName}.example.com`,
        deployment_time: new Date().toISOString(),
        results: results,
        mock: false
      };
    } catch (error) {
      logger.error('Kubernetes deployment failed:', error);
      throw error;
    }
  }
  
  mockDeploy(params, clusterName) {
    const { repository, image, environment = 'staging' } = params;
    
    logger.info(`[MOCK] Deploying ${repository} to ${environment} in cluster ${clusterName}`);
    
    // Generate mock deployment details
    return {
      status: 'success',
      repository: repository,
      environment: environment,
      cluster_name: clusterName,
      deployment_url: `https://${environment}-${repository.replace('/', '-')}.example.com`,
      deployment_time: new Date().toISOString(),
      mock: true,
      message: 'This is a mock deployment for POC purposes',
      pipeline_id: params.pipeline_id || ('pipeline-' + Date.now())
    };
  }
}

module.exports = new DeployAgent();

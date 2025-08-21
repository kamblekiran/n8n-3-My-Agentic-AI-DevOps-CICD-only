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

// Make sure all required methods exist
class DeployAgent {
  constructor() {
    this.k8sAvailable = false;
    
    // Try to load from a specific kubeconfig file
    try {
      this.kc = new k8s.KubeConfig();
      
      // Use a pre-created kubeconfig file
      const kubeconfigPath = process.env.KUBECONFIG || path.join(__dirname, '..', '..', 'config', 'kubeconfig');
      this.kc.loadFromFile(kubeconfigPath);
      
      this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
      logger.info('Kubernetes client initialized successfully from file');
    } catch (error) {
      logger.warn('Failed to load Kubernetes config:', error.message);
    }
  }

  // In your deploy method, make these changes
  async deploy(params) {
    // Check if params is null or undefined
    if (!params) {
      logger.error('Deploy called with null or undefined parameters');
      throw new Error('Deploy parameters are required');
    }
    
    // Log the entire params object for debugging
    logger.info(`Deploy called with params: ${JSON.stringify(params, null, 2)}`);
    
    // HARDCODE THE NAMESPACE VALUE for reliability
    const HARDCODED_NAMESPACE = 'default';
    
    // Extract other parameters, but use our hardcoded namespace
    const { 
      repository, 
      image, 
      environment = 'staging', 
      cluster_name
    } = params;
    
    logger.info(`Starting deployment with HARDCODED namespace: "${HARDCODED_NAMESPACE}"`);
    
    try {
      // Use the specified AKS cluster or default one
      const clusterName = cluster_name || process.env.DEFAULT_AKS_CLUSTER;
      
      if (!clusterName) {
        logger.error('No AKS cluster specified and no default cluster configured');
        throw new Error('AKS cluster name is required');
      }
      
      logger.info(`Using AKS cluster: ${clusterName}`);
      
      // Get AKS credentials
      const aksCredentials = await aksProvisioner.getAksCredentials(clusterName);
      
      if (aksCredentials.mock) {
        logger.warn('Using mock AKS credentials - this will not deploy to a real cluster');
        return this.mockDeploy(params);
      }
      
      // Initialize Kubernetes client with AKS credentials
      this.kc = new k8s.KubeConfig();
      
      // Load from the kubeconfig data
      const kubeconfigPath = await this.writeKubeconfig(aksCredentials.kubeconfig);
      this.kc.loadFromFile(kubeconfigPath);
      
      // Create API clients
      this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
      
      // Generate Kubernetes manifests
      const k8sManifests = this.generateK8sManifests(repository, image, environment);
      
      logger.info(`K8S Manifests generated: ${JSON.stringify(k8sManifests ? 'yes' : 'no')}`);
      
      // Verify the manifests
      if (!k8sManifests || !k8sManifests.deployment) {
        throw new Error('Failed to generate valid Kubernetes manifests');
      }
      
      const results = [];
      
      // Deploy Deployment with HARDCODED namespace
      if (k8sManifests.deployment) {
        try {
          // Explicitly set the namespace in the manifest
          k8sManifests.deployment.metadata.namespace = 'default';
          
          // Log what we're about to do
          logger.info(`Creating deployment "${k8sManifests.deployment.metadata.name}" in namespace "default"`);
          
          // Make the API call with hardcoded string 'default' as first parameter
          await this.k8sAppsClient.createNamespacedDeployment(
            'default', // Hardcoded string instead of variable
            k8sManifests.deployment
          );
          results.push({ type: 'deployment', status: 'created' });
        } catch (error) {
          // Log detailed error for debugging
          logger.error(`Deployment error: ${error.message}`);
          if (error.response) {
            logger.error(`Status code: ${error.response.statusCode}`);
            logger.error(`Response body: ${JSON.stringify(error.response.body)}`);
          }
          
          if (error.response?.statusCode === 409) {
            logger.info(`Updating existing deployment in namespace: ${HARDCODED_NAMESPACE}`);
            
            // Same hardcoded approach for updates
            await this.k8sAppsClient.replaceNamespacedDeployment(
              k8sManifests.deployment.metadata.name,
              'default', // Hardcoded string
              k8sManifests.deployment
            );
            results.push({ type: 'deployment', status: 'updated' });
          } else {
            throw error;
          }
        }
      }
      
      // Deploy Service with HARDCODED namespace
      if (k8sManifests.service) {
        try {
          // Explicitly set the namespace in the manifest
          k8sManifests.service.metadata.namespace = 'default';
          
          logger.info(`Creating service "${k8sManifests.service.metadata.name}" in namespace "default"`);
          
          // Make the API call with hardcoded string 'default' as first parameter
          await this.k8sClient.createNamespacedService(
            'default', // Hardcoded string instead of variable
            k8sManifests.service
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
      
      return {
        status: 'success',
        deployment_id: `${repository}-${Date.now()}`,
        deployed_resources: results,
        namespace: HARDCODED_NAMESPACE,
        environment: environment,
        cluster: clusterName,
        mock: false
      };
    } catch (error) {
      logger.error(`AKS deployment failed: ${error.message}`);
      throw error;
    }
  }
  
  mockDeploy(params) {
    if (!params) {
      logger.error('MockDeploy called with null parameters');
      throw new Error('MockDeploy parameters are required');
    }
    
    // Extract with defaults to avoid undefined
    const repository = params.repository || 'unknown-repo';
    const image = params.image || 'unknown-image:latest';
    const environment = params.environment || 'staging';
    const clusterName = params.cluster_name || 'mock-cluster';
    const namespace = params.namespace || 'default';
    
    logger.info(`[MOCK] Deploying ${repository} to ${environment} in cluster ${clusterName}, namespace ${namespace}`);
    
    // Generate mock deployment details
    return {
      status: 'success',
      repository: repository,
      environment: environment,
      namespace: namespace,
      cluster_name: clusterName,
      deployment_url: `https://${environment}-${repository.replace('/', '-')}.example.com`,
      deployment_time: new Date().toISOString(),
      mock: true,
      message: 'This is a mock deployment for POC purposes',
      pipeline_id: params.pipeline_id || ('pipeline-' + Date.now())
    };
  }
  
  generateK8sManifests(repository, image, environment) {
    // Extract repo name from repository string
    const repoName = repository.includes('/') ? repository.split('/')[1] : repository;
    
    // Create a valid app name for Kubernetes (must be DNS compliant)
    const appName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
    // HARDCODE THE NAMESPACE in all manifests
    const HARDCODED_NAMESPACE = 'default';
    
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: appName,
        namespace: HARDCODED_NAMESPACE, // <-- ADD THIS LINE
        labels: {
          app: appName,
          environment: environment
        },
        annotations: {
          'app.kubernetes.io/version': image.split(':')[1] || 'latest',
          'deployment-timestamp': new Date().toISOString(),
          'deployment-source': 'cicd-pipeline'
        }
      },
      spec: {
        replicas: 2,
        selector: {
          matchLabels: {
            app: appName
          }
        },
        template: {
          metadata: {
            labels: {
              app: appName
            }
          },
          spec: {
            containers: [{
              name: appName,
              image: image, // Use the full image name with tag
              ports: [{
                containerPort: 8080
              }],
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '128Mi'
                },
                limits: {
                  cpu: '500m',
                  memory: '512Mi'
                }
              },
              livenessProbe: {
                httpGet: {
                  path: '/health',
                  port: 8080
                },
                initialDelaySeconds: 30,
                periodSeconds: 10
              }
            }]
          }
        }
      }
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `${appName}-service`,
        namespace: HARDCODED_NAMESPACE, // <-- ADD THIS LINE
        labels: {
          app: appName
        }
      },
      spec: {
        selector: {
          app: appName
        },
        ports: [{
          port: 80,
          targetPort: 8080,
          protocol: 'TCP'
        }],
        type: 'ClusterIP'
      }
    };
    
    return {
      deployment,
      service
    };
  }
  
  // Helper to write kubeconfig to file
  async writeKubeconfig(kubeconfig) {
    const fs = require('fs').promises;
    const path = require('path');
    const os = require('os');
    
    const kubeconfigPath = path.join(os.tmpdir(), `kubeconfig-${Date.now()}`);
    await fs.writeFile(kubeconfigPath, kubeconfig);
    
    return kubeconfigPath;
  }
  
  // Add this method if you need a consistent way to get namespaces
  getNamespace(providedNamespace) {
    // Always return 'default' regardless of input
    return 'default';
  }
}

// This would work with the instance export
// const DeployAgent = require('../agents/deployAgent');
// const instance = new DeployAgent();

const deployAgentInstance = new DeployAgent();
module.exports = deployAgentInstance;

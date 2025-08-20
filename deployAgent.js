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

  // In your deploy method, ensure you're using the AKS cluster
  async deploy(params) {
    const { repository, image, environment = 'staging', cluster_name } = params;
    
    logger.info(`Deploying ${repository} with image ${image} to ${environment}`);
    
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
      
      // Deploy to Kubernetes
      const namespace = 'default'; // Or use a parameter
      const results = [];
      
      // Deploy Deployment
      if (k8sManifests.deployment) {
        try {
          await this.k8sAppsClient.createNamespacedDeployment(
            namespace,
            k8sManifests.deployment
          );
          results.push({ type: 'deployment', status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            // Deployment already exists, update it with the new image
            logger.info(`Deployment ${k8sManifests.deployment.metadata.name} already exists, updating it`);
            
            await this.k8sAppsClient.replaceNamespacedDeployment(
              k8sManifests.deployment.metadata.name,
              namespace,
              k8sManifests.deployment
            );
            results.push({ type: 'deployment', status: 'updated' });
          } else {
            throw error;
          }
        }
      }
      
      // Deploy Service
      if (k8sManifests.service) {
        try {
          await this.k8sClient.createNamespacedService(
            namespace,
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
        namespace: namespace,
        environment: environment,
        cluster: clusterName,
        mock: false
      };
    } catch (error) {
      logger.error(`AKS deployment failed: ${error.message}`);
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
  
  generateK8sManifests(repository, image, environment) {
    // Extract repo name from repository string
    const repoName = repository.includes('/') ? repository.split('/')[1] : repository;
    
    // Create a valid app name for Kubernetes (must be DNS compliant)
    const appName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
    // The image parameter already contains the full image name with tag
    // e.g., "ray786/sample-app-mcp:245cd4a"
    
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: appName,
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
    }; // <-- Added closing brace here

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `${appName}-service`,
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
}

module.exports = new DeployAgent();

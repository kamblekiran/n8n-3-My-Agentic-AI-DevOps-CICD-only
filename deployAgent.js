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
    
    try {
      this.kc = new k8s.KubeConfig();
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

  async deploy(params) {
    if (!params) {
      logger.error('Deploy called with null or undefined parameters');
      throw new Error('Deploy parameters are required');
    }
    
    // Use provided namespace or fallback to "default"
    const namespace = String(params.namespace || 'default');
    logger.info(`Using namespace: "${namespace}"`);
    
    const { repository, image, environment = 'staging', cluster_name } = params;
    logger.info(`Starting deployment with namespace: "${namespace}"`);
    
    try {
      const clusterName = cluster_name || process.env.DEFAULT_AKS_CLUSTER;
      if (!clusterName) {
        logger.error('No AKS cluster specified and no default cluster configured');
        throw new Error('AKS cluster name is required');
      }
      logger.info(`Using AKS cluster: ${clusterName}`);
      
      const aksCredentials = await aksProvisioner.getAksCredentials(clusterName);
      if (aksCredentials.mock) {
        logger.warn('Using mock AKS credentials - this will not deploy to a real cluster');
        return this.mockDeploy(params);
      }
      
      this.kc = new k8s.KubeConfig();
      const kubeconfigPath = await this.writeKubeconfig(aksCredentials.kubeconfig);
      this.kc.loadFromFile(kubeconfigPath);
      this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
      
      const k8sManifests = this.generateK8sManifests(repository, image, environment);
      logger.info(`K8S Manifests generated: ${k8sManifests ? 'yes' : 'no'}`);
      
      if (!k8sManifests || !k8sManifests.deployment) {
        throw new Error('Failed to generate valid Kubernetes manifests');
      }
      
      const results = [];
      
      if (k8sManifests.deployment) {
        try {
          // Force the deployment manifest to use "default" namespace
          k8sManifests.deployment.metadata.namespace = 'default';
          logger.info(`Creating deployment "${k8sManifests.deployment.metadata.name}" in namespace "default"`);
          logger.info(`About to call createNamespacedDeployment with namespace: "default"`);
          await this.k8sAppsClient.createNamespacedDeployment('default', k8sManifests.deployment);
          results.push({ type: 'deployment', status: 'created' });
        } catch (error) {
          logger.error(`Deployment error: ${error.message}`);
          if (error.response) {
            logger.error(`Status code: ${error.response.statusCode}`);
            logger.error(`Response body: ${JSON.stringify(error.response.body)}`);
          }
          if (error.response?.statusCode === 409) {
            logger.info(`Updating existing deployment in namespace "default"`);
            await this.k8sAppsClient.replaceNamespacedDeployment(
              k8sManifests.deployment.metadata.name,
              'default',
              k8sManifests.deployment
            );
            results.push({ type: 'deployment', status: 'updated' });
          } else {
            throw error;
          }
        }
      }
      
      if (k8sManifests.service) {
        try {
          k8sManifests.service.metadata.namespace = 'default';
          logger.info(`Creating service "${k8sManifests.service.metadata.name}" in namespace "default"`);
          await this.k8sClient.createNamespacedService('default', k8sManifests.service);
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
        namespace: 'default',
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
    const repository = params.repository || 'unknown-repo';
    const image = params.image || 'unknown-image:latest';
    const environment = params.environment || 'staging';
    const clusterName = params.cluster_name || 'mock-cluster';
    const namespace = params.namespace || 'default';
    
    logger.info(`[MOCK] Deploying ${repository} to ${environment} in namespace ${namespace}`);
    
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
    const repoName = repository.includes('/') ? repository.split('/')[1] : repository;
    const appName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const HARDCODED_NAMESPACE = 'default';
    
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: appName,
        namespace: HARDCODED_NAMESPACE,
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
        selector: { matchLabels: { app: appName } },
        template: {
          metadata: { labels: { app: appName } },
          spec: {
            containers: [{
              name: appName,
              image: image,
              ports: [{ containerPort: 8080 }],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '512Mi' }
              },
              livenessProbe: {
                httpGet: { path: '/health', port: 8080 },
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
        namespace: HARDCODED_NAMESPACE,
        labels: { app: appName }
      },
      spec: {
        selector: { app: appName },
        ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }],
        type: 'ClusterIP'
      }
    };
    
    return { deployment, service };
  }
  
  async writeKubeconfig(kubeconfig) {
    const os = require('os');
    const kubeconfigPath = path.join(os.tmpdir(), `kubeconfig-${Date.now()}`);
    await fs.writeFile(kubeconfigPath, kubeconfig);
    return kubeconfigPath;
  }
  
  getNamespace() {
    return 'default';
  }
}

const deployAgentInstance = new DeployAgent();
module.exports = deployAgentInstance;

const k8s = require('@kubernetes/client-node');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class DeployAgent {
  constructor() {
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
      this.k8sApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sCoreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sNetworkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    } catch (error) {
      logger.warn('Kubernetes client initialization failed:', error.message);
    }
  }

  async deploy(params) {
    const { 
      repository, 
      image_tag, 
      environment = 'staging', 
      kubernetes_config,
      namespace = environment 
    } = params;
    
    try {
      const deploymentId = uuidv4();
      const [owner, repo] = repository.split('/');
      const appName = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      // Ensure namespace exists
      await this.ensureNamespace(namespace);
      
      // Deploy to Kubernetes
      const deploymentResult = await this.deployToKubernetes(
        kubernetes_config,
        namespace,
        appName,
        deploymentId
      );
      
      // Wait for deployment to be ready
      await this.waitForDeployment(appName, namespace);
      
      // Get service URL
      const serviceUrl = await this.getServiceUrl(appName, namespace, environment);
      
      return {
        deployment_id: deploymentId,
        status: 'success',
        environment: environment,
        namespace: namespace,
        deployment_url: serviceUrl,
        deployed_resources: deploymentResult.resources,
        rollout_status: 'completed'
      };
      
    } catch (error) {
      logger.error('Deployment failed:', error);
      throw error;
    }
  }

  async ensureNamespace(namespace) {
    try {
      await this.k8sCoreApi.readNamespace(namespace);
      logger.info(`Namespace ${namespace} already exists`);
    } catch (error) {
      if (error.response?.statusCode === 404) {
        // Create namespace
        const namespaceManifest = {
          metadata: {
            name: namespace,
            labels: {
              name: namespace,
              'managed-by': 'mcp-devops-server'
            }
          }
        };
        
        await this.k8sCoreApi.createNamespace(namespaceManifest);
        logger.info(`Created namespace ${namespace}`);
      } else {
        throw error;
      }
    }
  }

  async deployToKubernetes(kubernetesConfig, namespace, appName, deploymentId) {
    const deployedResources = [];
    
    try {
      // Deploy Deployment
      if (kubernetesConfig.deployment) {
        const deployment = {
          ...kubernetesConfig.deployment,
          metadata: {
            ...kubernetesConfig.deployment.metadata,
            labels: {
              ...kubernetesConfig.deployment.metadata.labels,
              'deployment-id': deploymentId,
              'managed-by': 'mcp-devops-server'
            }
          }
        };
        
        try {
          await this.k8sApi.createNamespacedDeployment(namespace, deployment);
          deployedResources.push({ type: 'deployment', name: deployment.metadata.name, status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            // Update existing deployment
            await this.k8sApi.replaceNamespacedDeployment(
              deployment.metadata.name,
              namespace,
              deployment
            );
            deployedResources.push({ type: 'deployment', name: deployment.metadata.name, status: 'updated' });
          } else {
            throw error;
          }
        }
      }

      // Deploy Service
      if (kubernetesConfig.service) {
        const service = {
          ...kubernetesConfig.service,
          metadata: {
            ...kubernetesConfig.service.metadata,
            labels: {
              ...kubernetesConfig.service.metadata.labels,
              'deployment-id': deploymentId,
              'managed-by': 'mcp-devops-server'
            }
          }
        };
        
        try {
          await this.k8sCoreApi.createNamespacedService(namespace, service);
          deployedResources.push({ type: 'service', name: service.metadata.name, status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            deployedResources.push({ type: 'service', name: service.metadata.name, status: 'exists' });
          } else {
            throw error;
          }
        }
      }

      // Deploy Ingress
      if (kubernetesConfig.ingress) {
        const ingress = {
          ...kubernetesConfig.ingress,
          metadata: {
            ...kubernetesConfig.ingress.metadata,
            labels: {
              ...kubernetesConfig.ingress.metadata.labels,
              'deployment-id': deploymentId,
              'managed-by': 'mcp-devops-server'
            }
          }
        };
        
        try {
          await this.k8sNetworkingApi.createNamespacedIngress(namespace, ingress);
          deployedResources.push({ type: 'ingress', name: ingress.metadata.name, status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            await this.k8sNetworkingApi.replaceNamespacedIngress(
              ingress.metadata.name,
              namespace,
              ingress
            );
            deployedResources.push({ type: 'ingress', name: ingress.metadata.name, status: 'updated' });
          } else {
            throw error;
          }
        }
      }

      return { resources: deployedResources };
      
    } catch (error) {
      logger.error('Kubernetes deployment failed:', error);
      throw error;
    }
  }

  async waitForDeployment(appName, namespace, timeoutMs = 300000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const { body: deployment } = await this.k8sApi.readNamespacedDeployment(appName, namespace);
        
        const readyReplicas = deployment.status?.readyReplicas || 0;
        const replicas = deployment.spec?.replicas || 0;
        
        if (readyReplicas === replicas && replicas > 0) {
          logger.info(`Deployment ${appName} is ready (${readyReplicas}/${replicas} replicas)`);
          return true;
        }
        
        logger.info(`Waiting for deployment ${appName}: ${readyReplicas}/${replicas} replicas ready`);
        await this.sleep(5000); // Wait 5 seconds
        
      } catch (error) {
        logger.warn(`Error checking deployment status: ${error.message}`);
        await this.sleep(5000);
      }
    }
    
    throw new Error(`Deployment ${appName} did not become ready within ${timeoutMs}ms`);
  }

  async getServiceUrl(appName, namespace, environment) {
    try {
      // Try to get ingress URL first
      try {
        const { body: ingress } = await this.k8sNetworkingApi.readNamespacedIngress(
          `${appName}-ingress`,
          namespace
        );
        
        if (ingress.spec?.rules?.[0]?.host) {
          const protocol = ingress.spec.tls ? 'https' : 'http';
          return `${protocol}://${ingress.spec.rules[0].host}`;
        }
      } catch (error) {
        // Ingress might not exist, continue to service
      }
      
      // Get service URL
      const { body: service } = await this.k8sCoreApi.readNamespacedService(
        `${appName}-service`,
        namespace
      );
      
      if (service.spec?.type === 'LoadBalancer' && service.status?.loadBalancer?.ingress?.[0]) {
        const lb = service.status.loadBalancer.ingress[0];
        const host = lb.hostname || lb.ip;
        const port = service.spec.ports?.[0]?.port || 80;
        return `http://${host}:${port}`;
      }
      
      // Fallback to cluster IP (for internal access)
      const clusterIP = service.spec?.clusterIP;
      const port = service.spec?.ports?.[0]?.port || 80;
      
      if (clusterIP && clusterIP !== 'None') {
        return `http://${clusterIP}:${port}`;
      }
      
      // Final fallback
      return `http://${appName}-service.${namespace}.svc.cluster.local`;
      
    } catch (error) {
      logger.warn('Could not determine service URL:', error.message);
      return `http://${appName}-service.${namespace}.svc.cluster.local`;
    }
  }

  async rollback(deploymentId, namespace) {
    try {
      // Find deployment by deployment-id label
      const { body: deployments } = await this.k8sApi.listNamespacedDeployment(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `deployment-id=${deploymentId}`
      );
      
      if (deployments.items.length === 0) {
        throw new Error(`No deployment found with ID ${deploymentId}`);
      }
      
      const deployment = deployments.items[0];
      
      // Rollback to previous revision
      await this.k8sApi.createNamespacedDeploymentRollback(
        deployment.metadata.name,
        namespace,
        { name: deployment.metadata.name }
      );
      
      logger.info(`Rolled back deployment ${deployment.metadata.name}`);
      
      return {
        status: 'success',
        message: `Deployment ${deployment.metadata.name} rolled back successfully`
      };
      
    } catch (error) {
      logger.error('Rollback failed:', error);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new DeployAgent();
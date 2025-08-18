const Docker = require('dockerode');
const k8s = require('@kubernetes/client-node');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class DockerHandlerAgent {
  constructor() {
    this.docker = new Docker();
    
    // Initialize Kubernetes client
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
      this.k8sApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sCoreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    } catch (error) {
      logger.warn('Kubernetes client initialization failed:', error.message);
    }
  }

  async handle(params) {
    const { repository, commit_sha, build_prediction, action = 'build_and_push' } = params;
    
    try {
      // Check for required parameters
      if (!repository) {
        throw new Error('Repository parameter is required');
      }
      
      if (!commit_sha) {
        throw new Error('Commit SHA parameter is required');
      }
      
      // Handle null or undefined repository by providing a default value for splitting
      const repoString = repository || '';
      const [owner, repo] = repoString.split('/');
      
      if (!owner || !repo) {
        throw new Error('Repository must be in format owner/repo');
      }
      
      logger.info(`Docker handler: ${action} for ${repository} at ${commit_sha}`);
      
      switch (action) {
        case 'build_and_push':
          return await this.buildAndPushImage(owner, repo, commit_sha, build_prediction);
        case 'generate_k8s_manifests':
          const imageName = `${owner}/${repo}:${commit_sha.substring(0, 7)}`;
          return await this.generateKubernetesManifests(owner, repo, build_prediction, imageName);
        case 'deploy_to_k8s':
          return await this.deployToKubernetes(params);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('Docker handling failed:', error);
      throw error;
    }
  }

  async buildAndPushImage(owner, repo, commitSha, buildPrediction) {
    try {
      // Validate commitSha
      if (!commitSha) {
        throw new Error('Commit SHA is required for building Docker image');
      }
      
      // Use a safe substring operation
      const shortSha = commitSha ? commitSha.substring(0, 7) : 'latest';
      
      logger.info(`Building Docker image for ${owner}/${repo} at commit ${shortSha}`);
      
      // Generate a Dockerfile based on the build prediction
      const dockerfilePath = await this.generateDockerfile(buildPrediction);
      
      // Build the image
      const imageName = `${owner}/${repo}:${shortSha}`;
      const stream = await this.docker.buildImage({
        context: process.cwd(),
        src: ['Dockerfile']
      }, {t: imageName});
      
      const buildOutput = await this.followBuildProgress(stream);
      
      // Push the image if a registry is configured
      const registryHost = process.env.DOCKER_REGISTRY || '';
      if (registryHost) {
        const registryImage = `${registryHost}/${imageName}`;
        await this.pushImage(imageName, registryImage);
        logger.info(`Pushed image to ${registryImage}`);
      }
      
      return {
        status: 'success',
        image: imageName,
        registry_image: registryHost ? `${registryHost}/${imageName}` : null,
        build_output: buildOutput
      };
    } catch (error) {
      logger.error('Docker build failed:', error);
      throw error;
    }
  }

  async generateDockerfile(buildPrediction) {
    const dockerfile = this.createDockerfileContent(buildPrediction);
    
    try {
      await fs.writeFile('Dockerfile', dockerfile);
      logger.info('Generated Dockerfile');
      return dockerfile;
    } catch (error) {
      logger.error('Failed to write Dockerfile:', error);
      throw error;
    }
  }

  createDockerfileContent(buildPrediction) {
    // Handle null or undefined buildPrediction
    const prediction = buildPrediction || {};
    const strategy = prediction.strategy || 'standard';
    const resources = prediction.resources || {};
    
    // Default values if fields are missing
    const cpuReq = resources.cpu || '2 cores';
    const memReq = resources.memory || '4GB';
    
    // Simple Dockerfile generation based on detected language/framework
    return `
# Generated Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["npm", "start"]
`.trim();
  }

  async followBuildProgress(stream) {
    return new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err, res) => {
        if (err) {
          reject(err);
        } else {
          logger.info('Docker build completed successfully');
          resolve(res);
        }
      }, (event) => {
        if (event.stream) {
          logger.info(`Build: ${event.stream.trim()}`);
        }
      });
    });
  }

  async pushImage(localImage, registryImage) {
    try {
      const image = this.docker.getImage(localImage);
      
      // Tag for registry
      await image.tag({ repo: registryImage });
      
      // Push to registry
      const pushStream = await this.docker.getImage(registryImage).push();
      
      return new Promise((resolve, reject) => {
        this.docker.modem.followProgress(pushStream, (err, res) => {
          if (err) {
            reject(err);
          } else {
            logger.info(`Successfully pushed ${registryImage}`);
            resolve(res);
          }
        });
      });
    } catch (error) {
      logger.error('Docker push failed:', error);
      throw error;
    }
  }

  async generateKubernetesManifests(owner, repo, buildPrediction, imageName) {
    // Safely handle potentially null values
    const ownerSafe = owner || 'default';
    const repoSafe = repo || 'app';
    const imageNameSafe = imageName || `${ownerSafe}/${repoSafe}:latest`;
    
    // Add safety checks for buildPrediction
    const resources = buildPrediction?.resources || {
      cpu: '100m',
      memory: '128Mi',
      disk: '1Gi'
    };
    
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: appName,
        labels: {
          app: appName,
          version: 'v1'
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
              image: imageName || `${owner}/${repo}:latest`,
              ports: [{
                containerPort: 3000
              }],
              resources: {
                requests: {
                  cpu: resources.cpu || '100m',
                  memory: resources.memory || '128Mi'
                },
                limits: {
                  cpu: resources.cpu || '500m',
                  memory: resources.memory || '512Mi'
                }
              },
              livenessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000
                },
                initialDelaySeconds: 30,
                periodSeconds: 10
              },
              readinessProbe: {
                httpGet: {
                  path: '/health',
                  port: 3000
                },
                initialDelaySeconds: 5,
                periodSeconds: 5
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
          targetPort: 3000,
          protocol: 'TCP'
        }],
        type: 'ClusterIP'
      }
    };

    const ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `${appName}-ingress`,
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod'
        }
      },
      spec: {
        tls: [{
          hosts: [`${appName}.${process.env.DOMAIN || 'example.com'}`],
          secretName: `${appName}-tls`
        }],
        rules: [{
          host: `${appName}.${process.env.DOMAIN || 'example.com'}`,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: `${appName}-service`,
                  port: {
                    number: 80
                  }
                }
              }
            }]
          }
        }]
      }
    };

    return {
      deployment,
      service,
      ingress
    };
  }

  async deployToKubernetes(params) {
    const { k8s_manifests, namespace = 'default' } = params;
    
    if (!this.k8sApi) {
      throw new Error('Kubernetes client not initialized');
    }

    try {
      const results = [];

      // Deploy Deployment
      if (k8s_manifests.deployment) {
        try {
          await this.k8sApi.createNamespacedDeployment(namespace, k8s_manifests.deployment);
          results.push({ type: 'deployment', status: 'created' });
        } catch (error) {
          if (error.response?.statusCode === 409) {
            // Update existing deployment
            await this.k8sApi.replaceNamespacedDeployment(
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

      // Deploy Service
      if (k8s_manifests.service) {
        try {
          await this.k8sCoreApi.createNamespacedService(namespace, k8s_manifests.service);
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
        deployment_status: 'success',
        deployed_resources: results,
        namespace: namespace
      };

    } catch (error) {
      logger.error('Kubernetes deployment failed:', error);
      throw error;
    }
  }
}

module.exports = new DockerHandlerAgent();
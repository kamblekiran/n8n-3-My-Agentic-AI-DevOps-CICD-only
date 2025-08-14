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
      const [owner, repo] = repository.split('/');
      
      switch (action) {
        case 'build_and_push':
          return await this.buildAndPushImage(owner, repo, commit_sha, build_prediction);
        case 'generate_k8s_manifests':
          return await this.generateKubernetesManifests(owner, repo, build_prediction);
        case 'deploy_to_k8s':
          return await this.deployToKubernetes(params);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('Docker/K8s handling failed:', error);
      throw error;
    }
  }

  async buildAndPushImage(owner, repo, commitSha, buildPrediction) {
    try {
      const imageName = `${owner}/${repo}`;
      const imageTag = `${commitSha.substring(0, 8)}`;
      const fullImageName = `${imageName}:${imageTag}`;
      
      // Generate Dockerfile if it doesn't exist
      const dockerfile = await this.generateDockerfile(buildPrediction);
      
      // Build the Docker image
      logger.info(`Building Docker image: ${fullImageName}`);
      
      const buildStream = await this.docker.buildImage({
        context: process.cwd(),
        src: ['Dockerfile', '.']
      }, {
        t: fullImageName,
        dockerfile: 'Dockerfile'
      });
      
      // Wait for build to complete
      await this.followBuildProgress(buildStream);
      
      // Push to registry (if configured)
      if (process.env.DOCKER_REGISTRY) {
        const registryImage = `${process.env.DOCKER_REGISTRY}/${fullImageName}`;
        await this.pushImage(fullImageName, registryImage);
      }
      
      return {
        image_name: imageName,
        image_tag: imageTag,
        full_image_name: fullImageName,
        registry_url: process.env.DOCKER_REGISTRY ? `${process.env.DOCKER_REGISTRY}/${fullImageName}` : null,
        build_status: 'success',
        k8s_manifests: await this.generateKubernetesManifests(owner, repo, buildPrediction, fullImageName)
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
    // Simple Dockerfile generation based on detected language/framework
    const strategy = buildPrediction?.strategy || 'standard';
    const resources = buildPrediction?.resources || {};
    
    // This is a simplified example - in production, you'd want more sophisticated logic
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
    const appName = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const resources = buildPrediction?.resources || {};
    
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
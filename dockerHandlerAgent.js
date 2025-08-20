const Docker = require('dockerode');
const k8s = require('@kubernetes/client-node');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class DockerHandlerAgent {
  constructor() {
    // Check if the constructor logs or accesses Docker credentials
    this.dockerUsername = process.env.DOCKER_USERNAME;
    this.dockerPassword = process.env.DOCKER_PASSWORD;
    
    // Verify if it logs credentials status
    if (!this.dockerUsername || !this.dockerPassword) {
      console.warn('Docker credentials not found in environment variables');
    } else {
      console.log(`Docker credentials found for user: ${this.dockerUsername}`);
    }

    // Try to initialize Docker, but provide fallback if not available
    try {
      this.docker = new Docker();
      this.dockerAvailable = true;
      logger.info('Docker client initialized successfully');
    } catch (error) {
      logger.warn('Docker initialization failed:', error.message);
      this.dockerAvailable = false;
      logger.info('Will use mock Docker implementation for POC');
    }
    
    // Initialize Kubernetes client with fallback
    this.k8sAvailable = false;
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
      this.k8sClient = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAppsClient = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
      logger.info('Kubernetes client initialized successfully');
    } catch (error) {
      logger.warn('Kubernetes client initialization failed:', error.message);
      logger.info('Will use mock Kubernetes implementation for POC');
    }
  }

  async execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          logger.error(`Command execution error: ${error.message}`);
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async handle(params) {
    // Log environment variables (mask most of password)
    const username = process.env.DOCKER_USERNAME;
    const password = process.env.DOCKER_PASSWORD;
    const maskedPassword = password ? 
      password.substring(0, 2) + '***' + password.substring(password.length - 2) : 
      'not set';
    
    console.log('Docker credentials check:');
    console.log(`- DOCKER_USERNAME: ${username || 'not set'}`);
    console.log(`- DOCKER_PASSWORD: ${maskedPassword}`);
    
    const { repository, commit_sha, build_prediction, action = 'build_and_push' } = params;
    
    try {
      // Check for required parameters
      if (!repository) {
        throw new Error('Repository parameter is required');
      }
      
      if (!commit_sha) {
        throw new Error('Commit SHA parameter is required');
      }
      
      // Parse repository and convert to lowercase for Docker compatibility
      const [owner, repo] = repository.split('/');
      
      if (!owner || !repo) {
        throw new Error('Repository must be in format owner/repo');
      }
      
      logger.info(`Docker handler: ${action} for ${repository} at ${commit_sha}`);
      
      // Authenticate with Docker Hub
      if (!this.dockerPassword) {
        logger.warn('DOCKER_PASSWORD environment variable not set. Docker Hub push may fail.');
      } else {
        logger.info(`Authenticating with Docker Hub as ${this.dockerUsername}`);
        try {
          // Use the secure login method
          await this.execCommand(`echo "${this.dockerPassword}" | docker login -u ${this.dockerUsername} --password-stdin`);
          logger.info('Docker Hub authentication successful');
        } catch (loginError) {
          logger.error('Docker Hub authentication failed:', loginError);
          // Continue anyway, it might work if credentials are cached
        }
      }
      
      // Choose between real implementation or mock based on Docker availability
      switch (action) {
        case 'build_and_push':
          if (this.dockerAvailable) {
            return await this.buildAndPushImage(owner, repo, commit_sha, build_prediction);
          } else {
            return this.mockBuildAndPushImage(owner, repo, commit_sha, build_prediction);
          }
        case 'generate_k8s_manifests':
          const imageName = `${owner.toLowerCase()}/${repo.toLowerCase()}:${commit_sha.substring(0, 7)}`;
          return await this.generateKubernetesManifests(owner, repo, build_prediction, imageName);
        case 'deploy_to_k8s':
          if (this.k8sAvailable) {
            return await this.deployToKubernetes(params);
          } else {
            return this.mockDeployToKubernetes(params);
          }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('Docker handling failed:', error);
      throw error;
    }
  }

  // Mock implementation for when Docker is not available
  mockBuildAndPushImage(owner, repo, commitSha, buildPrediction) {
    logger.info(`[MOCK] Building Docker image for ${owner}/${repo} at commit ${commitSha.substring(0, 7)}`);
    
    // Convert owner and repo to lowercase for Docker compatibility
    const ownerLower = owner.toLowerCase();
    const repoLower = repo.toLowerCase();
    
    // Generate a mock Dockerfile based on the build prediction
    const dockerfileContent = this.createDockerfileContent(buildPrediction);
    logger.info('[MOCK] Generated Dockerfile:', dockerfileContent.substring(0, 100) + '...');
    
    // Mock image name - using lowercase
    const shortSha = commitSha.substring(0, 7);
    const imageName = `${ownerLower}/${repoLower}:${shortSha}`;
    
    // Mock registry
    const registryHost = process.env.DOCKER_REGISTRY || 'mock-registry.example.com';
    const registryImage = `${registryHost}/${imageName}`;
    
    logger.info(`[MOCK] Image would be pushed to ${registryImage}`);
    
    // Return mock success response
    return {
      status: 'success',
      image: imageName,
      registry_image: registryImage,
      build_output: '[MOCK] Docker build completed successfully',
      mock: true,
      dockerfile: dockerfileContent,
      pipeline_id: 'pipeline-' + Date.now(),
      // Include original values for reference
      original_repository: `${owner}/${repo}`
    };
  }

  async buildAndPushImage(owner, repo, commitSha, buildPrediction) {
    try {
      // Validate commitSha
      if (!commitSha) {
        throw new Error('Commit SHA is required for building Docker image');
      }
      
      // Convert owner and repo to lowercase for Docker compatibility
      const ownerLower = owner.toLowerCase();
      const repoLower = repo.toLowerCase();
      
      // Use a safe substring operation
      const shortSha = commitSha ? commitSha.substring(0, 7) : 'latest';
      
      logger.info(`Building Docker image for ${ownerLower}/${repoLower} at commit ${shortSha}`);
      logger.info(`Original repository: ${owner}/${repo}`);
      
      // Generate a Dockerfile based on the build prediction
      const dockerfilePath = await this.generateDockerfile(buildPrediction);
      
      // Build the image
      const imageName = `${ownerLower}/${repoLower}:${shortSha}`;
      const stream = await this.docker.buildImage({
        context: process.cwd(),
        src: ['Dockerfile']
      }, {t: imageName});
      
      const buildOutput = await this.followBuildProgress(stream);
      
      // Push the image to Docker Hub
      let result = {
        status: 'success',
        image: imageName,
        registry_image: null,
        build_output: buildOutput,
        original_repository: `${owner}/${repo}`
      };
      
      // Only do one push, to the standard Docker Hub
      try {
        logger.info(`Pushing image ${imageName} to Docker Hub`);
        const pushResult = await this.execCommand(`docker push ${imageName}`);
        logger.info('Image pushed successfully');
        result.push_output = pushResult;
      } catch (pushError) {
        logger.error('Failed to push image to Docker Hub:', pushError);
        result.push_error = pushError.message;
        // Don't fail the whole operation if push fails
      }
      
      return result;
    } catch (error) {
      logger.error('Docker build failed:', error);
      throw error;
    }
  }

  async generateDockerfile(buildPrediction) {
    const dockerfile = this.createDockerfileContent(buildPrediction);
    
    try {
      await fs.writeFile('Dockerfile', dockerfile);
      logger.info('Dockerfile generated at ' + path.resolve('Dockerfile'));
      return 'Dockerfile';
    } catch (error) {
      logger.error('Failed to write Dockerfile:', error);
      throw error;
    }
  }

  createDockerfileContent(buildPrediction) {
    // Handle null or undefined buildPrediction
    const prediction = buildPrediction || {};
    const strategy = prediction.strategy || 'standard';
    
    // Extract the programming language from the repository info
    const language = prediction.language || 'javascript';
    
    // Base image selection based on language
    let baseImage = 'node:18-alpine';
    let buildCommands = '';
    let runCommand = 'npm start';
    
    // Configure based on detected language
    switch (language.toLowerCase()) {
      case 'javascript':
      case 'typescript':
        baseImage = 'node:18-alpine';
        buildCommands = 'COPY package*.json ./\nRUN npm ci\nCOPY . .';
        runCommand = 'npm start';
        break;
      case 'python':
        baseImage = 'python:3.11-slim';
        buildCommands = 'COPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .';
        runCommand = 'python app.py';
        break;
      case 'java':
        baseImage = 'eclipse-temurin:17-jdk-alpine';
        buildCommands = 'COPY .mvn .mvn\nCOPY mvnw pom.xml ./\nRUN ./mvnw dependency:go-offline\nCOPY src ./src\nRUN ./mvnw package -DskipTests';
        runCommand = 'java -jar target/*.jar';
        break;
      case 'go':
        baseImage = 'golang:1.21-alpine';
        buildCommands = 'COPY go.* ./\nRUN go mod download\nCOPY . .\nRUN go build -o /app';
        runCommand = '/app';
        break;
      default:
        baseImage = 'node:18-alpine';
        buildCommands = 'COPY . .';
        runCommand = 'npm start';
    }
    
    // Optimize based on build strategy
    if (strategy === 'optimized') {
      // Use multi-stage builds for optimized strategy
      return `# Build stage
FROM ${baseImage} as builder
WORKDIR /app
${buildCommands}

# Production stage
FROM ${baseImage.includes('alpine') ? 'alpine:latest' : 'debian:bullseye-slim'}
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
CMD ["${runCommand}"]`;
    } else {
      // Standard single-stage build
      return `FROM ${baseImage}
WORKDIR /app
${buildCommands}
EXPOSE 8080
CMD ["${runCommand}"]`;
    }
  }

  // Mock implementation for K8s deployment
  mockDeployToKubernetes(params) {
    const { repository, image_tag, environment } = params;
    
    logger.info(`[MOCK] Deploying ${repository} with image tag ${image_tag} to ${environment}`);
    
    return {
      status: 'success',
      deployment_id: 'mock-deployment-' + Date.now(),
      deployment_url: `https://${environment}-${repository.replace('/', '-')}.example.com`,
      environment: environment,
      mock: true,
      pipeline_id: params.pipeline_id || ('pipeline-' + Date.now())
    };
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
    const imageNameSafe = imageName || `${ownerSafe.toLowerCase()}/${repoSafe.toLowerCase()}:latest`;
    
    // Create a valid app name for Kubernetes (must be DNS compliant)
    const appName = repoSafe.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
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
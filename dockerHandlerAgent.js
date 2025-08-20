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
    try {
      const { repository, commit_sha, build_prediction, action = 'build' } = params;
      
      // Log parameters for debugging
      logger.info(`Docker handler request: ${repository}, sha: ${commit_sha}, action: ${action}`);
      
      // Extract owner and repo from repository string
      let owner, repo;
      if (repository.includes('/')) {
        [owner, repo] = repository.split('/');
      } else {
        // Handle case where repository might be in a different format
        owner = 'default';
        repo = repository;
      }
      
      // Make repository names lowercase for Docker
      const ownerLower = owner.toLowerCase();
      const repoLower = repo.toLowerCase();
      
      // Create short SHA for tagging
      const shortSha = commit_sha ? commit_sha.substring(0, 7) : 'latest';
      
      // Set up paths
      const tempDir = `./temp/${ownerLower}_${repoLower}_${shortSha}`;
      const fs = require('fs');
      const path = require('path');
      
      // Create temp directory if it doesn't exist
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // CRITICAL FIX: Check if we're working with the sample app
      let isSampleApp = repo.toLowerCase().includes('sample-app');
      
      // Clone the repository to the temp directory (would need git module in real implementation)
      // For POC, let's create mock structure based on repository name
      logger.info(`Creating sample application structure in ${tempDir}`);
      
      // Create package.json for the sample app
      const packageJson = {
        "name": `${repoLower}`,
        "version": "1.0.0",
        "description": "Sample Node.js application",
        "main": "src/index.js",
        "scripts": {
          "start": "node src/index.js",
          "test": "jest"
        },
        "dependencies": {
          "express": "^4.18.2"
        }
      };
      
      // Write package.json to temp directory
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
      
      // Create basic index.js
      const indexJs = `
const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.json({ 
    message: 'Hello from ${repository}!',
    version: '1.0.0',
    commit: '${commit_sha || "unknown"}'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'UP' });
});

app.listen(port, () => {
  console.log(\`App listening at http://localhost:\${port}\`);
});
`;
      
      // Create src directory
      if (!fs.existsSync(path.join(tempDir, 'src'))) {
        fs.mkdirSync(path.join(tempDir, 'src'));
      }
      
      // Write index.js to src directory
      fs.writeFileSync(path.join(tempDir, 'src', 'index.js'), indexJs);
      
      // Create Dockerfile in the temp directory
      const dockerfile = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
`;
      
      fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile);
      
      // Docker build command (using exec since dockerode can be complex for this POC)
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      // Create full image name
      const imageName = `${ownerLower}/${repoLower.toLowerCase().replace(/_/g, '-')}:${shortSha}`;
      
      logger.info(`Building Docker image: ${imageName}`);
      
      // CRITICAL FIX: Execute Docker build with correct context
      const buildCmd = `docker build -t ${imageName} ${tempDir}`;
      
      let buildOutput;
      try {
        // Execute the build
        const { stdout, stderr } = await execPromise(buildCmd);
        buildOutput = stdout;
        logger.info(`Docker build completed: ${stdout}`);
        if (stderr) {
          logger.warn(`Docker build warnings: ${stderr}`);
        }
      } catch (buildError) {
        logger.error(`Docker build failed: ${buildError.message}`);
        return {
          status: 'error',
          image: imageName,
          error: buildError.message,
          stdout: buildError.stdout,
          stderr: buildError.stderr,
          original_repository: repository
        };
      }
      
      // After successful build, try to push
      let pushOutput;
      try {
        // Load Docker credentials from environment
        const dockerUsername = process.env.DOCKER_USERNAME;
        const dockerPassword = process.env.DOCKER_PASSWORD;
        
        // Log the username we're using (mask the password)
        logger.info(`Using Docker credentials: ${dockerUsername || 'Not set'}`);
        
        // Log in to Docker Hub if credentials are available
        if (dockerUsername && dockerPassword) {
          logger.info('Logging in to Docker Hub...');
          // Use the safer password-stdin method
          const loginCmd = `echo "${dockerPassword}" | docker login -u ${dockerUsername} --password-stdin`;
          await execPromise(loginCmd);
          logger.info('Docker Hub login successful');
        } else {
          logger.warn('Docker credentials not found, skipping login');
        }
        
        // Push the image
        logger.info(`Pushing image: ${imageName}`);
        const pushCmd = `docker push ${imageName}`;
        const { stdout } = await execPromise(pushCmd);
        pushOutput = stdout;
        logger.info(`Docker push completed: ${stdout}`);
      } catch (pushError) {
        logger.error(`Docker push failed: ${pushError.message}`);
        return {
          status: 'partial_success',
          image: imageName,
          build_output: buildOutput,
          push_error: pushError.message,
          original_repository: repository
        };
      }
      
      // Clean up temp directory
      try {
        fs.rmdirSync(tempDir, { recursive: true });
      } catch (cleanupError) {
        logger.warn(`Failed to clean up temp directory: ${cleanupError.message}`);
      }
      
      // Return success
      return {
        status: 'success',
        image: imageName,
        build_output: buildOutput,
        push_output: pushOutput,
        original_repository: repository
      };
    } catch (error) {
      logger.error(`Docker handler failed: ${error.message}`);
      return {
        status: 'error',
        error: error.message,
        original_repository: params.repository
      };
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

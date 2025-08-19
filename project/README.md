# MCP DevOps Server

A Model Context Protocol (MCP) server that acts as the central hub for DevOps automation, interfacing with LLMs and various DevOps tools.

## Features
npm install @azure/arm-containerservice @azure/identity
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-service-principal-id
AZURE_CLIENT_SECRET=your-service-principal-secret
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_RESOURCE_GROUP=your-resource-group-name
AZURE_LOCATION=eastus
- **Code Review Agent**: Automated code review using LLM analysis
- **Test Writer Agent**: Automatic test generation for code changes
- **Build Predictor Agent**: Predicts build outcomes and resource requirements
- **Docker Handler Agent**: Manages Docker image building and Kubernetes manifest generation
- **Deploy Agent**: Handles Kubernetes deployments with rollback capabilities
- **Monitor Agent**: Monitors deployed applications and generates health reports

## Architecture

The server provides REST API endpoints that can be called from n8n workflows or other automation tools. Each agent specializes in a specific aspect of the DevOps pipeline:

```
GitHub Webhook → n8n Pipeline → MCP Server Agents → DevOps Tools
```

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

4. **For development**:
   ```bash
   npm run dev
   ```

## API Endpoints

### Agent Endpoints

- `POST /agent/code-review` - Analyze code changes and provide review
- `POST /agent/test-writer` - Generate tests for changed files
- `POST /agent/build-predictor` - Predict build outcomes
- `POST /agent/docker-handler` - Handle Docker operations
- `POST /agent/deploy` - Deploy applications to Kubernetes
- `POST /agent/monitor` - Monitor deployed applications

### Utility Endpoints

- `GET /health` - Health check
- `GET /health/ready` - Readiness check
- `POST /notifications/slack` - Send Slack notifications
- `POST /notifications/teams` - Send Teams notifications

## Configuration

### Required Environment Variables

- `OPENAI_API_KEY` - OpenAI API key for LLM operations
- `GITHUB_TOKEN` - GitHub token for repository access
- `MCP_SERVER_TOKEN` - Authentication token for API access

### Optional Environment Variables

- `DOCKER_REGISTRY` - Docker registry URL
- `SLACK_WEBHOOK_URL` - Slack webhook for notifications
- `TEAMS_WEBHOOK_URL` - Teams webhook for notifications
- `GRAFANA_URL` - Grafana dashboard URL
- `DOMAIN` - Domain for ingress configuration

## Integration with n8n

The server is designed to work with the provided n8n workflow. Each n8n node calls the corresponding MCP server endpoint:

1. **GitHub Webhook** triggers the pipeline
2. **Filter PR Events** determines if processing is needed
3. **Code Review Agent** analyzes the code changes
4. **Test Writer Agent** generates tests
5. **Approval Gate** checks if conditions are met
6. **Build Predictor Agent** predicts build success
7. **Docker Handler** builds and pushes images
8. **Deploy Agent** deploys to Kubernetes
9. **Monitor Agent** monitors the deployment
10. **Notifications** send status updates

## Agent Details

### Code Review Agent
- Fetches PR diffs from GitHub
- Analyzes code quality using LLM
- Posts review comments for issues
- Provides approval/rejection recommendations

### Test Writer Agent
- Identifies changed files that need tests
- Generates comprehensive test suites
- Supports multiple programming languages
- Estimates test coverage

### Build Predictor Agent
- Analyzes repository structure
- Reviews build history
- Predicts build success probability
- Estimates resource requirements

### Docker Handler Agent
- Generates Dockerfiles automatically
- Builds and pushes Docker images
- Creates Kubernetes manifests
- Handles multi-stage builds

### Deploy Agent
- Deploys to Kubernetes clusters
- Manages namespaces and resources
- Supports rollback operations
- Waits for deployment readiness

### Monitor Agent
- Collects deployment metrics
- Performs health checks
- Generates monitoring reports
- Provides dashboard links

## Security

- JWT-based authentication for production
- Bearer token authentication for development
- CORS protection
- Request validation and sanitization
- Secure secret management

## Logging

The server uses Winston for structured logging:
- Console output for development
- File logging for production
- Error tracking and monitoring
- Request/response logging

## Error Handling

- Comprehensive error handling for all agents
- Graceful degradation when services are unavailable
- Detailed error messages for debugging
- Automatic retry mechanisms where appropriate

## Development

### Project Structure

```
src/
├── server.js              # Main server file
├── routes/                # API route handlers
│   ├── agents.js         # Agent endpoints
│   ├── notifications.js  # Notification endpoints
│   └── health.js         # Health check endpoints
├── agents/               # Agent implementations
│   ├── codeReviewAgent.js
│   ├── testWriterAgent.js
│   ├── buildPredictorAgent.js
│   ├── dockerHandlerAgent.js
│   ├── deployAgent.js
│   └── monitorAgent.js
└── middleware/           # Express middleware
    ├── auth.js          # Authentication
    └── errorHandler.js  # Error handling
```

### Adding New Agents

1. Create agent file in `src/agents/`
2. Implement required methods
3. Add route in `src/routes/agents.js`
4. Update n8n workflow if needed

### Testing

```bash
npm test
```

## Deployment

### Docker

```bash
docker build -t mcp-devops-server .
docker run -p 3000:3000 --env-file .env mcp-devops-server
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-devops-server
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mcp-devops-server
  template:
    metadata:
      labels:
        app: mcp-devops-server
    spec:
      containers:
      - name: mcp-devops-server
        image: mcp-devops-server:latest
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: mcp-devops-secrets
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

const { OpenAI } = require('openai');
const { Octokit } = require('@octokit/rest');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class BuildPredictorAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.github = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
  }

  async predict(params) {
    const { repository, branch, commit_sha, llm_model = 'gpt-4' } = params;
    
    try {
      const [owner, repo] = repository.split('/');
      
      // Get repository structure and build configuration
      const repoInfo = await this.analyzeRepository(owner, repo, branch);
      
      // Get recent build history
      const buildHistory = await this.getBuildHistory(owner, repo);
      
      // Predict build outcome using LLM
      const prediction = await this.predictBuildOutcome(repoInfo, buildHistory, llm_model);
      
      return {
        prediction: prediction.outcome,
        confidence: prediction.confidence,
        estimated_duration: prediction.duration,
        potential_issues: prediction.issues,
        recommendations: prediction.recommendations,
        build_strategy: prediction.strategy,
        resource_requirements: prediction.resources
      };
      
    } catch (error) {
      logger.error('Build prediction failed:', error);
      throw error;
    }
  }

  async analyzeRepository(owner, repo, branch) {
    try {
      // Get repository metadata
      const { data: repoData } = await this.github.repos.get({ owner, repo });
      
      // Get build configuration files
      const buildFiles = await this.getBuildConfigFiles(owner, repo, branch);
      
      // Get recent commits
      const { data: commits } = await this.github.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: 10
      });
      
      // Get repository languages
      const { data: languages } = await this.github.repos.listLanguages({ owner, repo });
      
      return {
        name: repoData.name,
        language: repoData.language,
        languages: languages,
        size: repoData.size,
        build_files: buildFiles,
        recent_commits: commits.map(c => ({
          sha: c.sha,
          message: c.commit.message,
          author: c.commit.author.name,
          date: c.commit.author.date
        }))
      };
    } catch (error) {
      logger.error('Repository analysis failed:', error);
      throw error;
    }
  }

  async getBuildConfigFiles(owner, repo, branch) {
    const buildFilePatterns = [
      'package.json',
      'Dockerfile',
      'docker-compose.yml',
      'Makefile',
      'pom.xml',
      'build.gradle',
      'requirements.txt',
      'Pipfile',
      'go.mod',
      'Cargo.toml',
      '.github/workflows',
      'Jenkinsfile',
      'azure-pipelines.yml'
    ];
    
    const buildFiles = [];
    
    for (const pattern of buildFilePatterns) {
      try {
        const { data: content } = await this.github.repos.getContent({
          owner,
          repo,
          path: pattern,
          ref: branch
        });
        
        if (Array.isArray(content)) {
          // Directory (like .github/workflows)
          buildFiles.push({
            path: pattern,
            type: 'directory',
            files: content.map(f => f.name)
          });
        } else {
          // Single file
          buildFiles.push({
            path: pattern,
            type: 'file',
            content: Buffer.from(content.content, 'base64').toString('utf-8')
          });
        }
      } catch (error) {
        // File doesn't exist, continue
      }
    }
    
    return buildFiles;
  }

  async getBuildHistory(owner, repo) {
    try {
      // Get recent workflow runs (GitHub Actions)
      const { data: workflows } = await this.github.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        per_page: 20
      });
      
      return workflows.workflow_runs.map(run => ({
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
        updated_at: run.updated_at,
        duration: run.updated_at && run.created_at ? 
          new Date(run.updated_at) - new Date(run.created_at) : null,
        head_sha: run.head_sha,
        event: run.event
      }));
    } catch (error) {
      logger.warn('Could not fetch build history:', error.message);
      return [];
    }
  }

  async predictBuildOutcome(repoInfo, buildHistory, model) {
    const prompt = `
You are an expert DevOps engineer. Analyze the following repository information and build history to predict the build outcome.

Repository Information:
${JSON.stringify(repoInfo, null, 2)}

Recent Build History:
${JSON.stringify(buildHistory, null, 2)}

Provide a prediction with:
1. Build outcome (success/failure/warning)
2. Confidence level (0-100)
3. Estimated duration in minutes
4. Potential issues that might cause failure
5. Recommendations to improve build success
6. Optimal build strategy
7. Resource requirements (CPU, memory, disk)

Respond in JSON format:
{
  "outcome": "success|failure|warning",
  "confidence": number,
  "duration": number,
  "issues": ["string"],
  "recommendations": ["string"],
  "strategy": "string",
  "resources": {
    "cpu": "string",
    "memory": "string",
    "disk": "string"
  }
}
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      logger.error('Build prediction LLM call failed:', error);
      
      // Fallback prediction based on build history
      return this.fallbackPrediction(buildHistory);
    }
  }

  fallbackPrediction(buildHistory) {
    const recentBuilds = buildHistory.slice(0, 5);
    const successRate = recentBuilds.filter(b => b.conclusion === 'success').length / recentBuilds.length;
    
    const avgDuration = recentBuilds
      .filter(b => b.duration)
      .reduce((sum, b) => sum + b.duration, 0) / recentBuilds.length / (1000 * 60); // Convert to minutes
    
    return {
      outcome: successRate > 0.7 ? 'success' : successRate > 0.4 ? 'warning' : 'failure',
      confidence: Math.round(successRate * 100),
      duration: Math.round(avgDuration) || 10,
      issues: successRate < 0.5 ? ['Recent build failures detected'] : [],
      recommendations: ['Monitor build logs', 'Ensure dependencies are up to date'],
      strategy: 'standard',
      resources: {
        cpu: '2 cores',
        memory: '4GB',
        disk: '20GB'
      }
    };
  }
}

module.exports = new BuildPredictorAgent();
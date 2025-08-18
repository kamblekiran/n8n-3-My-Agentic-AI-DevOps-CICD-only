const { OpenAI } = require('openai');
const { Octokit } = require('@octokit/rest');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'debug', // Changed to debug to capture all log levels
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class BuildPredictorAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    // Check if GitHub token is available
    if (!process.env.GITHUB_TOKEN) {
      logger.warn('GITHUB_TOKEN not set - GitHub API calls will be unavailable');
      this.githubAvailable = false;
    } else {
      this.github = new Octokit({
        auth: process.env.GITHUB_TOKEN
      });
      this.githubAvailable = true;
    }
  }

  async predict(repository, commit_sha, branch = 'main', changed_files = [], code_review_result = {}, llm_model = 'gpt-4') {
    // Validate required parameters
    if (!repository) {
      throw new Error('Repository parameter is required');
    }
    
    if (!commit_sha) {
      throw new Error('Commit SHA parameter is required');
    }

    try {
      // Enhanced debug logging
      logger.debug('Build prediction request:', {
        repository,
        commit_sha,
        branch,
        changed_files_count: Array.isArray(changed_files) ? changed_files.length : 'unknown',
        code_review_result: typeof code_review_result === 'object' ? 'provided' : 'missing'
      });

      // Validate repository format
      const [owner, repo] = repository.split('/');
      if (!owner || !repo) {
        logger.error('Invalid repository format:', repository);
        throw new Error('Repository must be in format owner/repo');
      }

      let repoInfo = {};
      let buildHistory = [];

      // Only try to get GitHub data if token is available
      if (this.githubAvailable) {
        try {
          // Get repository info
          repoInfo = await this.analyzeRepository(owner, repo, branch);
          
          // Get build history
          buildHistory = await this.getBuildHistory(owner, repo);
        } catch (githubError) {
          logger.error('GitHub API error:', githubError.message);
          logger.warn('Continuing with limited repository information');
          
          // Create minimal repo info from the data we have
          repoInfo = {
            name: repo,
            owner: owner,
            full_name: repository,
            language: 'unknown',
            languages: {},
            build_files: []
          };
        }
      } else {
        logger.warn('GitHub access unavailable - using minimal repository data');
        repoInfo = {
          name: repo,
          owner: owner,
          full_name: repository,
          language: 'unknown',
          languages: {},
          build_files: []
        };
      }
      
      // Process changed files
      let files = [];
      if (typeof changed_files === 'string') {
        files = changed_files.split(',').filter(Boolean);
      } else if (Array.isArray(changed_files)) {
        files = changed_files;
      }
      repoInfo.changed_files = files;

      // Add review data
      repoInfo.code_review = code_review_result;
      repoInfo.commit_sha = commit_sha;
      repoInfo.branch = branch;

      // Generate prediction - even without GitHub data
      const prediction = await this.predictBuildOutcome(repoInfo, buildHistory, llm_model);

      return {
        repository,
        branch,
        commit_sha,
        prediction: prediction.outcome,
        confidence: prediction.confidence,
        estimated_duration: prediction.duration,
        potential_issues: prediction.issues,
        recommendations: prediction.recommendations,
        build_strategy: prediction.strategy,
        resource_requirements: prediction.resources,
        github_data_available: this.githubAvailable
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
        owner: repoData.owner.login,
        full_name: repoData.full_name,
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
    // Enhanced prompt with more specific instructions
    const prompt = `
You are an expert DevOps engineer. Analyze the following repository information and build history to predict the build outcome.

Repository Information:
${JSON.stringify(repoInfo, null, 2)}

Recent Build History:
${JSON.stringify(buildHistory, null, 2)}

Based on the code changes, repository structure, and historical build data, provide a detailed prediction on whether the current build will succeed or fail.

Consider:
- Language-specific build patterns
- Common failure modes for this type of project
- The impact of recent code changes
- Historical build success rates
- Dependencies and their potential issues
- Infrastructure requirements

Provide a prediction with:
1. Build outcome (success/failure/warning)
2. Confidence level (0-100)
3. Estimated duration in minutes
4. Potential issues that might cause failure
5. Recommendations to improve build success
6. Optimal build strategy
7. Resource requirements (CPU, memory, disk)

Your analysis must be comprehensive and insightful.

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

    // Add retry logic for OpenAI API calls
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.info(`Calling OpenAI API (attempt ${attempt + 1}/${maxRetries})...`);
        
        const response = await this.openai.chat.completions.create({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2, // Slightly increased for more varied responses
          max_tokens: 1500,
          presence_penalty: 0.1, // Slight penalty to avoid repetition
          frequency_penalty: 0.1 // Slight penalty to avoid repetition
        });

        logger.info('OpenAI API response received');
        logger.debug('Response content:', response.choices[0].message.content.substring(0, 200) + '...');

        try {
          // Check if response has valid JSON
          const content = response.choices[0].message.content.trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          
          if (!jsonMatch) {
            logger.error('No valid JSON found in response');
            logger.debug('Full response:', content);
            throw new Error('No valid JSON in response');
          }
          
          const jsonContent = jsonMatch[0];
          const result = JSON.parse(jsonContent);
          
          // Validate the parsed result has required fields
          if (!result.outcome || !result.confidence || !result.duration) {
            logger.error('Missing required fields in response', { 
              hasOutcome: !!result.outcome,
              hasConfidence: !!result.confidence,
              hasDuration: !!result.duration
            });
            throw new Error('Incomplete prediction result');
          }
          
          logger.info('Successfully parsed LLM prediction', { 
            outcome: result.outcome,
            confidence: result.confidence
          });
          
          return result;
        } catch (parseError) {
          logger.error('Failed to parse LLM response:', parseError);
          logger.debug('Raw LLM response:', response.choices[0].message.content);
          
          // Try a more lenient approach - extract JSON if there's text around it
          try {
            const contentStr = response.choices[0].message.content;
            const jsonStartIndex = contentStr.indexOf('{');
            const jsonEndIndex = contentStr.lastIndexOf('}') + 1;
            
            if (jsonStartIndex >= 0 && jsonEndIndex > jsonStartIndex) {
              const jsonStr = contentStr.substring(jsonStartIndex, jsonEndIndex);
              const result = JSON.parse(jsonStr);
              
              logger.info('Recovered JSON from malformed response');
              
              // Add any missing fields
              if (!result.outcome) result.outcome = 'warning';
              if (!result.confidence) result.confidence = 70;
              if (!result.duration) result.duration = 10;
              if (!result.issues) result.issues = ['Response parsing issues encountered'];
              if (!result.recommendations) result.recommendations = ['Check build logs carefully'];
              if (!result.strategy) result.strategy = 'standard';
              if (!result.resources) result.resources = {
                cpu: '2 cores',
                memory: '4GB',
                disk: '20GB'
              };
              
              return result;
            }
          } catch (e) {
            logger.error('Recovery parsing also failed');
          }
          
          // If we're on the last retry, throw to trigger fallback
          if (attempt === maxRetries - 1) {
            throw parseError;
          }
        }
      } catch (error) {
        lastError = error;
        logger.warn(`LLM request attempt ${attempt + 1} failed: ${error.message}`);
        
        // Wait before retrying
        const waitTime = 1000 * Math.pow(2, attempt);
        logger.info(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    logger.error('All LLM prediction attempts failed:', lastError);
    
    // If OpenAI key is missing or invalid, provide a helpful error
    if (lastError?.message?.includes('API key')) {
      logger.error('OpenAI API key issue detected. Check your API key configuration.');
    }
    
    // Fallback prediction with a note that it's not LLM-based
    const fallback = this.fallbackPrediction(buildHistory);
    fallback.recommendations = [
      'Note: This is a fallback prediction as LLM analysis failed',
      'Check your OpenAI API key and quota',
      ...fallback.recommendations
    ];
    
    return fallback;
  }

  fallbackPrediction(buildHistory) {
    // Handle case where buildHistory is null or empty
    if (!buildHistory || buildHistory.length === 0) {
      return {
        outcome: 'warning',
        confidence: 50,
        duration: 10,
        issues: ['No build history available', 'Fallback prediction used (not LLM-based)'],
        recommendations: ['Set up CI/CD pipeline', 'Configure GitHub Actions', 'Ensure OpenAI API key is valid'],
        strategy: 'standard',
        resources: {
          cpu: '2 cores',
          memory: '4GB',
          disk: '20GB'
        }
      };
    }
    
    const recentBuilds = buildHistory.slice(0, 5);
    const successRate = recentBuilds.filter(b => b.conclusion === 'success').length / recentBuilds.length;
    
    const avgDuration = recentBuilds
      .filter(b => b.duration)
      .reduce((sum, b) => sum + b.duration, 0) / recentBuilds.length / (1000 * 60); // Convert to minutes
  
    return {
      outcome: successRate > 0.7 ? 'success' : successRate > 0.4 ? 'warning' : 'failure',
      confidence: Math.round(Math.max(20, successRate * 100)), // Minimum 20% confidence for fallback
      duration: Math.round(avgDuration) || 10,
      issues: [
        'Fallback prediction used (not LLM-based)',
        ...(successRate < 0.5 ? ['Recent build failures detected'] : [])
      ],
      recommendations: ['Monitor build logs', 'Ensure dependencies are up to date', 'Check OpenAI API access'],
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


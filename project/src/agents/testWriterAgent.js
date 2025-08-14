const { OpenAI } = require('openai');
const { Octokit } = require('@octokit/rest');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class TestWriterAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.github = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
  }

  async generateTests(params) {
    const { repository, pr_number, changed_files, llm_model = 'gpt-4' } = params;
    
    try {
      const [owner, repo] = repository.split('/');
      
      // Get the changed files content
      const filesContent = await this.getChangedFilesContent(owner, repo, pr_number);
      
      // Generate tests for each changed file
      const generatedTests = [];
      
      for (const file of filesContent) {
        if (this.shouldGenerateTests(file.filename)) {
          const tests = await this.generateTestsForFile(file, llm_model);
          if (tests) {
            generatedTests.push({
              original_file: file.filename,
              test_file: this.getTestFileName(file.filename),
              test_content: tests,
              framework: this.detectTestFramework(file.filename)
            });
          }
        }
      }
      
      // Create test files as PR comments or commits
      if (generatedTests.length > 0) {
        await this.createTestFiles(owner, repo, pr_number, generatedTests);
      }
      
      return {
        tests_generated: generatedTests.length,
        test_files: generatedTests.map(t => t.test_file),
        coverage_estimate: this.estimateCoverage(generatedTests),
        frameworks_used: [...new Set(generatedTests.map(t => t.framework))]
      };
      
    } catch (error) {
      logger.error('Test generation failed:', error);
      throw error;
    }
  }

  async getChangedFilesContent(owner, repo, prNumber) {
    try {
      const { data: files } = await this.github.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber
      });
      
      const filesContent = [];
      
      for (const file of files) {
        if (file.status !== 'removed') {
          try {
            const { data: content } = await this.github.repos.getContent({
              owner,
              repo,
              path: file.filename,
              ref: `refs/pull/${prNumber}/head`
            });
            
            filesContent.push({
              filename: file.filename,
              content: Buffer.from(content.content, 'base64').toString('utf-8'),
              additions: file.additions,
              deletions: file.deletions
            });
          } catch (error) {
            logger.warn(`Could not fetch content for ${file.filename}:`, error.message);
          }
        }
      }
      
      return filesContent;
    } catch (error) {
      logger.error('Failed to get changed files:', error);
      throw error;
    }
  }

  shouldGenerateTests(filename) {
    const testableExtensions = ['.js', '.ts', '.py', '.java', '.go', '.rb'];
    const excludePatterns = ['/test/', '/tests/', '.test.', '.spec.', '/node_modules/'];
    
    const hasTestableExtension = testableExtensions.some(ext => filename.endsWith(ext));
    const isNotTestFile = !excludePatterns.some(pattern => filename.includes(pattern));
    
    return hasTestableExtension && isNotTestFile;
  }

  async generateTestsForFile(file, model) {
    const prompt = `
You are an expert test writer. Generate comprehensive unit tests for the following code file.

File: ${file.filename}
Content:
${file.content}

Requirements:
1. Generate tests that cover all functions/methods
2. Include edge cases and error scenarios
3. Use appropriate test framework for the language
4. Follow best practices for the detected language
5. Aim for high code coverage

Respond with only the test code, no explanations.
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 3000
      });

      return response.choices[0].message.content;
    } catch (error) {
      logger.error(`Failed to generate tests for ${file.filename}:`, error);
      return null;
    }
  }

  getTestFileName(originalFile) {
    const ext = originalFile.split('.').pop();
    const nameWithoutExt = originalFile.replace(`.${ext}`, '');
    
    // Language-specific test file naming conventions
    const conventions = {
      'js': `${nameWithoutExt}.test.js`,
      'ts': `${nameWithoutExt}.test.ts`,
      'py': `test_${originalFile}`,
      'java': `${nameWithoutExt}Test.java`,
      'go': `${nameWithoutExt}_test.go`,
      'rb': `${nameWithoutExt}_spec.rb`
    };
    
    return conventions[ext] || `${nameWithoutExt}.test.${ext}`;
  }

  detectTestFramework(filename) {
    const ext = filename.split('.').pop();
    
    const frameworks = {
      'js': 'Jest',
      'ts': 'Jest',
      'py': 'pytest',
      'java': 'JUnit',
      'go': 'testing',
      'rb': 'RSpec'
    };
    
    return frameworks[ext] || 'Unknown';
  }

  async createTestFiles(owner, repo, prNumber, generatedTests) {
    try {
      // Create a comment with the generated tests
      const testSummary = generatedTests.map(test => 
        `### ${test.test_file}\n\`\`\`${this.getLanguageFromExtension(test.test_file)}\n${test.test_content}\n\`\`\``
      ).join('\n\n');
      
      await this.github.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `## 🧪 Generated Tests\n\nI've generated the following tests for your changes:\n\n${testSummary}`
      });
      
      logger.info(`Created test files comment for PR #${prNumber}`);
    } catch (error) {
      logger.error('Failed to create test files:', error);
    }
  }

  getLanguageFromExtension(filename) {
    const ext = filename.split('.').pop();
    const languages = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'go': 'go',
      'rb': 'ruby'
    };
    return languages[ext] || ext;
  }

  estimateCoverage(generatedTests) {
    // Simple heuristic: estimate coverage based on number of test cases
    const totalTests = generatedTests.reduce((sum, test) => {
      const testCount = (test.test_content.match(/test|it\(/g) || []).length;
      return sum + testCount;
    }, 0);
    
    // Rough estimate: each test case covers ~10% of functionality
    return Math.min(totalTests * 10, 95);
  }
}

module.exports = new TestWriterAgent();
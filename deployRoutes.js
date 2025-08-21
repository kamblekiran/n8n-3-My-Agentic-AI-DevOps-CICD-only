const express = require('express');
const router = express.Router();

// In your routes file
const deployAgentModule = require('../agents/deployAgent');
console.log('Type of deployAgent:', typeof deployAgentModule);
console.log('Has deploy method?', 'deploy' in deployAgentModule);
console.log('Is constructor?', deployAgentModule.prototype && deployAgentModule.prototype.constructor === deployAgentModule);

router.post('/deploy', async (req, res) => {
  try {
    // Get the deployAgent module
    const DeployAgent = require('../agents/deployAgent');
    
    // Check if it's a class or instance
    if (typeof DeployAgent === 'function') {
      // It's a class, instantiate it
      const deployAgentInstance = new DeployAgent();
      const result = await deployAgentInstance.deploy(req.body);
      res.json(result);
    } else {
      // It's already an instance
      const result = await DeployAgent.deploy(req.body);
      res.json(result);
    }
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
});

module.exports = router;

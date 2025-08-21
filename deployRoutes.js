const express = require('express');
const router = express.Router();

// Import DeployAgent once at the top
const DeployAgent = require('../agents/deployAgent');

// Debug info if needed
console.log('Type of DeployAgent:', typeof DeployAgent);
console.log('Has deploy method?', DeployAgent.prototype && 'deploy' in DeployAgent.prototype);
console.log('Is constructor?', typeof DeployAgent === 'function');

router.post('/deploy', async (req, res) => {
  try {
    // No need to require it again, use the one imported at the top
    const deployAgentInstance = new DeployAgent();
    const result = await deployAgentInstance.deploy(req.body);
    res.json(result);
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
});

module.exports = router;

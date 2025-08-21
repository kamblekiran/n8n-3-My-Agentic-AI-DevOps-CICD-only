const express = require('express');
const router = express.Router();

// Import the DeployAgent instance
const deployAgent = require('../agents/deployAgent');

router.post('/deploy', async (req, res) => {
  try {
    // Add the namespace explicitly to the request body
    const deployParams = {
      ...req.body,
      namespace: 'default' // Always include namespace
    };
    
    // Use the imported instance directly, don't create a new instance
    const result = await deployAgent.deploy(deployParams);
    res.json(result);
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
});

module.exports = router;

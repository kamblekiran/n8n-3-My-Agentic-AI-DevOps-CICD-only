const express = require('express');
const router = express.Router();
const deployAgent = require('../agents/deployAgent');

router.post('/deploy', async (req, res) => {
  try {
    const deployParams = { ...req.body, namespace: 'default' };
    const result = await deployAgent.deploy(deployParams);
    res.json(result);
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
});

module.exports = router;

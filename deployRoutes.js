router.post('/deploy', async (req, res) => {
  try {
    // Add explicit logging of the request body
    console.log('Deployment request:', JSON.stringify(req.body, null, 2));
    
    // IMPORTANT: Explicitly add the namespace parameter
    const deployParams = {
      ...req.body,
      namespace: req.body.namespace || process.env.DEFAULT_NAMESPACE || 'default'
    };
    
    console.log('Processed deployment params:', JSON.stringify(deployParams, null, 2));
    
    const deployAgent = new DeployAgent();
    const result = await deployAgent.deploy(deployParams);
    
    res.json(result);
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: error.message });
  }
});
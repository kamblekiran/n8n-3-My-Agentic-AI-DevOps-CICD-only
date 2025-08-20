const { ClientSecretCredential } = require('@azure/identity');
const { ContainerServiceClient } = require('@azure/arm-containerservice');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class AksProvisioner {
  constructor() {
    // Read Azure credentials from environment variables
    this.tenantId = process.env.AZURE_TENANT_ID;
    this.clientId = process.env.AZURE_CLIENT_ID;
    this.clientSecret = process.env.AZURE_CLIENT_SECRET;
    this.subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    this.resourceGroupName = process.env.AZURE_RESOURCE_GROUP || 'devops-poc-rg';
    this.location = process.env.AZURE_LOCATION || 'eastus';
    
    // Check if credentials are available
    this.azureAvailable = !!(this.tenantId && this.clientId && this.clientSecret && this.subscriptionId);
    
    if (this.azureAvailable) {
      try {
        // Initialize Azure credentials
        this.credentials = new ClientSecretCredential(this.tenantId, this.clientId, this.clientSecret);
        
        // Initialize container service client
        this.containerServiceClient = new ContainerServiceClient(this.credentials, this.subscriptionId);
        
        logger.info('Azure AKS client initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize Azure clients:', error);
        this.azureAvailable = false;
      }
    } else {
      logger.warn('Azure credentials not found, will use mock implementation');
    }
  }
  
  // In the createAksCluster method, ensure nodeCount is a number
  async createAksCluster(clusterName, nodeCount = 1, vmSize = 'Standard_D2s_v3') {
    // Convert nodeCount to a number if it's not already
    const numNodes = parseInt(nodeCount, 10);
    
    if (isNaN(numNodes)) {
      throw new Error('Invalid node count. Must be a valid number.');
    }
    
    if (!this.azureAvailable) {
      return this.mockCreateAksCluster(clusterName, numNodes, vmSize);
    }
    
    logger.info(`Creating AKS cluster: ${clusterName} with ${numNodes} nodes of size ${vmSize}`);
    
    try {
      // Define cluster parameters
      const clusterParameters = {
        location: this.location,
        dnsPrefix: `${clusterName}-dns`,
        agentPoolProfiles: [
          {
            name: 'agentpool',
            count: numNodes, // Use the converted number here
            vmSize: vmSize,
            mode: 'System',
            osType: 'Linux'
          }
        ],
        servicePrincipalProfile: {
          clientId: this.clientId,
          secret: this.clientSecret
        },
        kubernetesVersion: '1.27.7' // Try an older version that's more likely to be supported
      };
      
      // Create the cluster
      const createOperation = await this.containerServiceClient.managedClusters.beginCreateOrUpdate(
        this.resourceGroupName,
        clusterName,
        clusterParameters
      );
      
      // AKS cluster creation takes time, so we'll return the operation status
      logger.info(`AKS cluster creation initiated: ${clusterName}`);
      
      // Here you would typically wait for the operation to complete
      // For POC, we'll return quickly
      return {
        status: 'creating',
        cluster_name: clusterName,
        resource_group: this.resourceGroupName,
        location: this.location,
        provisioning_state: 'InProgress',
        estimated_time_minutes: 10,
        mock: false
      };
    } catch (error) {
      logger.error(`Failed to create AKS cluster ${clusterName}:`, error);
      throw error;
    }
  }
  
  async getAksCredentials(clusterName) {
    if (!this.azureAvailable) {
      return this.mockGetAksCredentials(clusterName);
    }
    
    try {
      // Get cluster details
      const cluster = await this.containerServiceClient.managedClusters.get(
        this.resourceGroupName,
        clusterName
      );
      
      // Get cluster admin credentials
      const credentials = await this.containerServiceClient.managedClusters.listClusterAdminCredentials(
        this.resourceGroupName,
        clusterName
      );
      
      // The kubeconfig is in the credentials.kubeconfigs array
      if (credentials.kubeconfigs && credentials.kubeconfigs.length > 0) {
        const kubeConfigContent = credentials.kubeconfigs[0].value.toString('utf8');
        logger.info(`Retrieved kubeconfig for cluster ${clusterName}`);
        
        return {
          status: 'success',
          cluster_name: clusterName,
          kubeconfig: kubeConfigContent,
          provisioning_state: cluster.provisioningState,
          fqdn: cluster.fqdn,
          mock: false
        };
      } else {
        throw new Error('No kubeconfig found in the response');
      }
    } catch (error) {
      logger.error(`Failed to get AKS credentials for ${clusterName}:`, error);
      throw error;
    }
  }
  
  async deleteAksCluster(clusterName) {
    if (!this.azureAvailable) {
      return this.mockDeleteAksCluster(clusterName);
    }
    
    try {
      logger.info(`Deleting AKS cluster: ${clusterName}`);
      
      // Start the delete operation
      const deleteOperation = await this.containerServiceClient.managedClusters.beginDeleteMethod(
        this.resourceGroupName,
        clusterName
      );
      
      return {
        status: 'deleting',
        cluster_name: clusterName,
        resource_group: this.resourceGroupName,
        mock: false
      };
    } catch (error) {
      logger.error(`Failed to delete AKS cluster ${clusterName}:`, error);
      throw error;
    }
  }
  
  async waitForClusterReady(clusterName, timeoutMinutes = 10) {
    logger.info(`Waiting for AKS cluster ${clusterName} to be ready...`);
    
    const startTime = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    let reconcileAttempted = false;
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check cluster status
        const cluster = await this.getClusterStatus(clusterName);
        
        if (cluster.provisioningState === 'Succeeded') {
          logger.info(`AKS cluster ${clusterName} is ready!`);
          return true;
        }
        
        logger.info(`Cluster status: ${cluster.provisioningState}. Waiting...`);
        
        // If we get a 'Failed' state and haven't tried reconciliation yet, try it
        if (cluster.provisioningState === 'Failed' && !reconcileAttempted) {
          logger.info(`Cluster in Failed state. Attempting reconciliation...`);
          await this.reconcileCluster(clusterName);
          reconcileAttempted = true;
        }
        
        // Wait 30 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        logger.warn(`Error checking cluster status: ${error.message}`);
        
        // If we haven't tried reconciliation yet, try it now
        if (!reconcileAttempted && error.message.includes('control plane')) {
          logger.info(`Control plane issue detected. Attempting reconciliation...`);
          try {
            await this.reconcileCluster(clusterName);
            reconcileAttempted = true;
          } catch (reconcileError) {
            logger.error(`Reconciliation failed: ${reconcileError.message}`);
          }
        }
        
        // Continue waiting
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
    
    throw new Error(`Timeout waiting for cluster ${clusterName} to be ready after ${timeoutMinutes} minutes`);
  }
  
  async getClusterStatus(clusterName) {
    if (!this.azureAvailable) {
      // In mock mode, pretend it's ready after a short delay
      await new Promise(resolve => setTimeout(resolve, 3000));
      return {
        provisioningState: 'Succeeded',
        mock: true
      };
    }
    
    try {
      const cluster = await this.containerServiceClient.managedClusters.get(
        this.resourceGroupName,
        clusterName
      );
      
      return {
        provisioningState: cluster.provisioningState,
        name: cluster.name,
        location: cluster.location,
        kubernetesVersion: cluster.kubernetesVersion,
        mock: false
      };
    } catch (error) {
      logger.error(`Failed to get status of cluster ${clusterName}:`, error);
      throw error;
    }
  }
  
  async reconcileCluster(clusterName) {
    if (!this.azureAvailable) {
      return {
        status: 'success',
        message: '[MOCK] Cluster reconciled successfully',
        mock: true
      };
    }
    
    try {
      logger.info(`Reconciling AKS cluster ${clusterName} using Azure SDK...`);
      
      // Use the Azure SDK to update the cluster (equivalent to az aks update)
      const cluster = await this.containerServiceClient.managedClusters.get(
        this.resourceGroupName,
        clusterName
      );
      
      // Just updating the cluster with its current config should trigger reconciliation
      const updateOperation = await this.containerServiceClient.managedClusters.beginCreateOrUpdate(
        this.resourceGroupName,
        clusterName,
        cluster
      );
      
      logger.info(`Cluster reconciliation initiated for ${clusterName}`);
      
      return {
        status: 'reconciling',
        cluster_name: clusterName,
        resource_group: this.resourceGroupName,
        mock: false
      };
    } catch (error) {
      logger.error(`Failed to reconcile cluster ${clusterName}:`, error);
      throw error;
    }
  }
  
  // Mock methods for when Azure credentials aren't available
  mockCreateAksCluster(clusterName, nodeCount, vmSize) {
    // Convert nodeCount to a number if it's not already
    const numNodes = parseInt(nodeCount, 10);
    
    logger.info(`[MOCK] Creating AKS cluster: ${clusterName} with ${numNodes} nodes of size ${vmSize}`);
    
    return {
      status: 'success',
      cluster_name: clusterName,
      resource_group: this.resourceGroupName || 'mock-resource-group',
      location: this.location || 'eastus',
      provisioning_state: 'Succeeded',
      kubernetes_version: '1.27.7',
      node_count: numNodes, // Use the converted number here
      vm_size: vmSize,
      mock: true,
      message: 'This is a mock AKS cluster for POC demonstration'
    };
  }
  
  mockGetAksCredentials(clusterName) {
    logger.info(`[MOCK] Retrieved kubeconfig for cluster ${clusterName}`);
    
    return {
      status: 'success',
      cluster_name: clusterName,
      kubeconfig: 'mock-kubeconfig-content',
      provisioning_state: 'Succeeded',
      fqdn: `${clusterName}.azmk8s.io`,
      mock: true
    };
  }
  
  mockDeleteAksCluster(clusterName) {
    logger.info(`[MOCK] Deleting AKS cluster: ${clusterName}`);
    
    return {
      status: 'deleting',
      cluster_name: clusterName,
      resource_group: this.resourceGroupName || 'mock-resource-group',
      mock: true
    };
  }
}

module.exports = new AksProvisioner();

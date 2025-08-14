const k8s = require('@kubernetes/client-node');
const winston = require('winston');
const axios = require('axios');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class MonitorAgent {
  constructor() {
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
      this.k8sApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sCoreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sMetricsApi = this.kc.makeApiClient(k8s.Metrics);
    } catch (error) {
      logger.warn('Kubernetes client initialization failed:', error.message);
    }
  }

  async monitor(params) {
    const { 
      deployment_id, 
      environment = 'staging', 
      monitoring_duration = 300,
      namespace = environment 
    } = params;
    
    try {
      // Find deployment by ID
      const deployment = await this.findDeploymentById(deployment_id, namespace);
      
      if (!deployment) {
        throw new Error(`Deployment with ID ${deployment_id} not found`);
      }
      
      const appName = deployment.metadata.name;
      
      // Start monitoring
      const monitoringResults = await this.performMonitoring(
        appName, 
        namespace, 
        monitoring_duration
      );
      
      // Generate monitoring report
      const report = await this.generateMonitoringReport(
        appName, 
        namespace, 
        monitoringResults
      );
      
      return {
        deployment_id,
        monitoring_status: 'completed',
        duration: monitoring_duration,
        health_status: report.overall_health,
        metrics: report.metrics,
        alerts: report.alerts,
        recommendations: report.recommendations,
        dashboard_url: this.generateDashboardUrl(appName, namespace)
      };
      
    } catch (error) {
      logger.error('Monitoring failed:', error);
      throw error;
    }
  }

  async findDeploymentById(deploymentId, namespace) {
    try {
      const { body: deployments } = await this.k8sApi.listNamespacedDeployment(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `deployment-id=${deploymentId}`
      );
      
      return deployments.items[0] || null;
    } catch (error) {
      logger.error('Failed to find deployment:', error);
      return null;
    }
  }

  async performMonitoring(appName, namespace, durationSeconds) {
    const monitoringInterval = 30; // seconds
    const iterations = Math.floor(durationSeconds / monitoringInterval);
    const results = [];
    
    logger.info(`Starting monitoring for ${appName} (${durationSeconds}s)`);
    
    for (let i = 0; i < iterations; i++) {
      try {
        const timestamp = new Date().toISOString();
        
        // Collect metrics
        const metrics = await this.collectMetrics(appName, namespace);
        
        results.push({
          timestamp,
          ...metrics
        });
        
        logger.info(`Monitoring iteration ${i + 1}/${iterations} completed`);
        
        // Wait for next iteration
        if (i < iterations - 1) {
          await this.sleep(monitoringInterval * 1000);
        }
        
      } catch (error) {
        logger.warn(`Monitoring iteration ${i + 1} failed:`, error.message);
        results.push({
          timestamp: new Date().toISOString(),
          error: error.message
        });
      }
    }
    
    return results;
  }

  async collectMetrics(appName, namespace) {
    const metrics = {
      deployment: await this.getDeploymentMetrics(appName, namespace),
      pods: await this.getPodMetrics(appName, namespace),
      service: await this.getServiceMetrics(appName, namespace),
      health: await this.performHealthCheck(appName, namespace)
    };
    
    return metrics;
  }

  async getDeploymentMetrics(appName, namespace) {
    try {
      const { body: deployment } = await this.k8sApi.readNamespacedDeployment(appName, namespace);
      
      return {
        replicas: deployment.spec?.replicas || 0,
        ready_replicas: deployment.status?.readyReplicas || 0,
        available_replicas: deployment.status?.availableReplicas || 0,
        unavailable_replicas: deployment.status?.unavailableReplicas || 0,
        updated_replicas: deployment.status?.updatedReplicas || 0,
        conditions: deployment.status?.conditions || []
      };
    } catch (error) {
      logger.error('Failed to get deployment metrics:', error);
      return { error: error.message };
    }
  }

  async getPodMetrics(appName, namespace) {
    try {
      const { body: pods } = await this.k8sCoreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${appName}`
      );
      
      const podMetrics = pods.items.map(pod => ({
        name: pod.metadata.name,
        phase: pod.status?.phase,
        ready: pod.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True',
        restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
        cpu_requests: this.extractResourceValue(pod.spec?.containers?.[0]?.resources?.requests?.cpu),
        memory_requests: this.extractResourceValue(pod.spec?.containers?.[0]?.resources?.requests?.memory),
        cpu_limits: this.extractResourceValue(pod.spec?.containers?.[0]?.resources?.limits?.cpu),
        memory_limits: this.extractResourceValue(pod.spec?.containers?.[0]?.resources?.limits?.memory)
      }));
      
      return {
        total_pods: pods.items.length,
        running_pods: podMetrics.filter(p => p.phase === 'Running').length,
        ready_pods: podMetrics.filter(p => p.ready).length,
        pods: podMetrics
      };
    } catch (error) {
      logger.error('Failed to get pod metrics:', error);
      return { error: error.message };
    }
  }

  async getServiceMetrics(appName, namespace) {
    try {
      const { body: service } = await this.k8sCoreApi.readNamespacedService(
        `${appName}-service`,
        namespace
      );
      
      return {
        type: service.spec?.type,
        cluster_ip: service.spec?.clusterIP,
        ports: service.spec?.ports || [],
        endpoints: await this.getServiceEndpoints(appName, namespace)
      };
    } catch (error) {
      logger.error('Failed to get service metrics:', error);
      return { error: error.message };
    }
  }

  async getServiceEndpoints(appName, namespace) {
    try {
      const { body: endpoints } = await this.k8sCoreApi.readNamespacedEndpoints(
        `${appName}-service`,
        namespace
      );
      
      return {
        ready_addresses: endpoints.subsets?.[0]?.addresses?.length || 0,
        not_ready_addresses: endpoints.subsets?.[0]?.notReadyAddresses?.length || 0
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async performHealthCheck(appName, namespace) {
    try {
      // Get service URL for health check
      const serviceUrl = await this.getServiceUrl(appName, namespace);
      
      if (!serviceUrl) {
        return { status: 'unknown', message: 'Service URL not available' };
      }
      
      // Perform HTTP health check
      const response = await axios.get(`${serviceUrl}/health`, {
        timeout: 5000,
        validateStatus: () => true // Don't throw on non-2xx status
      });
      
      return {
        status: response.status === 200 ? 'healthy' : 'unhealthy',
        status_code: response.status,
        response_time: response.headers['x-response-time'] || 'unknown',
        message: response.status === 200 ? 'Health check passed' : 'Health check failed'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Health check failed: ${error.message}`
      };
    }
  }

  async getServiceUrl(appName, namespace) {
    try {
      const { body: service } = await this.k8sCoreApi.readNamespacedService(
        `${appName}-service`,
        namespace
      );
      
      const clusterIP = service.spec?.clusterIP;
      const port = service.spec?.ports?.[0]?.port || 80;
      
      if (clusterIP && clusterIP !== 'None') {
        return `http://${clusterIP}:${port}`;
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  async generateMonitoringReport(appName, namespace, monitoringResults) {
    const validResults = monitoringResults.filter(r => !r.error);
    
    if (validResults.length === 0) {
      return {
        overall_health: 'unknown',
        metrics: {},
        alerts: ['No valid monitoring data collected'],
        recommendations: ['Check monitoring configuration and connectivity']
      };
    }
    
    // Calculate averages and trends
    const avgReadyReplicas = this.calculateAverage(validResults, 'deployment.ready_replicas');
    const avgRunningPods = this.calculateAverage(validResults, 'pods.running_pods');
    const healthyChecks = validResults.filter(r => r.health?.status === 'healthy').length;
    const healthPercentage = (healthyChecks / validResults.length) * 100;
    
    // Generate alerts
    const alerts = [];
    if (avgReadyReplicas < 1) alerts.push('Low replica count detected');
    if (avgRunningPods < 1) alerts.push('Insufficient running pods');
    if (healthPercentage < 80) alerts.push('Health check success rate below 80%');
    
    // Generate recommendations
    const recommendations = [];
    if (avgReadyReplicas < 2) recommendations.push('Consider increasing replica count for high availability');
    if (healthPercentage < 90) recommendations.push('Investigate health check failures');
    
    return {
      overall_health: healthPercentage >= 90 ? 'healthy' : healthPercentage >= 70 ? 'warning' : 'unhealthy',
      metrics: {
        monitoring_duration: monitoringResults.length,
        average_ready_replicas: avgReadyReplicas,
        average_running_pods: avgRunningPods,
        health_success_rate: `${healthPercentage.toFixed(1)}%`,
        data_points: validResults.length
      },
      alerts,
      recommendations
    };
  }

  calculateAverage(results, path) {
    const values = results.map(r => this.getNestedValue(r, path)).filter(v => typeof v === 'number');
    return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  extractResourceValue(resource) {
    if (!resource) return null;
    
    // Simple resource parsing (e.g., "100m" -> 0.1, "512Mi" -> 512)
    if (typeof resource === 'string') {
      if (resource.endsWith('m')) {
        return parseInt(resource) / 1000;
      }
      if (resource.endsWith('Mi')) {
        return parseInt(resource);
      }
      return resource;
    }
    
    return resource;
  }

  generateDashboardUrl(appName, namespace) {
    const grafanaUrl = process.env.GRAFANA_URL || 'http://grafana.monitoring.svc.cluster.local';
    return `${grafanaUrl}/d/kubernetes-deployment?var-deployment=${appName}&var-namespace=${namespace}`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new MonitorAgent();
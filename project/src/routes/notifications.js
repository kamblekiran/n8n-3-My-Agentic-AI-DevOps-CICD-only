const express = require('express');
const router = express.Router();
const axios = require('axios');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

// Slack notification endpoint
router.post('/slack', async (req, res) => {
  try {
    const { channel, message, deployment_url } = req.body;
    
    const slackPayload = {
      channel: channel || '#devops-alerts',
      text: message,
      attachments: deployment_url ? [{
        color: 'good',
        fields: [{
          title: 'Deployment URL',
          value: deployment_url,
          short: false
        }]
      }] : []
    };

    if (process.env.SLACK_WEBHOOK_URL) {
      await axios.post(process.env.SLACK_WEBHOOK_URL, slackPayload);
      logger.info('Slack notification sent successfully');
    } else {
      logger.warn('Slack webhook URL not configured, notification skipped');
    }

    res.json({
      status: 'success',
      message: 'Notification sent'
    });
  } catch (error) {
    logger.error('Slack notification failed:', error);
    res.status(500).json({
      error: 'Notification failed',
      message: error.message
    });
  }
});

// Teams notification endpoint
router.post('/teams', async (req, res) => {
  try {
    const { message, deployment_url } = req.body;
    
    const teamsPayload = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      "themeColor": "0076D7",
      "summary": "DevOps Pipeline Notification",
      "sections": [{
        "activityTitle": "DevOps Pipeline Update",
        "activitySubtitle": message,
        "facts": deployment_url ? [{
          "name": "Deployment URL",
          "value": deployment_url
        }] : []
      }]
    };

    if (process.env.TEAMS_WEBHOOK_URL) {
      await axios.post(process.env.TEAMS_WEBHOOK_URL, teamsPayload);
      logger.info('Teams notification sent successfully');
    } else {
      logger.warn('Teams webhook URL not configured, notification skipped');
    }

    res.json({
      status: 'success',
      message: 'Notification sent'
    });
  } catch (error) {
    logger.error('Teams notification failed:', error);
    res.status(500).json({
      error: 'Notification failed',
      message: error.message
    });
  }
});

module.exports = router;
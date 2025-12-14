// server.js
const express = require('express');
const admin = require('firebase-admin');
const EventEmitter = require('events');
require('dotenv').config();
// Initialize Express
const app = express();
app.use(express.json());

// Logging utility for consistent formatted logs
const formatLog = (level, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };
  return JSON.stringify(logEntry);
};

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(formatLog('INFO', 'Incoming Request', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userId: req.body.userId || 'N/A'
  }));

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(formatLog('INFO', 'Request Completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`
    }));
  });

  next();
});

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    project_id: serviceAccount.project_id,
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key.replace(/\\n/g, '\n')
  })
});;

// Initialize Firestore
const db = admin.firestore();
const devicesCollection = db.collection('devices');
const webhooksCollection = db.collection('webhooks');

/**
 * Register device token
 * POST /register-device
 * Body: {
 *   deviceToken: string,
 *   userId: string,
 *   platform: 'android' | 'ios'
 * }
 */
app.post('/register-device', async (req, res) => {
  try {
    const { deviceToken, userId, platform } = req.body;

    if (!deviceToken || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing deviceToken or userId'
      });
    }

    // Save to Firestore
    await devicesCollection.doc(userId).set({
      token: deviceToken,
      platform: platform || 'unknown',
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(formatLog('INFO', 'Device Registered Successfully', {
      userId,
      platform,
      timestamp: new Date().toISOString()
    }));

    res.status(200).json({
      success: true,
      message: 'Device token registered successfully'
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Device Registration Failed', {
      userId: req.body.userId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Helper function to poll Firebase for log creation
 * @param {string} userId - User ID
 * @param {string} serverId - Server ID to search for
 * @param {number} maxAttempts - Maximum polling attempts (default: 10)
 * @param {number} intervalMs - Interval between polls in ms (default: 1000)
 * @returns {Promise<object|null>} - Log data if found, null otherwise
 */
async function pollForLog(userId, serverId, maxAttempts = 10, intervalMs = 1000) {
  const logsCollection = db.collection('users').doc(userId).collection('logs');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const logQuery = await logsCollection.where('serverId', '==', serverId).limit(1).get();
      
      if (!logQuery.empty) {
        const logDoc = logQuery.docs[0];
        const logData = logDoc.data();
        
        console.log(formatLog('INFO', 'Log Found After Polling', {
          userId,
          serverId,
          logId: logDoc.id,
          status: logData.status,
          attempt: attempt,
          totalTime: `${attempt * intervalMs}ms`
        }));
        
        return {
          id: logDoc.id,
          recipient: logData.recipient,
          message: logData.message,
          status: logData.status,
          timestamp: logData.timestamp.toDate ? logData.timestamp.toDate().toISOString() : logData.timestamp,
          type: logData.type,
          serverId: logData.serverId
        };
      }
      
      // Wait before next attempt (except on last attempt)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    } catch (error) {
      console.error(formatLog('ERROR', 'Error During Log Polling', {
        userId,
        serverId,
        attempt: attempt,
        error: error.message
      }));
    }
  }
  
  console.log(formatLog('WARN', 'Log Not Found After Polling', {
    userId,
    serverId,
    attempts: maxAttempts,
    totalTime: `${maxAttempts * intervalMs}ms`
  }));
  
  return null;
}

/**
 * Send SMS by userId (lookup token automatically)
 * POST /send-sms
 * Body: {
 *   userId: string,
 *   phoneNumber: string,
 *   message: string,
 *   waitForLog: boolean (optional, default: true) - Wait for log creation
 *   maxWaitTime: number (optional, default: 10) - Max seconds to wait for log
 *   delaySeconds: number (optional, default: 5) - Delay between SMS sends on device
 * }
 */
app.post('/send-sms', async (req, res) => {
  try {
    const { userId, phoneNumber, message, waitForLog = true, maxWaitTime = 10, delaySeconds = 5 } = req.body;

    if (!userId || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get device token from Firestore
    const deviceDoc = await devicesCollection.doc(userId).get();
    
    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Device token not found for user'
      });
    }

    const deviceData = deviceDoc.data();
    const deviceToken = deviceData.token;

    // Generate unique serverId
    const serverId = `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Send FCM notification with serverId and delay
    const fcmMessage = {
      token: deviceToken,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString(),
        server_id: serverId,
        delay_seconds: delaySeconds.toString()
      },
      android: {
        priority: 'high'
      }
    };

    const fcmResponse = await admin.messaging().send(fcmMessage);

    console.log(formatLog('INFO', 'FCM Message Sent', {
      userId,
      phoneNumber: phoneNumber.slice(-4),
      messageId: fcmResponse,
      messageLength: message.length,
      serverId,
      delaySeconds
    }));

    // If waitForLog is true, poll for log creation
    let logData = null;
    let status = 'pending';
    
    if (waitForLog) {
      const maxAttempts = Math.max(1, Math.min(maxWaitTime, 30)); // Cap at 30 seconds
      logData = await pollForLog(userId, serverId, maxAttempts, 1000);
      
      if (logData) {
        status = logData.status;
      }
    }

    const responseData = {
      success: true,
      messageId: fcmResponse,
      userId: userId,
      serverId: serverId,
      status: status
    };


    console.log(formatLog('INFO', 'SMS Request Completed', {
      userId,
      serverId,
      status,
      logFound: !!logData,
      phoneNumber: phoneNumber.slice(-4)
    }));

    res.status(200).json(responseData);

  } catch (error) {
    console.error(formatLog('ERROR', 'SMS Send Failed', {
      userId: req.body.userId,
      phoneNumber: req.body.phoneNumber,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Event Emitter for SMS triggers
class SMSEventEmitter extends EventEmitter {}
const smsEmitter = new SMSEventEmitter();

// Listen for SMS send events (your custom logic goes here)
smsEmitter.on('sendSMS', async (data) => {
  console.log('SMS Event Triggered:', data);
  
  // TODO: Add your custom logic here
  // - Database logging
  // - Validation
  // - Rate limiting checks
  // - Analytics
});

/**
 * Send FCM notification to a specific device
 * POST /send-notification
 * Body: {
 *   userId: string,
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-notification', async (req, res) => {
  try {
    const { userId, phoneNumber, message } = req.body;

    if (!userId || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get device token from Firestore
    const deviceDoc = await devicesCollection.doc(userId).get();
    
    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Device token not found for user'
      });
    }

    const deviceData = deviceDoc.data();
    const deviceToken = deviceData.token;

    // Emit event before sending
    smsEmitter.emit('sendSMS', {
      deviceToken,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    // Prepare FCM message with data payload only (for background handling)
    const fcmMessage = {
      token: deviceToken,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        notification: {
          title: 'SMS Send Request',
          body: `Sending SMS to ${phoneNumber}`,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      }
    };

    // Send message via FCM
    const response = await admin.messaging().send(fcmMessage);

    console.log(formatLog('INFO', 'Notification Sent Successfully', {
      userId,
      phoneNumber: phoneNumber.slice(-4),
      messageId: response,
      hasNotification: true
    }));

    res.status(200).json({
      success: true,
      messageId: response,
      data: {
        phoneNumber,
        message
      }
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Notification Send Failed', {
      userId: req.body.userId,
      phoneNumber: req.body.phoneNumber,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send FCM notification to multiple devices
 * POST /send-notification-multiple
 * Body: {
 *   userIds: string[],
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-notification-multiple', async (req, res) => {
  try {
    const { userIds, phoneNumber, message } = req.body;

    if (!userIds || !Array.isArray(userIds) || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields or userIds is not an array'
      });
    }

    // Batch get device tokens from Firestore
    const devicePromises = userIds.map(userId => 
      devicesCollection.doc(userId).get()
    );
    const deviceDocs = await Promise.all(devicePromises);

    const tokens = [];
    deviceDocs.forEach((doc, idx) => {
      if (doc.exists) {
        tokens.push(doc.data().token);
      } else {
        console.warn(`Device token not found for userId: ${userIds[idx]}`);
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No valid device tokens found for provided userIds'
      });
    }

    // Emit event
    smsEmitter.emit('sendSMS', {
      deviceTokens: tokens,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    // Prepare multicast message
    const multicastMessage = {
      tokens: tokens,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().sendEachForMulticast(multicastMessage);

    console.log(formatLog('INFO', 'Multicast Message Sent', {
      userCount: userIds.length,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      phoneNumber: phoneNumber.slice(-4)
    }));

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses.map((resp, idx) => ({
        token: tokens[idx],
        success: resp.success,
        messageId: resp.messageId,
        error: resp.error?.message
      }))
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Multicast Send Failed', {
      userIds: req.body.userIds,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send to a topic (for broadcasting)
 * POST /send-to-topic
 * Body: {
 *   topic: string,
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-to-topic', async (req, res) => {
  try {
    const { topic, phoneNumber, message } = req.body;

    if (!topic || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: topic, phoneNumber, message'
      });
    }

    smsEmitter.emit('sendSMS', {
      topic,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    const topicMessage = {
      topic: topic,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().send(topicMessage);

    console.log(formatLog('INFO', 'Topic Message Sent', {
      topic,
      messageId: response,
      phoneNumber: phoneNumber.slice(-4)
    }));

    res.status(200).json({
      success: true,
      messageId: response
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Topic Message Send Failed', {
      topic: req.body.topic,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Subscribe device to a topic
 * POST /subscribe-to-topic
 * Body: {
 *   userIds: string[],
 *   topic: string
 * }
 */
app.post('/subscribe-to-topic', async (req, res) => {
  try {
    const { userIds, topic } = req.body;

    if (!userIds || !Array.isArray(userIds) || !topic) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields or userIds is not an array'
      });
    }

    // Batch get device tokens from Firestore
    const devicePromises = userIds.map(userId => 
      devicesCollection.doc(userId).get()
    );
    const deviceDocs = await Promise.all(devicePromises);

    const tokens = [];
    deviceDocs.forEach((doc, idx) => {
      if (doc.exists) {
        tokens.push(doc.data().token);
      } else {
        console.warn(`Device token not found for userId: ${userIds[idx]}`);
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No valid device tokens found for provided userIds'
      });
    }

    const response = await admin.messaging().subscribeToTopic(tokens, topic);

    console.log(formatLog('INFO', 'Topic Subscription Successful', {
      topic,
      userCount: userIds.length,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount
    }));

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      errors: response.errors
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Topic Subscription Failed', {
      topic: req.body.topic,
      userIds: req.body.userIds,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Unregister device token
 * POST /unregister-device
 * Body: {
 *   userId: string
 * }
 */
app.post('/unregister-device', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    await devicesCollection.doc(userId).delete();

    console.log(formatLog('INFO', 'Device Unregistered Successfully', {
      userId,
      timestamp: new Date().toISOString()
    }));

    res.status(200).json({
      success: true,
      message: 'Device token unregistered successfully'
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Device Unregistration Failed', {
      userId: req.body.userId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Register webhook URL for user
 * POST /register-webhook
 * Body: {
 *   userId: string,
 *   webhookUrl: string,
 *   events: string[] ('sms:sent', 'sms:received', etc.)
 * }
 */
app.post('/register-webhook', async (req, res) => {
  try {
    const { userId, webhookUrl, events } = req.body;

    if (!userId || !webhookUrl || !events || !Array.isArray(events)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, webhookUrl, events (array)'
      });
    }

    // Validate webhook URL format
    try {
      new URL(webhookUrl);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhookUrl format'
      });
    }

    // Create unique webhook ID
    const webhookId = `${userId}_${Date.now()}`;

    // Save webhook to Firestore
    await webhooksCollection.doc(webhookId).set({
      userId: userId,
      webhookUrl: webhookUrl,
      events: events,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(formatLog('INFO', 'Webhook Registered Successfully', {
      webhookId,
      userId,
      webhookUrl: webhookUrl.substring(0, 50) + '...',
      events,
      timestamp: new Date().toISOString()
    }));

    res.status(200).json({
      success: true,
      message: 'Webhook registered successfully',
      webhookId: webhookId
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Webhook Registration Failed', {
      userId: req.body.userId,
      webhookUrl: req.body.webhookUrl,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Unregister webhook URL
 * POST /unregister-webhook
 * Body: {
 *   webhookId: string
 * }
 */
app.post('/unregister-webhook', async (req, res) => {
  try {
    const { webhookId } = req.body;

    if (!webhookId) {
      return res.status(400).json({
        success: false,
        error: 'Missing webhookId'
      });
    }

    const webhookDoc = await webhooksCollection.doc(webhookId).get();
    if (!webhookDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Webhook not found'
      });
    }

    await webhooksCollection.doc(webhookId).delete();

    console.log(formatLog('INFO', 'Webhook Unregistered Successfully', {
      webhookId,
      userId: webhookDoc.data().userId,
      timestamp: new Date().toISOString()
    }));

    res.status(200).json({
      success: true,
      message: 'Webhook unregistered successfully'
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Webhook Unregistration Failed', {
      webhookId: req.body.webhookId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get user's registered webhooks
 * GET /webhooks/:userId
 */
app.get('/webhooks/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    const query = webhooksCollection.where('userId', '==', userId).where('active', '==', true);
    const snapshot = await query.get();

    const webhooks = [];
    snapshot.forEach(doc => {
      webhooks.push({
        webhookId: doc.id,
        ...doc.data()
      });
    });

    res.status(200).json({
      success: true,
      count: webhooks.length,
      webhooks: webhooks
    });

    console.log(formatLog('INFO', 'Webhooks Retrieved Successfully', {
      userId,
      webhookCount: webhooks.length,
      timestamp: new Date().toISOString()
    }));

  } catch (error) {
    console.error(formatLog('ERROR', 'Webhook Fetch Failed', {
      userId: req.params.userId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Helper function to send webhook logs to registered URLs
 * @param {string} userId - User ID
 * @param {object} logData - Log data object
 * @param {string} eventType - Event type ('sms:sent', 'sms:received', etc.)
 */
async function sendWebhookLogs(userId, logData, eventType) {
  try {
    const query = webhooksCollection
      .where('userId', '==', userId)
      .where('active', '==', true);
    
    const snapshot = await query.get();

    if (snapshot.empty) {
      console.log(formatLog('WARN', 'No Webhooks Found for User', {
        userId,
        eventType,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    console.log(formatLog('INFO', 'Processing Webhook Delivery', {
      userId,
      eventType,
      webhookCount: snapshot.size,
      logId: logData.id
    }));

    const webhookRequests = [];

    snapshot.forEach(doc => {
      const webhook = doc.data();

      // Check if webhook is subscribed to this event
      if (webhook.events.includes(eventType)) {
        const payload = {
          event: eventType,
          timestamp: new Date().toISOString(),
          data: logData
        };

        // Send POST request to webhook URL with timeout
        const request = fetch(webhook.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': eventType,
            'X-Webhook-Id': doc.id
          },
          body: JSON.stringify(payload)
        })
          .then(response => {
            if (!response.ok) {
              console.warn(formatLog('WARN', 'Webhook Delivery Failed', {
                webhookId: doc.id,
                url: webhook.webhookUrl.substring(0, 50) + '...',
                statusCode: response.status,
                eventType,
                logId: logData.id
              }));
            } else {
              console.log(formatLog('INFO', 'Webhook Delivered Successfully', {
                webhookId: doc.id,
                url: webhook.webhookUrl.substring(0, 50) + '...',
                statusCode: response.status,
                eventType,
                logId: logData.id
              }));
            }
          })
          .catch(error => {
            console.error(formatLog('ERROR', 'Webhook Delivery Error', {
              webhookId: doc.id,
              url: webhook.webhookUrl.substring(0, 50) + '...',
              error: error.message,
              eventType,
              logId: logData.id
            }));
          });

        webhookRequests.push(request);
      }
    });

    // Fire and forget - don't wait for all webhooks to complete
    Promise.all(webhookRequests).catch(error => {
      console.error('Error in webhook batch processing:', error);
    });

  } catch (error) {
    console.error('Error in sendWebhookLogs:', error);
  }
}

/**
 * Send SMS log to registered webhooks
 * POST /send-webhook-logs
 * Body: {
 *   userId: string,
 *   id: string,
 *   recipient: string,
 *   message: string,
 *   status: 'sent' | 'delivered' | 'failed' | 'received',
 *   type: 'sms:sent' | 'sms:received',
 *   timestamp: string (ISO 8601)
 * }
 */
app.post('/send-webhook-logs', async (req, res) => {
  try {
    const { userId, id, recipient, message, status, type, timestamp } = req.body;

    if (!userId || !id || !recipient || !message || !status || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, id, recipient, message, status, type'
      });
    }

    // Validate event type
    const validEventTypes = ['sms:sent', 'sms:received'];
    if (!validEventTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validEventTypes.join(', ')}`
      });
    }

    const logData = {
      id: id,
      recipient: recipient,
      message: message,
      status: status,
      timestamp: timestamp || new Date().toISOString(),
      type: type
    };

    // Send to webhooks asynchronously
    sendWebhookLogs(userId, logData, type);

    res.status(202).json({
      success: true,
      message: 'Webhook logs queued for delivery',
      data: logData
    });

  } catch (error) {
    console.error('Error sending webhook logs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get SMS log by ID or serverId
 * GET /get-sms
 * Query params:
 *   - userId: string (required)
 *   - logId: string (optional) - Get log by document ID
 *   - serverId: string (optional) - Get log by serverId
 * Note: Must provide either logId or serverId
 */
app.get('/get-sms', async (req, res) => {
  try {
    const { userId, logId, serverId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId parameter'
      });
    }

    if (!logId && !serverId) {
      return res.status(400).json({
        success: false,
        error: 'Must provide either logId or serverId parameter'
      });
    }

    const logsCollection = db.collection('users').doc(userId).collection('logs');

    // Search by document ID
    if (logId) {
      const logDoc = await logsCollection.doc(logId).get();

      if (!logDoc.exists) {
        console.log(formatLog('WARN', 'Log Not Found by ID', {
          userId,
          logId,
          timestamp: new Date().toISOString()
        }));

        return res.status(404).json({
          success: false,
          error: 'Log not found with provided logId'
        });
      }

      const logData = logDoc.data();

      console.log(formatLog('INFO', 'Log Retrieved by ID', {
        userId,
        logId,
        serverId: logData.serverId,
        timestamp: new Date().toISOString()
      }));

      return res.status(200).json({
        success: true,
        log: {
          id: logDoc.id,
          recipient: logData.recipient,
          message: logData.message,
          status: logData.status,
          timestamp: logData.timestamp.toDate ? logData.timestamp.toDate().toISOString() : logData.timestamp,
          type: logData.type,
          serverId: logData.serverId
        }
      });
    }

    // Search by serverId
    if (serverId) {
      const logQuery = await logsCollection.where('serverId', '==', serverId).limit(1).get();

      if (logQuery.empty) {
        console.log(formatLog('WARN', 'Log Not Found by serverId', {
          userId,
          serverId,
          timestamp: new Date().toISOString()
        }));

        return res.status(404).json({
          success: false,
          error: 'Log not found with provided serverId'
        });
      }

      const logDoc = logQuery.docs[0];
      const logData = logDoc.data();

      console.log(formatLog('INFO', 'Log Retrieved by serverId', {
        userId,
        serverId,
        logId: logDoc.id,
        timestamp: new Date().toISOString()
      }));

      return res.status(200).json({
        success: true,
        log: {
          id: logDoc.id,
          recipient: logData.recipient,
          message: logData.message,
          status: logData.status,
          timestamp: logData.timestamp.toDate ? logData.timestamp.toDate().toISOString() : logData.timestamp,
          type: logData.type,
          serverId: logData.serverId
        }
      });
    }

  } catch (error) {
    console.error(formatLog('ERROR', 'Get SMS Failed', {
      userId: req.query.userId,
      logId: req.query.logId,
      serverId: req.query.serverId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get SMS logs for a user
 * GET /users/:userId/logs
 * Optional query params:
 *   - logId: Get specific log by ID
 *   - limit: Number of logs to return (default: 100)
 */
app.get('/users/:userId/logs', async (req, res) => {
  try {
    const { userId } = req.params;
    const { logId, limit } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    const logsCollection = db.collection('users').doc(userId).collection('logs');

    // If logId is provided, fetch specific log
    if (logId) {
      const logDoc = await logsCollection.doc(logId).get();

      if (!logDoc.exists) {
        console.log(formatLog('WARN', 'Log Not Found', {
          userId,
          logId,
          timestamp: new Date().toISOString()
        }));

        return res.status(404).json({
          success: false,
          error: 'Log not found'
        });
      }

      const logData = logDoc.data();

      console.log(formatLog('INFO', 'Log Retrieved Successfully', {
        userId,
        logId,
        timestamp: new Date().toISOString()
      }));

      return res.status(200).json({
        success: true,
        log: {
          id: logDoc.id,
          recipient: logData.recipient,
          message: logData.message,
          status: logData.status,
          timestamp: logData.timestamp.toDate ? logData.timestamp.toDate().toISOString() : logData.timestamp,
          type: logData.type
        }
      });
    }

    // Fetch all logs for user, ordered by timestamp descending
    let query = logsCollection.orderBy('timestamp', 'desc');

    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        query = query.limit(limitNum);
      }
    } else {
      query = query.limit(100); // Default limit
    }

    const snapshot = await query.get();

    const logs = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        recipient: data.recipient,
        message: data.message,
        status: data.status,
        timestamp: data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp,
        type: data.type
      };
    });

    console.log(formatLog('INFO', 'Logs Retrieved Successfully', {
      userId,
      logCount: logs.length,
      timestamp: new Date().toISOString()
    }));

    res.status(200).json({
      success: true,
      count: logs.length,
      logs: logs
    });

  } catch (error) {
    console.error(formatLog('ERROR', 'Log Fetch Failed', {
      userId: req.params.userId,
      logId: req.query.logId,
      error: error.message,
      stack: error.stack
    }));
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FCM Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Export for testing
module.exports = { app, smsEmitter };
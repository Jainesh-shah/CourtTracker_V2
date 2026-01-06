const admin = require('firebase-admin');
const logger = require('../config/logger');
const { NotificationLog } = require('../models');
const path = require('path');
const fs = require('fs');

let firebaseApp;

/* ==================== INIT ==================== */

const initializeFirebase = () => {
  try {
    if (firebaseApp) return firebaseApp;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccountPath = path.isAbsolute(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
        ? process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        : path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.FIREBASE_CLIENT_EMAIL
    ) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL
        })
      });
    } else {
      logger.warn('Firebase not configured');
      return null;
    }

    return firebaseApp;
  } catch (err) {
    logger.error('Firebase init failed', err);
    return null;
  }
};

/* ==================== SEND ==================== */

const sendNotification = async (fcmToken, notification, data = {}) => {
  const app = initializeFirebase();
  if (!app) return { success: false };

  const message = {
    token: fcmToken,
    notification,
    data: {
      ...data,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'court_alerts',
        sound: 'default'
      }
    }
  };

  const response = await admin.messaging().send(message);
  return { success: true, messageId: response };
};

/* ==================== CASE ALERT ==================== */

const sendCaseAlert = async (deviceId, fcmToken, caseNumber, alertType, details = {}) => {
  let notification;

  switch (alertType) {
    case 'in_session':
      notification = {
        title: `⚖️ Case Started`,
        body: `${caseNumber} is now IN SESSION in Court ${details.courtNumber}`
      };
      break;

    case 'completed':
      notification = {
        title: `✅ Case Completed`,
        body: `${caseNumber} hearing has ended`
      };
      break;

    default:
      return;
  }

  const result = await sendNotification(fcmToken, notification, {
    caseNumber,
    courtNumber: details.courtNumber || '',
    streamUrl: details.streamUrl || ''
  });

  await NotificationLog.create({
    deviceId,
    caseNumber,
    notificationType: alertType,
    title: notification.title,
    message: notification.body,
    data: details,
    success: result.success
  });

  return result;
};

module.exports = {
  initializeFirebase,
  sendNotification,
  sendCaseAlert
};

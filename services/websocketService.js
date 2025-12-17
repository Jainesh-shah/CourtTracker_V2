const socketIO = require('socket.io');
const logger = require('../config/logger');
const { Watchlist } = require('../models');

let io;

function initializeWebSocket(server) {
  io = socketIO(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    logger.info(`WebSocket client connected: ${socket.id}`);

    // Client subscribes to their watchlist updates
    socket.on('subscribe', async (data) => {
      try {
        const { deviceId } = data;
        
        if (!deviceId) {
          socket.emit('error', { message: 'deviceId is required' });
          return;
        }

        // Join room for this device
        socket.join(`device_${deviceId}`);
        logger.info(`Device ${deviceId} subscribed to updates`);
        
        socket.emit('subscribed', { 
          message: 'Successfully subscribed to updates',
          deviceId 
        });
      } catch (error) {
        logger.error('Error in subscribe:', error);
        socket.emit('error', { message: error.message });
      }
    });

    // Client subscribes to specific case updates
    socket.on('subscribe_case', async (data) => {
      try {
        const { caseNumber } = data;
        
        if (!caseNumber) {
          socket.emit('error', { message: 'caseNumber is required' });
          return;
        }

        socket.join(`case_${caseNumber}`);
        logger.info(`Client ${socket.id} subscribed to case ${caseNumber}`);
        
        socket.emit('case_subscribed', { 
          message: 'Successfully subscribed to case updates',
          caseNumber 
        });
      } catch (error) {
        logger.error('Error in subscribe_case:', error);
        socket.emit('error', { message: error.message });
      }
    });

    // Unsubscribe
    socket.on('unsubscribe', (data) => {
      const { deviceId } = data;
      if (deviceId) {
        socket.leave(`device_${deviceId}`);
        logger.info(`Device ${deviceId} unsubscribed`);
      }
    });

    socket.on('disconnect', () => {
      logger.info(`WebSocket client disconnected: ${socket.id}`);
    });
  });

  logger.info('WebSocket server initialized');
  return io;
}

// Broadcast court data update to all connected clients
function broadcastCourtUpdate(courtData) {
  if (!io) return;
  
  io.emit('court_update', {
    timestamp: new Date().toISOString(),
    summary: courtData.summary,
    courts: courtData.courts
  });
}

// Send update to specific device
function sendDeviceUpdate(deviceId, data) {
  if (!io) return;
  
  io.to(`device_${deviceId}`).emit('watchlist_update', {
    timestamp: new Date().toISOString(),
    ...data
  });
}

// Send update for specific case
function sendCaseUpdate(caseNumber, data) {
  if (!io) return;
  
  io.to(`case_${caseNumber}`).emit('case_update', {
    timestamp: new Date().toISOString(),
    caseNumber,
    ...data
  });
}

// Notify all watchers of a case
async function notifyWatchers(caseNumber, updateData) {
  if (!io) return;

  try {
    const watchers = await Watchlist.find({ caseNumber, isActive: true });
    
    watchers.forEach(watcher => {
      sendDeviceUpdate(watcher.deviceId, {
        caseNumber,
        ...updateData
      });
    });

    // Also send to case-specific room
    sendCaseUpdate(caseNumber, updateData);
    
    logger.info(`Notified ${watchers.length} watchers for case ${caseNumber}`);
  } catch (error) {
    logger.error('Error notifying watchers:', error);
  }
}

module.exports = {
  initializeWebSocket,
  broadcastCourtUpdate,
  sendDeviceUpdate,
  sendCaseUpdate,
  notifyWatchers
};
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');
const logger = require('./config/logger');
const apiRoutes = require('./routes/api');
const { initializeWebSocket } = require('./services/websocketService');
const { initializeFirebase } = require('./services/fcmService');
const {
  startRealtimeScraper,
  startSnapshotScheduler,
  startCleanupScheduler,
  getScraperStatus
} = require('./services/cronService');

/* -------------------- APP SETUP -------------------- */

const app = express();
const server = http.createServer(app);

// Trust proxy (Render / Nginx / Cloudflare)
app.set('trust proxy', 1);

/* -------------------- SECURITY MIDDLEWARE -------------------- */

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- RATE LIMITING -------------------- */

// API limiter only (NOT websocket, NOT scraper status)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api', apiLimiter);

/* -------------------- ROUTES -------------------- */

app.use('/api', apiRoutes);

// Health endpoint (real signal, not vanity)
app.get('/api/health', (req, res) => {
  const scraper = getScraperStatus();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    scraper,
    timestamp: new Date().toISOString()
  });
});

// Scraper status (internal visibility)
app.get('/api/scraper/status', (req, res) => {
  res.json({ success: true, ...getScraperStatus() });
});

// Root
app.get('/', (_, res) => {
  res.json({
    service: 'Court Tracker Backend',
    version: '2.1.0',
    status: 'running'
  });
});

/* -------------------- ERROR HANDLING -------------------- */

app.use((err, req, res, next) => {
  logger.error('Unhandled request error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

/* -------------------- STARTUP -------------------- */

let shutdownInitiated = false;

async function startServer() {
  try {
    await connectDB();
    logger.info('✓ MongoDB connected');

    initializeFirebase();
    logger.info('✓ Firebase initialized');

    initializeWebSocket(server);
    logger.info('✓ WebSocket initialized');

    // 🚨 IMPORTANT: run scrapers ONLY in primary instance
    if (process.env.ENABLE_SCRAPER !== 'false') {
      startRealtimeScraper();
      startSnapshotScheduler();
      startCleanupScheduler();
      logger.info('✓ Schedulers started');
    } else {
      logger.warn('Scraper disabled for this instance');
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(`
══════════════════════════════════════════════
🏛️  Court Tracker Backend
──────────────────────────────────────────────
HTTP     : http://localhost:${PORT}
WebSocket: ws://localhost:${PORT}
Env      : ${process.env.NODE_ENV || 'development'}
Scraper  : ${process.env.ENABLE_SCRAPER !== 'false' ? 'ENABLED' : 'DISABLED'}
══════════════════════════════════════════════
      `);
    });
  } catch (err) {
    logger.error('Startup failure:', err);
    process.exit(1);
  }
}

/* -------------------- GRACEFUL SHUTDOWN -------------------- */

async function shutdown(signal) {
  if (shutdownInitiated) return;
  shutdownInitiated = true;

  logger.warn(`${signal} received — shutting down gracefully`);

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    logger.error('Force shutdown (timeout)');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});

/* -------------------- BOOT -------------------- */

startServer();

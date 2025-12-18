const mongoose = require('mongoose');

//
// ==================== Device Model ====================
//
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  fcmToken: { type: String, required: true },
  deviceInfo: {
    model: String,
    osVersion: String,
    appVersion: String
  },
  isActive: { type: Boolean, default: true },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

deviceSchema.index({ isActive: 1, lastSeen: -1 });


//
// ==================== Watchlist Model ====================
//
const watchlistSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  caseNumber: { type: String, required: true, index: true },
  courthouse: { type: String, default: 'Gujarat High Court' },
  nickname: { type: String, default: null },

  notificationSettings: {
    earlyWarning: { type: Boolean, default: true },
    approaching: { type: Boolean, default: true },
    inSession: { type: Boolean, default: true },
    completed: { type: Boolean, default: true }
  },

  isActive: { type: Boolean, default: true },

  // ⚠️ Deprecated (kept only for backward compatibility)
  lastNotificationSent: {
    type: String,
    enum: ['none', 'early_warning', 'approaching', 'in_session', 'completed'],
    default: 'none'
  },

  lastNotificationTime: Date,

  // ✅ STATE MACHINE FIELDS (CRITICAL)
  lastSeenStatus: {
    type: String,
    enum: ['FAR', 'NEAR', 'VERY_NEAR', 'NEXT', 'LIVE', 'COMPLETED'],
    default: null
  },
  lastSeenCourt: { type: String, default: null },
  lastSeenPosition: { type: Number, default: null },

  // ✅ Consecutive miss counter
  missCount: { type: Number, default: 0 },

  // ✅ Confidence for alerts (future-proof)
  confidenceScore: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  addedAt: { type: Date, default: Date.now }
}, { timestamps: true });

watchlistSchema.index({ deviceId: 1, caseNumber: 1 }, { unique: true });
watchlistSchema.index({ caseNumber: 1, isActive: 1 });


//
// ==================== Case History Model ====================
//
const caseHistorySchema = new mongoose.Schema({
  caseNumber: { type: String, required: true, index: true },
  courthouse: { type: String, default: 'Gujarat High Court' },
  courtNumber: String,
  judgeName: String,
  benchType: String,
  caseList: String,
  status: {
    type: String,
    enum: ['IN_SESSION', 'SITTING_OVER', 'RECESS', 'COMPLETED', 'UNKNOWN']
  },
  sessionStartTime: Date,
  sessionEndTime: Date,
  duration: Number,
  position: Number,
  gsrno: String,
  streamUrl: String,
  isLive: Boolean,
  scrapedAt: Date,

  // Optional but powerful
  eventType: {
    type: String,
    enum: ['STATUS_CHANGE', 'POSITION_CHANGE', 'COURT_CHANGE'],
    default: 'STATUS_CHANGE'
  }
}, { timestamps: true });

// ✅ Delta-only uniqueness (prevents history spam)
caseHistorySchema.index(
  { caseNumber: 1, status: 1, position: 1, courtNumber: 1, scrapedAt: 1 },
  { unique: true }
);

caseHistorySchema.index({ caseNumber: 1, createdAt: -1 });
caseHistorySchema.index({ courthouse: 1, createdAt: -1 });


//
// ==================== Court Snapshot Model ====================
//
const courtSnapshotSchema = new mongoose.Schema({
  courthouse: { type: String, default: 'Gujarat High Court' },
  snapshotTime: { type: Date, default: Date.now, index: true },

  summary: {
    total: Number,
    live: Number,
    active: Number,
    inSession: Number,
    sittingOver: Number,
    recess: Number
  },

  courts: [{
    courtNumber: String,
    judgeName: String,
    caseNumber: String,
    status: String,
    isLive: Boolean,

    // ✅ Queue intelligence
    queueLength: Number,
    currentCase: String
  }]
}, { timestamps: true });

// TTL: 90 days
courtSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });


//
// ==================== Case Statistics Model ====================
//
const caseStatisticsSchema = new mongoose.Schema({
  caseNumber: { type: String, required: true, unique: true, index: true },
  courthouse: String,
  firstSeen: Date,
  lastSeen: Date,
  totalAppearances: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
  averageDuration: { type: Number, default: 0 },
  courts: [String],
  judges: [String],
  statusHistory: [{
    status: String,
    timestamp: Date,
    courtNumber: String,
    queuePosition: Number
  }],
  estimatedWaitTime: Number,
  watchCount: { type: Number, default: 0 }
}, { timestamps: true });

caseStatisticsSchema.index({ lastSeen: -1 });
caseStatisticsSchema.index({ watchCount: -1 });

const CurrentCourtSchema = new mongoose.Schema({
  courtCode: { type: String, required: true, unique: true },
  data: { type: Object, required: true },
  updatedAt: { type: Date, default: Date.now }
});


//
// ==================== Notification Log Model ====================
//
const notificationLogSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  caseNumber: { type: String, required: true, index: true },
  notificationType: {
    type: String,
    enum: ['early_warning', 'approaching', 'in_session', 'completed', 'error'],
    required: true
  },
  title: String,
  message: String,
  data: mongoose.Schema.Types.Mixed,
  sentAt: { type: Date, default: Date.now },
  success: { type: Boolean, default: true },
  error: String,
  courtNumber: String,
  position: Number
}, { timestamps: true });

// ✅ De-duplication index (anti-spam / race-safe)
notificationLogSchema.index(
  { deviceId: 1, caseNumber: 1, notificationType: 1, courtNumber: 1 },
  { unique: true }
);

// TTL: 30 days
notificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });


//
// ==================== EXPORT ====================
//
module.exports = {
  Device: mongoose.model('Device', deviceSchema),
  Watchlist: mongoose.model('Watchlist', watchlistSchema),
  CaseHistory: mongoose.model('CaseHistory', caseHistorySchema),
  CourtSnapshot: mongoose.model('CourtSnapshot', courtSnapshotSchema),
  CaseStatistics: mongoose.model('CaseStatistics', caseStatisticsSchema),
  NotificationLog: mongoose.model('NotificationLog', notificationLogSchema),
  CurrentCourt: mongoose.model('CurrentCourt', CurrentCourtSchema)
};
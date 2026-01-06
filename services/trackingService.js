const { Watchlist, CaseHistory, CaseStatistics, Device } = require('../models');
const { sendCaseAlert } = require('./fcmService');
const logger = require('../config/logger');

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const lastCourtState = new Map();

/* ==================== HELPERS ==================== */

function now() {
  return Date.now();
}

function cooldownPassed(lastTime) {
  return !lastTime || now() - new Date(lastTime).getTime() > COOLDOWN_MS;
}

/**
 * INTERNAL STATE → ALERT TYPE
 */
const STATE_TO_ALERT = {
  FAR: 'early_warning',
  NEAR: 'early_warning',
  VERY_NEAR: 'approaching',
  NEXT: 'approaching',
  IN_SESSION: 'in_session',
  COMPLETED: 'completed'
};

/**
 * ALERT TYPE → USER SETTING KEY
 */
const ALERT_TO_SETTING = {
  early_warning: 'earlyWarning',
  approaching: 'approaching',
  in_session: 'inSession',
  completed: 'completed'
};

function buildHistoryEvent(court, scrapedAt) {
  return {
    caseNumber: court.caseNumber,
    courthouse: 'Gujarat High Court',
    courtNumber: court.courtNumber,
    judgeName: court.judgeName,
    benchType: court.benchType,
    status: court.caseStatus,
    position: court.queuePosition,
    gsrno: court.gsrno,
    streamUrl: court.streamUrl,
    isLive: court.isLive,
    scrapedAt: new Date(scrapedAt)
  };
}

/* ==================== QUEUE PRECOMPUTATION ==================== */

function buildCourtQueues(courts) {
  const queues = {};

  courts.forEach(c => {
    if (!c.courtNumber) return;
    if (!queues[c.courtNumber]) queues[c.courtNumber] = [];
    queues[c.courtNumber].push(c);
  });

  const result = {};

  for (const courtNumber in queues) {
    const pending = queues[courtNumber]
      .filter(c => c.queuePosition !== null && !['IN_SESSION', 'SITTING_OVER'].includes(c.caseStatus))
      .sort((a, b) => a.queuePosition - b.queuePosition);

    result[courtNumber] = {
      pending,
      currentCase: queues[courtNumber].find(c => c.caseStatus === 'IN_SESSION') || null
    };
  }

  return result;
}

/* ==================== MAIN ENTRY ==================== */

async function processCaseUpdates({ courts, scrapedAt }) {
  await processGlobalCaseHistory(courts, scrapedAt);
  await updateCaseStatistics(courts);

  const watchlists = await Watchlist.find({ isActive: true });
  if (!watchlists.length) return;

  const devices = await Device.find({ isActive: true });
  const deviceMap = Object.fromEntries(devices.map(d => [d.deviceId, d]));

  const courtQueues = buildCourtQueues(courts);

  for (const watch of watchlists) {
    try {
      await processWatchlist(watch, courts, courtQueues, deviceMap);
    } catch (e) {
      logger.error(`Watchlist ${watch._id} failed`, e);
    }
  }
}

/* ==================== WATCHLIST PROCESSOR ==================== */

async function processWatchlist(watch, courts, courtQueues, deviceMap) {
  const {
    caseNumber,
    deviceId,
    notificationSettings,
    lastSeenStatus,
    lastSeenPosition,
    missCount = 0,
    lastNotificationTime
  } = watch;

  const device = deviceMap[deviceId];
  if (!device || !device.fcmToken) return;

  const court = courts.find(c => c.caseNumber === caseNumber);

  /* ---------- CASE NOT FOUND (COMPLETED) ---------- */
  if (!court) {
    watch.missCount = missCount + 1;

    if (
      watch.missCount >= 2 &&
      lastSeenStatus !== 'COMPLETED' &&
      notificationSettings.completed &&
      cooldownPassed(lastNotificationTime)
    ) {
      await sendCaseAlert(deviceId, device.fcmToken, caseNumber, 'completed', {});
      watch.lastSeenStatus = 'COMPLETED';
      watch.lastNotificationTime = new Date();
    }

    await watch.save();
    return;
  }

  /* ---------- CASE FOUND ---------- */
  watch.missCount = 0;

  const queue = courtQueues[court.courtNumber];
  const pending = queue?.pending || [];
  const position =
    pending.findIndex(c => c.caseNumber === caseNumber) + 1 || null;

  const velocity =
    lastSeenPosition && position ? lastSeenPosition - position : 0;

  /* ---------- STATE DETECTION ---------- */

  let newState = null;

  if (court.caseStatus === 'IN_SESSION') newState = 'IN_SESSION';
  else if (position === 1) newState = 'NEXT';
  else if (position <= 3) newState = 'VERY_NEAR';
  else if (position <= 10) newState = 'NEAR';
  else if (position) newState = 'FAR';

  /* ---------- NOTIFICATION ---------- */

  if (newState && newState !== lastSeenStatus) {
    const alertType = STATE_TO_ALERT[newState];
    const settingKey = ALERT_TO_SETTING[alertType];

    if (!alertType || !settingKey) {
      logger.warn(
        `[NOTIFY SKIP] Invalid state=${newState} case=${caseNumber}`
      );
    } else if (
      notificationSettings[settingKey] &&
      cooldownPassed(lastNotificationTime)
    ) {
      await sendCaseAlert(
        deviceId,
        device.fcmToken,
        caseNumber,
        alertType,
        {
          courtNumber: court.courtNumber,
          judgeName: court.judgeName,
          position,
          velocity
        }
      );

      watch.lastSeenStatus = newState;
      watch.lastNotificationTime = new Date();
    }
  }

  watch.lastSeenPosition = position;
  watch.lastSeenCourt = court.courtNumber;

  await watch.save();
}

/* ==================== GLOBAL CASE HISTORY ==================== */

async function processGlobalCaseHistory(courts, scrapedAt) {
  const historyEvents = [];

  for (const court of courts) {
    if (!court.caseNumber) continue;

    const key = court.courtNumber;
    const prev = lastCourtState.get(key);

    const current = {
      caseNumber: court.caseNumber,
      status: court.caseStatus,
      queuePosition: court.queuePosition
    };

    if (!prev) {
      lastCourtState.set(key, current);
      historyEvents.push(buildHistoryEvent(court, scrapedAt));
      continue;
    }

    const changed =
      prev.caseNumber !== current.caseNumber ||
      prev.status !== current.status ||
      prev.queuePosition !== current.queuePosition;

    if (changed) {
      historyEvents.push(buildHistoryEvent(court, scrapedAt));
      lastCourtState.set(key, current);
    }
  }

  if (historyEvents.length) {
    await CaseHistory.insertMany(historyEvents, { ordered: false });
    logger.info(`Global history events saved: ${historyEvents.length}`);
  }
}

/* ==================== STATISTICS ==================== */

async function updateCaseStatistics(courts) {
  for (const c of courts) {
    if (!c.caseNumber) continue;

    await CaseStatistics.findOneAndUpdate(
      { caseNumber: c.caseNumber },
      {
        $set: { lastSeen: new Date() },
        $inc: { totalAppearances: 1 },
        $addToSet: {
          courts: c.courtNumber,
          judges: c.judgeName
        },
        $push: {
          statusHistory: {
            $each: [{
              status: c.caseStatus,
              timestamp: new Date(),
              courtNumber: c.courtNumber,
              queuePosition: c.queuePosition
            }],
            $slice: -100
          }
        }
      },
      { upsert: true }
    );
  }
}

/* ==================== EXPORT ==================== */

module.exports = {
  processCaseUpdates
};

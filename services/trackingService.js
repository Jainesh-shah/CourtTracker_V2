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

function buildHistoryEvent(court, scrapedAt) {
  return {
    caseNumber: court.caseNumber,
    courthouse: 'Gujarat High Court',
    courtNumber: court.courtNumber,
    judgeName: court.judgeName,
    benchType: court.benchType,
    status: court.caseStatus,
    streamUrl: court.streamUrl,
    isLive: court.isLive,
    scrapedAt: new Date(scrapedAt)
  };
}

/* ==================== MAIN ENTRY ==================== */

async function processCaseUpdates({ courts, scrapedAt }) {
  await processGlobalCaseHistory(courts, scrapedAt);
  await updateCaseStatistics(courts);

  const watchlists = await Watchlist.find({ isActive: true });
  if (!watchlists.length) return;

  const devices = await Device.find({ isActive: true });
  const deviceMap = Object.fromEntries(devices.map(d => [d.deviceId, d]));

  for (const watch of watchlists) {
    try {
      await processWatchlist(watch, courts, deviceMap, scrapedAt);
    } catch (e) {
      logger.error(`Watchlist ${watch._id} failed`, e);
    }
  }
}

/* ==================== WATCHLIST PROCESSOR ==================== */

async function processWatchlist(watch, courts, deviceMap, scrapedAt) {
  const {
    caseNumber,
    deviceId,
    notificationSettings,
    lastSeenStatus,
    missCount = 0,
    lastNotificationTime
  } = watch;

  const device = deviceMap[deviceId];
  if (!device || !device.fcmToken) return;

  const court = courts.find(c => c.caseNumber === caseNumber);

  /* ---------- CASE NOT FOUND → POSSIBLE COMPLETED ---------- */
  if (!court) {
    watch.missCount = missCount + 1;

    if (
      watch.missCount >= 2 &&
      lastSeenStatus !== 'COMPLETED' &&
      notificationSettings.completed &&
      cooldownPassed(lastNotificationTime)
    ) {
      await sendCaseAlert(
        deviceId,
        device.fcmToken,
        caseNumber,
        'completed',
        {}
      );

      watch.lastSeenStatus = 'COMPLETED';
      watch.lastNotificationTime = new Date();
    }

    await watch.save();
    return;
  }

  /* ---------- CASE FOUND ---------- */
  watch.missCount = 0;

  /* ---------- IN SESSION DETECTION ---------- */
  if (
    court.caseStatus === 'IN_SESSION' &&
    lastSeenStatus !== 'IN_SESSION' &&
    notificationSettings.inSession &&
    cooldownPassed(lastNotificationTime)
  ) {
    await sendCaseAlert(
      deviceId,
      device.fcmToken,
      caseNumber,
      'in_session',
      {
        courtNumber: court.courtNumber,
        judgeName: court.judgeName,
        streamUrl: court.streamUrl
      }
    );

    watch.lastSeenStatus = 'IN_SESSION';
    watch.lastNotificationTime = new Date();
  }

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
      status: court.caseStatus
    };

    if (!prev) {
      lastCourtState.set(key, current);
      historyEvents.push(buildHistoryEvent(court, scrapedAt));
      continue;
    }

    const changed =
      prev.caseNumber !== current.caseNumber ||
      prev.status !== current.status;

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
              courtNumber: c.courtNumber
            }],
            $slice: -100
          }
        }
      },
      { upsert: true }
    );
  }
}

module.exports = {
  processCaseUpdates
};

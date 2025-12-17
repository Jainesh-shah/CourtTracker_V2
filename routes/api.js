const express = require("express");
const router = express.Router();
const {
  Device,
  Watchlist,
  CaseHistory,
  CaseStatistics,
  CourtSnapshot,
  NotificationLog,
  CurrentCourt
} = require("../models");

const { calculateEstimatedWaitTime } = require("../services/trackingService");
const logger = require("../config/logger");
const { sendNotification } = require("../services/fcmService");
const {
  getLastCourtData,
  getLastScrapeTime,
} = require("../services/cronService");
const { upsertCurrentCourts } = require('../services/currentCourtService');

/* -------------------- HELPERS -------------------- */

async function requireCachedCourtData(res) {
  const data = getLastCourtData();
  const lastScrapeTime = getLastScrapeTime();

  // ✅ Case 1: Live cache exists
  if (data && data.courts) {
    return {
      source: "live",
      state: "live",
      lastScrapeTime,
      data,
    };
  }

  // ✅ Case 2: Fallback to snapshot
  const snapshot = await CourtSnapshot.findOne({})
    .sort({ snapshotTime: -1 })
    .lean();

  if (snapshot) {
    return {
      source: "snapshot",
      state: "stale",
      lastScrapeTime: snapshot.snapshotTime,
      data: {
        summary: snapshot.summary,
        courts: snapshot.courts,
      },
    };
  }

  // ❌ Case 3: Cold start (nothing exists)
  res.status(503).json({
    success: false,
    state: "warming",
    error: "Court data warming up, please retry shortly",
  });
  return null;
}

function isDev() {
  return process.env.NODE_ENV !== "production";
}

/* ==================== DEVICE ==================== */

router.post("/device/register", async (req, res) => {
  const { deviceId, fcmToken, deviceInfo } = req.body;
  if (!deviceId || !fcmToken) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  const device = await Device.findOneAndUpdate(
    { deviceId },
    { fcmToken, deviceInfo, isActive: true, lastSeen: new Date() },
    { upsert: true, new: true }
  );

  res.json({ success: true, device });
});

router.post("/device/heartbeat", async (req, res) => {
  await Device.findOneAndUpdate(
    { deviceId: req.body.deviceId },
    { lastSeen: new Date() }
  );
  res.json({ success: true });
});

/* ==================== WATCHLIST ==================== */

router.post("/watchlist/add", async (req, res) => {
  const { deviceId, caseNumber, nickname, notificationSettings } = req.body;

  const existing = await Watchlist.findOne({
    deviceId,
    caseNumber,
    isActive: true,
  });
  if (existing) {
    return res.status(409).json({ success: false, error: "Already watching" });
  }

  const watch = await Watchlist.create({
    deviceId,
    caseNumber,
    nickname,
    notificationSettings,
  });

  await CaseStatistics.updateOne(
    { caseNumber },
    { $inc: { watchCount: 1 } },
    { upsert: true }
  );

  res.json({ success: true, watch });
});

router.get("/watchlist/:deviceId", async (req, res) => {
  const watchlist = await Watchlist.find({
    deviceId: req.params.deviceId,
    isActive: true,
  }).lean();

  const caseNumbers = watchlist.map((w) => w.caseNumber);

  const statsMap = Object.fromEntries(
    (
      await CaseStatistics.find({ caseNumber: { $in: caseNumbers } }).lean()
    ).map((s) => [s.caseNumber, s])
  );

  const historyMap = Object.fromEntries(
    (
      await CaseHistory.aggregate([
        { $match: { caseNumber: { $in: caseNumbers } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$caseNumber", doc: { $first: "$$ROOT" } } },
      ])
    ).map((h) => [h._id, h.doc])
  );

  const enriched = watchlist.map((w) => ({
    ...w,
    statistics: statsMap[w.caseNumber] || null,
    currentStatus: historyMap[w.caseNumber] || null,
  }));

  res.json({ success: true, count: enriched.length, watchlist: enriched });
});

/* ==================== COURTS (CACHED ONLY) ==================== */

router.get("/courts", async (req, res) => {
  const courts = (
    await CurrentCourt.find({}, { _id: 0, data: 1 }).lean()
  ).map(c => c.data);

  if (courts.length) {
    return res.json({
      success: true,
      source: 'db',
      state: 'live',
      lastScrapeTime: getLastScrapeTime(),
      courts
    });
  }

  // fallback to snapshot
  const snapshot = await CourtSnapshot.findOne({})
    .sort({ snapshotTime: -1 })
    .lean();

  if (snapshot) {
    return res.json({
      success: true,
      source: 'snapshot',
      state: 'stale',
      lastScrapeTime: snapshot.snapshotTime,
      courts: snapshot.courts
    });
  }

  res.status(503).json({
    success: false,
    state: 'warming',
    error: 'Court data not ready'
  });
});


router.get("/courts/:courtNumber/queue", async (req, res) => {
  const ctx = await requireCachedCourtData(res);
  if (!ctx) return;

  const sameCourt = data.courts.filter(
    (c) => c.courtNumber === req.params.courtNumber
  );

  if (!sameCourt.length) {
    return res.status(404).json({ success: false, error: "Court not found" });
  }

  const queue = sameCourt
    .filter((c) => c.queuePosition !== null)
    .sort((a, b) => a.queuePosition - b.queuePosition);

  res.json({
    success: true,
    courtNumber: req.params.courtNumber,
    state: ctx.state,
    source: ctx.source,
    lastScrapeTime: ctx.lastScrapeTime,
    summary: ctx.data.summary,
    courts: ctx.data.courts,
    currentCase: queue.find((c) => c.caseStatus === "IN_SESSION") || null,
    queue,
    totalInQueue: queue.length,
  });
});

router.get("/courts/status/:status", async (req, res) => {
  const ctx = await requireCachedCourtData(res);
  if (!ctx) return;

  const status = req.params.status.toUpperCase().replace("-", "_");
  const allowed = ["IN_SESSION", "RECESS", "SITTING_OVER"];

  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, error: "Invalid status" });
  }

  const courts = ctx.data.courts.filter(
    (c) => c.caseStatus === status || c.status === status
  );

  res.json({
    success: true,
    state: ctx.state,
    source: ctx.source,
    lastScrapeTime: ctx.lastScrapeTime,
    status,
    count: courts.length,
    courts,
  });
});

/* ==================== CASE DATA ==================== */

router.get("/case/history/:caseNumber", async (req, res) => {
  const history = await CaseHistory.find({ caseNumber: req.params.caseNumber })
    .sort({ createdAt: -1 })
    .limit(50);

  res.json({ success: true, history });
});

router.get("/case/stats/:caseNumber", async (req, res) => {
  const stats = await CaseStatistics.findOne({
    caseNumber: req.params.caseNumber,
  });
  if (!stats) {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  const eta = await calculateEstimatedWaitTime(req.params.caseNumber);
  res.json({
    success: true,
    statistics: { ...stats.toObject(), estimatedWaitTime: eta },
  });
});

/* ==================== ANALYTICS ==================== */

router.get("/analytics/overview", async (req, res) => {
  const [watchlists, devices, cases] = await Promise.all([
    Watchlist.countDocuments({ isActive: true }),
    Device.countDocuments({ isActive: true }),
    CaseStatistics.countDocuments({}),
  ]);

  res.json({
    success: true,
    overview: {
      totalWatchlists: watchlists,
      totalDevices: devices,
      totalCases: cases,
    },
  });
});

/* ==================== DEBUG (DEV ONLY) ==================== */

if (isDev()) {
  router.post("/debug/test-notification", async (req, res) => {
    const result = await sendNotification(
      req.body.fcmToken,
      { title: "Test", body: "Debug notification" },
      { debug: true }
    );
    res.json({ success: true, result });
  });
}

router.get("/_routes", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).end();
  }

  const routes = [];

  req.app._router.stack.forEach((mw) => {
    if (!mw.route) return;

    const methods = Object.keys(mw.route.methods).map((m) => m.toUpperCase());

    routes.push({
      methods,
      path: mw.route.path,
    });
  });

  res.json(routes);
});
/* ==================== HEALTH ==================== */

router.get("/health", (_, res) => {
  res.json({ status: "OK", ts: new Date().toISOString() });
});

module.exports = router;

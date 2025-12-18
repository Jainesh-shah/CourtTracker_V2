const cron = require("node-cron");
const { scrapeCourtData } = require("./scraperService");
const { processCaseUpdates } = require("./trackingService");
const { broadcastCourtUpdate } = require("./websocketService");
const { CourtSnapshot } = require("../models");
const logger = require("../config/logger");
const { upsertCurrentCourts } = require("./currentCourtService");
const { CurrentCourt } = require("../models");

/* -------------------- STATE -------------------- */

let lastCourtData = null;
let lastScrapeTime = null;
let scrapeCount = 0;

let scraperLockUntil = 0;
let backoffUntil = 0;

const SCRAPER_INTERVAL = parseInt(process.env.SCRAPER_INTERVAL, 10) || 30000;
const MAX_EXPECTED_RUNTIME = 25000; // ms
const BACKOFF_MS = 2 * 60 * 1000; // 2 minutes

/* -------------------- GUARDS -------------------- */

function isCourtHours() {
  const hour = new Date().getHours();
  return hour >= 10 && hour <= 17;
}

function isLocked() {
  return Date.now() < scraperLockUntil;
}

function isInBackoff() {
  return Date.now() < backoffUntil;
}

/* -------------------- REALTIME SCRAPER -------------------- */

function startRealtimeScraper() {
  logger.info(`Starting realtime scraper (${SCRAPER_INTERVAL}ms)`);

  setInterval(async () => {
    if (!isCourtHours() || isLocked() || isInBackoff()) return;

    scraperLockUntil = Date.now() + MAX_EXPECTED_RUNTIME;

    try {
      scrapeCount++;
      logger.info(`Starting scrape #${scrapeCount}`);

      const { allCourts, changedCourts, scrapedAt, skipped } =
        await scrapeCourtData();

      // ✅ ALWAYS persist full state
      await upsertCurrentCourts(allCourts, scrapedAt);

      // ✅ CACHE FOR API
      lastCourtData = {
        success: true,
        scrapedAt,
        courts: allCourts,
      };

      // ✅ ONLY deltas trigger side effects
      if (!skipped && changedCourts.length) {
        await processCaseUpdates({
          courts: changedCourts,
          scrapedAt,
        });

        broadcastCourtUpdate({
          type: "COURT_DELTA",
          courts: changedCourts,
          scrapedAt,
        });
      }

      lastScrapeTime = new Date(scrapedAt);

      logger.info(`Scrape #${scrapeCount} done`);
    } catch (err) {
      logger.error("Realtime scraper error:", err);
      backoffUntil = Date.now() + BACKOFF_MS;
    } finally {
      scraperLockUntil = 0;
    }
  }, SCRAPER_INTERVAL);
}

/* -------------------- SNAPSHOT SCHEDULER -------------------- */

function startSnapshotScheduler() {
  cron.schedule("*/5 * * * *", async () => {
    try {
      const courts = (
        await CurrentCourt.find({}, { _id: 0, data: 1 }).lean()
      ).map((c) => c.data);

      if (!courts.length) return;

      await require("../models").CourtSnapshot.create({
        courthouse: "Gujarat High Court",
        snapshotTime: new Date(),
        courts,
      });

      logger.info("Snapshot saved");
    } catch (e) {
      logger.error("Snapshot error:", e);
    }
  });
}

/* -------------------- CLEANUP SCHEDULER -------------------- */

function startCleanupScheduler() {
  logger.info("Starting cleanup scheduler (daily @ 02:00)");

  const job = cron.schedule("0 2 * * *", async () => {
    try {
      logger.info("Cleanup job executed (TTL indexes handle deletions)");
    } catch (error) {
      logger.error("Cleanup scheduler error:", error);
    }
  });

  return job;
}

/* -------------------- STATUS -------------------- */

function getScraperStatus() {
  return {
    scrapeCount,
    lastScrapeTime,
    lockedUntil: scraperLockUntil ? new Date(scraperLockUntil) : null,
    backoffUntil: backoffUntil ? new Date(backoffUntil) : null,
    interval: SCRAPER_INTERVAL,
    hasCachedData: !!lastCourtData,
  };
}

function getLastCourtData() {
  return lastCourtData;
}

function getLastScrapeTime() {
  return lastScrapeTime;
}
/* -------------------- EXPORT -------------------- */

module.exports = {
  startRealtimeScraper,
  startSnapshotScheduler,
  startCleanupScheduler,
  getScraperStatus,
  getLastCourtData,
  getLastScrapeTime,
};

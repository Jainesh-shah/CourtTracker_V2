const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const logger = require("../config/logger");

const BASE =
  process.env.COURT_BASE_URL ||
  "https://gujarathighcourt.nic.in/streamingboard/";
const XHR_URL =
  process.env.COURT_XHR_URL || `${BASE}indexrequest.php`;

const cleanText = (text) =>
  text ? text.replace(/\s+/g, " ").trim() : "";

const isValidValue = (val) =>
  val && val !== "-" && val.trim() !== "";

const sha256 = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");

/* ------------------------------------------------------------------
   STATE
------------------------------------------------------------------ */

/**
 * Minimal snapshot for fast delta detection
 * courtCode -> { hash, caseNumber, srNo }
 */
const lastSnapshots = new Map();

/**
 * Full court state cache
 * courtCode -> courtObject
 */
const previousCourts = new Map();

/**
 * Conditional request headers
 */
let lastETag = null;
let lastModified = null;

/* ------------------------------------------------------------------
   SCRAPER
------------------------------------------------------------------ */

async function scrapeCourtData() {
  try {
    let xhrResp;

    /* ---------------- XHR REQUEST ---------------- */

    xhrResp = await axios.get(XHR_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/javascript, */*; q=0.01",
        ...(lastETag && { "If-None-Match": lastETag }),
        ...(lastModified && { "If-Modified-Since": lastModified }),
      },
      timeout: 15000,
      validateStatus: (s) => s === 200 || s === 304,
    });

    /* ---------------- 304 HANDLING ---------------- */

    if (xhrResp.status === 304) {
      logger.info("XHR not modified (304)");

      return {
        allCourts: Array.from(previousCourts.values()),
        changedCourts: [],
        scrapedAt: new Date().toISOString(),
        skipped: true,
      };
    }

    lastETag = xhrResp.headers.etag || lastETag;
    lastModified =
      xhrResp.headers["last-modified"] || lastModified;

    /* ---------------- PAGE REQUEST ---------------- */

    const pageResp = await axios.get(BASE, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000,
    });

    const xhrData = Array.isArray(xhrResp.data)
      ? xhrResp.data
      : JSON.parse(xhrResp.data || "[]");

    const $ = cheerio.load(pageResp.data || "");

    const changedCourts = [];
    const scrapedAt = new Date().toISOString();

    /* ---------------- PER COURT ---------------- */

    for (const row of xhrData) {
      const courtCode = String(row.courtcode || "").trim();
      if (!courtCode) continue;

      const $card = $(`#dv_${courtCode}`);
      if (!$card.length) continue;

      const cardHtml = $card.html();
      const currentHash = sha256(cardHtml);

      const minimal = {
        caseFooterText: cleanText(row.caseinfo || ""),
        srNo: cleanText(row.gsrno || ""),
      };

      const prev = lastSnapshots.get(courtCode);

      const unchanged =
        prev &&
        prev.hash === currentHash &&
        prev.caseNumber === minimal.caseFooterText &&
        prev.srNo === minimal.srNo;

      /* ---------------- FULL PARSE ---------------- */

      let judgeName = cleanText(
        $card.find(".card-category b").first().text()
      );
      if (!judgeName) {
        judgeName = cleanText(
          $card
            .find(".card-header, .card-title, .card-body")
            .first()
            .text()
        );
      }
      judgeName = judgeName.replace("[Live]", "").trim();

      let streamUrl = null;
      const a = $card.find("a").first();
      if (a?.attr("href")) {
        streamUrl = a.attr("href").trim();
        if (streamUrl.startsWith("/")) {
          streamUrl =
            "https://gujarathighcourt.nic.in" + streamUrl;
        }
      }

      const judgePhotos = [];
      $card.find(".photoclass, img").each((_, img) => {
        const src =
          $(img).attr("src") || $(img).attr("data-src");
        if (src) {
          judgePhotos.push(
            src.startsWith("http")
              ? src
              : `${BASE}${src.replace(/^\.\//, "")}`
          );
        }
      });

      const judgeCount = judgePhotos.length;
      const benchType =
        judgeCount >= 2 ? "Division Bench" : "Single Bench";

      let courtNumber = cleanText(
        $card.find(`#court_${courtCode}`).text()
      ).replace(/COURT\s*NO:?/i, "");

      const srNo = minimal.srNo || null;
      let queuePosition = null;
      if (srNo) {
        const m = srNo.match(/(\d+)/);
        if (m) queuePosition = parseInt(m[1], 10);
      }

      let caseNumber = null;
      let caseStatus = null;
      let caseType = null;

      const footer = minimal.caseFooterText;

      if (/COURT\s*SITTING\s*OVER/i.test(footer)) {
        caseStatus = "SITTING_OVER";
        caseType = "sitting_over";
      } else if (footer.includes("(RECESS)")) {
        caseStatus = "RECESS";
        caseType = "recess";
        caseNumber = footer.replace("(RECESS)", "").trim();
      } else if (isValidValue(footer)) {
        caseStatus = "IN_SESSION";
        caseType = "active";
        caseNumber = footer;
      }

      const isLive = $card.find(".blink_me").length > 0;

      const courtObj = {
        id: courtCode,
        judgeName,
        judgeCount,
        benchType,
        isLive,
        courtNumber,
        srNo,
        queuePosition,
        caseNumber,
        caseStatus,
        caseType,
        streamUrl,
        judgePhotos,
        hasStream: !!streamUrl,
        isActive:
          isLive ||
          caseStatus === "IN_SESSION" ||
          caseStatus === "RECESS",
        scrapedAt,
      };

      /* ---------------- STATE UPDATES ---------------- */

      previousCourts.set(courtCode, courtObj);

      lastSnapshots.set(courtCode, {
        hash: currentHash,
        caseNumber: footer,
        srNo,
      });

      if (!unchanged) {
        changedCourts.push(courtObj);
      }
    }

    const allCourts = Array.from(previousCourts.values());

    logger.info(`Scraped ${changedCourts.length} changed courts`);

    return {
      allCourts,
      changedCourts,
      scrapedAt,
      skipped: changedCourts.length === 0,
    };
  } catch (err) {
    logger.error("Scraping error:", err);
    throw err;
  }
}

/* ------------------------------------------------------------------
   EXPORT
------------------------------------------------------------------ */

module.exports = {
  scrapeCourtData,
};

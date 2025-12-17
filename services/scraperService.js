const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const logger = require("../config/logger");

const BASE =
  process.env.COURT_BASE_URL ||
  "https://gujarathighcourt.nic.in/streamingboard/";
const XHR_URL = process.env.COURT_XHR_URL || `${BASE}indexrequest.php`;

const cleanText = (text) => (text ? text.replace(/\s+/g, " ").trim() : "");
const isValidValue = (val) => val && val !== "-" && val.trim() !== "";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * In-memory snapshot store
 * courtCode -> { hash, caseNumber, caseStatus, srNo }
 * (Move to Redis/DB later if needed)
 */
const lastSnapshots = new Map();

/**
 * Conditional request state
 */
let lastETag = null;
let lastModified = null;

async function scrapeCourtData() {
  try {
    let xhrResp;

    // ---- XHR REQUEST (with conditional headers) ----
    try {
      xhrResp = await axios.get(XHR_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "application/json, text/javascript, */*; q=0.01",
          ...(lastETag && { "If-None-Match": lastETag }),
          ...(lastModified && { "If-Modified-Since": lastModified }),
        },
        timeout: 15000,
        validateStatus: (s) => s === 200 || s === 304,
      });
    } catch (err) {
      throw err;
    }

    // ---- 304 = NOTHING CHANGED, EXIT EARLY ----
    if (xhrResp.status === 304) {
      logger.info("XHR not modified (304) — skipping scrape");
      return {
        success: true,
        skipped: true,
        reason: "not_modified",
      };
    }

    // Save conditional headers
    lastETag = xhrResp.headers.etag || lastETag;
    lastModified = xhrResp.headers["last-modified"] || lastModified;

    // ---- MAIN PAGE REQUEST ----
    const pageResp = await axios.get(BASE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      timeout: 15000,
    });

    const xhrData = Array.isArray(xhrResp.data)
      ? xhrResp.data
      : JSON.parse(xhrResp.data || "[]");

    const $ = cheerio.load(pageResp.data || "");

    const courts = [];
    const allCourts = [];
    const changedCourts = [];

    const scrapedAt = new Date().toISOString();

    // ---- PER COURT LOOP ----
    for (const row of xhrData) {
      const courtCode = String(row.courtcode || "").trim();
      if (!courtCode) continue;

      const cardSelector = `#dv_${courtCode}`;
      const $card = $(cardSelector);
      if (!$card.length) continue;

      // ---- HASH THIS COURT BLOCK ----
      const cardHtml = $card.html();
      const currentHash = sha256(cardHtml);

      const prev = lastSnapshots.get(courtCode);

      // ---- MINIMAL SNAPSHOT (FAST CHECK) ----
      const minimal = {
        caseFooterText: cleanText(row.caseinfo || ""),
        srNo: cleanText(row.gsrno || ""),
      };

      // ---- FAST EXIT: HASH + SEMANTIC NO-CHANGE ----
      if (
        prev &&
        prev.hash === currentHash &&
        prev.caseNumber === minimal.caseFooterText &&
        prev.srNo === minimal.srNo
      ) {
        continue;
      }

      // ---- FULL PARSING STARTS ONLY HERE ----

      let judgeName = "";
      const catB = $card.find(".card-category b").first();
      if (catB.length) judgeName = cleanText(catB.text());
      if (!judgeName) {
        judgeName = cleanText(
          $card.find(".card-header, .card-title, .card-body").first().text()
        );
      }
      judgeName = judgeName.replace("[Live]", "").trim();

      let streamUrl = null;
      const a = $card.find("a").first();
      if (a && a.attr("href")) {
        streamUrl = a.attr("href").trim();
        if (streamUrl.startsWith("/")) {
          streamUrl = `https://gujarathighcourt.nic.in${streamUrl}`;
        }
      }

      const judgePhotos = [];
      $card.find(".photoclass, img").each((_, img) => {
        const src = $(img).attr("src") || $(img).attr("data-src");
        if (src) {
          judgePhotos.push(
            src.startsWith("http")
              ? src
              : `https://gujarathighcourt.nic.in/streamingboard/${src.replace(
                  /^\.\//,
                  ""
                )}`
          );
        }
      });

      const judgeCount = judgePhotos.length;
      const benchType = judgeCount >= 2 ? "Division Bench" : "Single Bench";

      let courtNumber = "";
      const courtEl = $card.find(`#court_${courtCode}`);
      if (courtEl.length) {
        courtNumber = cleanText(courtEl.text()).replace(/COURT\s*NO:?/i, "");
      }

      const srNo = minimal.srNo || null;

      let queuePosition = null;
      if (srNo) {
        const m = srNo.match(/(\d+)/);
        if (m) queuePosition = parseInt(m[1], 10);
      }

      const caseFooterText = minimal.caseFooterText;

      let caseNumber = null;
      let caseStatus = null;
      let caseType = null;

      if (/COURT\s*SITTING\s*OVER/i.test(caseFooterText)) {
        caseStatus = "SITTING_OVER";
        caseType = "sitting_over";
      } else if (caseFooterText.includes("(RECESS)")) {
        caseStatus = "RECESS";
        caseType = "recess";
        caseNumber = caseFooterText.replace("(RECESS)", "").trim();
      } else if (isValidValue(caseFooterText)) {
        caseStatus = "IN_SESSION";
        caseType = "active";
        caseNumber = caseFooterText;
      }

      const isLive = $card.find(".blink_me").length > 0;

      // ---- SAVE SNAPSHOT ----
      lastSnapshots.set(courtCode, {
        hash: currentHash,
        caseNumber: caseFooterText,
        caseStatus,
        srNo,
      });

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
          isLive || caseStatus === "IN_SESSION" || caseStatus === "RECESS",
        scrapedAt,
      };

      // ✅ ALWAYS store full state
      allCourts.push(courtObj);

      // ✅ ONLY changed courts go to delta pipeline
      if (
        !prev ||
        prev.hash !== currentHash ||
        prev.caseNumber !== minimal.caseFooterText ||
        prev.srNo !== minimal.srNo
      ) {
        changedCourts.push(courtObj);
      }
    }

    logger.info(`Scraped ${courts.length} changed courts`);

    return {
      success: true,
      scrapedAt,
      allCourts,
      changedCourts,
    };
  } catch (err) {
    logger.error("Scraping error:", err.message);
    throw err;
  }
}

module.exports = {
  scrapeCourtData,
};

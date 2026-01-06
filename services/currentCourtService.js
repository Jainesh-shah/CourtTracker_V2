const { CurrentCourt } = require('../models');
const crypto = require('crypto');

function hashCourtData(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}

const MISSING_THRESHOLD = 3;
async function upsertCurrentCourts(allCourts, scrapedAt) {
  if (!allCourts.length) return;

  const seenCourtCodes = new Set(allCourts.map(c => c.id));

  const existing = await CurrentCourt.find(
    {},
    { courtCode: 1, dataHash: 1, missingCount: 1 }
  ).lean();

  const existingMap = new Map(
    existing.map(d => [d.courtCode, d])
  );

  const ops = [];

  /* ---------------- SEEN COURTS ---------------- */
  for (const court of allCourts) {
    const newHash = hashCourtData(court);
    const prev = existingMap.get(court.id);

    if (prev && prev.dataHash === newHash) {
      ops.push({
        updateOne: {
          filter: { courtCode: court.id },
          update: {
            $set: {
              checkedAt: new Date(scrapedAt),
              isVisible: true,
              missingCount: 0
            }
          }
        }
      });
      continue;
    }

    ops.push({
      updateOne: {
        filter: { courtCode: court.id },
        update: {
          $set: {
            data: court,
            dataHash: newHash,
            checkedAt: new Date(scrapedAt),
            changedAt: new Date(scrapedAt),
            isVisible: true,
            missingCount: 0
          }
        },
        upsert: true
      }
    });
  }

  /* ---------------- MISSING COURTS ---------------- */
  for (const doc of existing) {
    if (seenCourtCodes.has(doc.courtCode)) continue;

    const newMissing = (doc.missingCount || 0) + 1;

    ops.push({
      updateOne: {
        filter: { courtCode: doc.courtCode },
        update: {
          $set: {
            checkedAt: new Date(scrapedAt),
            missingCount: newMissing,
            isVisible: newMissing < MISSING_THRESHOLD
          }
        }
      }
    });
  }

  if (ops.length) {
    await CurrentCourt.bulkWrite(ops, { ordered: false });
  }
}

async function getAllCurrentCourts() {
  const docs = await CurrentCourt
    .find({})
    .lean()
    .sort({ courtCode: 1 });

  if (!docs.length) {
    throw new Error('No court data available yet');
  }

  const latestCheckedAt = docs.reduce(
    (max, d) => d.checkedAt > max ? d.checkedAt : max,
    docs[0].checkedAt
  );

  return {
    checkedAt: latestCheckedAt,   // ⏱️ freshness
    changedAt: docs[0].changedAt, // 🔁 last real change
    data: docs.map(d => d.data)
  };
}

module.exports = { upsertCurrentCourts,  getAllCurrentCourts };

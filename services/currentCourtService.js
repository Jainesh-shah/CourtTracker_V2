const { CurrentCourt } = require('../models');

async function upsertCurrentCourts(allCourts, scrapedAt) {
  const ops = allCourts.map(court => ({
    updateOne: {
      filter: { courtCode: court.id },
      update: {
        $set: {
          data: court,
          updatedAt: new Date(scrapedAt)
        }
      },
      upsert: true
    }
  }));

  if (ops.length) {
    await CurrentCourt.bulkWrite(ops, { ordered: false });
  }
}
/**
 * ✅ ALWAYS used by /courts API
 */
async function getAllCurrentCourts() {
  const docs = await CurrentCourt
    .find({})
    .lean()
    .sort({ courtCode: 1 });

  if (!docs.length) {
    throw new Error('No court data available yet');
  }

  return {
    scrapedAt: docs[0].updatedAt,
    data: docs.map(d => d.data)
  };
}

module.exports = { upsertCurrentCourts,  getAllCurrentCourts };

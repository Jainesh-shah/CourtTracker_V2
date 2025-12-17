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

module.exports = { upsertCurrentCourts };

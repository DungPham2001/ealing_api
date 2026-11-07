const { getSettings } = require('../services/settings');
const { today } = require('../lib/dates');

/** Per-request evaluation context: thresholds + "today" in the business timezone. */
async function getEnv() {
  return { settings: await getSettings(), today: today() };
}

module.exports = { getEnv };

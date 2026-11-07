/**
 * Thresholds and the closed period are EALING's, not the app's (spec 2.7, 6). Examples:
 *   npm run setting                              # show current values
 *   npm run setting -- closedThrough=2026-09     # lock every month up to 2026-09
 *   npm run setting -- closedThrough=null leaseExpiringDays=90
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const { getSettings, setSettings, DEFAULTS } = require('../src/services/settings');

async function main() {
  await mongoose.connect(config.mongoUri);
  const patch = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    if (!(k in DEFAULTS)) throw new Error(`unknown setting "${k}" (known: ${Object.keys(DEFAULTS).join(', ')})`);
    patch[k] = v === 'null' ? null : Number.isFinite(Number(v)) && v !== '' ? Number(v) : v;
  }
  console.log(Object.keys(patch).length ? await setSettings(patch) : await getSettings());
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

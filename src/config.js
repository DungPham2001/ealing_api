require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ealing_holdings',
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  timezone: process.env.TIMEZONE || 'America/New_York',
  cronSecret: process.env.CRON_SECRET || '',
  // Per-IP limits (spec 2.8). All configurable; RATE_LIMIT=off disables them.
  rate: {
    enabled: process.env.RATE_LIMIT !== 'off' && process.env.NODE_ENV !== 'test',
    readPerMin: num(process.env.RATE_READ_PER_MIN, 60),
    writePerMin: num(process.env.RATE_WRITE_PER_MIN, 20),
    createPerDay: num(process.env.RATE_CREATE_PER_DAY, 300),
    exportPerDay: num(process.env.RATE_EXPORT_PER_DAY, 30),
    banAfterViolations: num(process.env.RATE_BAN_AFTER, 20),
    banMinutes: num(process.env.RATE_BAN_MINUTES, 15),
  },
};

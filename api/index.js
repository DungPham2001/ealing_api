/**
 * Vercel entry point: every request is rewritten here (see vercel.json).
 * The MongoDB connection is cached across invocations so warm functions reuse it.
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const app = require('../src/app');

mongoose.set('strictQuery', true);
mongoose.set('autoIndex', false); // indexes are created once with `npm run db:init`, not on every cold start
mongoose.set('bufferCommands', false);

let connecting = null;

async function connect() {
  if (mongoose.connection.readyState === 1) return;
  if (!connecting) {
    connecting = mongoose
      .connect(config.mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 })
      .catch((err) => {
        connecting = null; // allow the next request to retry
        throw err;
      });
  }
  await connecting;
}

module.exports = async (req, res) => {
  try {
    await connect();
  } catch (err) {
    console.error('database connection failed', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'The service is temporarily unavailable. Please try again in a few minutes.' } }));
  }
  return app(req, res);
};

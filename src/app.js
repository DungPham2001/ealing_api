const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const config = require('./config');
const { context } = require('./middleware/context');
const { limiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errors');
const api = require('./routes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Vercel / a proxy: req.ip is the real client IP (rate limiting)
app.use(helmet());
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, exposedHeaders: ['Retry-After', 'X-Request-Id', 'ETag'] }));
app.use(compression());
if (config.env !== 'test') app.use(morgan('tiny')); // method, url, status, time only: never record contents (spec 2.8)
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/v1', context, limiter, api);

app.use(notFound);
app.use(errorHandler);

module.exports = app;

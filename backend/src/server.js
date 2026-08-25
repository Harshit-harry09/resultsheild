'use strict';

const express    = require('express');
const { Pool }   = require('pg');
const Redis      = require('ioredis');
const client     = require('prom-client');

const resultRouter = require('./routes/result');
const metricsLib   = require('./lib/metrics');
const shutdown     = require('./lib/shutdown');

// ─── Environment ─────────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL  = process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/results';
const REDIS_URL     = process.env.REDIS_URL    || 'redis://localhost:6379';

// ─── Postgres pool ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Redis client ─────────────────────────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

// ─── Prometheus registry ─────────────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });
metricsLib.init(register);

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
const os  = require('os');
const HOSTNAME = process.env.HOSTNAME || os.hostname();

app.set('trust proxy', 1); // Trust Traefik reverse proxy to parse client IP
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('X-Served-By', HOSTNAME);
  next();
});

// Metrics middleware
app.use((req, res, next) => {
  const end = metricsLib.requestDurationHistogram.startTimer();
  res.on('finish', () => {
    // Only record for API routes to avoid cluttering metrics with /health
    if (req.path.startsWith('/api')) {
      end();
      metricsLib.requestCounter.inc({
        method: req.method,
        path: req.route ? req.route.path : req.path,
        status: res.statusCode
      });
    }
  });
  next();
});

// Inject shared resources into req context
app.use((req, _res, next) => {
  req.pool  = pool;
  req.redis = redis;
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
// shutdown.js sets this false on SIGTERM so Traefik stops routing immediately
let healthy = true;

app.get('/health', async (req, res) => {
  if (!healthy) {
    return res.status(503).json({ status: 'draining' });
  }
  try {
    // Verify Redis and Postgres are reachable
    await redis.ping();
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ── Prometheus metrics ────────────────────────────────────────────────────────
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ── Result API ────────────────────────────────────────────────────────────────
app.use('/api', resultRouter);

// ─── Start server ─────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  console.log(`[server] ResultShield backend listening on port ${PORT}`);
  console.log(`[server] DATABASE_URL: ${DATABASE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`[server] REDIS_URL:    ${REDIS_URL}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// healthRef wraps the `healthy` flag so shutdown.js can flip it without a
// circular require. The setter is defined on the object literal itself.
const healthRef = {
  get healthy() { return healthy; },
  set healthy(v) { healthy = v; },
};

shutdown.init({
  server:    httpServer,
  pool,
  redis,
  healthRef,
});

module.exports = { app };

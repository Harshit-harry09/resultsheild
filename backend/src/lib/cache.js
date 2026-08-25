'use strict';

/**
 * cache.js — Advanced Cache-Aside with XFetch, Redlock Quorum, and Circuit Breaker
 *
 * Implements:
 * 1. Probabilistic Early Recomputation (XFetch):
 *    Recomputes cache entries in the background before they expire using:
 *    -(delta * beta * ln(rand())) > (expireAt - now)
 *    Eliminating cache stampedes and wait times on hot keys.
 * 2. Distributed Redlock Consensus:
 *    Fault-tolerant locking across N Redis instances.
 * 3. Bulkheading & Circuit Breaker with Stale Fallback:
 *    Caps in-flight DB queries (bulkhead) and fails fast / serves stale data
 *    when PostgreSQL is degraded or unresponsive.
 */

const { Redlock }        = require('./redlock');
const { CircuitBreaker } = require('./circuitBreaker');
const metrics            = require('./metrics');

// ─── Config ───────────────────────────────────────────────────────────────────
const CACHE_TTL_SECONDS          = parseInt(process.env.CACHE_TTL_SECONDS          || '172800', 10);
const NEGATIVE_CACHE_TTL_SECONDS = parseInt(process.env.NEGATIVE_CACHE_TTL_SECONDS || '60',     10);
const STALE_CACHE_TTL_SECONDS    = 7 * 24 * 3600; // 7 days fallback cache
const STAMPEDE_LOCK_TTL_MS       = parseInt(process.env.STAMPEDE_LOCK_TTL_MS       || '5000',   10);
const STAMPEDE_WAIT_RETRY_MS     = parseInt(process.env.STAMPEDE_WAIT_RETRY_MS     || '100',    10);
const STAMPEDE_MAX_WAIT_MS       = parseInt(process.env.STAMPEDE_MAX_WAIT_MS       || '4500',   10);
const XFETCH_BETA                = parseFloat(process.env.XFETCH_BETA              || '1.0');

// Key builders
const cacheKey = (roll) => `cache:result:${roll}`;
const lockKey  = (roll) => `lock:result:${roll}`;
const staleKey = (roll) => `stale:result:${roll}`;

// Global Circuit Breaker instance for DB operations
const dbCircuitBreaker = new CircuitBreaker({
  name: 'postgres-db',
  timeoutMs: 1500,
  resetTimeoutMs: 8000,
  errorThresholdPct: 50,
  volumeThreshold: 5,
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT_DB_QUERIES || '10', 10),
});

// Map of in-flight background XFetch recomputations to prevent duplicate background workers
const inFlightRecomputations = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Direct Postgres query wrapped in Bulkhead and Circuit Breaker
 */
async function queryPostgresWithCircuitBreaker(pool, redis, rollNumber) {
  return await dbCircuitBreaker.execute(
    async () => {
      const { rows } = await pool.query(
        'SELECT roll_number, name, course, marks, total, percentage, status FROM results WHERE roll_number = $1',
        [rollNumber]
      );
      return rows[0] || null;
    },
    async (err) => {
      console.warn(`[circuit-breaker] Fallback triggered for roll ${rollNumber}: ${err.message}`);
      // Fallback: Serve stale data if available
      const staleData = await redis.get(staleKey(rollNumber));
      if (staleData) {
        const parsed = JSON.parse(staleData);
        parsed._isStale = true;
        return parsed;
      }
      return null;
    }
  );
}

/**
 * Writes computed data to primary cache and long-lived stale backup
 */
async function writeToCache(redis, rollNumber, data, deltaMs) {
  const ck = cacheKey(rollNumber);
  const sk = staleKey(rollNumber);

  if (data) {
    const payload = JSON.stringify({
      data,
      delta: deltaMs,
      expireAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    });
    await redis.set(ck, payload, 'EX', CACHE_TTL_SECONDS);
    // Write to stale backup
    await redis.set(sk, JSON.stringify(data), 'EX', STALE_CACHE_TTL_SECONDS);
  } else {
    // Negative caching for non-existent roll numbers
    const notFoundPayload = JSON.stringify({ _notFound: true });
    await redis.set(ck, notFoundPayload, 'EX', NEGATIVE_CACHE_TTL_SECONDS);
  }
}

/**
 * Non-blocking background recomputation via XFetch
 */
function recomputeInBackground(pool, redis, rollNumber, redlock) {
  if (inFlightRecomputations.has(rollNumber)) {
    return inFlightRecomputations.get(rollNumber);
  }

  const promise = (async () => {
    let lock = null;
    try {
      lock = await redlock.acquire(lockKey(rollNumber), STAMPEDE_LOCK_TTL_MS);
      if (!lock) return;

      const startTime = Date.now();
      const row = await queryPostgresWithCircuitBreaker(pool, redis, rollNumber);
      const deltaMs = Date.now() - startTime;

      await writeToCache(redis, rollNumber, row, deltaMs);
      console.log(`[xfetch] Proactively refreshed roll ${rollNumber} in background (${deltaMs}ms)`);
    } catch (err) {
      console.warn(`[xfetch] Background refresh failed for roll ${rollNumber}:`, err.message);
    } finally {
      if (lock) {
        try { await lock.release(); } catch (_) {}
      }
      inFlightRecomputations.delete(rollNumber);
    }
  })();

  inFlightRecomputations.set(rollNumber, promise);
  return promise;
}

// ─── Main Export ──────────────────────────────────────────────────────────────
/**
 * getResult(pool, redis, rollNumber, customRedlock)
 *
 * Returns the result row (with _cacheHit / _isStale flag), or null if not found.
 */
async function getResult(pool, redis, rollNumber, customRedlock = null) {
  const ck = cacheKey(rollNumber);
  const lk = lockKey(rollNumber);
  const redlock = customRedlock || new Redlock(redis);

  // ── 1. Check cache with XFetch probabilistic early recomputation ──────
  const cachedRaw = await redis.get(ck);
  if (cachedRaw) {
    metrics.cacheHitCounter.inc();
    const parsed = JSON.parse(cachedRaw);

    if (parsed._notFound) {
      return null;
    }

    const { data, delta, expireAt } = parsed;
    const now = Date.now();
    const timeToExpiryMs = expireAt ? expireAt - now : 0;
    const computeDelta = delta || 50;

    // XFetch check: should we recompute in the background before expiry?
    if (XFETCH_BETA > 0 && expireAt) {
      const xfetchThreshold = -(computeDelta * XFETCH_BETA * Math.log(Math.random() || 0.001));
      if (timeToExpiryMs <= 0 || xfetchThreshold > timeToExpiryMs) {
        recomputeInBackground(pool, redis, rollNumber, redlock);
      }
    }

    const returnObj = data || parsed;
    returnObj._cacheHit = true;
    return returnObj;
  }

  metrics.cacheMissCounter.inc();

  // ── 2. Cache miss — acquire Redlock distributed lock ──────────────────
  const lock = await redlock.acquire(lk, STAMPEDE_LOCK_TTL_MS);

  if (lock) {
    try {
      const startTime = Date.now();
      const row = await queryPostgresWithCircuitBreaker(pool, redis, rollNumber);
      const deltaMs = Date.now() - startTime;

      await writeToCache(redis, rollNumber, row, deltaMs);
      return row; // Cache miss served fresh
    } finally {
      await lock.release();
    }
  }

  // ── 3. Another replica holds the lock — wait for cache population ─────
  metrics.stampedeLockWaitCounter.inc();

  let waited = 0;
  while (waited < STAMPEDE_MAX_WAIT_MS) {
    const jitter = Math.floor(Math.random() * 30);
    const delay = STAMPEDE_WAIT_RETRY_MS + jitter;
    await sleep(delay);
    waited += delay;

    const populated = await redis.get(ck);
    if (populated) {
      metrics.cacheHitCounter.inc();
      const parsed = JSON.parse(populated);
      if (parsed._notFound) {
        return null;
      }
      const returnObj = parsed.data || parsed;
      returnObj._cacheHit = true;
      return returnObj;
    }
  }

  // ── 4. Safety valve on timeout ──────────────────────────────────────────
  console.warn(`[cache] Stampede lock wait timed out for roll ${rollNumber} after ${waited}ms`);
  const err = new Error('Database is under heavy load. Please retry.');
  err.statusCode = 503;
  throw err;
}

module.exports = {
  getResult,
  cacheKey,
  lockKey,
  staleKey,
  dbCircuitBreaker,
  recomputeInBackground,
};

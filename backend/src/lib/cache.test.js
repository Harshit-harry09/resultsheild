const test = require('node:test');
const assert = require('node:assert');
const RedisMock = require('ioredis-mock');
const { getResult, dbCircuitBreaker, cacheKey, staleKey } = require('./cache');
const { Redlock } = require('./redlock');
const { CircuitBreaker, STATE } = require('./circuitBreaker');
const metrics = require('./metrics');
const client = require('prom-client');
metrics.init(new client.Registry());

test('Advanced Cache, XFetch, Redlock, and Circuit Breaker', async (t) => {
  let redis;
  let pool;
  let queryCount = 0;

  t.beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    queryCount = 0;
    dbCircuitBreaker.state = STATE.CLOSED;
    dbCircuitBreaker.window = [];

    pool = {
      query: async (sql, params) => {
        queryCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (params[0] === '26099999') {
          return { rows: [] }; // not found sentinel
        }
        return { rows: [{ roll_number: params[0], name: 'Test Student' }] };
      },
    };
  });

  t.afterEach(() => {
    redis.disconnect();
  });

  await t.test('Cache miss (no lock contention): queries DB, populates cache and stale backup', async () => {
    const result = await getResult(pool, redis, '123');
    assert.strictEqual(result.name, 'Test Student');
    assert.strictEqual(result._cacheHit, undefined);
    assert.strictEqual(queryCount, 1);

    // Verify cache is populated with XFetch envelope
    const cached = await redis.get(cacheKey('123'));
    assert.ok(cached);
    const parsed = JSON.parse(cached);
    assert.strictEqual(parsed.data.name, 'Test Student');
    assert.ok(parsed.expireAt > Date.now());

    // Verify stale backup key populated
    const stale = await redis.get(staleKey('123'));
    assert.ok(stale);
    assert.strictEqual(JSON.parse(stale).name, 'Test Student');
  });

  await t.test('Cache hit: returns from cache without querying DB', async () => {
    const payload = JSON.stringify({
      data: { roll_number: '123', name: 'Cached Student' },
      delta: 20,
      expireAt: Date.now() + 100000,
    });
    await redis.set(cacheKey('123'), payload);

    const result = await getResult(pool, redis, '123');
    assert.strictEqual(result.name, 'Cached Student');
    assert.strictEqual(result._cacheHit, true);
    assert.strictEqual(queryCount, 0);
  });

  await t.test('Negative caching: non-existent roll number is cached and returns null', async () => {
    const result1 = await getResult(pool, redis, '26099999');
    assert.strictEqual(result1, null);
    assert.strictEqual(queryCount, 1);

    // Verify negative cache populated
    const cached = await redis.get(cacheKey('26099999'));
    assert.ok(cached);
    assert.strictEqual(JSON.parse(cached)._notFound, true);

    // Second request hits cache and does not query DB
    const result2 = await getResult(pool, redis, '26099999');
    assert.strictEqual(result2, null);
    assert.strictEqual(queryCount, 1);
  });

  await t.test('XFetch Early Recomputation: triggers background refresh near expiry', async () => {
    // Set a key with near-immediate expiry (triggers XFetch early recomputation)
    const payload = JSON.stringify({
      data: { roll_number: '123', name: 'Near Expiry Student' },
      delta: 5000,
      expireAt: Date.now() - 1,
    });
    await redis.set(cacheKey('123'), payload);

    const result = await getResult(pool, redis, '123');
    assert.strictEqual(result.name, 'Near Expiry Student');
    assert.strictEqual(result._cacheHit, true);

    // Wait for async background recomputation to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(queryCount, 1); // background refresh executed
  });

  await t.test('Redlock consensus: acquires lock, provides token, and releases cleanly', async () => {
    const redlock = new Redlock(redis);
    assert.strictEqual(redlock.quorum, 1);

    const lock = await redlock.acquire('test:resource', 2000);
    assert.ok(lock);
    assert.ok(lock.token);

    const val1 = await redis.get('test:resource');
    assert.strictEqual(val1, lock.token);

    await lock.release();
    const valAfter = await redis.get('test:resource');
    assert.strictEqual(valAfter, null);
  });

  await t.test('Circuit Breaker: trips on DB failure and serves stale fallback cache', async () => {
    // Populate stale backup cache first
    await redis.set(staleKey('999'), JSON.stringify({ roll_number: '999', name: 'Stale Student' }));

    // Simulate failing DB pool
    const brokenPool = {
      query: async () => {
        throw new Error('Database connection failed');
      },
    };

    const breaker = new CircuitBreaker({
      name: 'test-db',
      volumeThreshold: 2,
      errorThresholdPct: 50,
      timeoutMs: 50,
      resetTimeoutMs: 1000,
    });

    // Execute with fallback to stale cache
    const result = await breaker.execute(
      async () => brokenPool.query(),
      async () => {
        const stale = await redis.get(staleKey('999'));
        return JSON.parse(stale);
      }
    );

    assert.strictEqual(result.name, 'Stale Student');
  });
});

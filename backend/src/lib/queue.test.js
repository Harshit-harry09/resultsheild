const test = require('node:test');
const assert = require('node:assert');
const RedisMock = require('ioredis-mock');
const { handleRequest, onRequestComplete, COUNTER_KEY, QUEUE_KEY, ADMITTED_SET_KEY, MAX_CONCURRENT_ADMITTED } = require('./queue');
const metrics = require('./metrics');
const client = require('prom-client');
metrics.init(new client.Registry());

test('Queue and Admission Logic', async (t) => {
  let redis;

  t.beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
  });

  t.afterEach(() => {
    redis.disconnect();
  });

  await t.test('Fresh request (under capacity): admits immediately', async () => {
    const result = await handleRequest(redis, null);
    
    assert.strictEqual(result.queued, false);
    assert.ok(result.sessionToken);

    // Admitted count should be 1
    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, '1');

    // Token should be in admitted set
    const isMember = await redis.sismember(ADMITTED_SET_KEY, result.sessionToken);
    assert.strictEqual(isMember, 1);
  });

  await t.test('Fresh request (over capacity): queues with position', async () => {
    // Fill up the capacity
    const MAX_CAPACITY = MAX_CONCURRENT_ADMITTED;
    await redis.set(COUNTER_KEY, MAX_CAPACITY.toString());

    const result = await handleRequest(redis, null);
    
    assert.strictEqual(result.queued, true);
    assert.ok(result.sessionToken);
    assert.strictEqual(result.position, 1);
    assert.ok(result.estimatedWaitSeconds >= 0);

    // Queue depth should be 1
    const depth = await redis.zcard(QUEUE_KEY);
    assert.strictEqual(depth, 1);
    
    // Admitted count should not have increased
    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, MAX_CAPACITY.toString());
  });

  await t.test('Forged/Unknown token over capacity: does not bypass, queues properly', async () => {
    const MAX_CAPACITY = MAX_CONCURRENT_ADMITTED;
    await redis.set(COUNTER_KEY, MAX_CAPACITY.toString());

    const result = await handleRequest(redis, 'forged-token-xyz');
    
    assert.strictEqual(result.queued, true);
    assert.strictEqual(result.sessionToken, 'forged-token-xyz');
    assert.strictEqual(result.position, 1);

    const isMember = await redis.sismember(ADMITTED_SET_KEY, 'forged-token-xyz');
    assert.strictEqual(isMember, 0);
  });

  await t.test('Polling (queued token): returns updated position without changing count', async () => {
    const MAX_CAPACITY = MAX_CONCURRENT_ADMITTED;
    await redis.set(COUNTER_KEY, MAX_CAPACITY.toString());

    // Queue two requests
    const res1 = await handleRequest(redis, null);
    const res2 = await handleRequest(redis, null);

    assert.strictEqual(res1.position, 1);
    assert.strictEqual(res2.position, 2);

    // Poll the second request
    const pollRes2 = await handleRequest(redis, res2.sessionToken);
    assert.strictEqual(pollRes2.queued, true);
    assert.strictEqual(pollRes2.position, 2);
    
    // Count remains unchanged
    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, MAX_CAPACITY.toString());
  });

  await t.test('Polling (token admitted): removes from queue and admits', async () => {
    const MAX_CAPACITY = MAX_CONCURRENT_ADMITTED;
    await redis.set(COUNTER_KEY, MAX_CAPACITY.toString());

    // Queue a request
    const res = await handleRequest(redis, null);
    assert.strictEqual(res.queued, true);

    // Simulate capacity dropping
    await redis.decr(COUNTER_KEY);

    // Poll the queued request
    const pollRes = await handleRequest(redis, res.sessionToken);
    
    assert.strictEqual(pollRes.queued, false);
    assert.strictEqual(pollRes.sessionToken, res.sessionToken);

    // It should be removed from the queue
    const depth = await redis.zcard(QUEUE_KEY);
    assert.strictEqual(depth, 0);

    // Admitted count should go back to MAX_CAPACITY
    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, MAX_CAPACITY.toString());
  });

  await t.test('Completion: decrements admitted_count correctly', async () => {
    await redis.set(COUNTER_KEY, '5');
    await redis.sadd(ADMITTED_SET_KEY, 'some-token');

    await onRequestComplete(redis, 'some-token');

    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, '4');

    const isMember = await redis.sismember(ADMITTED_SET_KEY, 'some-token');
    assert.strictEqual(isMember, 0);
  });

  await t.test('Completion: does not decrement below zero', async () => {
    await redis.set(COUNTER_KEY, '0');

    await onRequestComplete(redis, 'some-token');

    const count = await redis.get(COUNTER_KEY);
    assert.strictEqual(count, '0');
  });
});

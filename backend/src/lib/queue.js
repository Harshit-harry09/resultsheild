'use strict';

/**
 * queue.js — Redis-backed virtual waiting room
 *
 * All state lives in Redis (rules.md Section 3, techspec.md Section 6.2):
 *   queue:waiting            sorted set, member=sessionToken, score=microsecond timestamp
 *   capacity:admitted_count  integer counter of currently-admitted concurrent sessions
 *   capacity:admitted_set    set of active admitted session tokens
 *
 * All admission checks, additions, and capacity transitions are performed atomically
 * via Redis Lua scripts to eliminate TOCTOU race conditions across backend replicas.
 */

const { v4: uuidv4 } = require('uuid');
const metrics         = require('./metrics');

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_CONCURRENT_ADMITTED = parseInt(
  process.env.MAX_CONCURRENT_ADMITTED || '1000', 10
);

// ─── Redis key names ──────────────────────────────────────────────────────────
const QUEUE_KEY        = 'queue:waiting';
const COUNTER_KEY      = 'capacity:admitted_count';
const ADMITTED_SET_KEY = 'capacity:admitted_set';

// Sequence counter to guarantee strict FIFO ordering within the same millisecond
let seqCounter = 0;
function getMonotonicScore() {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() * 1000 + seqCounter;
}

// ─── Estimated wait computation ───────────────────────────────────────────────
function estimateWaitSeconds(position) {
  return Math.max(0, Math.ceil(position / 2));
}

// ─── Lua Scripts ──────────────────────────────────────────────────────────────
const HANDLE_REQUEST_LUA = `
local counterKey = KEYS[1]
local queueKey = KEYS[2]
local admittedSetKey = KEYS[3]

local token = ARGV[1]
local maxAdmitted = tonumber(ARGV[2])
local score = tonumber(ARGV[3])
local newToken = ARGV[4]

-- 1. If token exists and is in the admitted set, allow request
if token ~= '' and redis.call('SISMEMBER', admittedSetKey, token) == 1 then
  return {0, token, 0}
end

-- 2. Check if token is in the queue
local rank = false
if token ~= '' then
  rank = redis.call('ZRANK', queueKey, token)
end

local currentAdmitted = tonumber(redis.call('GET', counterKey) or '0')

if not rank then
  -- Fresh request or unrecognized token
  local assignToken = token
  if assignToken == '' then
    assignToken = newToken
  end

  if currentAdmitted < maxAdmitted then
    redis.call('INCR', counterKey)
    redis.call('SADD', admittedSetKey, assignToken)
    return {0, assignToken, 0}
  else
    redis.call('ZADD', queueKey, 'NX', score, assignToken)
    local newRank = redis.call('ZRANK', queueKey, assignToken)
    local pos = 1
    if newRank then
      pos = tonumber(newRank) + 1
    end
    return {1, assignToken, pos}
  end
else
  -- In queue: only promote to admitted if at head of queue (rank 0) AND capacity available
  if tonumber(rank) == 0 and currentAdmitted < maxAdmitted then
    redis.call('ZREM', queueKey, token)
    redis.call('INCR', counterKey)
    redis.call('SADD', admittedSetKey, token)
    return {0, token, 0}
  else
    return {1, token, tonumber(rank) + 1}
  end
end
`;

const COMPLETE_REQUEST_LUA = `
local counterKey = KEYS[1]
local admittedSetKey = KEYS[2]
local token = ARGV[1]

if token ~= '' then
  redis.call('SREM', admittedSetKey, token)
end

local current = tonumber(redis.call('GET', counterKey) or '0')
if current > 0 then
  redis.call('DECR', counterKey)
end
return 1
`;

// ─── handleRequest ────────────────────────────────────────────────────────────
/**
 * Decides whether to ADMIT or QUEUE the incoming request atomically.
 *
 * @param {Redis}       redis
 * @param {string|null} sessionToken  Value of X-Session-Token header (null if absent)
 * @returns {Promise<{ queued: boolean, sessionToken: string, position?: number, estimatedWaitSeconds?: number }>}
 */
async function handleRequest(redis, sessionToken) {
  const token = sessionToken || '';
  const newToken = uuidv4();
  const score = getMonotonicScore();

  const res = await redis.eval(
    HANDLE_REQUEST_LUA,
    3,
    COUNTER_KEY,
    QUEUE_KEY,
    ADMITTED_SET_KEY,
    token,
    MAX_CONCURRENT_ADMITTED,
    score,
    newToken
  );

  const isQueued = res[0] === 1;
  const returnedToken = res[1];
  const position = Number(res[2]);

  if (metrics.queueDepthGauge) {
    const depth = await redis.zcard(QUEUE_KEY);
    metrics.queueDepthGauge.set(depth);
  }

  if (isQueued) {
    return {
      queued:               true,
      sessionToken:         returnedToken,
      position,
      estimatedWaitSeconds: estimateWaitSeconds(position),
    };
  }

  if (metrics.queueAdmittedCounter && sessionToken) {
    metrics.queueAdmittedCounter.inc();
  }

  return {
    queued:       false,
    sessionToken: returnedToken,
  };
}

// ─── onRequestComplete ────────────────────────────────────────────────────────
/**
 * Called when request finishes — releases the admitted slot atomically.
 */
async function onRequestComplete(redis, sessionToken) {
  const token = sessionToken || '';
  await redis.eval(
    COMPLETE_REQUEST_LUA,
    2,
    COUNTER_KEY,
    ADMITTED_SET_KEY,
    token
  );
}

module.exports = {
  handleRequest,
  onRequestComplete,
  QUEUE_KEY,
  COUNTER_KEY,
  ADMITTED_SET_KEY,
  MAX_CONCURRENT_ADMITTED,
};

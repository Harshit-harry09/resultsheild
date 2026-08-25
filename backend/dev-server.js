#!/usr/bin/env node
/**
 * dev-server.js — Full local dev mode (no Docker, no external services)
 *
 * Uses:
 *   - better-sqlite3 as a local database (auto-seeded with 200 sample records)
 *   - In-memory Redis shim (Map + Set) for cache + queue
 *   - All the same business logic as production (cache.js, queue.js, etc.)
 *
 * Run with:
 *   node dev-server.js
 *   (Then in another terminal: cd frontend && npm run dev)
 */
'use strict';

const express   = require('express');
const path      = require('path');
const crypto    = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── In-memory Redis shim ─────────────────────────────────────────────────────
// Implements the subset of ioredis API used by cache.js and queue.js:
//   get, set (with EX), del, incr, decr, zadd (NX), zrank, zrem, zcard, pipeline
class MockRedis {
  constructor() {
    this.store   = new Map();   // key → {value, expiresAt}
    this.zsets   = new Map();   // key → Map(member → score)
    this.listeners = {};
  }

  _isExpired(entry) {
    return entry.expiresAt && Date.now() > entry.expiresAt;
  }

  _get(key) {
    const entry = this.store.get(key);
    if (!entry || this._isExpired(entry)) { this.store.delete(key); return null; }
    return entry.value;
  }

  async get(key)   { return this._get(key); }
  async ping()     { return 'PONG'; }

  async set(key, value, ...args) {
    let expiresAt = null;
    for (let i = 0; i < args.length - 1; i++) {
      if (typeof args[i] === 'string' && args[i].toUpperCase() === 'EX') {
        expiresAt = Date.now() + parseInt(args[i + 1], 10) * 1000;
      }
      if (typeof args[i] === 'string' && args[i].toUpperCase() === 'NX') {
        if (this._get(key) !== null) return null;  // key exists, NX fails
      }
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key)   { this.store.delete(key); return 1; }

  async incr(key) {
    const v = parseInt(this._get(key) || '0', 10) + 1;
    this.store.set(key, { value: String(v), expiresAt: null });
    return v;
  }

  async decr(key) {
    const v = Math.max(0, parseInt(this._get(key) || '0', 10) - 1);
    this.store.set(key, { value: String(v), expiresAt: null });
    return v;
  }

  async zadd(key, flagOrScore, scoreOrMember, member) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    const zset = this.zsets.get(key);
    // Handle both (key, score, member) and (key, 'NX', score, member)
    let score, mem;
    if (typeof flagOrScore === 'string' && flagOrScore.toUpperCase() === 'NX') {
      score = scoreOrMember;
      mem   = member;
      if (zset.has(mem)) return 0;
    } else {
      score = flagOrScore;
      mem   = scoreOrMember;
    }
    zset.set(mem, score);
    return 1;
  }

  async zrank(key, member) {
    const zset = this.zsets.get(key);
    if (!zset || !zset.has(member)) return null;
    const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]);
    return sorted.findIndex(([m]) => m === member);
  }

  async zrem(key, member) {
    const zset = this.zsets.get(key);
    if (zset) { zset.delete(member); return 1; }
    return 0;
  }

  async zcard(key) {
    const zset = this.zsets.get(key);
    return zset ? zset.size : 0;
  }

  pipeline() {
    const cmds = [];
    const self = this;
    const p = {
      set:  (...args) => { cmds.push(['set',  ...args]); return p; },
      get:  (...args) => { cmds.push(['get',  ...args]); return p; },
      del:  (...args) => { cmds.push(['del',  ...args]); return p; },
      incr: (...args) => { cmds.push(['incr', ...args]); return p; },
      async exec() {
        const results = [];
        for (const [cmd, ...args] of cmds) results.push(await self[cmd](...args));
        return results;
      },
    };
    return p;
  }

  on(event, cb) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
    return this;
  }

  async quit() { return 'OK'; }
}

// ─── SQLite database ──────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE results (
    roll_number  TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    course       TEXT NOT NULL,
    marks        TEXT NOT NULL,
    total        INTEGER NOT NULL,
    percentage   REAL NOT NULL,
    status       TEXT NOT NULL
  );
`);

// Seed 200 sample records (much faster than 50k for dev)
const COURSES  = ['Science', 'Commerce', 'Arts'];
const SUBJECTS = {
  Science:  ['maths', 'physics', 'chemistry', 'biology', 'english'],
  Commerce: ['accountancy', 'businessStudies', 'economics', 'maths', 'english'],
  Arts:     ['history', 'geography', 'politicalScience', 'sociology', 'english'],
};
const NAMES = [
  'Aarav Singh','Aditi Sharma','Akash Gupta','Anjali Patel','Arjun Kumar',
  'Bhavya Mehta','Chetan Verma','Deepika Jain','Divya Nair','Harsh Agarwal',
  'Ishaan Reddy','Kavya Iyer','Kiran Pillai','Lakshmi Das','Manish Tiwari',
  'Meera Pandey','Mohan Sinha','Nandita Rao','Nikhil Dubey','Priya Kapoor',
  'Rahul Mishra','Ravi Chauhan','Rohini Bhatt','Sakshi Garg','Sanjay Desai',
  'Shreya Varma','Simran Khanna','Sneha Joshi','Suresh Thakur','Tanvi Srivastava',
];

const insert = db.prepare(`
  INSERT INTO results (roll_number, name, course, marks, total, percentage, status)
  VALUES (@roll_number, @name, @course, @marks, @total, @percentage, @status)
`);

const insertMany = db.transaction((records) => {
  for (const r of records) insert.run(r);
});

const records = [];
for (let i = 1; i <= 200; i++) {
  const rollNumber = String(26010000 + i);
  const course = COURSES[i % 3];
  const subjects = SUBJECTS[course];
  const marks = {};
  for (const s of subjects) marks[s] = Math.floor(Math.random() * 101);
  const total = Object.values(marks).reduce((a, b) => a + b, 0);
  const max   = subjects.length * 100;
  const percentage = parseFloat(((total / max) * 100).toFixed(2));
  records.push({
    roll_number: rollNumber,
    name: NAMES[(i - 1) % NAMES.length],
    course,
    marks: JSON.stringify(marks),
    total,
    percentage,
    status: percentage >= 33 ? 'PASS' : 'FAIL',
  });
}
insertMany(records);
console.log(`[dev] SQLite seeded with ${records.length} records (rolls 26010001–26010200)`);

// Mock pg Pool that delegates to SQLite
class MockPool {
  async query(sql, params) {
    if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
    const stmt = db.prepare(sql.replace(/\$\d+/g, (m, offset, str) => '?'));
    const rows = stmt.all(...(params || []));
    // Parse JSON marks column
    return { rows: rows.map(r => ({ ...r, marks: typeof r.marks === 'string' ? JSON.parse(r.marks) : r.marks })) };
  }
  async end() {}
}

// ─── Override environment vars before requiring app modules ───────────────────
process.env.DATABASE_URL  = 'sqlite:local';
process.env.REDIS_URL     = 'memory:local';
process.env.PORT          = String(PORT);
process.env.MAX_CONCURRENT_ADMITTED       = '10';  // lower for demo
process.env.RATE_LIMIT_UNAUTHENTICATED_RPM = '60'; // relaxed for dev
process.env.STAMPEDE_MAX_WAIT_MS          = '4500';
process.env.CACHE_TTL_SECONDS             = '172800';
process.env.SHUTDOWN_GRACE_MS             = '3000';

// ─── Create shared instances (bypassing real DB/Redis) ────────────────────────
const redis = new MockRedis();
const pool  = new MockPool();

// ─── Patch require so our lib files get the mock instances ────────────────────
// We rebuild the minimal logic inline rather than monkey-patching modules,
// to keep dev-server.js self-contained.

const { v4: uuidv4 } = require('uuid');

// Inline cache (same logic as lib/cache.js, uses local `redis` and `pool`)
const CACHE_TTL         = parseInt(process.env.CACHE_TTL_SECONDS, 10);
const STAMPEDE_LOCK_TTL = parseInt(process.env.STAMPEDE_LOCK_TTL_SECONDS || '5', 10);
const STAMPEDE_RETRY_MS = 100;
const STAMPEDE_MAX_MS   = parseInt(process.env.STAMPEDE_MAX_WAIT_MS, 10);

async function getResult(rollNumber) {
  const ck = `cache:result:${rollNumber}`;
  const lk = `lock:result:${rollNumber}`;

  const cached = await redis.get(ck);
  if (cached) {
    const p = JSON.parse(cached); p._cacheHit = true; return p;
  }

  const lockAcquired = await redis.set(lk, '1', 'NX', 'EX', STAMPEDE_LOCK_TTL);
  if (lockAcquired === 'OK') {
    try {
      const { rows } = await pool.query(
        'SELECT roll_number, name, course, marks, total, percentage, status FROM results WHERE roll_number = $1',
        [rollNumber]
      );
      const row = rows[0] || null;
      if (row) await redis.set(ck, JSON.stringify(row), 'EX', CACHE_TTL);
      return row;
    } finally {
      await redis.del(lk);
    }
  }

  // Wait for lock holder
  let waited = 0;
  while (waited < STAMPEDE_MAX_MS) {
    await new Promise(r => setTimeout(r, STAMPEDE_RETRY_MS));
    waited += STAMPEDE_RETRY_MS;
    const populated = await redis.get(ck);
    if (populated) { const p = JSON.parse(populated); p._cacheHit = true; return p; }
  }

  // Safety valve
  const { rows } = await pool.query(
    'SELECT roll_number, name, course, marks, total, percentage, status FROM results WHERE roll_number = $1',
    [rollNumber]
  );
  const row = rows[0] || null;
  if (row) await redis.set(ck, JSON.stringify(row), 'EX', CACHE_TTL);
  return row;
}

// Inline queue (same logic as lib/queue.js, uses local `redis`)
const MAX_ADMITTED = parseInt(process.env.MAX_CONCURRENT_ADMITTED, 10);
const QUEUE_KEY    = 'queue:waiting';
const COUNTER_KEY  = 'capacity:admitted_count';

async function handleQueueRequest(sessionToken) {
  if (!sessionToken) {
    const newToken  = uuidv4();
    const admitted  = await redis.incr(COUNTER_KEY);
    if (admitted <= MAX_ADMITTED) return { queued: false, sessionToken: newToken };
    await redis.decr(COUNTER_KEY);
    await redis.zadd(QUEUE_KEY, 'NX', Date.now(), newToken);
    const rank     = await redis.zrank(QUEUE_KEY, newToken);
    const position = (rank ?? 0) + 1;
    return { queued: true, sessionToken: newToken, position, estimatedWaitSeconds: Math.ceil(position / 2) };
  }

  const rank = await redis.zrank(QUEUE_KEY, sessionToken);
  if (rank === null) return { queued: false, sessionToken };

  const admittedRaw = await redis.get(COUNTER_KEY);
  const admitted = parseInt(admittedRaw || '0', 10);
  if (admitted < MAX_ADMITTED) {
    await redis.zrem(QUEUE_KEY, sessionToken);
    await redis.incr(COUNTER_KEY);
    return { queued: false, sessionToken };
  }

  return { queued: true, sessionToken, position: rank + 1, estimatedWaitSeconds: Math.ceil((rank + 1) / 2) };
}

async function onRequestComplete() {
  const current = parseInt((await redis.get(COUNTER_KEY)) || '0', 10);
  if (current > 0) await redis.decr(COUNTER_KEY);
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve built frontend (or redirect if not built yet)
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
const fs = require('fs');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// CORS for frontend dev server (Vite runs on :5173)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  next();
});

// Health
app.get('/health', async (_req, res) => {
  await redis.ping();
  res.json({ status: 'ok', mode: 'dev (SQLite + in-memory Redis)' });
});

// Metrics (stub)
app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`# ResultShield dev mode — real metrics require Docker stack\n`);
});

// Rate limit (simple, tokenless only)
const RATE_RPM  = parseInt(process.env.RATE_LIMIT_UNAUTHENTICATED_RPM, 10);
const rateMap   = new Map();
function rateLimitCheck(ip) {
  const now     = Date.now();
  const window  = 60_000;
  const entry   = rateMap.get(ip) || { count: 0, reset: now + window };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + window; }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count <= RATE_RPM;
}

// Result endpoint
app.get('/api/result/:rollNumber', async (req, res) => {
  const { rollNumber } = req.params;
  const sessionToken   = req.headers['x-session-token'] || null;

  if (!/^[0-9]{8}$/.test(rollNumber)) {
    return res.status(400).json({ status: 'error', message: 'Invalid roll number format. Must be exactly 8 digits.' });
  }

  // Rate limit only tokenless
  if (!sessionToken && !rateLimitCheck(req.ip)) {
    return res.status(429).json({ status: 'error', message: 'Too many requests. Please wait and try again.' });
  }

  try {
    const admission = await handleQueueRequest(sessionToken);
    if (admission.queued) {
      return res.status(202).json({
        status:               'queued',
        sessionToken:         admission.sessionToken,
        position:             admission.position,
        estimatedWaitSeconds: admission.estimatedWaitSeconds,
      });
    }

    try {
      const result = await getResult(rollNumber);
      if (!result) {
        return res.status(200).json({ status: 'error', message: 'Roll number not found' });
      }
      return res.status(200).json({
        status: 'ok',
        cache:  result._cacheHit ? 'hit' : 'miss',
        data: {
          rollNumber:   result.roll_number,
          name:         result.name,
          course:       result.course,
          marks:        result.marks,
          total:        result.total,
          percentage:   parseFloat(result.percentage),
          resultStatus: result.status,
        },
      });
    } finally {
      await onRequestComplete();
    }
  } catch (err) {
    console.error('[dev] Error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// SPA fallback for built frontend
if (fs.existsSync(distPath)) {
  app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        ResultShield — Dev Mode (No Docker needed)     ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║  Backend API  : http://localhost:${PORT}/api           ║`);
  console.log(`║  Health       : http://localhost:${PORT}/health        ║`);
  console.log('║                                                       ║');
  console.log('║  Database     : SQLite in-memory (200 records)        ║');
  console.log('║  Cache        : In-memory Redis shim                  ║');
  console.log('║  Valid rolls  : 26010001 – 26010200                   ║');
  console.log('║  Not-found    : 26099999                              ║');
  console.log('║                                                       ║');
  console.log('║  FRONTEND: run in a separate terminal:                ║');
  console.log('║    cd frontend && npm run dev                         ║');
  console.log('║    → http://localhost:5173                            ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
});

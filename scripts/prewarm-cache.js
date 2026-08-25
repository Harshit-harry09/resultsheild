#!/usr/bin/env node
/**
 * prewarm-cache.js — Populate Redis with all synthetic results before an experiment.
 *
 * ORDERING CONSTRAINT (tracker.md Section 1):
 *   Run db/seed/generate-synthetic-results.js FIRST.
 *   This script pre-warms against the general pool only (26010001–26059999).
 *   The reserved-cold range (26099001–26099100) is intentionally NOT pre-warmed
 *   so it can demonstrate the stampede lock live (Demo Part 5b, appflow.md Section 7).
 *
 * Cache TTL: CACHE_TTL_SECONDS = 172800 (48h) per rules.md Section 2.
 *   This covers an overnight gap between pre-warming and judging.
 *   If more than 48h passes, re-run this script.
 */

'use strict';

const { Client }  = require('pg');
const Redis       = require('ioredis');

const DATABASE_URL      = process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/results';
const REDIS_URL         = process.env.REDIS_URL    || 'redis://localhost:6379';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '172800', 10);
const BATCH_SIZE        = 200;  // pipeline batch size

const cacheKey = (roll) => `cache:result:${roll}`;

async function main() {
  const db    = new Client({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL);

  await db.connect();
  console.log('[prewarm] Connected to Postgres and Redis');
  console.log(`[prewarm] Cache TTL: ${CACHE_TTL_SECONDS}s (${(CACHE_TTL_SECONDS/3600).toFixed(1)}h)`);

  // Fetch only the general pool — exclude reserved cold range
  const { rows } = await db.query(`
    SELECT roll_number, name, course, marks, total, percentage, status
    FROM results
    WHERE roll_number >= '26010001' AND roll_number <= '26059999'
    ORDER BY roll_number
  `);

  console.log(`[prewarm] Found ${rows.length} records in general pool to pre-warm`);

  let warmed = 0;
  let pipeline = redis.pipeline();

  for (const row of rows) {
    const payload = JSON.stringify(row);
    pipeline.set(cacheKey(row.roll_number), payload, 'EX', CACHE_TTL_SECONDS);
    warmed++;

    if (warmed % BATCH_SIZE === 0) {
      await pipeline.exec();
      pipeline = redis.pipeline();
      process.stdout.write(`\r  Pre-warmed ${warmed}/${rows.length} keys …`);
    }
  }

  // Flush remaining
  if (warmed % BATCH_SIZE !== 0) {
    await pipeline.exec();
  }

  console.log(`\n[prewarm] Done. ${warmed} keys set in Redis with ${CACHE_TTL_SECONDS}s TTL.`);
  console.log('[prewarm] Reserved cold range 26099001–26099100: NOT pre-warmed (intentional).');
  console.log('[prewarm] Sentinel 26099999: not in DB (intentional).');

  await db.end();
  await redis.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error('[prewarm] Failed:', err.message);
  process.exit(1);
});

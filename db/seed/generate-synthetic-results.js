#!/usr/bin/env node
/**
 * generate-synthetic-results.js
 *
 * Produces 50,000 synthetic exam result records per schema.md Section 3.
 *
 * Roll number ranges:
 *   26010001–26059999  General pool (~50,000) — pre-warmed in normal experiments
 *   26099001–26099100  Reserved cold (100 records) — NEVER pre-warmed, for stampede demo
 *   26099999           Sentinel — NOT inserted, for reliable Not-found demo
 *
 * Ordering constraint (from tracker.md Section 1):
 *   Run THIS script BEFORE scripts/prewarm-cache.js
 */

'use strict';

const { Client } = require('pg');

// ─── Config ────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/results';
const BATCH_SIZE   = 500;      // rows per INSERT for speed

// Pass threshold: percentage >= 33 → PASS (rules.md Section 1)
const PASS_THRESHOLD = 33;

// Subject sets per course (marks out of 100 each)
const COURSE_SUBJECTS = {
  Science:  ['maths', 'physics', 'chemistry', 'biology', 'english'],
  Commerce: ['accountancy', 'businessStudies', 'economics', 'maths', 'english'],
  Arts:     ['history', 'geography', 'politicalScience', 'sociology', 'english'],
};

const COURSES = Object.keys(COURSE_SUBJECTS);

// ─── Helpers ────────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function firstName() {
  const names = [
    'Aarav','Aditi','Akash','Anjali','Arjun','Bhavya','Chetan','Deepika',
    'Divya','Harsh','Ishaan','Kavya','Kiran','Lakshmi','Manish','Meera',
    'Mohan','Nandita','Nikhil','Pari','Priya','Rahul','Ravi','Rohini',
    'Sakshi','Sanjay','Shreya','Simran','Sneha','Suresh','Tanvi','Usha',
    'Varun','Vijay','Vishal','Yamini','Yash','Zara',
  ];
  return pickRandom(names);
}

function lastName() {
  const names = [
    'Agarwal','Bhatt','Chauhan','Das','Desai','Dubey','Garg','Gupta',
    'Iyer','Jain','Joshi','Kapoor','Khanna','Kumar','Mehta','Mishra',
    'Nair','Pandey','Patel','Pillai','Rao','Reddy','Sharma','Singh',
    'Sinha','Srivastava','Thakur','Tiwari','Varma','Verma',
  ];
  return pickRandom(names);
}

function generateMarks(course) {
  const subjects = COURSE_SUBJECTS[course];
  const marks = {};
  for (const subject of subjects) {
    marks[subject] = rand(0, 100);
  }
  return marks;
}

function buildRecord(rollNumber, nameOverride) {
  const course      = pickRandom(COURSES);
  const marks       = generateMarks(course);
  const total       = Object.values(marks).reduce((a, b) => a + b, 0);
  const maxPossible = COURSE_SUBJECTS[course].length * 100;
  const percentage  = parseFloat(((total / maxPossible) * 100).toFixed(2));
  const status      = percentage >= PASS_THRESHOLD ? 'PASS' : 'FAIL';
  const name        = nameOverride || `${firstName()} ${lastName()}`;

  return { rollNumber: String(rollNumber), name, course, marks, total, percentage, status };
}

// ─── Batch insert helper ─────────────────────────────────────────────────────
async function insertBatch(client, records) {
  if (records.length === 0) return;

  const values = [];
  const params = [];
  let   idx    = 1;

  for (const r of records) {
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      r.rollNumber,
      r.name,
      r.course,
      JSON.stringify(r.marks),
      r.total,
      r.percentage,
      r.status
    );
  }

  const sql = `
    INSERT INTO results (roll_number, name, course, marks, total, percentage, status)
    VALUES ${values.join(', ')}
    ON CONFLICT (roll_number) DO NOTHING
  `;
  await client.query(sql, params);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to Postgres.');

  let batch   = [];
  let total   = 0;

  // ── General pool: 26010001 – 26059999 (~50,000 records)
  console.log('Seeding general pool 26010001–26059999 …');
  for (let i = 1; i <= 50000; i++) {
    const rollNumber = 26010000 + i;
    batch.push(buildRecord(rollNumber, `Student ${i}`));

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(client, batch);
      total += batch.length;
      process.stdout.write(`\r  Inserted ${total} records …`);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(client, batch);
    total += batch.length;
    batch = [];
  }
  console.log(`\n  General pool done: ${total} records.`);

  // ── Reserved cold range: 26099001 – 26099100 (100 records, NEVER pre-warmed)
  console.log('Seeding reserved-cold range 26099001–26099100 …');
  for (let i = 1; i <= 100; i++) {
    const rollNumber = 26099000 + i;
    batch.push(buildRecord(rollNumber, `ColdStudent ${i}`));
  }
  await insertBatch(client, batch);
  console.log(`  Reserved cold done: ${batch.length} records.`);
  total += batch.length;
  batch = [];

  // ── Sentinel 26099999 — deliberately NOT inserted
  console.log('Sentinel 26099999 intentionally skipped (reliable not-found).');

  // ── Final count
  const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM results');
  console.log(`\nSeed complete. Total rows in DB: ${rows[0].cnt}`);
  console.log('Roll number ranges:');
  console.log('  General pool   : 26010001–26059999');
  console.log('  Reserved cold  : 26099001–26099100 (not pre-warmed)');
  console.log('  Sentinel        : 26099999 (not in DB)');

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

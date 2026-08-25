#!/usr/bin/env node
/**
 * generate-roll-numbers.js
 * Generates k6/data/roll-numbers.json for use in k6 load test scripts.
 * Run this once before running any k6 scripts.
 */
const fs = require('fs');
const path = require('path');

const general = [];
for (let i = 1; i <= 50000; i++) general.push(String(26010000 + i));

const cold = [];
for (let i = 1; i <= 100; i++) cold.push(String(26099000 + i));

const output = {
  general,            // 50,000 pre-warmed roll numbers
  cold,               // 100 never-pre-warmed (for stampede demo)
  sentinel: '26099999', // not in DB — reliable not-found
};

const outPath = path.join(__dirname, 'data', 'roll-numbers.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  general: ${general.length} roll numbers`);
console.log(`  cold:    ${cold.length} roll numbers`);

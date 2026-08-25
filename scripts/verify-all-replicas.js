#!/usr/bin/env node
/**
 * verify-all-replicas.js
 * Sends rapid requests to http://localhost/api/result/:roll
 * Tracks X-Served-By headers until EVERY running backend replica has received traffic.
 */

const http = require('http');

const TARGET_URL = process.env.TARGET_URL || 'http://localhost/api/result/26010001';
const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

const replicaHits = new Map();
let totalRequests = 0;

console.log('==> Testing replica distribution across Traefik load balancer...');

function sendRequest() {
  return new Promise((resolve) => {
    const req = http.get(TARGET_URL, { agent }, (res) => {
      totalRequests++;
      const servedBy = res.headers['x-served-by'] || 'unknown';
      replicaHits.set(servedBy, (replicaHits.get(servedBy) || 0) + 1);

      res.resume(); // consume response body
      res.on('end', () => resolve(servedBy));
    });

    req.on('error', (err) => {
      console.error(`Request failed: ${err.message}`);
      resolve(null);
    });
  });
}

async function run() {
  const targetReplicas = 4; // Expected backend replicas
  const startTime = Date.now();

  console.log(`Sending requests until all ${targetReplicas} replicas receive traffic...\n`);

  for (let batch = 0; batch < 50; batch++) {
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(sendRequest());
    }
    await Promise.all(promises);

    process.stdout.write(`\r[${totalRequests} reqs] Discovered ${replicaHits.size} / ${targetReplicas} replicas...`);

    if (replicaHits.size >= targetReplicas && totalRequests >= 100) {
      break;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n\n================================================================');
  console.log('                REPLICA HIT DISTRIBUTION REPORT                 ');
  console.log('================================================================');
  console.log(` Total Requests Tested : ${totalRequests}`);
  console.log(` Unique Replicas Hit  : ${replicaHits.size}`);
  console.log(` Test Duration         : ${duration}s`);
  console.log('----------------------------------------------------------------');
  console.log(' Replica Container ID    Requests Served    Traffic Share');
  console.log('----------------------------------------------------------------');

  for (const [replica, count] of replicaHits.entries()) {
    const pct = ((count / totalRequests) * 100).toFixed(1);
    console.log(` ${replica.padEnd(23)} ${String(count).padStart(12)} reqs     ${pct.padStart(6)}%`);
  }
  console.log('================================================================\n');

  if (replicaHits.size >= targetReplicas) {
    console.log('✅ SUCCESS: Every single backend replica is actively handling traffic!');
  } else {
    console.log(`⚠️ Note: Detected ${replicaHits.size} replicas active.`);
  }
}

run();

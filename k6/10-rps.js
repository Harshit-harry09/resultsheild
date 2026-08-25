/**
 * k6/10-rps.js — Controlled 10 Requests Per Second (10 RPS) Load Test
 *
 * Uses `constant-arrival-rate` executor (open-model testing) to guarantee
 * an exact rate of 10 requests per second.
 *
 * Each simulated user session passes an X-Session-Token header to interact
 * with ResultShield's admission queue and Redis cache tier.
 *
 * Real-time Grafana Dashboard:
 * http://localhost:3001/d/resultshield-main/resultshield-e28094-load-resilience-dashboard
 */

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Custom Metrics ───────────────────────────────────────────────────────────
const errorRate = new Rate('error_rate');
const successfulReqs = new Counter('successful_requests');
const queuedReqs = new Counter('queued_requests');
const resultLatencyTrend = new Trend('result_api_latency');

const BASE_URL = __ENV.TARGET_URL || 'http://localhost';

// ─── Load Synthetic Test Data ────────────────────────────────────────────────
let rollNumbers = [];
try {
  const data = JSON.parse(open('./data/roll-numbers.json'));
  rollNumbers = data.general || [];
} catch (_err) {
  for (let i = 1; i <= 50000; i++) {
    rollNumbers.push(String(26010000 + i));
  }
}

// ─── Workload Model: Exact 10 RPS for 30 Seconds ─────────────────────────────
export const options = {
  scenarios: {
    ten_rps_sustained: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: __ENV.TEST_DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    error_rate: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
  discardResponseBodies: false,
};

export default function () {
  const vuId = __VU;
  const iter = __ITER;
  const randomIndex = Math.floor(Math.random() * rollNumbers.length);
  const rollNumber = rollNumbers[randomIndex] || '26010001';

  // Generate distinct session token per user session to exercise admission queue
  const sessionToken = `vu-${vuId}-sess-${iter}`;

  const params = {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Token': sessionToken,
    },
    tags: { name: 'GetResult' },
    timeout: '5s',
  };

  const startTime = Date.now();
  const res = http.get(`${BASE_URL}/api/result/${rollNumber}`, params);
  const latency = Date.now() - startTime;
  resultLatencyTrend.add(latency);

  const isSuccess = res.status === 200;
  const isQueued = res.status === 202;
  const isOk = isSuccess || isQueued;

  if (isOk) {
    if (isSuccess) {
      successfulReqs.add(1);
    } else {
      queuedReqs.add(1);
    }
    errorRate.add(0);
  } else {
    errorRate.add(1);
  }

  check(res, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
    'no 5xx server error': (r) => r.status < 500,
    'response under 500ms': (r) => r.timings.duration < 500,
    'valid JSON body': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b && (b.status === 'ok' || b.status === 'queued');
      } catch {
        return false;
      }
    },
  });
}

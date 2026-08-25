/**
 * k6/10k-rps.js — High-Throughput 10,000 Requests Per Second (10k RPS) Load Test
 *
 * Senior Performance Engineering Architecture:
 * - Uses `ramping-arrival-rate` executor (open-model testing) to guarantee exact RPS.
 * - Manages per-VU `X-Session-Token` lifecycle:
 *     - Initial unauthenticated request enters waiting room or gets admitted.
 *     - Retains `X-Session-Token` so admitted/queued requests skip the 20 RPM
 *       anonymous rate limiter and exercise the high-throughput Redis cache tier.
 * - Sized via Little's Law: VUs = Target RPS × Expected Latency (with headroom).
 * - Stages:
 *     1. Safe Gradual Ramp: 100 RPS → 10,000 RPS over 4 minutes
 *     2. Sustained Peak: 10,000 RPS held steadily for 5 minutes
 *     3. Safe Cooldown: 10,000 RPS → 0 RPS over 1.5 minutes
 * - Thresholds:
 *     - Error rate < 1% (rate < 0.01)
 *     - P95 latency < 800ms (p(95) < 800)
 *     - P99 latency < 1500ms (p(99) < 1500)
 * - Custom Summary: Formatted console breakdown with RED metrics & SLO validations.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Custom Metrics ───────────────────────────────────────────────────────────
const errorRate          = new Rate('error_rate');
const successfulReqs     = new Counter('successful_requests');
const queuedReqs         = new Counter('queued_requests');
const resultLatencyTrend = new Trend('result_api_latency');

// ─── Target Host ──────────────────────────────────────────────────────────────
const BASE_URL = __ENV.TARGET_URL || 'http://localhost';

// ─── Load Test Data ───────────────────────────────────────────────────────────
let rollNumbers = [];
try {
  const data = JSON.parse(open('./data/roll-numbers.json'));
  rollNumbers = data.general || [];
} catch (_err) {
  for (let i = 1; i <= 50000; i++) {
    rollNumbers.push(String(26010000 + i));
  }
}

// ─── Session Token Storage ───────────────────────────────────────────────────
// Maps virtual users to session tokens so queued/admitted users bypass anonymous rate limits
const sessionTokens = new Map();

// ─── k6 Options & Workload Model ──────────────────────────────────────────────
export const options = {
  scenarios: {
    ten_k_rps_flash_crowd: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 1500,
      maxVUs: 8000,
      stages: [
        // ── Stage 1: Safe Gradual Ramp (4m) ──────────────────────────────────
        { duration: '1m', target: 1000 },    // Ramp to 1,000 RPS
        { duration: '1m', target: 3000 },    // Ramp to 3,000 RPS
        { duration: '1m', target: 6000 },    // Ramp to 6,000 RPS
        { duration: '1m', target: 10000 },   // Reach peak 10,000 RPS

        // ── Stage 2: Peak Sustain (5m) ───────────────────────────────────────
        { duration: '5m', target: 10000 },   // Hold 10,000 RPS steady for 5 minutes

        // ── Stage 3: Controlled Cooldown (1.5m) ──────────────────────────────
        { duration: '1m',  target: 1000 },   // Cooldown down to 1,000 RPS
        { duration: '30s', target: 0 },      // Drain to 0 RPS
      ],
    },
  },

  // ─── Strict Service Level Objectives (SLOs) ────────────────────────────────
  thresholds: {
    // 1. Error rate must stay below 1% across the entire test
    error_rate: [
      {
        threshold: 'rate<0.01',
        abortOnFail: false,
      },
    ],
    // 2. HTTP Request Latency SLOs
    http_req_duration: [
      'p(95)<800',   // P95 latency strictly below 800ms
      'p(99)<1500',  // P99 latency strictly below 1500ms
    ],
    // 3. System must maintain connection stability
    http_req_failed: ['rate<0.01'],
  },

  discardResponseBodies: false,
};

// ─── VU Iteration Execution ───────────────────────────────────────────────────
export default function () {
  const vuId = __VU;
  const randomIndex = Math.floor(Math.random() * rollNumbers.length);
  const rollNumber = rollNumbers[randomIndex] || '26010001';

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'k6-10k-load-generator/1.0',
  };

  // Attach session token if this VU was queued or admitted
  const token = sessionTokens.get(vuId);
  if (token) {
    headers['X-Session-Token'] = token;
  }

  const startTime = Date.now();
  const res = http.get(`${BASE_URL}/api/result/${rollNumber}`, {
    headers,
    tags: { name: '/api/result/:rollNumber' },
    timeout: '3000ms',
  });
  const duration = Date.now() - startTime;
  resultLatencyTrend.add(duration);

  // Validate HTTP 200 (Success / Cache Hit) or 202 (Queued Waiting Room)
  const isAcceptedStatus = res.status === 200 || res.status === 201 || res.status === 202;

  const passed = check(res, {
    'status is 200/201/202': (r) => isAcceptedStatus,
    'no 5xx server error':   (r) => r.status < 500,
    'response under 1500ms': (r) => r.timings.duration < 1500,
  });

  if (passed) {
    if (res.status === 202) {
      queuedReqs.add(1);
      try {
        const body = JSON.parse(res.body);
        if (body.sessionToken) {
          sessionTokens.set(vuId, body.sessionToken);
        }
      } catch (_) {}
    } else if (res.status === 200) {
      successfulReqs.add(1);
      // Clean up token upon final result delivery
      sessionTokens.delete(vuId);
    }
    errorRate.add(0);
  } else {
    errorRate.add(1);
  }
}

// ─── Custom Summary Report ────────────────────────────────────────────────────
export function handleSummary(data) {
  const getVal = (metric, key, fallback = 0) => {
    if (!data.metrics || !data.metrics[metric] || !data.metrics[metric].values) {
      return fallback;
    }
    const val = data.metrics[metric].values[key];
    return typeof val === 'number' ? val : fallback;
  };

  const httpReqs    = getVal('http_reqs', 'count', 0);
  const reqRate     = getVal('http_reqs', 'rate', 0).toFixed(1);
  const p50         = (getVal('http_req_duration', 'p(50)') || getVal('http_req_duration', 'med', 0)).toFixed(1);
  const p90         = getVal('http_req_duration', 'p(90)', 0).toFixed(1);
  const p95         = getVal('http_req_duration', 'p(95)', 0).toFixed(1);
  const p99         = getVal('http_req_duration', 'p(99)', 0).toFixed(1);
  const errRatePct  = (getVal('error_rate', 'rate', 0) * 100).toFixed(2);
  const vusPeak     = getVal('vus_max', 'value', getVal('vus', 'max', 0));

  const p95Pass = parseFloat(p95) < 800 ? 'PASS' : 'FAIL';
  const p99Pass = parseFloat(p99) < 1500 ? 'PASS' : 'FAIL';
  const errPass = parseFloat(errRatePct) < 1.0 ? 'PASS' : 'FAIL';

  const report = `
================================================================================
                    RESULT-SHIELD 10,000 RPS BENCHMARK REPORT                   
================================================================================
  Target Peak Throughput : 10,000 Requests/sec
  Total Requests Fired   : ${httpReqs.toLocaleString()}
  Mean Throughput Achieved: ${reqRate} reqs/sec
  Peak Active VUs        : ${vusPeak.toLocaleString()} VUs

--------------------------------------------------------------------------------
                         LATENCY & SLA BREAKDOWN                                
--------------------------------------------------------------------------------
  Metric                 Value          Threshold Target       Status
  ------------------------------------------------------------------------------
  P50 Latency (Median) : ${p50.padStart(7)} ms    N/A                    INFO
  P90 Latency          : ${p90.padStart(7)} ms    N/A                    INFO
  P95 Latency          : ${p95.padStart(7)} ms    < 800.0 ms             [ ${p95Pass} ]
  P99 Latency          : ${p99.padStart(7)} ms    < 1500.0 ms            [ ${p99Pass} ]
  Error Rate           : ${errRatePct.padStart(7)} %     < 1.00 %               [ ${errPass} ]

================================================================================
`;

  return {
    stdout: report,
  };
}

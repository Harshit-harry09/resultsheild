import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ─── Custom Metrics ───────────────────────────────────────────────────────────
const successRate   = new Rate('success_rate');
const replicaHits   = new Counter('replica_hits');
const latencyTrend  = new Trend('api_latency');

// ─── Target & Data ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.TARGET_URL || 'http://localhost';

let rollNumbers = [];
try {
  const data = JSON.parse(open('./data/roll-numbers.json'));
  rollNumbers = data.general || [];
} catch (_) {
  for (let i = 1; i <= 50000; i++) {
    rollNumbers.push(String(26010000 + i));
  }
}

// ─── Workload Options: 1,000,000 Requests using Pooled Keep-Alive Connections ─
export const options = {
  scenarios: {
    million_request_pipeline: {
      executor: 'shared-iterations',
      vus: 300,
      iterations: 1000000,
      maxDuration: '15m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    success_rate: ['rate>0.99'],
  },
  discardResponseBodies: true,
};

export default function () {
  const randomIndex = Math.floor(Math.random() * rollNumbers.length);
  const rollNumber = rollNumbers[randomIndex] || '26010001';

  const params = {
    headers: {
      'Accept': 'application/json',
      'Connection': 'keep-alive',
    },
    tags: { name: '/api/result/:rollNumber' },
    timeout: '5000ms',
  };

  const res = http.get(`${BASE_URL}/api/result/${rollNumber}`, params);

  const isOk = res.status === 200 || res.status === 202;
  successRate.add(isOk);

  const servedBy = res.headers['X-Served-By'] || 'unknown';
  replicaHits.add(1, { replica: servedBy });
}

export function handleSummary(data) {
  const getVal = (metric, key, fallback = 0) => {
    if (!data.metrics || !data.metrics[metric] || !data.metrics[metric].values) return fallback;
    const val = data.metrics[metric].values[key];
    return typeof val === 'number' ? val : fallback;
  };

  const totalReqs = getVal('http_reqs', 'count', 0);
  const rate      = getVal('http_reqs', 'rate', 0).toFixed(1);
  const p50       = (getVal('http_req_duration', 'p(50)') || getVal('http_req_duration', 'med', 0)).toFixed(2);
  const p95       = getVal('http_req_duration', 'p(95)', 0).toFixed(2);
  const p99       = getVal('http_req_duration', 'p(99)', 0).toFixed(2);
  const successPct = (getVal('success_rate', 'rate', 1) * 100).toFixed(2);

  const report = `
================================================================================
                    RESULT-SHIELD 1,000,000 REQUESTS REPORT                     
================================================================================
  Total Requests Executed : ${totalReqs.toLocaleString()}
  Overall Throughput Rate : ${rate} reqs/sec
  Success Rate (200 OK)   : ${successPct}%
  P50 Latency             : ${p50} ms
  P95 Latency             : ${p95} ms
  P99 Latency             : ${p99} ms
================================================================================
`;
  return { stdout: report };
}

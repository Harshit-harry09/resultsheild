import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics to track breaking point indicators
export const errorRate = new Rate('errors');
export const p95Latency = new Trend('p95_latency');
export const p99Latency = new Trend('p99_latency');

export const options = {
  // Aggressive ramp-up to find the breaking point
  stages: [
    { duration: '1m', target: 1000 },   // 1. Baseline (warm-up)
    { duration: '2m', target: 5000 },   // 2. Heavy load
    { duration: '2m', target: 10000 },  // 3. Extreme load
    { duration: '3m', target: 20000 },  // 4. BREAKING POINT territory
    { duration: '3m', target: 20000 },  // 5. Hold at max (watch for degradation/crash)
    { duration: '1m', target: 0 },      // 6. Ramp down
  ],
  // Fail the test if the system degrades beyond acceptable limits
  thresholds: {
    http_req_failed: ['rate<0.10'],       // Alert if >10% of requests fail
    http_req_duration: ['p(95)<500'],     // Alert if P95 latency exceeds 500ms
    p95_latency: ['p(95)<500'],
    p99_latency: ['p(99)<1000'],
  },
  // Optimize k6 for high load generation
  ext: {
    loadimpact: {
      distribution: { 'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 100 } },
    },
  },
};

export default function () {
  const params = {
    headers: { 
      'Connection': 'keep-alive',
      'Accept': 'application/json'
    },
    timeout: '5s', // Prevent k6 from hanging on dead connections
  };

  // Target your actual endpoint
  const res = http.get('http://localhost/api/result/26010001', params);
  
  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'latency < 500ms': (r) => r.timings.duration < 500,
  });
  
  errorRate.add(!success);
  p95Latency.add(res.timings.duration);
  p99Latency.add(res.timings.duration);

  // Tiny sleep to prevent k6 itself from becoming the bottleneck
  sleep(0.01); 
}

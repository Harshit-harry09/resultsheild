/**
 * k6/cold-range.js — Stampede demo using reserved-cold roll numbers
 *
 * Safer alternative to flush-cache.sh for Demo Part 5b (appflow.md Section 7).
 * Queries ONLY the 26099001–26099100 range (never pre-warmed).
 * Proves the stampede lock works without wiping the warm cache the rest
 * of the demo depends on (schema.md Section 3.2).
 *
 * Expected behavior:
 *   - stampede_lock_wait_total spikes in Grafana
 *   - Postgres query rate stays flat (one query per unique roll number, not N)
 *   - No 5xx errors
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const data = JSON.parse(open('./data/roll-numbers.json'));
const COLD_ROLL_NUMBERS = data.cold;  // 100 numbers, never pre-warmed

export const options = {
  scenarios: {
    stampede_proof: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 200 },  // quick burst to same cold keys
        { duration: '30s', target: 200 },  // hold to observe stampede prevention
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    errors: ['rate<0.01'],  // strict — stampede protection should prevent errors
  },
};

export default function () {
  // Deliberately reuse the same small set of keys to maximize concurrent misses
  const roll = COLD_ROLL_NUMBERS[Math.floor(Math.random() * COLD_ROLL_NUMBERS.length)];
  const res = http.get(`http://localhost/api/result/${roll}`);

  const ok = check(res, {
    'served (not 5xx)': (r) => r.status < 500,
    '200 ok':           (r) => r.status === 200,
  });
  errorRate.add(!ok);
  sleep(0.5);  // shorter sleep to maximize concurrent pressure on the same keys
}

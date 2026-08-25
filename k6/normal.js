/**
 * k6/normal.js — Normal load profile (100 VUs)
 * Purpose: sanity check, everyday baseline.
 * Thresholds: p(95) < 1000ms, error rate < 5% (rules.md Section 7)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const data = JSON.parse(open('./data/roll-numbers.json'));
const ROLL_NUMBERS = data.general;

export const options = {
  scenarios: {
    normal: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m',  target: 100 },
        { duration: '1m',  target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    errors: ['rate<0.05'],
  },
};

export default function () {
  const roll = ROLL_NUMBERS[Math.floor(Math.random() * ROLL_NUMBERS.length)];
  const res = http.get(`http://localhost/api/result/${roll}`, {
    headers: { 'X-Session-Token': '' },  // empty — new request, not a poll
  });

  const ok = check(res, {
    'status 200 or 202': (r) => r.status === 200 || r.status === 202,
    'has status field':  (r) => { try { return JSON.parse(r.body).status; } catch { return false; } },
  });
  errorRate.add(!ok);
  sleep(1);
}

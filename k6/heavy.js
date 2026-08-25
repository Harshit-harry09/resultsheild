/**
 * k6/heavy.js — Heavy load profile (1,000 VUs)
 * Purpose: pre-spike warning zone, triggers autoscaler.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const data = JSON.parse(open('./data/roll-numbers.json'));
const ROLL_NUMBERS = data.general;

export const options = {
  scenarios: {
    heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 200 },
        { duration: '30s', target: 500 },
        { duration: '1m',  target: 1000 },
        { duration: '2m',  target: 1000 },
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
  const res = http.get(`http://localhost/api/result/${roll}`);
  const ok = check(res, {
    'status 200 or 202': (r) => r.status === 200 || r.status === 202,
  });
  errorRate.add(!ok);
  sleep(1);
}

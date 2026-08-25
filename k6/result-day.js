/**
 * k6/result-day.js — Result Day load profile (5,000 VUs or laptop ceiling)
 *
 * Main demo scenario (PRD Section 12, Experiment C/D).
 * techspec.md Section 11.2 script skeleton.
 *
 * IMPORTANT (rules.md Section 7): the 5,000 VU figure is the target; if the
 * demo laptop can't sustain it, use whatever was measured in Hour 21–23.
 * Never quote the PRD's 50,000+ illustrative figure as achieved.
 *
 * 202 responses (queued) are counted as success — the queue is a feature.
 * Polling requests from a queued session carry X-Session-Token and are
 * never rate-limited (rules.md Section 4).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const data = JSON.parse(open('./data/roll-numbers.json'));
const ROLL_NUMBERS = data.general;

// Per-VU session token (simulates a queued student polling)
const sessionTokens = new Map();

export const options = {
  scenarios: {
    result_day: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '30s', target: 2000 },
        { duration: '1m',  target: 5000 },
        { duration: '2m',  target: 5000 },
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
  const vuId = __VU;
  const roll  = ROLL_NUMBERS[Math.floor(Math.random() * ROLL_NUMBERS.length)];

  const headers = {};
  const token = sessionTokens.get(vuId);
  if (token) {
    // This VU was queued — resume polling with existing token
    // Token-bearing requests skip rate limiting (rules.md Section 4)
    headers['X-Session-Token'] = token;
  }

  const res = http.get(`http://localhost/api/result/${roll}`, { headers });

  const ok = check(res, {
    'status 200 or 202': (r) => r.status === 200 || r.status === 202,
  });
  errorRate.add(!ok);

  if (res.status === 202) {
    try {
      const body = JSON.parse(res.body);
      if (body.sessionToken) {
        sessionTokens.set(vuId, body.sessionToken);
      }
    } catch (_) {}
  } else if (res.status === 200) {
    // Admitted — clear the queued token
    sessionTokens.delete(vuId);
  }

  sleep(1);
}

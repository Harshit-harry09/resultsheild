/**
 * k6/extreme.js — Extreme load profile (above measured ceiling)
 *
 * Deliberately exceeds system capacity to trigger and demonstrate the
 * virtual queue (PRD Demo Part 5, appflow.md Section 7).
 *
 * Expected behavior: queue activates (202 responses), no uncontrolled
 * application failure. This is what differentiates ResultShield from
 * a plain load-balanced app.
 *
 * No ramp-down — the job of this script is to hold the system above
 * capacity and show the queue holding steady.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate   = new Rate('errors');
const queuedRate  = new Rate('queued');
const data = JSON.parse(open('./data/roll-numbers.json'));
const ROLL_NUMBERS = data.general;

const sessionTokens = new Map();

export const options = {
  scenarios: {
    extreme: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 },
        { duration: '30s', target: 2500 },
        { duration: '1m',  target: 2500 },  // well above typical capacity
        { duration: '3m',  target: 2500 },  // hold to show stable queue
      ],
    },
  },
  // No strict thresholds here — we WANT to exceed capacity
  // The metric to watch is 202 rate vs 5xx rate
  // Success = queue activates, 5xx stays low
};

export default function () {
  const vuId = __VU;
  const roll  = ROLL_NUMBERS[Math.floor(Math.random() * ROLL_NUMBERS.length)];

  const headers = {};
  const token = sessionTokens.get(vuId);
  if (token) headers['X-Session-Token'] = token;

  const res = http.get(`http://localhost/api/result/${roll}`, { headers });

  const isOk     = res.status === 200 || res.status === 202;
  const isQueued  = res.status === 202;

  check(res, {
    'no 5xx error': (r) => r.status < 500,
    'queued or served': (r) => r.status === 200 || r.status === 202,
  });

  errorRate.add(!isOk);
  queuedRate.add(isQueued);

  if (isQueued) {
    try {
      const body = JSON.parse(res.body);
      if (body.sessionToken) sessionTokens.set(vuId, body.sessionToken);
    } catch (_) {}
  } else if (res.status === 200) {
    sessionTokens.delete(vuId);
  }

  sleep(1);
}

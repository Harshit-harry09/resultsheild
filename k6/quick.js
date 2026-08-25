import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const data = JSON.parse(open('./data/roll-numbers.json'));
const ROLL_NUMBERS = data.general;

export const options = {
  scenarios: {
    constant: {
      executor: 'constant-vus',
      vus: 50,
      duration: '40s',
    },
  },
};

export default function () {
  const roll = ROLL_NUMBERS[Math.floor(Math.random() * ROLL_NUMBERS.length)];
  const res = http.get(`http://localhost/api/result/${roll}`, {
    headers: { 'X-Session-Token': '' },
  });

  const ok = check(res, {
    'status 200 or 202': (r) => r.status === 200 || r.status === 202,
  });
  errorRate.add(!ok);
  sleep(1);
}

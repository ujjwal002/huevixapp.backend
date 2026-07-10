import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp up to 20 concurrent users
    { duration: '1m',  target: 20 },   // hold at 20
    { duration: '30s', target: 100 },  // push to 100
    { duration: '1m',  target: 100 },  // hold at 100
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],    // under 1% errors
  },
};

const BASE = 'https://backend.huevix.com/api/v1';

export default function () {
  const res = http.get(`${BASE}/meta`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'fast enough': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
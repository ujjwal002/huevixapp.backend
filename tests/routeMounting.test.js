import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import app from '../src/app.js';

// Boot the real Express app on an ephemeral port and talk to it over HTTP, so
// this exercises the ACTUAL route table in src/routes/index.js (mounting order
// included) — not a hand-built mock. Nothing here touches the database:
//   - GET  /ads/admob-ssv  with no query returns 400 before any DB call
//   - POST /ads/reward     with no auth header 401s in requireAuth, pre-DB
// so the suite is deterministic with or without a test DB.
let server;
let base;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('route mounting order — AdMob SSV callback', () => {
  // THE REGRESSION GUARD. If /ads/admob-ssv is ever registered AFTER
  // `router.use('/ads', adsRouter)`, the authed prefix mount captures this path
  // and returns 401 to AdMob (whose server-to-server callback carries no auth
  // header). That silently breaks every rewarded-ad grant. Reaching the real
  // handler with no signature yields 400 "missing signature" — proof the public
  // route is NOT shadowed by requireAuth.
  it('is reachable WITHOUT an Authorization header (not shadowed by requireAuth)', async () => {
    const res = await fetch(`${base}/ads/admob-ssv`);
    expect(res.status).not.toBe(401); // 401 here == the shadowing bug is back
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('missing signature');
  });

  it('still validates the signature once reached (no signature => 400)', async () => {
    const res = await fetch(`${base}/ads/admob-ssv?ad_network=5450213213286189855`);
    expect(res.status).toBe(400);
  });
});

describe('route mounting order — sibling /ads routes stay protected', () => {
  // The fix must NOT accidentally unauthenticate the rest of /ads. The rewarded
  // credit endpoint must still require auth: no token => 401 from requireAuth.
  it('POST /ads/reward requires authentication', async () => {
    const res = await fetch(`${base}/ads/reward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
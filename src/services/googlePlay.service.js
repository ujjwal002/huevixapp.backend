import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { withTimeout } from '../utils/withTimeout.js';

// =============================================================================
// Google Play Developer API — server-side purchase verification.
//
// This mirrors the role payment.service.js plays for Razorpay: it talks to the
// payment provider and tells the controller whether a purchase is real. The
// client NEVER decides entitlement; it only forwards a `purchaseToken` that we
// verify here against Google's servers.
//
// Like the Razorpay service, this honours config.mockExternal so you can test
// the entire purchase → verify → grant loop locally without any Google setup.
// In mock mode we fabricate an "active" response for any token.
//
// Docs: https://developers.google.com/android-publisher (androidpublisher v3)
// =============================================================================

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

// Purchase states for one-time products (purchases.products.get).
export const PRODUCT_PURCHASED = 0;
export const PRODUCT_CANCELED = 1;
export const PRODUCT_PENDING = 2;

let _auth; // GoogleAuth is reused; it caches + refreshes access tokens internally.

function getAuth() {
  if (_auth) return _auth;

  const raw = config.googlePlay.serviceAccountJson;
  if (!raw) {
    throw new ApiError(500, 'Google Play service account not configured', 'GP_NOT_CONFIGURED');
  }

  // Accept either the full JSON pasted into an env var, OR a path to the file.
  let credentials;
  try {
    credentials = raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(raw, 'utf8'));
  } catch {
    throw new ApiError(500, 'Invalid Google service account credentials', 'GP_BAD_CREDS');
  }

  _auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return _auth;
}

async function authedFetch(url, { method = 'GET', body } = {}) {
  const client = await getAuth().getClient();
  const { token } = await client.getAccessToken();

  const res = await withTimeout(
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    }),
    { ms: 15000, label: 'Google Play API' }
  );

  return res;
}

async function readError(res, label) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j);
  } catch {
    detail = await res.text().catch(() => '');
  }
  console.error(`[googlePlay] ${label} failed: ${res.status} ${detail}`);
  return detail;
}

// --- Subscriptions (subscriptionsv2) ----------------------------------------

// Returns the raw subscriptionsv2 resource. Key fields we use downstream:
//   subscriptionState      e.g. SUBSCRIPTION_STATE_ACTIVE
//   acknowledgementState   ACKNOWLEDGEMENT_STATE_PENDING | ..._ACKNOWLEDGED
//   lineItems[].expiryTime RFC3339 timestamp of the current paid period end
//   lineItems[].productId  the subscription product (SKU)
//   linkedPurchaseToken    present on upgrade/downgrade (old token to supersede)
export async function getSubscription(purchaseToken) {
  if (config.mockExternal) {
    const end = new Date();
    end.setMonth(end.getMonth() + 1);
    return {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      latestOrderId: `mock_order_${Date.now()}`,
      lineItems: [{ productId: config.googlePlay.subMonthlyId, expiryTime: end.toISOString() }],
      _mock: true,
    };
  }

  const url = `${BASE}/${config.googlePlay.packageName}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await authedFetch(url);
  if (!res.ok) {
    const d = await readError(res, 'subscription get');
    throw ApiError.badRequest(d || 'Subscription verification failed', 'GP_SUB_VERIFY_FAILED');
  }
  return res.json();
}

export async function acknowledgeSubscription(productId, purchaseToken) {
  if (config.mockExternal) return;
  const url = `${BASE}/${config.googlePlay.packageName}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const res = await authedFetch(url, { method: 'POST', body: '{}' });
  // 200 = acknowledged. An already-acknowledged token returns 4xx; that's fine —
  // it just means another path (or the client's finishTransaction) beat us to it.
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    await readError(res, 'subscription acknowledge');
  }
}

// Picks the latest expiry across line items (normally just one).
export function subscriptionExpiry(sub) {
  const times = (sub.lineItems || [])
    .map((li) => li.expiryTime)
    .filter(Boolean)
    .map((t) => new Date(t).getTime());
  if (!times.length) return null;
  return new Date(Math.max(...times));
}

// Active = user should have access right now (paid period valid, incl. grace).
export function isSubActiveState(state) {
  return state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
}

// --- One-time products (consumable credit packs) -----------------------------

export async function getProduct(productId, purchaseToken) {
  if (config.mockExternal) {
    return {
      purchaseState: PRODUCT_PURCHASED,
      acknowledgementState: 0,
      consumptionState: 0,
      orderId: `mock_order_${Date.now()}`,
      _mock: true,
    };
  }

  const url = `${BASE}/${config.googlePlay.packageName}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await authedFetch(url);
  if (!res.ok) {
    const d = await readError(res, 'product get');
    throw ApiError.badRequest(d || 'Product verification failed', 'GP_PRODUCT_VERIFY_FAILED');
  }
  return res.json();
}

// Consuming a CONSUMABLE marks it used so the same SKU can be bought again
// (credit packs). For a permanent "lifetime unlock" you would acknowledge
// instead of consume (see acknowledgeProduct). The client also calls
// finishTransaction({ isConsumable: true }); doing it server-side too is a safe
// backstop if the client dies right after payment.
export async function consumeProduct(productId, purchaseToken) {
  if (config.mockExternal) return;
  const url = `${BASE}/${config.googlePlay.packageName}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`;
  const res = await authedFetch(url, { method: 'POST', body: '{}' });
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    await readError(res, 'product consume');
  }
}

// Use this INSTEAD of consumeProduct for a non-consumable one-time unlock.
export async function acknowledgeProduct(productId, purchaseToken) {
  if (config.mockExternal) return;
  const url = `${BASE}/${config.googlePlay.packageName}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  const res = await authedFetch(url, { method: 'POST', body: '{}' });
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    await readError(res, 'product acknowledge');
  }
}

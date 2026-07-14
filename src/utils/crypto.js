import crypto from 'node:crypto';

// Constant-time string comparison that also tolerates a wrong-length or missing
// candidate. crypto.timingSafeEqual throws a RangeError when the two buffers
// differ in length, so we normalise first and, on a length mismatch, still spend
// the work of a comparison to avoid leaking length via timing. Used everywhere a
// secret / HMAC / SHA-256 hex digest is compared (ad reward, email OTP, Razorpay
// signature, Google RTDN secret) so there is ONE audited implementation.
export function timingSafeEqualStr(expected, actual) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a); // equivalent work; don't leak length via timing
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

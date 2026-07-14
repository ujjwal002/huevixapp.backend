// Native bcrypt (not bcryptjs): same algorithm and hash format, but the work
// runs on libuv's threadpool instead of the main JS thread — so a burst of
// logins no longer contends the event loop. Existing bcryptjs-created hashes in
// the DB verify unchanged (both produce/accept standard $2a$/$2b$ bcrypt).
import bcrypt from 'bcrypt';
import { config } from '../config/env.js';

export const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Precomputed hash of a value no real password equals. Compared against on the
// "user not found" login path so the endpoint performs the same bcrypt work
// whether or not the account exists (closes a timing-based user-enumeration
// oracle). The candidate never matches, so it always yields false.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('::nonexistent-account::', config.bcryptRounds);

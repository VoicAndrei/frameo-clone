'use strict';

/**
 * Password hashing for the frameo-clone admin accounts.
 *
 * Algorithm: scrypt from node:crypto. No native dependencies, by design — this whole stack
 * ships a zero-native-module container (see ARCHITECTURE-PUBLIC.md §2.3).
 *
 * Storage format (self-describing so the cost parameters can be raised later without
 * invalidating the hashes that already exist):
 *
 *     scrypt$N=32768,r=8,p=1$<salt base64url, no padding>$<derived key base64url, no padding>
 *
 * IMPORTANT: `maxmem` must always be passed explicitly. Node's default maxmem is 32 MiB and
 * scrypt needs 128 * N * r = 33 554 432 bytes at N=32768,r=8, which is *just* over it. Without
 * an explicit maxmem every call throws ERR_CRYPTO_INVALID_SCRYPT_PARAM.
 *
 * This module is required both by the server (async verification, so a 100 ms hash never blocks
 * a live WebRTC signalling socket) and by the hash-password CLI.
 */

const crypto = require('node:crypto');

/** Normative parameters. Do not lower these. */
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });

/** Passwords longer than this are rejected before any scrypt call (free-CPU-DoS guard). */
const MAX_PASSWORD_BYTES = 256;

/** Minimum length enforced by the CLI, not by the login endpoint. */
const MIN_PASSWORD_CHARS = 12;

const HASH_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/**
 * scrypt needs strictly more than 128*N*r bytes. 256*N*r gives 100 % headroom and is what we
 * always pass, with a 64 MiB floor so small-N legacy hashes still verify.
 */
function maxmemFor(N, r) {
  return Math.max(64 * 1024 * 1024, 256 * N * r);
}

/** Reject absurd cost parameters read from a file rather than trying to honour them. */
function paramsSane(N, r, p) {
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!(N >= 16384 && N <= 1048576)) return false;
  if ((N & (N - 1)) !== 0) return false; // N must be a power of two
  if (!(r >= 1 && r <= 32)) return false;
  if (!(p >= 1 && p <= 16)) return false;
  return true;
}

/** @returns {Buffer} the password bytes, or throws if it is unusable. */
function passwordBytes(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw Object.assign(new Error('password must be a non-empty string'), { code: 'BAD_PASSWORD' });
  }
  const buf = Buffer.from(password, 'utf8');
  if (buf.length > MAX_PASSWORD_BYTES) {
    throw Object.assign(new Error(`password exceeds ${MAX_PASSWORD_BYTES} bytes`), { code: 'BAD_PASSWORD' });
  }
  return buf;
}

/**
 * Hash a password. Synchronous on purpose: this is only ever called by the CLI, never on a
 * request path.
 * @param {string} password
 * @returns {string} the `scrypt$...` storage string
 */
function hashPassword(password) {
  const pw = passwordBytes(password);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

/** Cheap structural check used when validating admins.json / ADMIN_PASSWORD_HASHES. */
function isValidHash(stored) {
  const m = HASH_RE.exec(String(stored || ''));
  if (!m) return false;
  if (!paramsSane(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(m[4], 'base64url');
    expected = Buffer.from(m[5], 'base64url');
  } catch {
    return false;
  }
  return salt.length >= 8 && expected.length >= 16 && expected.length <= 64;
}

/**
 * Verify a password against a stored hash, asynchronously.
 *
 * Async matters: scrypt at N=2^15 takes ~100 ms, and a login attempt may try several accounts.
 * Blocking the event loop for half a second would stall every live signalling socket, including
 * one in the middle of an ICE exchange.
 *
 * Never throws — any malformed stored hash simply fails to verify.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    let pw;
    try {
      pw = passwordBytes(password);
    } catch {
      resolve(false);
      return;
    }
    const m = HASH_RE.exec(String(stored || ''));
    if (!m) {
      resolve(false);
      return;
    }
    const N = Number(m[1]);
    const r = Number(m[2]);
    const p = Number(m[3]);
    if (!paramsSane(N, r, p)) {
      resolve(false);
      return;
    }
    let salt;
    let expected;
    try {
      salt = Buffer.from(m[4], 'base64url');
      expected = Buffer.from(m[5], 'base64url');
    } catch {
      resolve(false);
      return;
    }
    if (salt.length < 8 || expected.length < 16 || expected.length > 64) {
      resolve(false);
      return;
    }
    try {
      crypto.scrypt(pw, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) }, (err, actual) => {
        if (err || !actual || actual.length !== expected.length) {
          resolve(false);
          return;
        }
        let ok = false;
        try {
          ok = crypto.timingSafeEqual(actual, expected);
        } catch {
          ok = false;
        }
        resolve(ok);
      });
    } catch {
      resolve(false);
    }
  });
}

module.exports = {
  SCRYPT_PARAMS,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARS,
  hashPassword,
  verifyPassword,
  isValidHash,
};

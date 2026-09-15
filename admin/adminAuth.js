// admin/adminAuth.js
//
// Who may use the admin portal, and how the server knows it is them.
//
// Two people log in, so the accounts live in one environment variable rather
// than in a table: LOJIQ_ADMIN_USERS, a JSON list of { email, name, hash }.
// The hash comes from scripts/admin-user.js; no password is ever stored.
// Deliberately not in Airtable, where anyone with access to the base reads
// every field - which is exactly how the Merchants passwords are kept today.
//
// The session is a signed cookie, separate from the store's lojiq_session.
// It carries a fingerprint of the account's hash, so setting a new password
// ends every session that was signed in with the old one.

import crypto from "crypto";

export const COOKIE = "lojiq_admin";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ---------------- passwords ---------------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });

  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = text(stored).split("$");

  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;

  const expected = Buffer.from(keyB64, "base64");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Checked against when the e-mail is unknown, so a wrong address costs the
// same time as a wrong password and the two cannot be told apart.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

/* ---------------- accounts ---------------- */

export function parseUsers(raw) {
  if (!text(raw)) return [];

  let list;

  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("LOJIQ_ADMIN_USERS is not valid JSON");
  }

  if (!Array.isArray(list)) throw new Error("LOJIQ_ADMIN_USERS must be a JSON list");

  return list
    .map((user) => ({
      email: text(user?.email).toLowerCase(),
      name: text(user?.name) || text(user?.email),
      hash: text(user?.hash)
    }))
    .filter((user) => user.email && user.hash.startsWith("scrypt$"));
}

export function authenticate(users, email, password) {
  const wanted = text(email).toLowerCase();
  const user = users.find((candidate) => candidate.email === wanted);

  const ok = verifyPassword(password, user ? user.hash : DUMMY_HASH);

  return ok && user ? user : null;
}

const fingerprint = (hash) => crypto.createHash("sha256").update(hash).digest("base64url").slice(0, 16);

/* ---------------- session cookie ---------------- */

export function signSession(user, secret, now = Date.now()) {
  const payload = { e: user.email, f: fingerprint(user.hash), exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");

  return `${body}.${sig}`;
}

// The account behind a cookie, or null. The account must still exist and
// still have the password the cookie was issued under.
export function readSession(token, secret, users, now = Date.now()) {
  const raw = text(token);
  const dot = raw.indexOf(".");

  if (!secret || dot <= 0) return null;

  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(body).digest("base64url"));

  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;

  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload?.e || !(now < Number(payload.exp))) return null;

  const user = users.find((candidate) => candidate.email === payload.e);

  if (!user || fingerprint(user.hash) !== payload.f) return null;

  return user;
}

export function readCookie(req, name) {
  for (const part of text(req.headers.cookie).split(";")) {
    const eq = part.indexOf("=");

    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return "";
      }
    }
  }

  return "";
}

export function cookieHeader(req, value, maxAgeSeconds) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];

  // Secure everywhere except a local run, which has no https to send it over.
  if (!["localhost", "127.0.0.1"].includes(req.hostname)) attrs.push("Secure");

  return attrs.join("; ");
}

/* ---------------- login attempts ---------------- */

// Ten tries per address per quarter of an hour, counted per IP and e-mail.
export function createAttemptLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();

  return {
    blocked(key, now = Date.now()) {
      const entry = hits.get(key);

      if (!entry || now - entry.start > windowMs) return false;

      return entry.count >= max;
    },

    fail(key, now = Date.now()) {
      const entry = hits.get(key);

      if (!entry || now - entry.start > windowMs) {
        hits.set(key, { start: now, count: 1 });
      } else {
        entry.count += 1;
      }

      // Keep the map from growing without end under a flood of addresses.
      if (hits.size > 5000) {
        for (const [candidate, value] of hits) {
          if (now - value.start > windowMs) hits.delete(candidate);
        }
      }
    },

    reset(key) {
      hits.delete(key);
    }
  };
}

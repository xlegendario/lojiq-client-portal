// partner/partnerPortal.js
//
// The partner dashboard on /partner: a supplier whose pairs are on our shelf
// signs in, sees that stock, and makes his own forwards.
//
// Accounts live in Supabase public.partner_users, one row per person, each
// tied to one Sellers Database record. Everything a partner reads or writes is
// filtered on that record server-side; the browser never names a seller.
//
// Passwords, the session cookie and the login limit are the admin portal's
// (adminAuth.js), with their own cookie and a secret derived from the admin
// secret, so an admin cookie never opens the partner side or the other way.

import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";

import {
  SESSION_TTL_MS,
  authenticate,
  cookieHeader,
  createAttemptLimiter,
  readCookie,
  readSession,
  signSession
} from "../admin/adminAuth.js";
import { createSupabaseRest } from "../admin/externalSalesSync.js";
import { loadPartnerPairs, summarizeStock } from "./partnerStock.js";
import { ForwardError, createPartnerForward, loadForwardable, summarizeForwardable } from "./partnerForward.js";
import { loadForwards } from "./partnerSent.js";

export const PARTNER_COOKIE = "lojiq_partner";

const USERS_CACHE_MS = 60_000;
const FEE_CACHE_MS = 10 * 60_000;

// A label photo or PDF from a phone, as a data URL: a few megabytes.
export const FORWARD_BODY_LIMIT = "15mb";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export function partnerSecret(adminSecret) {
  if (!text(adminSecret)) return "";

  return crypto.createHmac("sha256", adminSecret).update("lojiq-partner-session").digest("base64url");
}

// A partner_users row in the shape adminAuth works with.
export function toAccount(row) {
  return {
    id: text(row?.id),
    email: text(row?.email).toLowerCase(),
    name: text(row?.name) || text(row?.email),
    hash: text(row?.password_hash),
    sellerRecordId: text(row?.seller_record_id),
    sellerId: text(row?.seller_id)
  };
}

const usable = (account) => account.email && account.hash.startsWith("scrypt$") && account.sellerRecordId;

/*
 * deps:
 *   adminSecret   LOJIQ_ADMIN_SECRET; the partner secret is derived from it
 *   supabaseUrl, serviceKey
 *   pageFile      private/partner.html
 *   services      { airtable, sellersTable, kickzBaseUrl, internalSecret, wmsBaseUrl }
 *   fetchImpl     for the tests
 *   now           for the tests
 */
export function createPartnerPortal({ adminSecret, supabaseUrl, serviceKey, pageFile, services = {}, fetchImpl = fetch, now = Date.now } = {}) {
  const router = express.Router();
  const db = createSupabaseRest({ supabaseUrl, serviceKey, fetchImpl });
  const secret = partnerSecret(adminSecret);
  const enabled = Boolean(secret && db.configured);
  const attempts = createAttemptLimiter();
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  // The table is a handful of rows; reading it whole keeps adminAuth's
  // list-based checks usable. Login always reads it fresh, so a new account
  // or a new password works straight away.
  let cache = { at: 0, accounts: [] };

  async function accounts({ fresh = false } = {}) {
    if (!fresh && now() - cache.at < USERS_CACHE_MS) return cache.accounts;

    const rows = await db.get("partner_users?select=id,email,name,password_hash,seller_record_id,seller_id&active=eq.true");
    cache = { at: now(), accounts: (rows || []).map(toAccount).filter(usable) };

    return cache.accounts;
  }

  async function currentPartner(req) {
    const token = readCookie(req, PARTNER_COOKIE);

    if (!token) return null;

    return readSession(token, secret, await accounts(), now());
  }

  const noStore = (res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
  };

  function sameOrigin(req) {
    const origin = text(req.headers.origin);

    if (!origin) return true;

    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const publicAccount = (account) => ({ name: account.name, email: account.email, seller_id: account.sellerId });

  /* ----- page ----- */

  router.get(["/partner", "/partner/"], (req, res) => {
    noStore(res);

    if (!enabled || !page) {
      return res.status(503).type("text").send("The partner dashboard is not configured yet.");
    }

    res.type("html").send(page);
  });

  /* ----- session ----- */

  router.post("/api/partner/login", express.json({ limit: "10kb" }), async (req, res) => {
    noStore(res);

    if (!enabled) return res.status(503).json({ error: "The partner dashboard is not configured yet." });
    if (!sameOrigin(req)) return res.status(403).json({ error: "Not allowed" });

    const email = text(req.body?.email).toLowerCase();
    const password = String(req.body?.password ?? "");
    const key = `${req.ip}|${email}`;

    if (attempts.blocked(key)) return res.status(429).json({ error: "too_many_attempts" });

    let account = null;

    try {
      account = email && password ? authenticate(await accounts({ fresh: true }), email, password) : null;
    } catch (err) {
      console.error("[partner] login lookup failed:", err.message);
      return res.status(502).json({ error: "try_again" });
    }

    if (!account) {
      attempts.fail(key);
      console.warn("[partner] failed login for", email || "(no email)", "from", req.ip);
      return res.status(401).json({ error: "wrong_login" });
    }

    attempts.reset(key);
    res.append(
      "Set-Cookie",
      cookieHeader(req, signSession(account, secret, now()), Math.floor(SESSION_TTL_MS / 1000), PARTNER_COOKIE)
    );

    db.patch(`partner_users?id=eq.${encodeURIComponent(account.id)}`, { last_login_at: new Date(now()).toISOString() }).catch(
      (err) => console.warn("[partner] last login not written:", err.message)
    );
    console.log(`[partner] ${account.email} (${account.sellerId}) signed in`);

    res.json({ partner: publicAccount(account) });
  });

  router.post("/api/partner/logout", (req, res) => {
    noStore(res);
    res.append("Set-Cookie", cookieHeader(req, "", 0, PARTNER_COOKIE));
    res.json({ ok: true });
  });

  // Everything below needs a signed-in partner, and only ever sees his seller.
  router.use("/api/partner", async (req, res, next) => {
    noStore(res);

    if (!enabled) return res.status(503).json({ error: "The partner dashboard is not configured yet." });

    try {
      const account = await currentPartner(req);

      if (!account) return res.status(401).json({ error: "not_signed_in" });

      req.partner = account;
      next();
    } catch (err) {
      console.error("[partner] session check failed:", err.message);
      res.status(502).json({ error: "try_again" });
    }
  });

  router.get("/api/partner/me", (req, res) => {
    res.json({ partner: publicAccount(req.partner) });
  });

  router.get("/api/partner/stock", async (req, res) => {
    try {
      res.json(summarizeStock(await loadPartnerPairs(db, req.partner.sellerRecordId)));
    } catch (err) {
      console.error(`[partner] stock for ${req.partner.sellerId} failed:`, err.message);
      res.status(502).json({ error: "try_again" });
    }
  });

  /* ----- send pairs ----- */

  const base = (url) => text(url).replace(/\/$/, "");

  async function post(url, body, headers = {}) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      // Someone sold or sent one of the pairs between choosing and sending.
      if (response.status === 409) throw new ForwardError("pairs_gone", 409);

      const reason = [data.error, ...(Array.isArray(data.errors) ? data.errors : []), data.details].filter(Boolean).join(" ");
      throw new ForwardError("try_again", 502, { reason: reason || `answered ${response.status}` });
    }

    return data;
  }

  const forwardDeps = {
    db,
    callKc(pathName, body) {
      if (!base(services.kickzBaseUrl) || !text(services.internalSecret)) {
        throw new ForwardError("try_again", 503, { reason: "Kickz Caviar portal not configured" });
      }
      return post(`${base(services.kickzBaseUrl)}${pathName}`, body, { "x-kc-secret": services.internalSecret });
    },
    callWms(pathName, body) {
      if (!base(services.wmsBaseUrl)) throw new ForwardError("try_again", 503, { reason: "WMS not configured" });
      return post(`${base(services.wmsBaseUrl)}${pathName}`, body);
    }
  };

  // The fee per pair agreed with the partner, in the Sellers Database. A pair
  // can carry its own fee from intake; this is the fee of all the others.
  const fees = new Map();

  async function defaultFee(account) {
    const cached = fees.get(account.sellerRecordId);
    if (cached && now() - cached.at < FEE_CACHE_MS) return cached.fee;

    let fee = 0;

    try {
      const record = services.airtable
        ? await services.airtable(services.sellersTable || "Sellers Database").find(account.sellerRecordId)
        : null;
      fee = Number(record?.fields?.["Forwarding Fee"]) || 0;
    } catch (err) {
      console.warn(`[partner] forwarding fee of ${account.sellerId} not read:`, err.message);
      return cached?.fee ?? 0;
    }

    fees.set(account.sellerRecordId, { at: now(), fee });
    return fee;
  }

  router.get("/api/partner/forwardable", async (req, res) => {
    try {
      const fee = await defaultFee(req.partner);
      const rows = await loadForwardable(db, req.partner.sellerRecordId);

      res.json({ products: summarizeForwardable(rows, fee), default_fee: fee });
    } catch (err) {
      console.error(`[partner] forwardable for ${req.partner.sellerId} failed:`, err.message);
      res.status(502).json({ error: "try_again" });
    }
  });

  router.post("/api/partner/forwards", express.json({ limit: FORWARD_BODY_LIMIT }), async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: "Not allowed" });

    try {
      const forward = await createPartnerForward(forwardDeps, req.partner, req.body);

      console.log(`[partner] ${req.partner.sellerId} made ${forward.display_id}: ${forward.pairs} pair(s), ${forward.shipping_status}`);
      res.json({ forward });
    } catch (err) {
      if (err instanceof ForwardError) {
        if (err.status >= 500) console.error(`[partner] forward for ${req.partner.sellerId} failed:`, err.reason || err.code);
        return res.status(err.status).json({ error: err.code, short: err.short || [] });
      }

      console.error(`[partner] forward for ${req.partner.sellerId} failed:`, err.message);
      res.status(502).json({ error: "try_again" });
    }
  });

  /* ----- sent ----- */

  router.get("/api/partner/forwards", async (req, res) => {
    try {
      res.json({ forwards: await loadForwards(db, req.partner.sellerRecordId) });
    } catch (err) {
      console.error(`[partner] forwards for ${req.partner.sellerId} failed:`, err.message);
      res.status(502).json({ error: "try_again" });
    }
  });

  return { router, enabled, db };
}

export function partnerPagePath(dirname) {
  return path.join(dirname, "private", "partner.html");
}

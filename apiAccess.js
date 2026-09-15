// apiAccess.js
//
// API Access for Lojiq stores: the page, a real session behind it, and the two
// routes that pass calls on to the seller API.
//
// Why a session here, when the rest of this portal has none: every other page
// trusts the merchant id the browser sends. That is a known gap, and building
// key management on top of it would let anyone who knows a merchant id mint a
// live API key for that store. So login now also sets a signed cookie, and
// only what lives in this file relies on it.
//
// Why the calls pass through here: a Lojiq store talks to portal.lojiq.io and
// never to a Kickz Caviar address. The API itself runs once, on the Kickz
// Caviar portal; this portal forwards to it.

import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";

const COOKIE = "lojiq_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ---------------- session ---------------- */

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");

  return `${body}.${sig}`;
}

function verify(token, secret) {
  const raw = text(token);
  const dot = raw.indexOf(".");

  if (!secret || dot <= 0) return null;

  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(body).digest("base64url"));

  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    return payload?.mid && Date.now() < Number(payload.exp) ? payload : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of text(req.headers.cookie).split(";")) {
    const eq = part.indexOf("=");

    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }

  return "";
}

function cookieAttributes(req, maxAgeSeconds) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];

  // Secure everywhere except a local run, which has no https to send it over.
  if (!["localhost", "127.0.0.1"].includes(req.hostname)) attrs.push("Secure");

  return attrs.join("; ");
}

/* ---------------- the module ---------------- */

/*
 * deps:
 *   sessionSecret        LOJIQ_SESSION_SECRET; without it nothing here works
 *   kickzBaseUrl         where the seller API runs
 *   serviceSecret        the secret the Kickz Caviar portal trusts
 *   publicOrigin         what stores call, e.g. https://portal.lojiq.io
 *   loadMerchant(id)     -> the normalized merchant
 *   loadSeller(merchant) -> { record_id } or throws when none is linked
 */
export function createApiAccess({ sessionSecret, kickzBaseUrl, serviceSecret, publicOrigin, loadMerchant, loadSeller, pageFile }) {
  const base = text(kickzBaseUrl).replace(/\/$/, "");
  const page = fs.readFileSync(pageFile, "utf8");
  const router = express.Router();

  function setSession(req, res, merchantId) {
    if (!sessionSecret) return;

    const token = sign({ mid: merchantId, exp: Date.now() + TTL_MS }, sessionSecret);

    res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(req, Math.floor(TTL_MS / 1000))}`);
  }

  function clearSession(req, res) {
    res.append("Set-Cookie", `${COOKIE}=; ${cookieAttributes(req, 0)}`);
  }

  // The merchant behind the cookie, still enabled. Portal access switched off
  // after login ends API Access too, without waiting for the cookie to expire.
  async function merchantFor(req) {
    const session = verify(readCookie(req, COOKIE), sessionSecret);

    if (!session) return null;

    const merchant = await loadMerchant(session.mid).catch(() => null);

    return merchant?.portal_enabled ? merchant : null;
  }

  router.get("/api-access", async (req, res) => {
    if (!sessionSecret) return res.status(503).send("API Access is not configured yet.");

    const merchant = await merchantFor(req);

    // Logged in the old way, through the browser only: send them through the
    // login once, which is what sets the cookie.
    //
    // FIXED - this went to "/" plainly, and the login page sends anyone the
    // browser remembers straight on to /portal. So a store logged in from
    // before API Access existed clicked the tab and landed back where it
    // started, with nothing said. The login page now knows why it was sent
    // there, asks for the password once, and comes back here.
    if (!merchant) return res.redirect("/?next=api-access");

    const config = {
      brand: "Lojiq",
      theme: "blue",
      apiBase: `${text(publicOrigin).replace(/\/$/, "")}/api/v1`,
      keysBase: "/api/seller-api",
      backUrl: "/portal",
      loginUrl: "/",
      accountLabel: merchant.store_name || ""
    };

    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page.replace("__API_ACCESS_CONFIG__", JSON.stringify(config).replace(/</g, "\\u003c")));
  });

  /*
   * Keys and webhooks, for the signed-in store's own seller profile.
   *
   * The seller record is decided here, from the session, and put on the
   * forwarded call; nothing the browser sends can name another one.
   */
  router.all(/^\/api\/seller-api\/(.+)$/, async (req, res) => {
    try {
      if (!sessionSecret || !serviceSecret) {
        return res.status(503).json({ success: false, message: "API Access is not configured yet." });
      }

      const merchant = await merchantFor(req);

      if (!merchant) return res.status(401).json({ success: false, message: "Not signed in" });

      let seller;

      try {
        seller = await loadSeller(merchant);
      } catch {
        return res.status(403).json({
          success: false,
          message: "This store has no linked seller profile yet. Contact support to use the API."
        });
      }

      const url = new URL(`${base}/api/seller-api/${req.params[0]}`);
      url.searchParams.set("seller_record_id", seller.record_id);

      const hasBody = !["GET", "HEAD"].includes(req.method);
      const body = hasBody ? { ...(req.body || {}) } : null;

      if (body) delete body.seller_record_id;

      const upstream = await fetch(url, {
        method: req.method,
        headers: {
          Accept: "application/json",
          "x-kc-secret": serviceSecret,
          ...(hasBody ? { "Content-Type": "application/json" } : {})
        },
        body: hasBody ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      });

      res.status(upstream.status).json(await upstream.json().catch(() => ({ success: false, message: "Unexpected response" })));
    } catch (err) {
      console.error("API Access key call failed:", err.message);
      res.status(502).json({ success: false, message: "Could not reach the API right now. Try again shortly." });
    }
  });

  /*
   * The API itself, passed through as it is.
   *
   * No session: a key is the whole identity of an API call, and it is checked
   * on the other side. Only the headers an integration needs travel either
   * way, so nothing about where the API really runs leaks into a response.
   */
  const RELAYED = [
    "content-type",
    "content-disposition",
    "cache-control",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "retry-after",
    "x-api-mode"
  ];

  router.all(/^\/api\/v1(\/.*)?$/, async (req, res) => {
    try {
      const headers = {};

      for (const name of ["authorization", "accept"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }

      let body;

      if (!["GET", "HEAD"].includes(req.method) && req.body && Object.keys(req.body).length) {
        body = JSON.stringify(req.body);
        headers["content-type"] = "application/json";
      }

      const upstream = await fetch(`${base}${req.originalUrl}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000)
      });

      res.status(upstream.status);

      for (const name of RELAYED) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }

      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error("API passthrough failed:", err.message);
      res.status(502).json({ success: false, message: "The API could not be reached. Try again shortly." });
    }
  });

  /*
   * A malformed JSON body is rejected by express.json() before any route
   * runs, and would otherwise come back as an HTML error page.
   *
   * Returned separately and mounted on the app, not on the router: while an
   * error is in flight Express skips ordinary middleware, and a router is
   * ordinary middleware, so a handler inside it would never be reached.
   */
  function errorHandler(err, req, res, next) {
    if (!/^\/api\/(v1|seller-api)(\/|$)/.test(req.path)) return next(err);

    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ success: false, message: "Request body is not valid JSON" });
    }

    if (err?.type === "entity.too.large") {
      return res.status(413).json({ success: false, message: "Request body is too large" });
    }

    return next(err);
  }

  return { router, errorHandler, setSession, clearSession };
}

export function apiAccessPagePath(dirname) {
  return path.join(dirname, "private", "api-access.html");
}

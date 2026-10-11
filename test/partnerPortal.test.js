import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

import { hashPassword, readSession } from "../admin/adminAuth.js";
import { PARTNER_COOKIE, createPartnerPortal, partnerSecret, toAccount } from "../partner/partnerPortal.js";

const ADMIN_SECRET = "test-admin-secret";

const jimmy = {
  id: "u1",
  email: "jimmy@example.com",
  name: "Jimmy",
  password_hash: hashPassword("a long partner password"),
  seller_id: "SE-00781",
  seller_record_id: "recJIMMY00000001",
  active: true
};

// Just enough Supabase for the login: read partner_users, write last_login_at.
function fakeSupabase(rows) {
  const calls = [];

  async function fetchImpl(url, options = {}) {
    const { pathname, search } = new URL(url);
    calls.push({ method: options.method || "GET", path: pathname + search });

    if (pathname === "/rest/v1/partner_users" && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify(rows.filter((row) => row.active)), { status: 200 });
    }

    if (pathname === "/rest/v1/partner_users" && options.method === "PATCH") {
      return new Response("[]", { status: 200 });
    }

    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  }

  return { fetchImpl, calls };
}

async function withServer(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partner-"));
  const pageFile = path.join(dir, "partner.html");
  fs.writeFileSync(pageFile, "<html>partner</html>");

  const supa = fakeSupabase(options.rows || [jimmy]);
  const portal = createPartnerPortal({
    adminSecret: "adminSecret" in options ? options.adminSecret : ADMIN_SECRET,
    supabaseUrl: "https://db.example",
    serviceKey: "service-key",
    pageFile,
    fetchImpl: supa.fetchImpl
  });

  const app = express();
  app.use(portal.router);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(base, supa);
  } finally {
    server.close();
  }
}

async function login(base, email, password) {
  const response = await fetch(`${base}/api/partner/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  return { response, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}

test("the partner secret is derived, and never the admin secret itself", () => {
  assert.equal(partnerSecret(""), "");
  assert.ok(partnerSecret(ADMIN_SECRET));
  assert.notEqual(partnerSecret(ADMIN_SECRET), ADMIN_SECRET);
  assert.equal(partnerSecret(ADMIN_SECRET), partnerSecret(ADMIN_SECRET));
});

test("an account row keeps its seller and lower-cases the e-mail", () => {
  const account = toAccount({ ...jimmy, email: "Jimmy@Example.com" });

  assert.equal(account.email, "jimmy@example.com");
  assert.equal(account.sellerRecordId, "recJIMMY00000001");
  assert.equal(account.sellerId, "SE-00781");
});

test("stays off without the admin secret", async () => {
  await withServer({ adminSecret: "" }, async (base) => {
    assert.equal((await fetch(`${base}/partner`)).status, 503);
    assert.equal((await fetch(`${base}/api/partner/me`)).status, 503);
  });
});

test("login, guard, me, logout", async () => {
  await withServer({}, async (base, supa) => {
    assert.equal((await fetch(`${base}/partner`)).status, 200);
    assert.equal((await fetch(`${base}/api/partner/me`)).status, 401);

    const bad = await login(base, jimmy.email, "wrong password");
    assert.equal(bad.response.status, 401);
    assert.equal((await bad.response.json()).error, "wrong_login");
    assert.equal(bad.cookie, "");

    const good = await login(base, "JIMMY@example.com", "a long partner password");
    assert.equal(good.response.status, 200);
    assert.ok(good.cookie.startsWith(`${PARTNER_COOKIE}=`));
    assert.deepEqual((await good.response.json()).partner, { name: "Jimmy", email: jimmy.email, seller_id: "SE-00781" });
    assert.ok(supa.calls.some((call) => call.method === "PATCH" && call.path.includes("id=eq.u1")));

    const me = await fetch(`${base}/api/partner/me`, { headers: { cookie: good.cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).partner.seller_id, "SE-00781");

    const out = await fetch(`${base}/api/partner/logout`, { method: "POST", headers: { cookie: good.cookie } });
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("an admin cookie does not open the partner side", async () => {
  await withServer({}, async (base) => {
    const good = await login(base, jimmy.email, "a long partner password");
    const token = decodeURIComponent(good.cookie.split("=").slice(1).join("="));

    // Signed with the partner secret, so it reads there and nowhere else.
    assert.ok(readSession(token, partnerSecret(ADMIN_SECRET), [toAccount(jimmy)]));
    assert.equal(readSession(token, ADMIN_SECRET, [toAccount(jimmy)]), null);

    const asAdminCookie = await fetch(`${base}/api/partner/me`, { headers: { cookie: `lojiq_admin=${encodeURIComponent(token)}` } });
    assert.equal(asAdminCookie.status, 401);
  });
});

test("a switched-off account cannot sign in", async () => {
  await withServer({ rows: [{ ...jimmy, active: false }] }, async (base) => {
    assert.equal((await login(base, jimmy.email, "a long partner password")).response.status, 401);
  });
});

test("a cross-site login is refused", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/partner/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: jimmy.email, password: "a long partner password" })
    });

    assert.equal(response.status, 403);
  });
});

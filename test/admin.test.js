import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

import {
  authenticate,
  createAttemptLimiter,
  hashPassword,
  parseUsers,
  readSession,
  signSession,
  verifyPassword
} from "../admin/adminAuth.js";
import { VIEWS, buildListFormula, fieldsFor, findView, formulaString, panelFields } from "../admin/adminViews.js";
import { cellValue, createAdminPortal } from "../admin/adminRouter.js";

const SECRET = "test-secret-for-admin";
const dario = { email: "dario@example.com", name: "Dario", hash: hashPassword("correct horse battery") };
const partner = { email: "partner@example.com", name: "Partner", hash: hashPassword("another long password") };
const USERS_JSON = JSON.stringify([dario, partner]);

/* ---------------- passwords and sessions ---------------- */

test("a password verifies against its own hash only", () => {
  assert.equal(verifyPassword("correct horse battery", dario.hash), true);
  assert.equal(verifyPassword("correct horse batterY", dario.hash), false);
  assert.equal(verifyPassword("correct horse battery", "plain-text"), false);
});

test("accounts: bad entries are dropped, e-mail is case-insensitive", () => {
  const users = parseUsers(JSON.stringify([dario, { email: "x@y.z", hash: "not-a-hash" }, { name: "no email" }]));

  assert.equal(users.length, 1);
  assert.equal(authenticate(users, "DARIO@example.com", "correct horse battery")?.name, "Dario");
  assert.equal(authenticate(users, "dario@example.com", "wrong"), null);
  assert.equal(authenticate(users, "nobody@example.com", "correct horse battery"), null);
  assert.throws(() => parseUsers("{not json"));
});

test("session: signed, expires, and ends when the password changes", () => {
  const users = parseUsers(USERS_JSON);
  const token = signSession(users[0], SECRET, 1_000);

  assert.equal(readSession(token, SECRET, users, 2_000)?.email, dario.email);
  assert.equal(readSession(token, "other-secret", users, 2_000), null);
  assert.equal(readSession(token + "x", SECRET, users, 2_000), null);
  assert.equal(readSession(token, SECRET, users, 1_000 + 15 * 24 * 3600 * 1000), null);

  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), e: partner.email })).toString("base64url");
  assert.equal(readSession(`${forged}.${sig}`, SECRET, users, 2_000), null);

  const changed = [{ ...users[0], hash: hashPassword("a brand new password") }, users[1]];
  assert.equal(readSession(token, SECRET, changed, 2_000), null);
});

test("login attempts are limited per key and reset on success", () => {
  const limiter = createAttemptLimiter({ max: 3, windowMs: 1000 });

  for (let i = 0; i < 3; i += 1) limiter.fail("k", 0);
  assert.equal(limiter.blocked("k", 10), true);
  assert.equal(limiter.blocked("k", 2000), false);

  limiter.reset("k");
  assert.equal(limiter.blocked("k", 10), false);
});

/* ---------------- views ---------------- */

test("formula strings cannot be broken out of", () => {
  assert.equal(formulaString("Sneaker's"), "'Sneaker\\'s'");
  assert.equal(formulaString("a\\'b"), "'a\\\\\\'b'");
});

test("every tab has a unique key per section and a column for each id", () => {
  const seen = new Set();

  for (const view of VIEWS) {
    const id = `${view.section}/${view.key}`;
    assert.equal(seen.has(id), false, `duplicate ${id}`);
    seen.add(id);
    assert.ok(view.columns.length > 0, id);
    assert.equal(new Set(view.columns.map((c) => c.key)).size, view.columns.length, `duplicate column in ${id}`);
  }

  // The tabs from the Whimsical, minus Unpaid (that became Payouts).
  const store = VIEWS.filter((v) => v.section === "store").map((v) => v.label);
  assert.deepEqual(store, ["Queued Orders", "General", "Open Orders", "Offers", "Fulfilled", "Allocated", "Labels Requested", "Ready To Ship", "Shipment Delayed", "Shipped", "Delivered", "Completed", "Issues"]);
});

test("filters combine with the tab and only apply where they exist", () => {
  const open = findView("store", "open");
  const formula = buildListFormula(open, { store: "O'Neill Store", buyer: "ignored", search: "DD1391" });

  assert.match(formula, /^AND\(/);
  assert.match(formula, /\{Fulfillment Status\} = 'Pending'/);
  assert.match(formula, /TRIM\(\{Store Name\} & ''\) = 'O\\'Neill Store'/);
  assert.match(formula, /SEARCH\('dd1391'/);
  assert.doesNotMatch(formula, /Buyer Name/);

  const general = findView("store", "general");
  assert.match(buildListFormula(general, {}), /^NOT\(AND\(TRIM\(\{Store Name\} & ''\) = 'SneakerAsk'/);
  assert.match(buildListFormula(general, { store: "SneakerAsk" }), /^AND\(NOT\(/);

  const mwtb = findView("mwtb", "offers");
  assert.match(buildListFormula(mwtb, { store: "x", buyer: "Jan" }), /SEARCH\('jan', LOWER\(\{Buyer Name\}/);
  assert.doesNotMatch(buildListFormula(mwtb, { store: "x" }), /Store Name/);
});

test("every tab opens with the picture, once", () => {
  for (const view of VIEWS) {
    assert.equal(view.columns[0].key, "picture", `${view.section}/${view.key}`);
    assert.equal(view.columns.filter((c) => c.type === "image").length, 1, `${view.section}/${view.key}`);
  }
});

test("completed means paid, and Trusted does not count", () => {
  assert.match(findView("store", "completed").formula, /\{Invoice Status\} = 'Paid'/);
  assert.match(findView("mwtb", "completed").formula, /\{Payment Status\} = 'Paid'/);
  assert.doesNotMatch(findView("mwtb", "completed").formula, /Trusted/);
});

test("the intake queue never asks for a unit field it does not have", () => {
  assert.equal(fieldsFor(findView("store", "queued")).includes("Linked Inventory Unit"), false);
  assert.equal(panelFields("queue").includes("Linked Inventory Unit"), false);
  assert.equal(fieldsFor(findView("store", "fulfilled")).includes("Linked Inventory Unit"), true);
});

test("cells: money from lookups, safe links only, seller from the unit", () => {
  assert.deepEqual(cellValue({ type: "money", field: "P" }, { P: [120] }), { value: 120 });
  assert.deepEqual(cellValue({ type: "money", field: "P" }, {}), { value: null });
  assert.deepEqual(cellValue({ type: "url", field: "U" }, { U: "javascript:alert(1)" }), { value: "", href: "" });
  assert.deepEqual(cellValue({ type: "url", field: "U", fallback: "A" }, { A: [{ url: "https://x.test/l.pdf" }] }), { value: "Open", href: "https://x.test/l.pdf" });
  assert.deepEqual(cellValue({ type: "mono", field: "T", link: "L" }, { T: "3S123", L: "ftp://nope" }), { value: "3S123" });
  assert.deepEqual(
    cellValue({ type: "seller" }, {}, { "Seller Name": ["Jan"], "Seller ID (Lookup)": ["SE-00001"] }),
    { value: "Jan (SE-00001)" }
  );
});

/* ---------------- router ---------------- */

function fakeAirtable() {
  const calls = [];

  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const table = decodeURIComponent(u.pathname.split("/").pop());

    if (table === "Unfulfilled Orders Log") {
      return Response.json({
        records: [{ id: "recAAAAAAAAAAAAAA", fields: { "Order ID": "ORD-1", "Selling Price": 200, "Linked Inventory Unit": ["recUUUUUUUUUUUUUU"] } }],
        offset: "next-page"
      });
    }

    if (table === "Inventory Units") {
      return Response.json({ records: [{ id: "recUUUUUUUUUUUUUU", fields: { "Seller Name": ["Jan"], "Seller ID (Lookup)": ["SE-1"] } }] });
    }

    return Response.json({ records: [] });
  };

  return { calls, fetchImpl };
}

async function withServer(options, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-"));
  const pageFile = path.join(dir, "admin.html");
  fs.writeFileSync(pageFile, "<html>admin</html>");

  const logged = [];
  const audit = { record: async (entry) => logged.push(entry), forRecord: async () => [] };

  const { router } = createAdminPortal({
    usersJson: USERS_JSON,
    sessionSecret: SECRET,
    airtableToken: "t",
    airtableBaseId: "appBASE",
    audit,
    pageFile,
    ...options
  });

  const app = express();
  app.use(express.json());
  app.use(router);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(base, logged);
  } finally {
    server.close();
  }
}

async function login(base, email = dario.email, password = "correct horse battery") {
  const response = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  return { response, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}

test("router: stays off without secret or accounts", async () => {
  await withServer({ sessionSecret: "" }, async (base) => {
    assert.equal((await fetch(`${base}/admin`)).status, 503);
    assert.equal((await fetch(`${base}/api/admin/me`)).status, 503);
  });
});

test("router: login, guard, list, logout", async () => {
  const air = fakeAirtable();

  await withServer({ fetchImpl: air.fetchImpl }, async (base, logged) => {
    assert.equal((await fetch(`${base}/api/admin/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/list?section=store&view=open`)).status, 401);

    const bad = await login(base, dario.email, "wrong password");
    assert.equal(bad.response.status, 401);
    assert.equal(bad.cookie, "");

    const { response, cookie } = await login(base);
    assert.equal(response.status, 200);
    assert.match(cookie, /^lojiq_admin=/);
    assert.equal(logged.at(-1).action, "login");
    assert.equal(logged.at(-1).actor.email, dario.email);

    const me = await (await fetch(`${base}/api/admin/me`, { headers: { cookie } })).json();
    assert.equal(me.user.name, "Dario");
    assert.ok(me.views.some((v) => v.section === "mwtb" && v.key === "offers"));

    const list = await fetch(`${base}/api/admin/list?section=store&view=open&store=Test%20Store`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const data = await list.json();
    assert.equal(data.next_offset, "next-page");
    assert.equal(data.rows[0].cells.order_id.value, "ORD-1");
    assert.equal(data.rows[0].cells.selling.value, 200);

    const orderCall = air.calls.find((u) => u.pathname.endsWith(encodeURIComponent("Unfulfilled Orders Log")));
    assert.match(orderCall.searchParams.get("filterByFormula"), /Test Store/);
    assert.ok(orderCall.searchParams.getAll("fields[]").includes("Target Buying Price"));

    assert.equal((await fetch(`${base}/api/admin/list?section=store&view=nope`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/admin/record?source=store&id=../../etc`, { headers: { cookie } })).status, 400);

    const crossSite = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: dario.email, password: "correct horse battery" })
    });
    assert.equal(crossSite.status, 403);

    const out = await fetch(`${base}/api/admin/logout`, { method: "POST", headers: { cookie } });
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("router: record reads its unit and returns the panel groups", async () => {
  const air = fakeAirtable();

  await withServer({ fetchImpl: air.fetchImpl }, async (base) => {
    const { cookie } = await login(base);
    const response = await fetch(`${base}/api/admin/record?source=store&id=recAAAAAAAAAAAAAA`, { headers: { cookie } });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.label, "ORD-1");
    assert.equal(data.groups.at(-1).title, "Inventory unit");

    // Looked up inside the right table, never base-wide.
    const recordCall = air.calls.find((u) => /RECORD_ID\(\) = 'recAAAAAAAAAAAAAA'/.test(u.searchParams.get("filterByFormula") || ""));
    assert.ok(recordCall.pathname.endsWith(encodeURIComponent("Unfulfilled Orders Log")));
  });
});

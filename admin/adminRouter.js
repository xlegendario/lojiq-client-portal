// admin/adminRouter.js
//
// The Lojiq Admin portal: the page on /admin and everything it calls under
// /api/admin: every Store Orders and Member WTBs tab, the filters, search, the
// side panel, and the buttons. What each button does lives in adminActions.js;
// every one goes through the action log.
//
// Nothing here trusts the browser for identity. Every /api/admin route but
// login needs the signed admin cookie; see adminAuth.js.

import express from "express";
import fs from "fs";
import path from "path";

import {
  COOKIE,
  SESSION_TTL_MS,
  authenticate,
  cookieHeader,
  createAttemptLimiter,
  parseUsers,
  readCookie,
  readSession,
  signSession
} from "./adminAuth.js";
import {
  PANELS,
  TABLES,
  UNIT_FIELDS,
  UNIT_PANEL,
  VIEWS,
  buildListFormula,
  fieldsFor,
  findView,
  formulaString,
  panelFields,
  publicViews,
  searchFormula,
  sortFieldFor
} from "./adminViews.js";
import { NAME_MAX, SECTIONS, cleanFilters } from "./adminFilters.js";
import {
  ActionError,
  LINK_FIELDS,
  actionFields,
  availableActions,
  describeAction,
  publicActions,
  rowLinks,
  runAction
} from "./adminActions.js";
import { PaymentError, loadOpenPayments, markPaidByBankTransfer } from "./adminPayments.js";
import { PayoutError, SHIPPING_FILTERS, loadPayouts, markUnitsPaid } from "./adminPayouts.js";
import { createForwardingStore, mountForwarding } from "./adminForwarding.js";
import { createBolPagesStore, mountBolPages } from "./adminBolPages.js";
import { createExternalSalesStore, mountExternalSales } from "./adminExternalSales.js";
import { createMolliePayoutsStore, mountMolliePayouts } from "./adminMolliePayouts.js";
import { createSelfBilling, mountSelfBilling } from "./adminSelfBilling.js";
import { createSupabaseRest } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const PAGE_SIZE = 50;
const CACHE_MS = 15_000;
const STORES_CACHE_MS = 10 * 60_000;

/* ---------------- values ---------------- */

// Lookups arrive as lists; a cell shows them as one value.
function flat(value) {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (item && typeof item === "object" ? item.name || item.url || "" : item))
      .filter((item) => item !== null && item !== undefined && item !== "");

    return parts.length ? parts.join(", ") : "";
  }

  if (value && typeof value === "object") return value.name || value.url || "";

  return value === null || value === undefined ? "" : value;
}

function number(value) {
  const first = Array.isArray(value) ? value.find((item) => item !== null && item !== "") : value;
  const n = typeof first === "number" ? first : Number(first);

  return Number.isFinite(n) && first !== "" && first !== undefined && first !== null ? n : null;
}

function attachmentUrl(value, thumb = false) {
  const first = Array.isArray(value) ? value[0] : null;

  if (!first) return "";

  return (thumb && (first.thumbnails?.small?.url || first.thumbnails?.large?.url)) || first.url || "";
}

// Only web addresses become links; anything else stays plain text.
function safeUrl(value) {
  const raw = text(flat(value));

  return /^https?:\/\//i.test(raw) ? raw : "";
}

function sellerLabel(unit, fields) {
  const name = text(flat(unit?.["Seller Company Name"])) || text(flat(unit?.["Seller Name"]));
  const id = text(flat(unit?.["Seller ID (Lookup)"])) || text(flat(fields?.["Seller ID (Lookup)"]));

  if (name && id) return `${name} (${id})`;

  return name || id;
}

// One field, made ready for the page: { value, href? }.
export function cellValue(spec, fields, unit) {
  switch (spec.type) {
    case "money":
    case "hours":
      return { value: number(fields[spec.field]) };

    case "image":
      return { value: attachmentUrl(fields[spec.field], true) };

    case "url": {
      const href = safeUrl(fields[spec.field]) || (spec.fallback ? attachmentUrl(fields[spec.fallback]) : "");
      return { value: href ? "Open" : "", href };
    }

    case "fixed":
      return { value: spec.value || "" };

    case "seller":
      return { value: sellerLabel(unit, fields) };

    case "unit":
      return { value: spec.unitType === "money" ? number(unit?.[spec.unitField]) : flat(unit?.[spec.unitField]) };

    default: {
      const cell = { value: flat(fields[spec.field]) };

      if (spec.link) {
        const href = safeUrl(fields[spec.link]);
        if (href) cell.href = href;
      }

      return cell;
    }
  }
}

/* ---------------- Airtable ---------------- */

function createAirtableReader({ token, baseId, fetchImpl }) {
  async function select(table, { formula = "", fields = [], sort = "", pageSize = PAGE_SIZE, offset = "", maxRecords = 0 } = {}) {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);

    if (formula) url.searchParams.set("filterByFormula", formula);
    for (const field of fields) url.searchParams.append("fields[]", field);
    if (sort) {
      url.searchParams.set("sort[0][field]", sort);
      url.searchParams.set("sort[0][direction]", "desc");
    }
    url.searchParams.set("pageSize", String(Math.min(pageSize, 100)));
    if (maxRecords) url.searchParams.set("maxRecords", String(maxRecords));
    if (offset) url.searchParams.set("offset", offset);

    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.error?.message || data?.error?.type || `Airtable answered ${response.status}`;
      throw new Error(`${table}: ${message}`);
    }

    return { records: data.records || [], offset: data.offset || "" };
  }

  // Records by id, always inside the named table. Not .find(): that resolves
  // an id across the whole base and cannot tell which table it came from.
  async function byIds(table, ids, fields) {
    const unique = [...new Set(ids.filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];
    const out = new Map();

    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const { records } = await select(table, {
        formula: `OR(${chunk.map((id) => `RECORD_ID() = '${id}'`).join(",")})`,
        fields,
        pageSize: 100
      });

      for (const record of records) out.set(record.id, record.fields || {});
    }

    return out;
  }

  // One record, written. Only ever called from an action in adminActions.js,
  // after that action has read the record fresh and checked it may run.
  async function update(table, id, fields) {
    const response = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(30_000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`${table}: ${data?.error?.message || data?.error?.type || `Airtable answered ${response.status}`}`);
    }

    return data;
  }

  async function create(table, fields) {
    const response = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(30_000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`${table}: ${data?.error?.message || data?.error?.type || `Airtable answered ${response.status}`}`);
    }

    return data;
  }

  return { select, byIds, update, create };
}

/* ---------------- the router ---------------- */

/*
 * deps:
 *   usersJson       LOJIQ_ADMIN_USERS
 *   sessionSecret   LOJIQ_ADMIN_SECRET; without it and the users the portal stays off
 *   airtableToken, airtableBaseId
 *   audit           createAuditLog(...)
 *   savedFilters    createSavedFilters(...)
 *   services        { wmsBaseUrl, kickzBaseUrl, counterOffersSecret, kcPortalSecret,
 *                     discordUpdatesBaseUrl, deliveredWebhookUrl, mollieApiKey } for the buttons
 *   pageFile        private/admin.html
 *   supabaseUrl, serviceKey  for Forward Service (forwarding_log)
 */
export function createAdminPortal({ usersJson, sessionSecret, airtableToken, airtableBaseId, audit, savedFilters, services = {}, pageFile, supabaseUrl = "", serviceKey = "", fetchImpl = fetch, externalSalesSyncMs = 5 * 60_000 }) {
  const router = express.Router();
  const users = parseUsers(usersJson);
  const enabled = Boolean(text(sessionSecret) && users.length);
  const airtable = createAirtableReader({ token: airtableToken, baseId: airtableBaseId, fetchImpl });
  const attempts = createAttemptLimiter();
  const cache = new Map();

  const storesCache = { store: { at: 0, names: [] }, all: { at: 0, names: [] } };

  const page = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  function cached(key, load) {
    const hit = cache.get(key);

    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;

    const promise = load();
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));

    if (cache.size > 500) {
      for (const [candidate, value] of cache) {
        if (Date.now() - value.at > CACHE_MS) cache.delete(candidate);
      }
    }

    return promise;
  }

  function currentUser(req) {
    return enabled ? readSession(readCookie(req, COOKIE), sessionSecret, users) : null;
  }

  const noStore = (res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
  };

  /* ----- page ----- */

  router.get(["/admin", "/admin/"], (req, res) => {
    noStore(res);

    if (!enabled) {
      return res.status(503).type("text").send("The admin portal is not configured yet (LOJIQ_ADMIN_SECRET and LOJIQ_ADMIN_USERS).");
    }

    res.type("html").send(page);
  });

  /* ----- session ----- */

  // A browser form elsewhere cannot post JSON here with our cookie, but check
  // the origin as well so a cross-site request is refused outright.
  function sameOrigin(req) {
    const origin = text(req.headers.origin);

    if (!origin) return true;

    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  router.post("/api/admin/login", express.json({ limit: "10kb" }), async (req, res) => {
    noStore(res);

    if (!enabled) return res.status(503).json({ error: "The admin portal is not configured yet." });
    if (!sameOrigin(req)) return res.status(403).json({ error: "Not allowed" });

    const email = text(req.body?.email).toLowerCase();
    const password = String(req.body?.password ?? "");
    const key = `${req.ip}|${email}`;

    if (attempts.blocked(key)) {
      return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }

    const user = email && password ? authenticate(users, email, password) : null;

    if (!user) {
      attempts.fail(key);
      console.warn("[admin] failed login for", email || "(no email)", "from", req.ip);
      return res.status(401).json({ error: "E-mail or password is incorrect." });
    }

    attempts.reset(key);
    res.append("Set-Cookie", cookieHeader(req, signSession(user, sessionSecret), Math.floor(SESSION_TTL_MS / 1000)));
    audit.record({ actor: user, action: "login", details: { ip: req.ip } });

    res.json({ user: { email: user.email, name: user.name } });
  });

  router.post("/api/admin/logout", (req, res) => {
    noStore(res);

    const user = currentUser(req);

    res.append("Set-Cookie", cookieHeader(req, "", 0));
    if (user) audit.record({ actor: user, action: "logout" });

    res.json({ ok: true });
  });

  // Everything below needs a signed-in admin.
  router.use("/api/admin", (req, res, next) => {
    noStore(res);

    if (!enabled) return res.status(503).json({ error: "The admin portal is not configured yet." });

    const user = currentUser(req);

    if (!user) return res.status(401).json({ error: "Not signed in" });
    if (req.method !== "GET" && !sameOrigin(req)) return res.status(403).json({ error: "Not allowed" });

    req.admin = user;
    next();
  });

  // Forward Service: partner forwards in Supabase. Its own module and page
  // (admin/adminForwarding.js, private/admin-forwarding.html).
  mountForwarding(router, {
    store: createForwardingStore({ supabaseUrl, serviceKey, fetchImpl }),
    audit,
    callWms: (pathName, body) => deps.callWms(pathName, body),
    pageFile: pageFile ? path.join(path.dirname(pageFile), "admin-forwarding.html") : ""
  });

  // bol pages: offers the bol sync refused because bol's page is another
  // shoe or size (admin/adminBolPages.js, private/admin-bol-pages.html).
  const bolPages = createBolPagesStore({ supabaseUrl, serviceKey, fetchImpl });

  mountBolPages(router, {
    store: bolPages,
    audit,
    pageFile: pageFile ? path.join(path.dirname(pageFile), "admin-bol-pages.html") : ""
  });

  // External Sales: deals, parcels, money and checks, in Supabase
  // (admin/adminExternalSales.js, admin/externalSalesSync.js,
  // private/admin-external-sales.html).
  const externalSalesStore = createExternalSalesStore({
    airtable,
    supabaseUrl,
    serviceKey,
    callWms: (pathName, body) => deps.callWms(pathName, body),
    rompslompToken: services.rompslompToken,
    rompslompCompanyId: services.rompslompCompanyId,
    sendMail: services.sendInvoiceMail || null,
    mailFrom: services.invoiceMailFrom,
    replyTo: services.invoiceReplyTo,
    mollieApiKey: services.mollieApiKey,
    paymentWebhookUrl: services.mollieWebhookUrl,
    paymentRedirectUrl: services.externalPaymentRedirectUrl,
    fetchImpl
  });

  mountExternalSales(router, {
    store: externalSalesStore,
    audit,
    internalSecret: services.counterOffersSecret,
    pageFile: pageFile ? path.join(path.dirname(pageFile), "admin-external-sales.html") : ""
  });

  // The self-billing purchase invoice for any unit we bought
  // (admin/adminSelfBilling.js, admin/selfBillingPdf.js).
  const selfBilling = createSelfBilling({ airtable });

  mountSelfBilling(router, { store: selfBilling, internalSecret: services.counterOffersSecret });

  // Mollie payouts: what ING paid out, split into the payments in it and the
  // invoices behind them (admin/adminMolliePayouts.js,
  // private/admin-mollie-payouts.html).
  mountMolliePayouts(router, {
    store: createMolliePayoutsStore({
      airtable,
      db: createSupabaseRest({ supabaseUrl, serviceKey, fetchImpl }),
      token: services.mollieReportingToken,
      profileId: services.mollieProfileId,
      fetchImpl
    }),
    audit,
    pageFile: pageFile ? path.join(path.dirname(pageFile), "admin-mollie-payouts.html") : ""
  });

  // unref: the timer never keeps the process (or a test) alive on its own.
  if (enabled && externalSalesStore.configured && externalSalesSyncMs > 0) {
    // Every ten minutes: which invoices Rompslomp now has as paid (block 5).
    const payTick = () => externalSalesStore.checkPayments()
      .then((out) => { if (out.changed.length || out.errors.length) console.log("[external sales payments]", JSON.stringify(out)); })
      .catch((err) => console.error("[external sales payments]", err.message));
    setTimeout(payTick, 45_000).unref?.();
    setInterval(payTick, externalSalesSyncMs * 2).unref?.();
  }

  /*
   * Counts for the sidebar, every tab at once.
   *
   * Measured on 17-09-2026: counting a tab costs one Airtable call per 100
   * rows. Most tabs are one to six calls. Store Orders General (12,500 rows,
   * 126 calls, 32 s), Fulfilled (3,600) and Delivered (3,100) are archives
   * that only grow, so they get no count rather than slowing everything down.
   *
   * Computed at most every five minutes and only while someone has the admin
   * open; the page asks after it has drawn, so it never waits on this.
   *
   * CHANGED - Airtable allows five requests a second per base, shared with
   * the portal, the WMS and every sync. The first version counted Open
   * Payments and Payouts by loading them in full and fired its calls as fast
   * as they came back: 81 calls in 11 seconds, peaking at 13 a second, every
   * two minutes. Now the tabs are counted at two calls a second at most, and
   * Open Payments and Payouts show the count from the last time their own tab
   * was loaded (not loaded yet means no count yet).
   */
  const UNCOUNTED = new Set(["store/general", "store/fulfilled", "store/delivered"]);
  const COUNTS_MS = 300_000;
  const COUNT_CALL_GAP_MS = 500;
  const lastMoneyCounts = {};
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const forwardingCounts = createForwardingStore({ supabaseUrl, serviceKey, fetchImpl });
  let countsCache = { at: 0, promise: null };

  async function countView(view) {
    let offset = "";
    let total = 0;
    let calls = 0;

    do {
      const page = await airtable.select(TABLES[view.source], {
        formula: buildListFormula(view, {}),
        fields: view.exclude ? listFields(view) : ["Fulfillment Status"],
        pageSize: 100,
        offset
      });

      total += view.exclude ? page.records.filter((record) => !view.exclude(record.fields || {})).length : page.records.length;
      offset = page.offset;
      calls += 1;

      await pause(COUNT_CALL_GAP_MS);
    } while (offset && calls < 20);

    return offset ? null : total;
  }

  async function loadCounts() {
    const tabs = {};

    // One after another: a burst of parallel calls would eat into the
    // Airtable rate limit everything else on this base shares.
    for (const view of VIEWS) {
      const key = `${view.section}/${view.key}`;
      if (UNCOUNTED.has(key)) continue;

      try {
        tabs[key] = await countView(view);
      } catch (err) {
        console.error("[admin] count failed:", key, err.message);
      }
    }

    Object.assign(tabs, lastMoneyCounts);

    if (externalSalesStore.configured) {
      try {
        const sales = await externalSalesStore.counts();
        tabs["external/pending"] = sales.pending;
        tabs["external/ready"] = sales.ready;
        tabs["external/checks"] = sales.checks;
      } catch (err) {
        console.error("[admin] external sales counts failed:", err.message);
      }
    }

    if (forwardingCounts.configured) {
      try {
        const forwards = await forwardingCounts.counts();
        tabs["forwarding/awaiting_label"] = forwards.awaiting_label;
        tabs["forwarding/ready_to_ship"] = forwards.ready_to_ship;
        tabs["forwarding/shipped"] = forwards.shipped;
        tabs["money/forwarding_payments"] = forwards.unpaid;
      } catch (err) {
        console.error("[admin] forwarding counts failed:", err.message);
      }

      try {
        tabs["marketplaces/bol_pages"] = (await bolPages.counts()).blocked;
      } catch (err) {
        console.error("[admin] bol page counts failed:", err.message);
      }
    }

    return { tabs, at: new Date().toISOString() };
  }

  router.get("/api/admin/counts", async (req, res) => {
    if (!countsCache.promise || Date.now() - countsCache.at > COUNTS_MS || req.query.fresh) {
      countsCache = { at: Date.now(), promise: loadCounts() };
      countsCache.promise.catch(() => { countsCache = { at: 0, promise: null }; });
    }

    try {
      res.json(await countsCache.promise);
    } catch (err) {
      console.error("[admin] counts failed:", err.message);
      res.status(502).json({ error: "Could not count the tabs." });
    }
  });

  router.get("/api/admin/me", (req, res) => {
    res.json({ user: { email: req.admin.email, name: req.admin.name }, views: publicViews(), actions: publicActions() });
  });

  // Every store that can have store orders, for the Store Name filter: Order
  // Intake API or Both. Blank counts as API, as it does in the client portal;
  // a Manual store only ever has Member WTBs.
  router.get("/api/admin/stores", async (req, res) => {
    try {
      // Open Payments also covers Manual stores, whose want-to-buys are billed too.
      const kind = req.query.all === "1" ? "all" : "store";
      const entry = storesCache[kind];

      if (Date.now() - entry.at > STORES_CACHE_MS) {
        const names = new Set();
        let offset = "";

        do {
          const page = await airtable.select(TABLES.merchants, {
            formula: kind === "all" ? "" : `LOWER(TRIM({Order Intake} & '')) != 'manual'`,
            fields: ["Store Name"],
            pageSize: 100,
            offset
          });

          for (const record of page.records) {
            const name = text(record.fields?.["Store Name"]);
            if (name) names.add(name);
          }

          offset = page.offset;
        } while (offset);

        entry.at = Date.now();
        entry.names = [...names].sort((a, b) => a.localeCompare(b));
      }

      res.json({ stores: entry.names });
    } catch (err) {
      console.error("[admin] stores failed:", err.message);
      res.status(502).json({ error: "Could not load the stores from Airtable." });
    }
  });

  async function unitsFor(records) {
    const ids = records.map((record) => (record.fields?.["Linked Inventory Unit"] || [])[0]).filter(Boolean);

    if (!ids.length) return new Map();

    try {
      return await airtable.byIds(TABLES.units, ids, UNIT_FIELDS);
    } catch (err) {
      // A missing seller column is not worth an empty tab.
      console.error("[admin] units failed:", err.message);
      return new Map();
    }
  }

  router.get("/api/admin/list", async (req, res) => {
    const view = findView(text(req.query.section), text(req.query.view));

    if (!view) return res.status(404).json({ error: "Unknown tab" });

    // ?store=A&store=B, with store_mode=exclude to leave those out instead.
    const filters = {
      stores: [].concat(req.query.store || []).map(text),
      storeMode: req.query.store_mode === "exclude" ? "exclude" : "include",
      buyer: text(req.query.buyer),
      search: text(req.query.q)
    };
    const offset = text(req.query.offset);
    const key = JSON.stringify([view.section, view.key, filters, offset]);

    try {
      const data = await cached(key, async () => {
        const page = await airtable.select(TABLES[view.source], {
          formula: buildListFormula(view, filters),
          fields: listFields(view),
          sort: sortFieldFor(view),
          // A tab that leaves rows out after reading asks for more per page.
          pageSize: view.exclude ? 100 : PAGE_SIZE,
          offset
        });

        if (view.exclude) page.records = page.records.filter((record) => !view.exclude(record.fields || {}));

        const units = view.source === "queue" ? new Map() : await unitsFor(page.records);

        return {
          rows: page.records.map((record) => {
            const fields = record.fields || {};
            const unit = units.get((fields["Linked Inventory Unit"] || [])[0]);
            const cells = {};

            for (const column of view.columns) cells[column.key] = cellValue(column, fields, unit);

            return {
              id: record.id,
              cells,
              actions: availableActions(view.source, view.actions, fields),
              links: view.actions.length ? rowLinks(view.source, fields) : {}
            };
          }),
          next_offset: page.offset
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] list failed:", view.section, view.key, err.message);

      // Airtable forgets an offset after a few minutes; say so plainly.
      if (/offset/i.test(err.message)) {
        return res.status(409).json({ error: "This list changed or expired. Refresh to start from the top." });
      }

      res.status(502).json({ error: "Could not load this list from Airtable.", details: err.message });
    }
  });

  /* ----- saved filters ----- */

  router.get("/api/admin/filters", async (req, res) => {
    const section = text(req.query.section);

    if (!SECTIONS.includes(section)) return res.status(400).json({ error: "Unknown section" });
    if (!savedFilters?.configured) return res.json({ filters: [], available: false });

    try {
      const rows = await savedFilters.list(section);

      // Your own first, then everyone else's; each alphabetical.
      rows.sort((a, b) =>
        Number(b.owner_email === req.admin.email) - Number(a.owner_email === req.admin.email) ||
        a.name.localeCompare(b.name)
      );

      res.json({
        available: true,
        filters: rows.map(({ owner_email: ownerEmail, ...row }) => ({ ...row, mine: ownerEmail === req.admin.email }))
      });
    } catch (err) {
      console.error("[admin] filters failed:", err.message);
      res.status(502).json({ error: "Could not load the saved filters." });
    }
  });

  router.post("/api/admin/filters", async (req, res) => {
    const section = text(req.body?.section);
    const name = text(req.body?.name).replace(/\s+/g, " ");

    if (!SECTIONS.includes(section)) return res.status(400).json({ error: "Unknown section" });
    if (!name) return res.status(400).json({ error: "Give the filter a name." });
    if (name.length > NAME_MAX) return res.status(400).json({ error: `Keep the name under ${NAME_MAX} characters.` });
    if (!savedFilters?.configured) return res.status(503).json({ error: "Saved filters are not available yet." });

    try {
      const saved = await savedFilters.save({
        owner: req.admin,
        section,
        name,
        filters: cleanFilters(section, req.body?.filters)
      });

      audit.record({ actor: req.admin, action: "save filter", source: section, label: name, details: saved.filters });

      res.json({ filter: { ...saved, mine: true } });
    } catch (err) {
      console.error("[admin] save filter failed:", err.message);
      res.status(502).json({ error: "Could not save the filter." });
    }
  });

  router.delete("/api/admin/filters/:id", async (req, res) => {
    const id = text(req.params.id);

    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "Unknown filter" });
    if (!savedFilters?.configured) return res.status(503).json({ error: "Saved filters are not available yet." });

    try {
      const deleted = await savedFilters.remove({ owner: req.admin, id });

      if (!deleted) return res.status(403).json({ error: "You can only delete your own filters." });

      audit.record({ actor: req.admin, action: "delete filter", details: { id } });
      res.json({ ok: true });
    } catch (err) {
      console.error("[admin] delete filter failed:", err.message);
      res.status(502).json({ error: "Could not delete the filter." });
    }
  });

  // The search bar at the top: orders and want-to-buys at once.
  router.get("/api/admin/search", async (req, res) => {
    const query = text(req.query.q);

    if (query.length < 2) return res.json({ results: [] });

    const sources = [
      { section: "store", source: "store", table: TABLES.store, id: "Order ID", title: "Shopify Product Name", sub: ["Store Name", "Size", "Fulfillment Status"], sort: "Order Date" },
      { section: "mwtb", source: "mwtb", table: TABLES.mwtb, id: "Member WTB ID", title: "Product Name", sub: ["Buyer Name", "Size", "Fulfillment Status"], sort: "Date" }
    ];

    try {
      const groups = await cached(`search:${query.toLowerCase()}`, () =>
        Promise.all(
          sources.map(async (source) => {
            const { records } = await airtable.select(source.table, {
              formula: searchFormula(source.source, query),
              fields: [source.id, source.title, ...source.sub],
              sort: source.sort,
              pageSize: 8,
              maxRecords: 8
            });

            return records.map((record) => ({
              section: source.section,
              id: record.id,
              label: text(flat(record.fields?.[source.id])),
              title: text(flat(record.fields?.[source.title])),
              sub: source.sub.map((field) => text(flat(record.fields?.[field]))).filter(Boolean).join(" · ")
            }));
          })
        )
      );

      res.json({ results: groups.flat() });
    } catch (err) {
      console.error("[admin] search failed:", err.message);
      res.status(502).json({ error: "Search failed. Try again." });
    }
  });

  /* ----- buttons ----- */

  function listFieldsFor(source, actionKeys) {
    const fields = new Set(actionFields(source, actionKeys));
    if (actionKeys.some((key) => key === "track" || key === "discord")) for (const field of LINK_FIELDS[source] || []) fields.add(field);
    return [...fields];
  }

  function listFields(view) {
    return [...new Set([...fieldsFor(view), ...(view.actions.length ? listFieldsFor(view.source, view.actions) : [])])];
  }

  const service = (base) => text(base).replace(/\/$/, "");

  async function post(url, body, headers = {}) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The owning service's own sentence is the useful one ("This offer is no longer available.").
      throw new ActionError(text(data.error || data.message || data.details) || `The service answered ${response.status}.`, response.status >= 500 ? 502 : 409);
    }

    return data;
  }

  const deps = {
    airtable,

    // The lists behind the store's and buyer's own Offers tabs.
    async getKc(pathName, params) {
      if (!service(services.kickzBaseUrl) || !text(services.counterOffersSecret)) {
        throw new ActionError("This button needs COUNTER_OFFERS_SECRET on this service.", 503);
      }

      const url = new URL(`${service(services.kickzBaseUrl)}${pathName}`);
      for (const [name, value] of Object.entries(params || {})) url.searchParams.set(name, value);

      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "x-kc-secret": services.counterOffersSecret },
        signal: AbortSignal.timeout(60_000)
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new ActionError(text(data.error || data.details) || `Kickz Caviar answered ${response.status}.`, 502);
      }

      return data;
    },

    callKc(pathName, body, which = "counter") {
      const secret = which === "portal" ? services.kcPortalSecret : services.counterOffersSecret;
      if (!service(services.kickzBaseUrl) || !text(secret)) {
        throw new ActionError(which === "portal" ? "Sending member offers needs KC_PORTAL_SECRET on this service." : "This button needs COUNTER_OFFERS_SECRET on this service.", 503);
      }
      return post(`${service(services.kickzBaseUrl)}${pathName}`, body, { "x-kc-secret": secret });
    },

    callWms(pathName, body) {
      if (!service(services.wmsBaseUrl)) throw new ActionError("The WMS address is not configured.", 503);
      return post(`${service(services.wmsBaseUrl)}${pathName}`, body);
    },

    get itemShippedUrl() {
      return service(services.discordUpdatesBaseUrl) ? `${service(services.discordUpdatesBaseUrl)}/` : "";
    },

    get discordUpdatesUrl() {
      return service(services.discordUpdatesBaseUrl) ? `${service(services.discordUpdatesBaseUrl)}/` : "";
    },

    get deliveredWebhookUrl() {
      return text(services.deliveredWebhookUrl);
    },

    // A notification that fails must not undo the status that was already
    // written; it comes back as a sentence in the result instead.
    async notify(url, body, label) {
      if (!url) return `No ${label} sent (not configured here).`;

      try {
        await post(url, body);
        return "";
      } catch (err) {
        console.error("[admin] notification failed:", label, err.message);
        return `The ${label} could not be sent.`;
      }
    },

    async firstLinked(table, value, fields) {
      const id = Array.isArray(value) ? value[0] : value;
      if (!id) return null;
      return (await airtable.byIds(table, [id], fields).catch(() => new Map())).get(id) || null;
    }
  };

  async function freshRecord(source, id, key) {
    if (!TABLES[source] || source === "units" || source === "merchants") throw new ActionError("Unknown list", 404);
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new ActionError("Invalid record", 400);

    const idField = PANELS[source]?.[0]?.fields?.[0]?.field;
    const fields = [...new Set([...actionFields(source, [key]), ...(idField ? [idField] : [])])];
    const found = await airtable.byIds(TABLES[source], [id], fields);

    if (!found.has(id)) throw new ActionError("This record no longer exists.", 404);

    return { id, fields: found.get(id), label: idField ? text(flat(found.get(id)[idField])) : id };
  }

  function actionError(res, err, key) {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
    console.error("[admin] action failed:", key, err.message);
    return res.status(502).json({ error: "Something went wrong while doing this. Nothing is guaranteed to have changed; check the record." });
  }

  // What the dialog should say for this record right now.
  router.get("/api/admin/action", async (req, res) => {
    const key = text(req.query.action);
    const source = text(req.query.source);

    try {
      if (!publicActions()[key]) throw new ActionError("This button does not exist.", 404);
      const record = await freshRecord(source, text(req.query.id), key);
      res.json({ label: record.label, ...(await describeAction(key, source, record, deps)) });
    } catch (err) {
      actionError(res, err, key);
    }
  });

  async function perform(req, res, { key, source, id, input, file }) {
    try {
      const record = await freshRecord(source, id, key);
      const result = await runAction({ key, source, record, input, file, deps });

      cache.clear();
      audit.record({
        actor: req.admin,
        action: publicActions()[key]?.label || key,
        source,
        recordId: id,
        label: record.label,
        details: { changed: result.changed || null, note: result.message }
      });

      res.json({ ok: true, message: result.message });
    } catch (err) {
      actionError(res, err, key);
    }
  }

  router.post("/api/admin/action", async (req, res) => {
    const input = req.body?.input && typeof req.body.input === "object" ? req.body.input : {};
    const key = text(req.body?.action);

    if (publicActions()[key]?.upload) return res.status(400).json({ error: "Upload the file through the upload form." });

    await perform(req, res, { key, source: text(req.body?.source), id: text(req.body?.id), input, file: null });
  });

  // The label itself travels as the raw PDF, so the JSON body limit of the
  // rest of the portal does not apply to it.
  router.post("/api/admin/action/upload", express.raw({ type: "application/pdf", limit: "10mb" }), async (req, res) => {
    const key = text(req.query.action);

    if (!publicActions()[key]?.upload) return res.status(400).json({ error: "This button does not take a file." });
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "The label must be a PDF file." });

    await perform(req, res, {
      key,
      source: text(req.query.source),
      id: text(req.query.id),
      input: { tracking: text(req.query.tracking) },
      file: req.body
    });
  });

  /* ----- Open Payments ----- */

  router.get("/api/admin/payments", async (req, res) => {
    const filters = {
      stores: [].concat(req.query.store || []).map(text),
      storeMode: req.query.store_mode === "exclude" ? "exclude" : "include",
      search: text(req.query.q),
      kind: ["store", "mwtb"].includes(req.query.kind) ? req.query.kind : "all"
    };

    try {
      const data = await cached(JSON.stringify(["payments", filters, req.query._ ? Date.now() : 0]), () => loadOpenPayments(airtable, filters));

      // Unfiltered, this is the number behind the tab in the sidebar.
      if (!filters.stores.length && !filters.search && filters.kind === "all") lastMoneyCounts["money/payments"] = data.count;

      res.json(data);
    } catch (err) {
      console.error("[admin] open payments failed:", err.message);
      res.status(502).json({ error: "Could not load the open payments from Airtable." });
    }
  });

  const paymentDeps = {
    airtable,

    async tellKickzPaid(memberWtbIds) {
      if (!service(services.kickzBaseUrl) || !text(services.counterOffersSecret)) {
        return "Kickz Caviar was not told these want-to-buys are paid (not configured here); the seller's label step may wait.";
      }

      const failed = [];

      for (const id of memberWtbIds) {
        try {
          await post(`${service(services.kickzBaseUrl)}/api/internal/member-wtb-paid`, { member_wtb_record_id: id }, { "x-kc-secret": services.counterOffersSecret });
        } catch (err) {
          console.error("[admin] member-wtb-paid failed:", id, err.message);
          failed.push(id);
        }
      }

      return failed.length ? `Kickz Caviar could not be told about ${failed.length} paid want-to-buy(s); the seller's label step may wait.` : "";
    },

    // A payment link that stays live could still take money for amounts that are paid now.
    async archiveMollieLink(linkId) {
      if (!text(services.mollieApiKey)) return "the Mollie link could not be switched off here (no Mollie key); it can still be paid.";

      try {
        const response = await fetchImpl(`https://api.mollie.com/v2/payment-links/${encodeURIComponent(linkId)}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${services.mollieApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
          signal: AbortSignal.timeout(20_000)
        });

        if (response.ok) return "";

        const data = await response.json().catch(() => ({}));
        console.error("[admin] archiving Mollie link failed:", linkId, response.status, data.detail || data.title);
        return "the Mollie link could not be switched off; it can still be paid. Deactivate it in Mollie.";
      } catch (err) {
        console.error("[admin] archiving Mollie link failed:", linkId, err.message);
        return "the Mollie link could not be switched off; it can still be paid. Deactivate it in Mollie.";
      }
    }
  };

  router.post("/api/admin/payments/mark-paid", async (req, res) => {
    try {
      const result = await markPaidByBankTransfer({ targets: req.body?.targets, deps: paymentDeps });

      cache.clear();

      for (const target of result.targets) {
        audit.record({
          actor: req.admin,
          action: "Mark paid (bank transfer)",
          source: target.source,
          recordId: target.id,
          label: target.label,
          details: { store: result.store, total: result.total, count: result.count, cancelled_links: result.cancelled }
        });
      }

      const amount = result.total.toLocaleString("nl-NL", { style: "currency", currency: "EUR" });
      const message = [
        `${result.count} amount${result.count === 1 ? "" : "s"} for ${result.store} marked paid (${amount}, bank transfer).`,
        result.cancelled.length ? `Cancelled payment link ${result.cancelled.join(", ")}.` : "",
        ...result.notes
      ].filter(Boolean).join(" ");

      res.json({ ok: true, message });
    } catch (err) {
      if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
      console.error("[admin] mark paid failed:", err.message);
      res.status(502).json({ error: "Something went wrong while marking this paid. Check the records before trying again." });
    }
  });

  /* ----- Payouts ----- */

  router.get("/api/admin/payouts", async (req, res) => {
    const filters = {
      shipping: SHIPPING_FILTERS.includes(req.query.shipping) ? req.query.shipping : "all",
      type: text(req.query.type),
      search: text(req.query.q)
    };

    try {
      const data = await cached(JSON.stringify(["payouts", filters, req.query._ ? Date.now() : 0]), () => loadPayouts(airtable, filters));

      if (filters.shipping === "all" && !filters.type && !filters.search) lastMoneyCounts["money/payouts"] = data.count;

      res.json(data);
    } catch (err) {
      console.error("[admin] payouts failed:", err.message);
      res.status(502).json({ error: "Could not load the payouts from Airtable." });
    }
  });

  router.post("/api/admin/payouts/mark-paid", async (req, res) => {
    try {
      const result = await markUnitsPaid({ ids: req.body?.ids, airtable });

      cache.clear();

      for (const unit of result.units) {
        audit.record({
          actor: req.admin,
          action: "Payout marked paid",
          source: "units",
          recordId: unit.id,
          label: unit.item,
          details: { seller: result.seller, units: result.count, total: result.total }
        });
      }

      const amount = result.total.toLocaleString("nl-NL", { style: "currency", currency: "EUR" });
      res.json({ ok: true, message: `${result.count} unit${result.count === 1 ? "" : "s"}${result.seller ? ` of ${result.seller}` : ""} marked Paid (${amount}).` });
    } catch (err) {
      if (err instanceof PayoutError) return res.status(err.status).json({ error: err.message });
      console.error("[admin] payout mark paid failed:", err.message);
      res.status(502).json({ error: "Something went wrong while marking these paid. Check the units before trying again." });
    }
  });

  // One record for the side panel, with its unit and its history.
  router.get("/api/admin/record", async (req, res) => {
    const source = text(req.query.source);
    const id = text(req.query.id);

    if (!PANELS[source]) return res.status(404).json({ error: "Unknown list" });
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return res.status(400).json({ error: "Invalid record" });

    try {
      const view = findView(text(req.query.section), text(req.query.view));
      const tabActions = view && view.source === source ? view.actions : [];
      const found = await airtable.byIds(TABLES[source], [id], [...new Set([...panelFields(source), ...listFieldsFor(source, tabActions)])]);
      const fields = found.get(id);

      if (!fields) return res.status(404).json({ error: "This record no longer exists." });

      const unitId = (fields["Linked Inventory Unit"] || [])[0];
      const units = unitId ? await airtable.byIds(TABLES.units, [unitId], UNIT_FIELDS).catch(() => new Map()) : new Map();
      const unit = units.get(unitId);

      const draw = (group, from) => ({
        title: group.title,
        fields: group.fields.map((spec) => ({ label: spec.label, type: spec.type, ...cellValue(spec, from, unit) }))
      });

      const groups = PANELS[source].map((group) => draw(group, fields));
      if (unit) groups.push(draw(UNIT_PANEL, unit));

      const idField = PANELS[source][0].fields[0].field;

      res.json({
        id,
        source,
        label: text(flat(fields[idField])),
        groups,
        actions: availableActions(source, tabActions, fields),
        links: rowLinks(source, fields),
        timeline: await audit.forRecord(id)
      });
    } catch (err) {
      console.error("[admin] record failed:", source, id, err.message);
      res.status(502).json({ error: "Could not load this record from Airtable." });
    }
  });

  return { router, enabled, externalSales: externalSalesStore };
}

export function adminPagePath(dirname) {
  return path.join(dirname, "private", "admin.html");
}

// Exposed for the tests.
export const _internal = { flat, number, formulaString, VIEWS };

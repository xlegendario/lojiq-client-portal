// admin/adminRouter.js
//
// The Lojiq Admin portal: the page on /admin and everything it calls under
// /api/admin. Step one is reading - every Store Orders and Member WTBs tab,
// the filters, search and the side panel. Buttons that change records come
// after, and each of them goes through the action log.
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

  return { select, byIds };
}

/* ---------------- the router ---------------- */

/*
 * deps:
 *   usersJson       LOJIQ_ADMIN_USERS
 *   sessionSecret   LOJIQ_ADMIN_SECRET; without it and the users the portal stays off
 *   airtableToken, airtableBaseId
 *   audit           createAuditLog(...)
 *   savedFilters    createSavedFilters(...)
 *   pageFile        private/admin.html
 */
export function createAdminPortal({ usersJson, sessionSecret, airtableToken, airtableBaseId, audit, savedFilters, pageFile, fetchImpl = fetch }) {
  const router = express.Router();
  const users = parseUsers(usersJson);
  const enabled = Boolean(text(sessionSecret) && users.length);
  const airtable = createAirtableReader({ token: airtableToken, baseId: airtableBaseId, fetchImpl });
  const attempts = createAttemptLimiter();
  const cache = new Map();

  let storesCache = { at: 0, names: [] };

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

  router.get("/api/admin/me", (req, res) => {
    res.json({ user: { email: req.admin.email, name: req.admin.name }, views: publicViews() });
  });

  // Every store name, for the Store Name filter.
  router.get("/api/admin/stores", async (req, res) => {
    try {
      if (Date.now() - storesCache.at > STORES_CACHE_MS) {
        const names = new Set();
        let offset = "";

        do {
          const page = await airtable.select(TABLES.merchants, { fields: ["Store Name"], pageSize: 100, offset });

          for (const record of page.records) {
            const name = text(record.fields?.["Store Name"]);
            if (name) names.add(name);
          }

          offset = page.offset;
        } while (offset);

        storesCache = { at: Date.now(), names: [...names].sort((a, b) => a.localeCompare(b)) };
      }

      res.json({ stores: storesCache.names });
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
          fields: fieldsFor(view),
          sort: sortFieldFor(view),
          pageSize: PAGE_SIZE,
          offset
        });

        const units = view.source === "queue" ? new Map() : await unitsFor(page.records);

        return {
          rows: page.records.map((record) => {
            const fields = record.fields || {};
            const unit = units.get((fields["Linked Inventory Unit"] || [])[0]);
            const cells = {};

            for (const column of view.columns) cells[column.key] = cellValue(column, fields, unit);

            return { id: record.id, cells };
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

  // One record for the side panel, with its unit and its history.
  router.get("/api/admin/record", async (req, res) => {
    const source = text(req.query.source);
    const id = text(req.query.id);

    if (!PANELS[source]) return res.status(404).json({ error: "Unknown list" });
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return res.status(400).json({ error: "Invalid record" });

    try {
      const found = await airtable.byIds(TABLES[source], [id], panelFields(source));
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
        timeline: await audit.forRecord(id)
      });
    } catch (err) {
      console.error("[admin] record failed:", source, id, err.message);
      res.status(502).json({ error: "Could not load this record from Airtable." });
    }
  });

  return { router, enabled };
}

export function adminPagePath(dirname) {
  return path.join(dirname, "private", "admin.html");
}

// Exposed for the tests.
export const _internal = { flat, number, formulaString, VIEWS };

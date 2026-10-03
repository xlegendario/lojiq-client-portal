// admin/adminPartnerStock.js
//
// Partner Stock: the pairs a partner keeps here that are not ours (30-09-2026).
//
// Kept apart from Inventory on purpose. Inventory is everything that became
// ours on paper, and these pairs are exactly what has not: the partner is
// paid when one sells, and only then does an Inventory Unit exist for it.
// Folding them in would turn a rule you can state in one line back into
// "ours, plus some things that are not".
//
// It also shows what Inventory has no room for, because these are columns of
// partner_stock and of nothing else: which parcel a pair arrived in, whether
// it came in to be sold or to be forwarded, and what the partner is owed for
// it.
//
// The counterpart of Inbound Scans, which says what was in each parcel. This
// says what is still on the shelf.

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// How the intake called it, as the screen says it. Same words as Inbound
// Scans uses, so a parcel and its pairs do not describe themselves
// differently on two screens.
export const MODES = {
  consignment: "Consignment",
  forwarding: "Forwarding",
  both: "Consignment & Forwarding"
};

export const STATES = {
  in_stock: "On the shelf",
  // Promised to a deal that is not confirmed yet: off the shelf for
  // everything else, and back on it if that deal falls apart.
  reserved: "On a deal",
  sold: "Sold",
  forwarded: "Forwarded"
};

export class PartnerStockError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function stockRow(row = {}) {
  const status = text(row.status) || "in_stock";

  return {
    id: text(row.id),
    seller_id: text(row.seller_id),
    seller_record_id: text(row.seller_record_id),
    party: "",
    sku: text(row.sku),
    size: text(row.size),
    product_name: text(row.product_name),
    brand: text(row.brand),
    barcode: text(row.barcode),
    vat_type: text(row.vat_type),
    mode: MODES[text(row.mode)] || text(row.mode) || "",
    status,
    state: STATES[status] || status,
    partner_price: row.partner_price === null || row.partner_price === undefined ? null : round2(row.partner_price),
    markup: row.markup === null || row.markup === undefined ? null : round2(row.markup),
    tracking: text(row.tracking_number),
    received_at: text(row.received_at) || null,
    sold_at: text(row.sold_at) || null,
    sold_ref: text(row.sold_ref),
    forwarded_at: text(row.forwarded_at) || null,
    /*
     * The purchase this pair became, once it sold.
     *
     * Empty on all 26 sold rows on the day this was written, although the
     * units do exist - only the reference back is never written. Shown so
     * the gap is visible rather than discovered during a migration, where
     * SKU and size are the only things left to match on and four sales of
     * one shoe in one size cannot be told apart.
     */
    inventory_unit_id: text(row.inventory_unit_id)
  };
}

export const VIEWS = {
  in_stock: (row) => row.status === "in_stock",
  sold: (row) => row.status === "sold",
  forwarded: (row) => row.status === "forwarded",
  all: () => true
};

/*
 * deps:
 *   db        createSupabaseRest - partner_stock
 *   airtable  byIds - Sellers Database, for the partner's name
 */
export function createPartnerStockStore({ db, airtable, cacheMs = 120_000 }) {
  const COLUMNS =
    "id,seller_id,seller_record_id,sku,size,product_name,brand,barcode,vat_type,mode," +
    "partner_price,markup,status,tracking_number,received_at,sold_at,sold_ref,forwarded_at,inventory_unit_id";

  let cache = { at: 0, promise: null };

  function everything() {
    if (!cache.promise || Date.now() - cache.at > cacheMs) {
      cache = {
        at: Date.now(),
        promise: db.get(`partner_stock?select=${COLUMNS}&order=received_at.desc&limit=5000`)
          .then((rows) => (rows || []).map(stockRow))
      };

      cache.promise.catch(() => { cache = { at: 0, promise: null }; });
    }

    return cache.promise;
  }

  // Who it belongs to. One partner today, so the name is looked up once for
  // the handful of sellers on the list rather than per row.
  async function withNames(rows) {
    const ids = [...new Set(rows.map((row) => row.seller_record_id).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];

    const sellers = ids.length
      ? await airtable.byIds("Sellers Database", ids, ["Seller ID", "Full Name", "Company Name"]).catch(() => new Map())
      : new Map();

    for (const row of rows) {
      const seller = sellers.get(row.seller_record_id);
      row.party = seller
        ? text(seller["Company Name"]) || text(seller["Full Name"]) || text(seller["Seller ID"])
        : row.seller_id;
    }

    return rows;
  }

  async function list({ view = "in_stock", q = "", limit = 500 } = {}) {
    const wanted = Math.min(Math.max(Number(limit) || 500, 10), 2000);
    const needle = text(q).toUpperCase();
    const all = await everything();

    const counts = { all: all.length };
    for (const [name, pick] of Object.entries(VIEWS)) counts[name] = all.filter(pick).length;

    let chosen = all.filter(VIEWS[text(view)] || VIEWS.all);

    if (needle) {
      chosen = chosen.filter((row) =>
        row.sku.toUpperCase().includes(needle) ||
        row.product_name.toUpperCase().includes(needle) ||
        row.tracking.toUpperCase().includes(needle) ||
        row.seller_id.toUpperCase().includes(needle) ||
        row.size.toUpperCase() === needle);
    }

    const shown = await withNames(chosen.slice(0, wanted));

    /*
     * What the partner is owed, over the pairs on the shelf alone. Counting
     * the sold ones in would read as money we still have to find, and that
     * was settled when they sold.
     */
    const owed = chosen.filter(VIEWS.in_stock).reduce((sum, row) => sum + (row.partner_price || 0), 0);

    return {
      units: shown,
      counts,
      totals: {
        units: chosen.length,
        shown: shown.length,
        value: round2(chosen.reduce((sum, row) => sum + (row.partner_price || 0), 0)),
        on_the_shelf: round2(owed),
        // Sold pairs that never got their purchase written back onto the row.
        unlinked: chosen.filter((row) => row.status === "sold" && !row.inventory_unit_id).length
      }
    };
  }

  async function count() {
    const all = await everything();

    return { in_stock: all.filter(VIEWS.in_stock).length };
  }

  return { list, count };
}

export function mountPartnerStock(router, { store, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof PartnerStockError ? err.status : 500;
    if (status >= 500) console.error("[admin partner stock]", err.message);
    res.status(status).json({ error: err instanceof PartnerStockError ? err.message : `Partner Stock failed: ${err.message}` });
  };

  router.get(["/admin/partner-stock", "/admin/partner-stock/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/partner-stock", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      res.json(await store.list({
        view: text(req.query.view) || "in_stock",
        q: text(req.query.q),
        limit: req.query.limit
      }));
    } catch (err) {
      send(res, err);
    }
  });
}

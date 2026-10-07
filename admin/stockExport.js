// admin/stockExport.js
//
// Export: our stock, partner stock and consignment stock as one file
// (07-10-2026).
//
// One button on each of the three screens, one dialog: tick the stock you
// want, Excel or CSV. The screen you are on exports exactly what it shows -
// view, search, filters and order - unless you untick that. The other
// screens export what is on the shelf, everything, in size order per shoe.
//
// It reads the rows through the same list() the screens use, with `all` so
// nothing is cut off at a page. A file therefore never disagrees with the
// screen it was made from.

import { readRefine } from "./stockRefine.js";
import { csv, xlsx, zip } from "./xlsxWriter.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const yes = (value) => (value ? "Yes" : "");
const day = (value) => text(value).slice(0, 10);

/*
 * What each sheet holds. Wider than the screens on purpose: a file is read
 * without a side panel to click open, so what the panel would say is in a
 * column instead.
 */
const SHEETS = {
  inventory: {
    title: "Our stock",
    defaults: { view: "in_stock" },
    columns: [
      { label: "Item ID", width: 14, read: (u) => u.item_id },
      { label: "SKU", width: 16, read: (u) => u.sku },
      { label: "Product", width: 44, read: (u) => u.product_name },
      { label: "Brand", width: 14, read: (u) => u.brand },
      { label: "Size", width: 8, read: (u) => u.size },
      { label: "Type", width: 13, read: (u) => u.kind },
      { label: "VAT type", width: 10, read: (u) => u.vat_type },
      { label: "Status", width: 12, read: (u) => u.availability },
      { label: "Verification", width: 13, read: (u) => u.verification },
      { label: "Location", width: 18, read: (u) => u.location },
      { label: "Purchase price", type: "money", read: (u) => u.cost || null },
      { label: "Floor", type: "money", read: (u) => u.floor || null },
      { label: "Ideal price", type: "money", read: (u) => u.ideal || null },
      { label: "Purchase date", width: 12, read: (u) => day(u.purchase_date) },
      { label: "Days in stock", type: "number", width: 10, read: (u) => u.days },
      { label: "Sellable", width: 9, read: (u) => yes(u.sellable) },
      { label: "What disagrees", width: 50, read: (u) => (u.checks || []).map((c) => c.say).join("; ") }
    ]
  },
  partner: {
    title: "Partner stock",
    defaults: { view: "in_stock" },
    columns: [
      { label: "Partner", width: 20, read: (u) => u.party || u.seller_id },
      { label: "Seller ID", width: 11, read: (u) => u.seller_id },
      { label: "SKU", width: 16, read: (u) => u.sku },
      { label: "Product", width: 44, read: (u) => u.product_name },
      { label: "Brand", width: 14, read: (u) => u.brand },
      { label: "Size", width: 8, read: (u) => u.size },
      { label: "Barcode", width: 15, read: (u) => u.barcode },
      { label: "VAT type", width: 10, read: (u) => u.vat_type },
      { label: "How", width: 22, read: (u) => u.mode },
      { label: "State", width: 12, read: (u) => u.state },
      { label: "Partner price", type: "money", read: (u) => u.partner_price },
      { label: "Markup", type: "money", read: (u) => u.markup || null },
      { label: "Parcel", width: 20, read: (u) => u.tracking },
      { label: "Received", width: 12, read: (u) => day(u.received_at) },
      { label: "Sold", width: 12, read: (u) => day(u.sold_at) },
      { label: "Sold on", width: 14, read: (u) => u.sold_ref }
    ]
  },
  consignment: {
    title: "Consignment stock",
    defaults: { view: "all" },
    columns: [
      { label: "SKU", width: 16, read: (p) => p.sku },
      { label: "Product", width: 44, read: (p) => p.product_name },
      { label: "Brand", width: 14, read: (p) => p.brand },
      { label: "Size", width: 8, read: (p) => p.size },
      { label: "Cheapest consignor", width: 20, read: (p) => p.party || p.seller_id },
      { label: "Seller ID", width: 11, read: (p) => p.seller_id },
      { label: "Asks", type: "money", read: (p) => p.ask },
      { label: "VAT type", width: 10, read: (p) => p.vat_type },
      { label: "Costs us", type: "money", read: (p) => p.compare },
      { label: "Pairs", type: "number", width: 8, read: (p) => p.quantity },
      { label: "Consignors", type: "number", width: 11, read: (p) => p.consignors },
      { label: "Partner pair", width: 12, read: (p) => yes(p.partner) },
      { label: "Added", width: 12, read: (p) => day(p.added_at) }
    ]
  }
};

export const SOURCES = Object.keys(SHEETS);

// What the browser said about one screen: its view, search and filters.
function readState(raw, source) {
  let state = {};

  try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
  if (!state || typeof state !== "object") state = {};

  const fallback = SHEETS[source].defaults;

  return {
    view: text(state.view) || fallback.view,
    check: text(state.check),
    q: text(state.q).slice(0, 200),
    // Not the screen you are on: in size order per shoe, so the list reads
    // the way a stock list is read.
    refine: readRefine({ sort: "sku", ...state }, source)
  };
}

export function mountStockExport(router, { stores }) {
  router.get("/api/admin/stock-export", async (req, res) => {
    try {
      const sources = text(req.query.sources).split(",").map(text).filter((name) => SOURCES.includes(name));

      if (!sources.length) return res.status(400).json({ error: "Tick at least one kind of stock." });

      const format = text(req.query.format) === "csv" ? "csv" : "xlsx";

      const sheets = [];

      for (const source of sources) {
        const state = readState(req.query[source], source);
        const out = await stores[source].list({ ...state, all: true });
        const definition = SHEETS[source];

        sheets.push({
          source,
          name: definition.title,
          columns: definition.columns,
          rows: (out.units || []).map((unit) => definition.columns.map((column) => {
            const value = column.read(unit);
            return value === undefined ? null : value;
          }))
        });
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const base = sources.length === 1 ? SHEETS[sources[0]].title.toLowerCase().replace(/\s+/g, "-") : "lojiq-stock";

      let body;
      let type;
      let name;

      if (format === "xlsx") {
        body = xlsx(sheets);
        type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        name = `${base}-${stamp}.xlsx`;
      } else if (sheets.length === 1) {
        body = Buffer.from(csv(sheets[0]), "utf8");
        type = "text/csv; charset=utf-8";
        name = `${base}-${stamp}.csv`;
      } else {
        // Several kinds have different columns, so one CSV each, zipped.
        body = zip(sheets.map((sheet) => ({
          name: `${sheet.name.toLowerCase().replace(/\s+/g, "-")}-${stamp}.csv`,
          data: csv(sheet)
        })));
        type = "application/zip";
        name = `${base}-${stamp}.zip`;
      }

      res.set("Cache-Control", "no-store");
      res.set("X-Export-Rows", sheets.map((sheet) => `${sheet.source}=${sheet.rows.length}`).join(","));
      res.attachment(name);
      res.type(type).send(body);
    } catch (err) {
      console.error("[admin stock export]", err.message);
      res.status(500).json({ error: `Export failed: ${err.message}` });
    }
  });
}

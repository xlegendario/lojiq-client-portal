// admin/adminWtbMatch.js
//
// The screen behind admin/wtbMatch.js: paste a want-to-buy, see what we can
// actually offer on it.
//
// It reads nothing of its own. The warehouse, the consignment stock and the
// partner stock each already have a store that loads and tidies its own rows
// and holds them for a few minutes, so this asks those three and puts their
// answers side by side. One source being down is said out loud rather than
// quietly leaving its shelf out of the answer - a matcher that reports "we
// have none" because Airtable timed out is worse than one that reports
// nothing at all.

import express from "express";
import fs from "fs";

import { matchStock, offerText, parseRequest, readyIn, shelf } from "./wtbMatch.js";
import { csv } from "./xlsxWriter.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/*
 * deps: the three stock stores, as adminRouter already builds them.
 */
export function createWtbMatchStore({ inventory, consignmentStock, partnerStock, airtable = null, cacheMs = 300_000 }) {
  /*
   * What kind of seller a pair is coming from.
   *
   * Most consignors have nothing in Source and their pair is simply with
   * them. The handful that do - EU Supplier, Asia, Marketplace - do not ship
   * the same day, and the person making an offer has to know that before he
   * promises anything. Eleven of nine hundred sellers carry one, so the whole
   * list is read once and held.
   */
  let sellers = { at: 0, promise: null };

  function sellerInfo() {
    if (!airtable) return Promise.resolve(new Map());

    if (!sellers.promise || Date.now() - sellers.at > cacheMs) {
      sellers = { at: Date.now(), promise: readSellers() };
      sellers.promise.catch(() => { sellers = { at: 0, promise: null }; });
    }

    return sellers.promise;
  }

  async function readSellers() {
    const found = new Map();
    let offset = "";

    // Nine hundred sellers, ten calls, held for five minutes - the whole
    // list rather than the ones on this answer, because the next search
    // wants different ones and this way it costs nothing at all.
    for (let page = 0; page < 20; page += 1) {
      const result = await airtable.select("Sellers Database", {
        fields: ["Discord", "Source"],
        pageSize: 100,
        offset
      });

      for (const record of result?.records || []) {
        found.set(record.id, {
          discord: text(record.fields?.Discord),
          source: text(record.fields?.Source)
        });
      }

      offset = result?.offset || "";
      if (!offset) break;
    }

    return found;
  }

  async function tryShelf(name, load) {
    try {
      return { name, rows: (await load()) || [], error: "" };
    } catch (err) {
      return { name, rows: [], error: text(err?.message) || "could not be read" };
    }
  }

  async function search(input) {
    const { wanted, unreadable } = parseRequest(input);

    if (!wanted.length) return { wanted: [], unreadable, rows: [], sources: [], missing: [] };

    const [warehouse, consignment, partner] = await Promise.all([
      tryShelf("Warehouse", () => inventory.working()),
      tryShelf("Consignment", () => consignmentStock.everything()),
      tryShelf("Partner", () => partnerStock.everything())
    ]);

    const all = shelf({
      warehouse: warehouse.rows,
      consignment: consignment.rows,
      partner: partner.rows
    });

    // A seller who cannot ship today says so on the pair, not in someone's
    // head. A lookup that fails leaves it blank rather than holding up the
    // whole answer.
    const sellerBy = await sellerInfo().catch(() => new Map());

    for (const option of all) {
      const seller = sellerBy.get(option.seller_record_id);

      option.seller_source = seller?.source || "";
      // A Discord name is what he is called where the deal is made; a
      // Seller ID is only something to look up. The id stays as the
      // fallback, because a seller without a Discord still has to show.
      option.seller_name = seller?.discord || option.seller;
      option.ready_in = readyIn(option);
    }

    const rows = matchStock(wanted, all);

    return {
      wanted,
      unreadable,
      rows,
      // What was actually looked through, so a thin answer can be told apart
      // from an empty shelf.
      sources: [warehouse, consignment, partner].map((source) => ({
        name: source.name,
        rows: source.rows.length,
        error: source.error
      })),
      missing: [warehouse, consignment, partner].filter((source) => source.error).map((source) => source.name)
    };
  }

  /*
   * The message for the buyer, written here rather than on the screen.
   *
   * The screen could put these lines together itself, but then the wording
   * of an offer would live in two places and one of them would fall behind.
   * The engine writes it, the tests cover it, and the screen only shows it.
   */
  const offer = (rows) => ({ text: offerText(Array.isArray(rows) ? rows : []) });

  /*
   * The answer as a file.
   *
   * Comma separated and quoted, which is the one that opens in columns here;
   * the semicolons this had at first arrived as a single long column. The
   * same writer the stock screens use, so it behaves the same way they do.
   *
   * A pair we have not got still gets a line. On the screen those are one
   * sentence above the table, but a file is read away from the screen and a
   * question with no answer beside it is worth seeing.
   */
  const COLUMNS = [
    { label: "SKU", width: 16, read: (row, option) => row.sku },
    { label: "Size", width: 10, read: (row) => row.size },
    { label: "Product", width: 44, read: (row, option) => option?.product_name || "" },
    { label: "Source", width: 14, read: (row, option) => option?.source || "not on any shelf" },
    { label: "Seller", width: 18, read: (row, option) => option?.seller_name || option?.seller || "" },
    { label: "Quantity", width: 10, read: (row, option) => (option ? Number(option.quantity) || 0 : null) },
    { label: "Cost", width: 12, read: (row, option) => (option && option.cost !== null ? Number(option.cost) : null) },
    { label: "VAT", width: 10, read: (row, option) => option?.vat_type || "" },
    { label: "ETA", width: 18, read: (row, option) => option?.ready_in || "" },
    { label: "Offer", width: 10, read: (row) => (text(row.offer_price) ? Number(String(row.offer_price).replace(",", ".")) : null) },
    { label: "VAT out", width: 10, read: (row) => text(row.offer_vat) }
  ];

  function exportFile(rows) {
    const lines = [];

    for (const row of Array.isArray(rows) ? rows : []) {
      const options = Array.isArray(row.options) && row.options.length ? row.options : [null];

      for (const option of options) {
        lines.push(COLUMNS.map((column) => {
          const value = column.read(row, option);
          return value === undefined ? null : value;
        }));
      }
    }

    return csv({ columns: COLUMNS, rows: lines });
  }


  return { search, offer, exportFile };
}

export function mountWtbMatch(router, { store, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  router.get(["/admin/wtb-match", "/admin/wtb-match/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  // A paste rather than a file: the list arrives as a Discord line as often
  // as a csv, and a textarea takes both.
  router.post("/api/admin/wtb-match", express.json({ limit: "200kb" }), async (req, res) => {
    try {
      res.json(await store.search(req.body?.input));
    } catch (err) {
      console.error("[admin wtb match]", err.message);
      res.status(500).json({ error: `Matching failed: ${err.message}` });
    }
  });

  router.post("/api/admin/wtb-match/export", express.json({ limit: "2mb" }), (req, res) => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);

      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="wtb-match-${stamp}.csv"`);
      res.send(store.exportFile(req.body?.rows));
    } catch (err) {
      console.error("[admin wtb match export]", err.message);
      res.status(500).json({ error: `The file could not be made: ${err.message}` });
    }
  });

  router.post("/api/admin/wtb-match/offer", express.json({ limit: "200kb" }), (req, res) => {
    try {
      res.json(store.offer(req.body?.rows));
    } catch (err) {
      console.error("[admin wtb match offer]", err.message);
      res.status(500).json({ error: `The offer could not be written: ${err.message}` });
    }
  });
}

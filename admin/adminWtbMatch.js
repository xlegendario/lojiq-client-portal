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

  function sellerSources() {
    if (!airtable) return Promise.resolve(new Map());

    if (!sellers.promise || Date.now() - sellers.at > cacheMs) {
      sellers = {
        at: Date.now(),
        promise: airtable
          .select("Sellers Database", { fields: ["Source"], formula: "{Source} != ''", pageSize: 100 })
          .then((result) => new Map((result?.records || []).map((record) => [record.id, text(record.fields?.Source)])))
      };

      sellers.promise.catch(() => { sellers = { at: 0, promise: null }; });
    }

    return sellers.promise;
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
    const sources = await sellerSources().catch(() => new Map());

    for (const option of all) {
      option.seller_source = sources.get(option.seller_record_id) || "";
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

  return { search, offer };
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

  router.post("/api/admin/wtb-match/offer", express.json({ limit: "200kb" }), (req, res) => {
    try {
      res.json(store.offer(req.body?.rows));
    } catch (err) {
      console.error("[admin wtb match offer]", err.message);
      res.status(500).json({ error: `The offer could not be written: ${err.message}` });
    }
  });
}

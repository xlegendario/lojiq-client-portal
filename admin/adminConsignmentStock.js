// admin/adminConsignmentStock.js
//
// Consignment Stock: what consignors are holding for us (01-10-2026).
//
// 4.558 pairs over 20 consignors that until now were visible nowhere. The
// marketplace syncs read them, the member WTB machinery offers on them, but
// nobody could simply look up what a shoe costs us and who has it.
//
// That is the first thing a deal needs. Somebody asks for a Jordan 4 in 44
// and the question is what we can source it for, from whom, and whether
// there is a second holder if the first says no.
//
// Read-only. Bringing out an offer from here is the next step and needs the
// partner-run member WTB behind it.

import express from "express";
import fs from "fs";
import { facetsOf, filterRows, readRefine, sortRows } from "./stockRefine.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/*
 * What a pair really costs us, on one scale.
 *
 * A VAT0 consignor asking 100 costs 121 to buy, so comparing his 100 against
 * a margin consignor's 100 would make him look the cheaper of the two and we
 * would pick the wrong man. Same rule as getBuyingComparePrice in the KC
 * portal and normalizeCost in the marketplace sync, deliberately: three
 * places deciding what a consignor costs is how they end up disagreeing.
 */
export function comparePrice(price, vatType) {
  const n = Number(price || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return text(vatType).toUpperCase() === "VAT0" ? round2(n * 1.21) : round2(n);
}

// The same three answers the Buying Inventory Filter gives on a member WTB,
// so what the screen shows and what an offer later asks for cannot drift.
export const VAT_FILTERS = {
  all: ["Margin", "VAT0", "VAT21"],
  margin: ["Margin"],
  b2b: ["VAT0", "VAT21"]
};

export class ConsignmentStockError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function stockRow(row = {}) {
  const ask = round2(row.selling_price_suggested);
  const payout = Number(row.payout_price) || 0;

  return {
    id: text(row.id),
    seller_id: text(row.seller_id),
    seller_record_id: text(row.seller_record_id),
    party: "",
    sku: text(row.sku).toUpperCase(),
    size: text(row.size),
    product_name: text(row.product_name),
    brand: text(row.brand),
    vat_type: text(row.vat_type),
    ask,
    // What he costs once his VAT scheme is taken into account.
    compare: comparePrice(ask, row.vat_type),
    /*
     * A partner's pair, which is already on our own shelf - no parcel has to
     * come from anywhere. Worth seeing next to a price, because it is a day
     * of difference on the same shoe.
     */
    partner: payout > 0,
    payout: payout > 0 ? round2(payout) : null,
    quantity: Number(row.quantity) || 0,
    image_url: text(row.image_url),
    added_at: text(row.created_at) || null,
  };
}

/*
 * One line per shoe and size, with every consignor holding it underneath.
 *
 * A consignor is not a thing you are looking for, a pair is - so the list is
 * a list of pairs, and who has it is what you open it to find out. The
 * cheapest of them is hoisted onto the line, because that is the one you
 * would ask first.
 *
 * Grouped AFTER the VAT filter, so "2 more consignors" on a Margin Only list
 * means two more margin consignors and not two you are not allowed to use.
 */
export function groupRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = `${row.sku}|${row.size}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        sku: row.sku,
        size: row.size,
        product_name: row.product_name,
        brand: row.brand,
        image_url: row.image_url,
        holders: []
      });
    }

    const group = groups.get(key);

    group.holders.push(row);
    // A row without a picture or a name should not decide how the pair looks.
    if (!group.image_url) group.image_url = row.image_url;
    if (!group.product_name) group.product_name = row.product_name;
    if (!group.brand) group.brand = row.brand;
  }

  for (const group of groups.values()) {
    group.holders.sort((a, b) => a.compare - b.compare || text(a.seller_id).localeCompare(text(b.seller_id)));

    const best = group.holders[0];

    group.ask = best.ask;
    group.compare = best.compare;
    group.vat_type = best.vat_type;
    group.seller_id = best.seller_id;
    group.seller_record_id = best.seller_record_id;
    group.consignors = group.holders.length;
    group.alternatives = group.holders.length - 1;
    group.partner = group.holders.some((h) => h.partner);
    group.quantity = group.holders.reduce((sum, h) => sum + h.quantity, 0);
    group.added_at = group.holders.reduce(
      (newest, h) => (text(h.added_at) > text(newest) ? h.added_at : newest),
      group.holders[0].added_at
    );
  }

  return [...groups.values()];
}

// The three the screen offers, as Airtable spells them.
export const FILTER_LABELS = {
  all: "All Inventory",
  margin: "Margin Only",
  b2b: "B2B Only"
};

/*
 * deps:
 *   db        createSupabaseRest - consignment_inventory
 *   airtable  byIds - Sellers Database
 *   deals     createBrokerDealsStore - the deal this pair is bought for
 */
export function createConsignmentStockStore({ db, airtable, deals = null, cacheMs = 180_000 }) {
  const COLUMNS =
    "id,seller_id,seller_record_id,sku,size,product_name,brand,vat_type," +
    "selling_price_suggested,payout_price,quantity,image_url,created_at";

  let cache = { at: 0, promise: null };

  /*
   * Everything a consignor actually holds and has priced. Same two
   * conditions the marketplace sync uses: no stock or no price means there
   * is nothing to sell, and a row like that would only be a dead end on a
   * deal.
   */
  async function everything() {
    const rows = [];

    for (let from = 0; from < 20_000; from += 1000) {
      const page = await db.get(
        `consignment_inventory?select=${COLUMNS}&quantity=gt.0&selling_price_suggested=gt.0` +
        `&order=created_at.desc&limit=1000&offset=${from}`
      );

      rows.push(...(page || []));
      if (!page || page.length < 1000) break;
    }

    return rows.map(stockRow);
  }

  function loaded() {
    if (!cache.promise || Date.now() - cache.at > cacheMs) {
      cache = { at: Date.now(), promise: everything() };
      cache.promise.catch(() => { cache = { at: 0, promise: null }; });
    }

    return cache.promise;
  }

  // Who is holding it. Twenty consignors in all, so the names are looked up
  // for the rows on screen rather than per row.
  async function withNames(rows) {
    const ids = [...new Set(rows.map((r) => r.seller_record_id).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];

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

  // refine and all: see the Inventory store - the same on all three screens.
  async function list({ view = "all", q = "", limit = 400, refine = {}, all: everyRow = false } = {}) {
    const wanted = everyRow ? Infinity : Math.min(Math.max(Number(limit) || 400, 10), 5000);
    const needle = text(q).toUpperCase();
    const all = await loaded();

    // Counted in pairs, because that is what the list shows.
    const counts = {};
    for (const [name, types] of Object.entries(VAT_FILTERS)) {
      counts[name] = new Set(
        all.filter((r) => types.includes(r.vat_type)).map((r) => `${r.sku}|${r.size}`)
      ).size;
    }

    const types = VAT_FILTERS[text(view)] || VAT_FILTERS.all;
    let chosen = all.filter((r) => types.includes(r.vat_type));

    /*
     * Every word has to land somewhere, so "military blue 44" narrows to the
     * shoe AND the size. One box typed the way you would say it out loud,
     * rather than a shoe search and a separate size filter.
     */
    const words = needle.split(/\s+/).filter(Boolean);

    const hits = (row, word) =>
      row.size.toUpperCase() === word ||
      row.sku.includes(word) ||
      row.product_name.toUpperCase().includes(word) ||
      row.seller_id.toUpperCase().includes(word);

    if (words.length) chosen = chosen.filter((row) => words.every((word) => hits(row, word)));

    // On single offers, before they become pairs: see stockRefine.js.
    const facets = facetsOf(chosen, "consignment");
    chosen = filterRows(chosen, "consignment", refine);

    const pairs = groupRows(chosen);

    /*
     * How many consignors each pair has under EACH filter, counted over the
     * whole stock rather than over this tab.
     *
     * The list is grouped after the tab's filter, so a line on Margin Only
     * knows nothing about the B2B men holding the same shoe. The offer form
     * lets you switch filter without leaving the page, and it has to be able
     * to say what that would reach.
     */
    const reach = new Map();

    for (const row of all) {
      const key = `${row.sku}|${row.size}`;
      if (!reach.has(key)) reach.set(key, { all: 0, margin: 0, b2b: 0 });

      const counts = reach.get(key);
      for (const [name, types] of Object.entries(VAT_FILTERS)) {
        if (types.includes(row.vat_type)) counts[name] += 1;
      }
    }

    for (const pair of pairs) pair.by_filter = reach.get(pair.key) || { all: 0, margin: 0, b2b: 0 };

    /*
     * Cheapest first, because that is the man to ask - but a pair whose SIZE
     * matches leads whatever it costs. Searching "44" otherwise turned up
     * cheap pairs in other sizes, because "HQ4409" contains a 44 too.
     *
     * Without a search there is no shoe yet, so the newest arrivals lead.
     */
    const onSize = (pair) => (words.some((word) => pair.size.toUpperCase() === word) ? 0 : 1);

    // A chosen sort wins; the pair carries its cheapest offer's price and
    // the newest added date, so it sorts like a single row.
    if (!sortRows(pairs, "consignment", refine)) {
      pairs.sort(words.length
        ? (a, b) => onSize(a) - onSize(b) || a.compare - b.compare || a.sku.localeCompare(b.sku)
        : (a, b) => text(b.added_at).localeCompare(text(a.added_at)));
    }

    // The pairs that match on size, when any do - the ones the search is
    // really about. Without a size in the query that is simply everything.
    const onSizeRows = pairs.filter((pair) => onSize(pair) === 0);
    const leading = words.length && onSizeRows.length ? onSizeRows : pairs;

    const shown = pairs.slice(0, wanted);

    // Names for every holder on screen, not only the cheapest: the panel
    // lists them all and an id there would read as a different kind of thing.
    await withNames(shown.flatMap((pair) => pair.holders));
    for (const pair of shown) pair.party = pair.holders[0].party;

    return {
      units: shown,
      counts,
      facets,
      totals: {
        units: pairs.length,
        shown: shown.length,
        offers: chosen.length,
        consignors: new Set(chosen.map((r) => r.seller_id)).size,
        /*
         * The cheapest of the ones actually asked for. Searching a size also
         * turns up a SKU with those digits in it, and quoting that pair's
         * price as the cheapest would be a number for a different shoe.
         */
        cheapest: leading.length ? Math.min(...leading.map((r) => r.compare)) : 0
      }
    };
  }

  async function count() {
    const all = await loaded();
    return { all: new Set(all.map((r) => `${r.sku}|${r.size}`)).size };
  }

  /*
   * Bring out an offer on a pair - the shoe and the size, not a consignor.
   *
   * Which consignor hears it is not ours to decide and never was: the KC
   * portal reads the stock itself, keeps whoever the VAT filter allows, and
   * takes the lowest normalised price. That is the same choice the ordinary
   * Buying page makes, and the first version of this screen quietly promised
   * otherwise - it said "offer to this man" while the round could go to
   * somebody cheaper.
   *
   * Read fresh rather than from the cached list: a price that moved while
   * the screen was open would otherwise be quoted at the old number, and
   * this is the one place where that becomes a promise.
   */
  /*
   * A pair from this list, into a deal.
   *
   * The deal is the thing that is really being made: a buyer, this pair,
   * and the offer that goes out to whoever is holding it cheapest. Starting
   * one from here is the short way round for the common case - one pair,
   * one buyer - and anything more goes on the deal's own screen.
   *
   * `dealId` adds it to a deal that is already running; without one a new
   * deal is made for `buyerId`.
   */
  async function bringOutOffer({ sku, size, buyerPrice, payout, filter = "all", note = "", buyerId = "", dealId = "" } = {}) {
    if (!deals) throw new ConsignmentStockError("Deals are not reachable from this service.", 503);

    const style = text(sku).toUpperCase();
    const which = text(size);

    if (!style || !which) throw new ConsignmentStockError("Which pair?");

    const buyer = Number(buyerPrice);
    const owed = Number(payout);

    if (!(buyer > 0)) throw new ConsignmentStockError("What does the buyer pay?");
    if (!(owed > 0)) throw new ConsignmentStockError("What do we offer the consignor?");

    const chosen = text(filter) in FILTER_LABELS ? text(filter) : "all";
    const label = FILTER_LABELS[chosen];

    const rows = await db.get(
      `consignment_inventory?select=${COLUMNS}&sku=eq.${encodeURIComponent(style)}` +
      `&size=eq.${encodeURIComponent(which)}&quantity=gt.0&selling_price_suggested=gt.0`
    );

    const holders = (rows || []).map(stockRow);

    if (!holders.length) throw new ConsignmentStockError(`${style} ${which} is no longer in the consignment stock.`, 409);

    // The same two things the portal will do with this pair, so the screen
    // cannot claim one thing and the round do another.
    const allowed = holders
      .filter((row) => VAT_FILTERS[chosen].includes(row.vat_type))
      .sort((a, b) => a.compare - b.compare);

    if (!allowed.length) {
      throw new ConsignmentStockError(
        `Nobody holding ${style} ${which} is inside ${label}.`
      );
    }

    const likely = allowed[0];

    /*
     * Never offer more than he is asking.
     *
     * The round goes to the cheapest man inside the filter and he is offered
     * the lower of the budget and his own price, so anything above his ask
     * buys nothing - it just stands on the want-to-buy as a number that
     * never happened. Refused rather than silently capped, because a payout
     * of 200 against an ask of 170 is a typo, not an intention.
     */
    if (owed > likely.ask) {
      throw new ConsignmentStockError(
        `${likely.seller_id} is asking ${round2(likely.ask)}; offering ${round2(owed)} would only ever pay him his own price.`
      );
    }

    const deal = text(dealId)
      ? { id: text(dealId) }
      : await deals.create({ buyerId, note });

    const line = await deals.addLine({
      saleId: deal.id,
      sku: style,
      size: which,
      buyerPrice: buyer,
      payout: owed,
      vatFilter: chosen,
      productName: likely.product_name,
      brand: likely.brand
    });

    /*
     * The offer round itself is the KC portal's, unchanged: the same embed,
     * the same buttons, the same counter rounds. Everything the consignor
     * sees is what he has always seen.
     *
     * The line is left standing when this fails. It carries the numbers and
     * can be offered again from the deal; throwing it away would lose them.
     */
    const asked = await deals.answer({ lineId: line.id, action: "offer" })
      .catch((err) => ({ ok: false, error: err.message }));

    return {
      deal_id: deal.id,
      deal_line_id: line.id,
      sku: style,
      size: which,
      product_name: likely.product_name,
      // Who it will most likely reach. The portal picks at the moment it
      // runs, so this is the answer as the stock stood a second ago.
      seller_id: asked?.seller_id || likely.seller_id,
      asks: likely.ask,
      offered: asked?.payout ?? Math.min(owed, likely.ask),
      consignors: allowed.length,
      buyer_price: round2(buyer),
      margin: round2(buyer - owed),
      filter: label,
      asked: asked?.ok !== false,
      error: asked?.ok === false ? text(asked.error) : ""
    };
  }

  return { list, count, bringOutOffer };
}

export function mountConsignmentStock(router, { store, audit = null, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof ConsignmentStockError ? err.status : 500;
    if (status >= 500) console.error("[admin consignment stock]", err.message);
    res.status(status).json({ error: err instanceof ConsignmentStockError ? err.message : `Consignment Stock failed: ${err.message}` });
  };

  router.get(["/admin/consignment-stock", "/admin/consignment-stock/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/consignment-stock", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      res.json(await store.list({
        view: text(req.query.view) || "all",
        q: text(req.query.q),
        limit: req.query.limit,
        refine: readRefine(req.query, "consignment")
      }));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/consignment-stock/offer", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const out = await store.bringOutOffer({
        sku: req.body?.sku,
        size: req.body?.size,
        buyerPrice: req.body?.buyer_price,
        payout: req.body?.payout,
        filter: req.body?.filter,
        note: text(req.body?.note),
        buyerId: req.body?.buyer_id,
        dealId: req.body?.deal_id
      });

      audit?.record({
        actor: req.admin,
        action: "consignment_offer",
        source: "consignment_stock",
        recordId: out.deal_line_id,
        label: `${out.sku} ${out.size}`,
        details: { deal_id: out.deal_id, seller_id: out.seller_id, offered: out.offered, buyer_price: out.buyer_price, asked: out.asked }
      })?.catch?.(() => {});

      res.json({ ok: true, ...out });
    } catch (err) {
      send(res, err);
    }
  });
}

// admin/adminPartnerDeals.js
//
// Partner Deals: the offers a partner has out with consignors (01-10-2026).
//
// He brings one out from Consignment Stock and then has to wait for an
// answer - and until now that answer only appeared in Discord and in
// Airtable, neither of which he should have to live in. He is standing with
// a buyer on the phone; he needs to see "confirmed" or "he wants 190" and
// act on it in one place.
//
// The offers themselves are the KC portal's, in public.consignment_offers.
// Nothing here starts a round or writes an offer: accepting, countering and
// declining all go back to that portal's own endpoints, so a partner-run
// deal travels exactly the road every other consignment offer travels.

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => text(Array.isArray(value) ? value[0] : value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/*
 * What the offer is waiting on, in the partner's words.
 *
 * "store_pending" is the one that matters: the consignor came back with a
 * price of his own and nothing moves until the partner answers. The portal
 * calls it that because the store is the one being waited on; here the
 * partner is the store.
 */
export const STATES = {
  open: { say: "Waiting for him", yours: false },
  store_pending: { say: "He countered", yours: true },
  accepted: { say: "Confirmed", yours: false },
  denied: { say: "He declined", yours: false },
  store_denied: { say: "You declined", yours: false },
  closed: { say: "Closed", yours: false },
  cancelled: { say: "Cancelled", yours: false },
  expired: { say: "Expired", yours: false }
};

export class PartnerDealsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const WTB_FIELDS = [
  "Member WTB ID", "Product Name", "SKU", "Size", "Brand",
  "Max Price", "Current Lowest Source Price", "Offer Margin", "Final Buying Price",
  "Fulfillment Status", "Purchase Status", "Payment Status",
  "Buyer Seller ID", "Buyer Name", "Date"
];

/*
 * One line per offer, with the want-to-buy it belongs to folded in.
 *
 * Per offer rather than per deal because that is what the partner acts on:
 * a counter is answered, not a pair.
 */
export function dealRow(offer, wtb = {}) {
  const state = STATES[text(offer.status)] || { say: text(offer.status) || "—", yours: false };

  // What we would pay if this one goes through: his counter when he made
  // one, otherwise what we offered him.
  const payout = round2(offer.consignor_counter_price || offer.offer_price);
  const buyerPrice = round2(wtb["Max Price"]);

  return {
    id: text(offer.id),
    member_wtb_record_id: text(offer.member_wtb_record_id),
    wtb_id: text(wtb["Member WTB ID"]) || text(offer.order_id),
    sku: text(offer.sku).toUpperCase(),
    size: text(offer.size),
    product_name: text(offer.product_name) || text(wtb["Product Name"]),
    brand: text(offer.brand) || text(wtb.Brand),
    seller_id: text(offer.seller_id),
    seller_record_id: text(offer.seller_record_id),
    party: "",
    vat_type: text(offer.vat_type),
    asks: round2(offer.seller_price),
    offered: round2(offer.offer_price),
    countered: offer.consignor_counter_price ? round2(offer.consignor_counter_price) : null,
    payout,
    buyer_price: buyerPrice,
    margin: buyerPrice > 0 && payout > 0 ? round2(buyerPrice - payout) : null,
    status: text(offer.status),
    state: state.say,
    // Whether the partner is the one holding this up.
    yours: state.yours,
    fulfillment: text(wtb["Fulfillment Status"]),
    payment: text(wtb["Payment Status"]),
    buyer: first(wtb["Buyer Name"]),
    created_at: text(offer.created_at) || null,
    countered_at: text(offer.consignor_counter_at) || null
  };
}

export const VIEWS = {
  yours: (row) => row.yours,
  waiting: (row) => row.status === "open",
  settled: (row) => !row.yours && row.status !== "open",
  all: () => true
};

/*
 * deps:
 *   db        createSupabaseRest - consignment_offers
 *   airtable  select, byIds - Member WTBs, Sellers Database
 *   tellKickz posts to the KC portal's offer endpoints
 */
export function createPartnerDealsStore({ db, airtable, tellKickz = null, cacheMs = 45_000 }) {
  let cache = { at: 0, promise: null };

  /*
   * Every partner-run want-to-buy, and the offers that went out on it.
   *
   * The want-to-buys lead: they are what the partner made, and an offer
   * without one is a consignment offer belonging to somebody else's deal.
   */
  async function everything() {
    const wtbs = [];
    let offset = "";

    for (let page = 0; page < 20; page += 1) {
      const result = await airtable.select("Member WTBs", {
        fields: WTB_FIELDS,
        formula: "{Partner Run?} = TRUE()",
        sort: "Date",
        pageSize: 100,
        offset
      });

      wtbs.push(...result.records);
      offset = result.offset;
      if (!offset) break;
    }

    const byRecord = new Map(wtbs.map((record) => [record.id, record.fields || {}]));

    if (!byRecord.size) return [];

    /*
     * Asked for by want-to-buy rather than by "every partner-run offer",
     * because the offers table has no such flag - it only knows which
     * want-to-buy an offer belongs to.
     */
    const ids = [...byRecord.keys()];
    const offers = [];

    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map((id) => `"${id}"`).join(",");

      offers.push(...await db.get(
        `consignment_offers?select=*&member_wtb_record_id=in.(${chunk})&order=created_at.desc`
      ));
    }

    return offers.map((offer) => dealRow(offer, byRecord.get(text(offer.member_wtb_record_id)) || {}));
  }

  function loaded() {
    if (!cache.promise || Date.now() - cache.at > cacheMs) {
      cache = { at: Date.now(), promise: everything() };
      cache.promise.catch(() => { cache = { at: 0, promise: null }; });
    }

    return cache.promise;
  }

  // An answer changes what is on screen, so the next read must be fresh.
  const forget = () => { cache = { at: 0, promise: null }; };

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

  async function list({ view = "yours", q = "", limit = 300 } = {}) {
    const wanted = Math.min(Math.max(Number(limit) || 300, 10), 2000);
    const needle = text(q).toUpperCase();
    const all = await loaded();

    const counts = { all: all.length };
    for (const [name, pick] of Object.entries(VIEWS)) counts[name] = all.filter(pick).length;

    let chosen = all.filter(VIEWS[text(view)] || VIEWS.all);

    if (needle) {
      chosen = chosen.filter((row) =>
        row.sku.includes(needle) ||
        row.product_name.toUpperCase().includes(needle) ||
        row.seller_id.toUpperCase().includes(needle) ||
        row.wtb_id.toUpperCase().includes(needle) ||
        row.size.toUpperCase() === needle);
    }

    /*
     * The ones holding him up first, newest within that - a counter that
     * came in ten minutes ago is the one he is on the phone about.
     */
    chosen.sort((a, b) =>
      Number(b.yours) - Number(a.yours) ||
      text(b.countered_at || b.created_at).localeCompare(text(a.countered_at || a.created_at)));

    const shown = await withNames(chosen.slice(0, wanted));

    return {
      offers: shown,
      counts,
      totals: {
        offers: chosen.length,
        shown: shown.length,
        deals: new Set(chosen.map((r) => r.member_wtb_record_id)).size
      }
    };
  }

  async function count() {
    return { yours: (await loaded()).filter(VIEWS.yours).length };
  }

  /*
   * Answering a counter, through the portal that made it.
   *
   * Nothing is written here: the portal closes the round, tells the
   * consignor, and moves the want-to-buy on. Doing any of that from this
   * side would be a second set of rules that drifts from the first.
   */
  async function answer({ id, action, price } = {}) {
    if (!tellKickz) throw new PartnerDealsError("Kickz Caviar is not reachable from this service.", 503);

    const offerId = text(id);
    if (!offerId) throw new PartnerDealsError("Which offer?");

    const rows = await loaded();
    const offer = rows.find((row) => row.id === offerId);

    if (!offer) throw new PartnerDealsError("That offer is not one of yours.", 404);
    if (!offer.yours) throw new PartnerDealsError(`Nothing to answer: ${offer.state.toLowerCase()}.`, 409);

    if (action === "accept") {
      await tellKickz(`/api/consignment/offers/${encodeURIComponent(offerId)}/store-accept`, {});
      forget();
      return { ok: true, did: "accepted", payout: offer.payout, seller_id: offer.seller_id };
    }

    if (action === "deny") {
      await tellKickz(`/api/consignment/offers/${encodeURIComponent(offerId)}/store-deny`, {});
      forget();
      return { ok: true, did: "declined", seller_id: offer.seller_id };
    }

    if (action === "counter") {
      const whole = Number(price);

      // The portal takes whole euros only, and says so with a 400. Caught
      // here so the partner is told before the round is touched.
      if (!Number.isInteger(whole) || whole <= 0) {
        throw new PartnerDealsError("A counter is a whole number of euros.");
      }

      await tellKickz(`/api/consignment/offers/${encodeURIComponent(offerId)}/store-counter`, { price: whole });
      forget();
      return { ok: true, did: "countered", payout: whole, seller_id: offer.seller_id };
    }

    throw new PartnerDealsError("Accept, counter or decline.");
  }

  return { list, count, answer };
}

export function mountPartnerDeals(router, { store, audit = null, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof PartnerDealsError ? err.status : 500;
    if (status >= 500) console.error("[admin partner deals]", err.message);
    res.status(status).json({ error: err instanceof PartnerDealsError ? err.message : `Partner Deals failed: ${err.message}` });
  };

  router.get(["/admin/partner-deals", "/admin/partner-deals/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/partner-deals", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      res.json(await store.list({
        view: text(req.query.view) || "yours",
        q: text(req.query.q),
        limit: req.query.limit
      }));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/partner-deals/answer", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const out = await store.answer({
        id: req.body?.id,
        action: text(req.body?.action),
        price: req.body?.price
      });

      audit?.record({
        actor: req.admin,
        action: `partner_deal_${out.did}`,
        source: "partner_deals",
        recordId: text(req.body?.id),
        label: out.seller_id,
        details: { payout: out.payout ?? null }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });
}

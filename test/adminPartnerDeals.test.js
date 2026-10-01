import test from "node:test";
import assert from "node:assert/strict";

import { STATES, createPartnerDealsStore, dealRow } from "../admin/adminPartnerDeals.js";

const WTB = {
  id: "recWANTTOBUY12345",
  fields: {
    "Member WTB ID": "MWTB-000489",
    "Product Name": "Jordan 4 Retro Military Blue (2024)",
    SKU: "FV5029-141",
    Size: "44",
    Brand: "Jordan",
    "Max Price": 250,
    "Current Lowest Source Price": 200,
    "Fulfillment Status": "Outsource",
    "Payment Status": "Pending"
  }
};

const offer = (extra = {}) => ({
  id: "410bcdef-205d-4195-99e3-40411e69c6b9",
  member_wtb_record_id: WTB.id,
  order_id: "MWTB-000489",
  sku: "fv5029-141",
  size: "44",
  product_name: "Jordan 4 Retro Military Blue (2024)",
  brand: "Jordan",
  seller_id: "SE-00412",
  seller_record_id: "recCONSIGNOR12345",
  seller_price: 220,
  offer_price: 200,
  vat_type: "Margin",
  status: "open",
  created_at: "2026-10-01T10:00:00.000Z",
  ...extra
});

function shop(offers, { wtbs = [WTB], kickz = null } = {}) {
  const sent = [];

  const airtable = {
    async select(table, options) {
      assert.equal(table, "Member WTBs");
      assert.equal(options.formula, "{Partner Run?} = TRUE()");
      return { records: wtbs, offset: "" };
    },
    async byIds() { return new Map(); }
  };

  const asked = [];

  const store = createPartnerDealsStore({
    db: { get: async (q) => { asked.push(q); return offers; } },
    airtable,
    tellKickz: kickz === null
      ? async (pathName, body) => { sent.push({ pathName, body }); return { ok: true }; }
      : kickz,
    cacheMs: 0
  });

  return { store, sent, asked };
}

/* ---------------- what an offer is waiting on ---------------- */

/*
 * "store_pending" is the one that matters: the consignor came back with a
 * price of his own and nothing moves until the partner answers.
 */
test("only a consignor's counter is the partner's turn", () => {
  assert.equal(STATES.store_pending.yours, true);
  assert.equal(STATES.open.yours, false);
  assert.equal(STATES.accepted.yours, false);
  assert.equal(STATES.denied.yours, false);

  assert.equal(dealRow(offer({ status: "store_pending" }), WTB.fields).yours, true);
  assert.equal(dealRow(offer(), WTB.fields).yours, false);
});

test("a row carries both prices and what is left between them", () => {
  const row = dealRow(offer(), WTB.fields);

  assert.equal(row.asks, 220, "what he wanted");
  assert.equal(row.offered, 200, "what we put to him");
  assert.equal(row.buyer_price, 250);
  assert.equal(row.payout, 200);
  assert.equal(row.margin, 50);
  assert.equal(row.sku, "FV5029-141");
  assert.equal(row.wtb_id, "MWTB-000489");
});

// His counter is what we would pay if it goes through, so it is what the
// margin has to be worked out against.
test("once he counters, the margin follows his number", () => {
  const row = dealRow(offer({ status: "store_pending", consignor_counter_price: 235 }), WTB.fields);

  assert.equal(row.countered, 235);
  assert.equal(row.payout, 235);
  assert.equal(row.margin, 15);
  assert.equal(row.state, "He countered");
});

test("a counter that eats the margin shows a negative one rather than hiding it", () => {
  const row = dealRow(offer({ status: "store_pending", consignor_counter_price: 270 }), WTB.fields);

  assert.equal(row.margin, -20);
});

test("an offer whose want-to-buy is gone still reads, on what the offer itself knows", () => {
  const row = dealRow(offer(), {});

  assert.equal(row.product_name, "Jordan 4 Retro Military Blue (2024)");
  assert.equal(row.wtb_id, "MWTB-000489");
  assert.equal(row.buyer_price, 0);
  assert.equal(row.margin, null, "no buyer price means no margin to claim");
});

/* ---------------- the list ---------------- */

test("only partner-run want-to-buys are asked for, and their offers by record", async () => {
  const { store, asked } = shop([offer()]);

  await store.list({ view: "all" });

  assert.match(asked[0], /^consignment_offers\?select=\*/);
  assert.match(asked[0], /member_wtb_record_id=in\.\("recWANTTOBUY12345"\)/);
});

test("the views split what is on him from what is on us", async () => {
  const { store } = shop([
    offer({ id: "1", status: "open" }),
    offer({ id: "2", status: "store_pending", consignor_counter_price: 235 }),
    offer({ id: "3", status: "accepted" }),
    offer({ id: "4", status: "denied" })
  ]);

  const all = await store.list({ view: "all" });

  assert.deepEqual(all.counts, { all: 4, yours: 1, waiting: 1, settled: 2 });
  assert.deepEqual((await store.list({ view: "yours" })).offers.map((o) => o.id), ["2"]);
  assert.deepEqual((await store.list({ view: "waiting" })).offers.map((o) => o.id), ["1"]);
  assert.deepEqual(await store.count(), { yours: 1 });
});

// He is on the phone about the one that came in ten minutes ago.
test("the ones holding him up lead, newest first", async () => {
  const { store } = shop([
    offer({ id: "old-counter", status: "store_pending", consignor_counter_at: "2026-09-01T10:00:00.000Z" }),
    offer({ id: "waiting", status: "open", created_at: "2026-10-01T23:00:00.000Z" }),
    offer({ id: "new-counter", status: "store_pending", consignor_counter_at: "2026-10-01T12:00:00.000Z" })
  ]);

  assert.deepEqual(
    (await store.list({ view: "all" })).offers.map((o) => o.id),
    ["new-counter", "old-counter", "waiting"]
  );
});

test("a search looks through the SKU, product, consignor and the want-to-buy", async () => {
  const { store } = shop([
    offer({ id: "1" }),
    offer({ id: "2", sku: "U9060NRI", product_name: "New Balance 9060", seller_id: "SE-00999", order_id: "MWTB-000500" })
  ]);

  assert.deepEqual((await store.list({ view: "all", q: "9060" })).offers.map((o) => o.id), ["2"]);
  assert.deepEqual((await store.list({ view: "all", q: "SE-00999" })).offers.map((o) => o.id), ["2"]);
  assert.deepEqual((await store.list({ view: "all", q: "fv5029" })).offers.map((o) => o.id), ["1"]);
  assert.equal((await store.list({ view: "all", q: "9060" })).counts.all, 2, "the tabs stay the whole picture");
});

/* ---------------- answering ---------------- */

/*
 * Nothing is written here. The portal closes the round, tells the consignor
 * and moves the want-to-buy on; a second set of rules would drift from it.
 */
test("accepting goes to the portal that owns the round", async () => {
  const { store, sent } = shop([offer({ status: "store_pending", consignor_counter_price: 235 })]);

  const out = await store.answer({ id: offer().id, action: "accept" });

  assert.deepEqual(sent, [{ pathName: `/api/consignment/offers/${offer().id}/store-accept`, body: {} }]);
  assert.equal(out.did, "accepted");
  assert.equal(out.payout, 235);
});

test("declining does too", async () => {
  const { store, sent } = shop([offer({ status: "store_pending" })]);

  const out = await store.answer({ id: offer().id, action: "deny" });

  assert.match(sent[0].pathName, /\/store-deny$/);
  assert.equal(out.did, "declined");
});

// The portal takes whole euros only and says so with a 400; caught here so
// the partner is told before the round is touched.
test("a counter is whole euros, and is refused here rather than there", async () => {
  const { store, sent } = shop([offer({ status: "store_pending" })]);

  await assert.rejects(store.answer({ id: offer().id, action: "counter", price: 190.5 }), /whole number of euros/);
  await assert.rejects(store.answer({ id: offer().id, action: "counter", price: 0 }), /whole number of euros/);
  assert.equal(sent.length, 0);

  const out = await store.answer({ id: offer().id, action: "counter", price: 190 });

  assert.deepEqual(sent, [{ pathName: `/api/consignment/offers/${offer().id}/store-counter`, body: { price: 190 } }]);
  assert.equal(out.payout, 190);
});

test("an offer nobody is waiting on cannot be answered", async () => {
  const { store, sent } = shop([offer({ status: "open" })]);

  await assert.rejects(store.answer({ id: offer().id, action: "accept" }), /Nothing to answer/);
  assert.equal(sent.length, 0);
});

test("an offer that is not one of his is not his to answer", async () => {
  const { store } = shop([offer({ status: "store_pending" })]);

  await assert.rejects(store.answer({ id: "someone-elses", action: "accept" }), /not one of yours/);
});

test("an answer the portal refuses is passed on as it put it", async () => {
  const { store } = shop([offer({ status: "store_pending" })], {
    kickz: async () => { throw new Error("Counter offer is no longer pending"); }
  });

  await assert.rejects(store.answer({ id: offer().id, action: "accept" }), /no longer pending/);
});

test("a service that cannot reach the portal refuses rather than half-doing it", async () => {
  const store = createPartnerDealsStore({
    db: { get: async () => [] },
    airtable: { async select() { return { records: [], offset: "" }; }, async byIds() { return new Map(); } }
  });

  await assert.rejects(store.answer({ id: "x", action: "accept" }), /not reachable/);
});

/* ---------------- the buyer price is the partner's, always ---------------- */

function pricingShop(offers, { wtbs = [WTB] } = {}) {
  const writes = [];

  const airtable = {
    async select() { return { records: wtbs, offset: "" }; },
    async byIds() { return new Map(); },
    async update(table, id, fields) { writes.push({ table, id, fields }); return { id }; }
  };

  return {
    writes,
    store: createPartnerDealsStore({
      db: { get: async () => offers },
      airtable,
      tellKickz: async () => ({ ok: true }),
      cacheMs: 0
    })
  };
}

/*
 * He is standing between two people he haggles with separately. The
 * consignor settles at 170, he goes back to his buyer, and whatever they
 * agree is the price - never something worked out from the payout.
 */
test("the buyer price can be set at any point, on its own", async () => {
  const { store, writes } = pricingShop([offer({ status: "open", offer_price: 160 })]);

  const out = await store.answer({ id: offer().id, action: "price", buyerPrice: 175 });

  assert.equal(out.did, "priced");
  assert.equal(out.buyer_price, 175);
  assert.equal(writes[0].table, "Member WTBs");
  assert.equal(writes[0].fields["Max Price"], 175);
});

test("the margin is kept in step, net, because Airtable reads it that way", async () => {
  const { store, writes } = pricingShop([offer({ status: "store_pending", consignor_counter_price: 170 })]);

  await store.answer({ id: offer().id, action: "price", buyerPrice: 175 });

  assert.equal(writes[0].fields["Offer Margin"], 4.13);
  assert.equal(Math.round((170 + 4.13 * 1.21) * 100) / 100, 175);
});

test("a price that does not cover the payout is refused", async () => {
  const { store, writes } = pricingShop([offer({ status: "store_pending", consignor_counter_price: 170 })]);

  await assert.rejects(
    store.answer({ id: offer().id, action: "price", buyerPrice: 165 }),
    /165 does not cover the 170 going to SE-00412/
  );

  await assert.rejects(store.answer({ id: offer().id, action: "price", buyerPrice: 0 }), /What does the buyer pay/);
  assert.equal(writes.length, 0);
});

/*
 * Accepting is what books the deal, so whatever stands on the want-to-buy
 * at that moment is what the invoice says. The price goes on first.
 */
test("accepting takes the buyer price with it, and writes it before accepting", async () => {
  const { store, writes } = pricingShop([offer({ status: "store_pending", consignor_counter_price: 170 })]);

  const out = await store.answer({ id: offer().id, action: "accept", buyerPrice: 175 });

  assert.equal(writes.length, 1, "written before the portal was told");
  assert.equal(writes[0].fields["Max Price"], 175);
  assert.equal(out.payout, 170);
  assert.equal(out.buyer_price, 175);
});

test("accepting without a price keeps the one that was already there", async () => {
  const { store, writes } = pricingShop([offer({ status: "store_pending", consignor_counter_price: 170 })]);

  const out = await store.answer({ id: offer().id, action: "accept" });

  assert.equal(writes.length, 0);
  assert.equal(out.buyer_price, 250, "the one on the want-to-buy");
});

/*
 * A consignor who simply accepts books the deal himself, there and then.
 * After that Max Price decides nothing: the number the invoice reads was
 * written at confirmation, onto the want-to-buy and onto the unit.
 */
test("a booked deal can still be priced, and the unit moves with it", async () => {
  const { store, writes } = pricingShop(
    [offer({ status: "accepted", offer_price: 160 })],
    { wtbs: [{ ...WTB, fields: { ...WTB.fields, "Linked Inventory Unit": ["recUNIT123456789"] } }] }
  );

  const out = await store.answer({ id: offer().id, action: "price", buyerPrice: 175 });

  assert.equal(out.buyer_price, 175);
  assert.deepEqual(writes.map((w) => w.table), ["Member WTBs", "Inventory Units"]);
  assert.equal(writes[0].fields["Final Buying Price"], 175);
  assert.equal(writes[1].id, "recUNIT123456789");
  assert.equal(writes[1].fields["Selling Price"], 175);
});

test("before it is booked there is no unit to move, and no final price to write", async () => {
  const { store, writes } = pricingShop([offer({ status: "open", offer_price: 160 })]);

  await store.answer({ id: offer().id, action: "price", buyerPrice: 175 });

  assert.equal(writes.length, 1);
  assert.ok(!("Final Buying Price" in writes[0].fields));
});

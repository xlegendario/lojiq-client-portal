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

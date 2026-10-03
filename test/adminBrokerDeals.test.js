import test from "node:test";
import assert from "node:assert/strict";

import {
  LINE_STATES,
  createBrokerDealsStore,
  dealRow,
  lineRow
} from "../admin/adminBrokerDeals.js";

const SALE = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "broker",
  stage: "negotiating",
  deal_number: 87,
  buyer_uuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  buyer_record_id: "recBUYER000000001",
  buyer_company: "Genky Sneakers",
  buyer_country_code: "NL",
  buyer_vat_id: "",
  payment_status: "pending",
  shipping_status: "pending",
  bookkeeping_status: "not_invoiced"
};

const line = (extra = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  sale_id: SALE.id,
  sku: "DV1748-601",
  size: "44",
  product_name: "Jordan 1 Retro High OG Chicago",
  vat_filter: "all",
  buyer_price: 180,
  payout: 150,
  status: "draft",
  offer_id: null,
  inventory_unit_record_id: null,
  created_at: "2026-10-02T09:00:00.000Z",
  ...extra
});

const offer = (extra = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  external_sale_id: SALE.id,
  seller_id: "SE-00281",
  seller_record_id: "recCONSIGNOR1234",
  sku: "DV1748-601",
  size: "44",
  vat_type: "Margin",
  seller_price: 165,
  offer_price: 150,
  status: "open",
  created_at: "2026-10-02T10:00:00.000Z",
  ...extra
});

/*
 * The store, with Supabase and the portal replaced by what they would have
 * said. Every table is a list; a patch rewrites the rows it matches, which
 * is enough for `id=eq.` and `sale_id=eq.` - the only two shapes used.
 */
function shop({ sales = [SALE], lines = [], offers = [], pairs = [], kickz = null } = {}) {
  // Copied per row, not per list: a patch writes into the row object, and
  // a shared fixture would carry one test's deal into the next.
  const copy = (rows) => rows.map((row) => ({ ...row }));
  const tables = { external_sales: copy(sales), deal_lines: copy(lines), consignment_offers: copy(offers), external_sale_pairs: copy(pairs), buyers: [] };
  const uploads = [];
  const sent = [];

  const match = (rows, query) => {
    let out = rows;

    for (const [key, value] of new URLSearchParams(query)) {
      if (key === "select" || key === "order" || key === "limit") continue;

      // PostgREST writes the operator into the value: `id=eq.<uuid>`,
      // `status=in.("a","b")`. The first dot is the separator.
      const [op, ...rest] = String(value).split(".");
      const wanted = rest.join(".").replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/"/g, ""));

      out = out.filter((row) => (op === "in" ? wanted.includes(String(row[key])) : String(row[key]) === wanted[0]));
    }

    return out;
  };

  const split = (path) => {
    const [table, query = ""] = String(path).split("?");
    return { table, query };
  };

  const db = {
    get: async (path) => {
      const { table, query } = split(path);
      return match(tables[table] || [], query);
    },
    insert: async (table, rows) => {
      const made = rows.map((row, i) => ({ id: `new-${table}-${(tables[table] || []).length + i}`, ...row }));
      tables[table] = [...(tables[table] || []), ...made];
      return made;
    },
    patch: async (path, fields) => {
      const { table, query } = split(path);
      const hit = match(tables[table] || [], query);
      for (const row of hit) Object.assign(row, fields);
      return hit;
    },
    upload: async (path, data, type) => {
      uploads.push({ path, type, bytes: String(data).length });
      return `https://storage.example/${path}`;
    },
    remove: async (path) => {
      const { table, query } = split(path);
      const hit = new Set(match(tables[table] || [], query));
      tables[table] = (tables[table] || []).filter((row) => !hit.has(row));
      return [];
    }
  };

  const airtable = {
    async byIds(table, ids) {
      if (table === "Sellers Database") return new Map(ids.map((id) => [id, { "Seller ID": "SE-00281", "Full Name": "Dario Bouman" }]));

      return new Map(ids.map((id) => [id, {
        "Item ID": "CS-001234",
        SKU: "DV1748-601",
        Size: "44",
        "Product Name": "Jordan 1 Retro High OG Chicago",
        "VAT Type": "Margin",
        "Final Purchase Price": 150
      }]));
    }
  };

  const store = createBrokerDealsStore({
    db,
    airtable,
    tellKickz: async (path, body) => {
      // A test that brought its own answers gets the first word.
      if (kickz) {
        const own = await kickz(path, body);
        if (own !== undefined) return own;
      }

      /*
       * Otherwise the buyer comes back with his Airtable row made - that
       * is what asking with_airtable does, and what the invoice guard
       * later insists on. Answered here rather than counted as a call,
       * because no test is about it.
       */
      if (path === "/api/internal/buyers/get") {
        return {
          ok: true,
          buyer: {
            id: body.id,
            buyer_number: 3,
            full_name: "Genky Sneakers",
            company_name: "Genky Sneakers B.V.",
            airtable_record_id: "recBUYER000000001",
            country_code: "NL"
          }
        };
      }

      sent.push({ path, body });
      return { ok: true, seller_id: "SE-00281", offered: 150, inventory_unit_record_id: "recUNIT0000000001", item_id: "CS-001234" };
    }
  });

  return { store, sent, tables, uploads };
}

/* ---------------- what a line is waiting on ---------------- */

test("a line that was never offered is the broker's own move", () => {
  const row = lineRow(line(), null);

  assert.equal(row.status, "draft");
  assert.equal(row.state, "Not offered yet");
  assert.equal(row.yours, true, "he still has to send it");
  assert.equal(row.offerable, true);
  assert.equal(row.due_at, null, "nothing is running out on a pair nobody was asked about");
});

test("once a round is out, the round says where the line stands", () => {
  const waiting = lineRow(line({ status: "offered", offer_id: offer().id }), offer());

  assert.equal(waiting.state, "Waiting for him");
  assert.equal(waiting.yours, false);
  assert.ok(waiting.due_at, "and the clock is running");

  const countered = lineRow(
    line({ status: "countered", offer_id: offer().id }),
    offer({ status: "store_pending", consignor_counter_price: 160, consignor_counter_at: "2026-10-02T12:00:00.000Z" })
  );

  assert.equal(countered.state, "He countered");
  assert.equal(countered.yours, true);
  assert.equal(countered.payout, 160, "his counter is what the pair would cost now");
  assert.equal(countered.margin, 20, "180 - 160");
});

test("agreed is the broker's move and nothing is booked", () => {
  const row = lineRow(
    line({ status: "agreed", offer_id: offer().id }),
    offer({ status: "partner_agreed", accepted_at: "2026-10-02T13:00:00.000Z" })
  );

  assert.equal(row.closable, true);
  assert.equal(row.done, false);
  assert.equal(row.inventory_unit_record_id, "", "no unit until he closes it");
});

/* ---------------- the deal as a whole ---------------- */

test("only bought pairs count as money", () => {
  const rows = [
    lineRow(line({ id: "a", buyer_price: 180, payout: 150 }), offer({ status: "accepted" })),
    lineRow(line({ id: "b", buyer_price: 200, payout: 170 }), offer({ status: "open" }))
  ];

  const deal = dealRow(SALE, rows);

  assert.equal(deal.pairs, 2);
  assert.equal(deal.bought, 1);
  assert.equal(deal.waiting, 1);
  assert.equal(deal.selling, 180, "the one that is still being haggled over is not revenue");
  assert.equal(deal.paying, 150);
  assert.equal(deal.deal_id, "EXTD-000087");
});

/* ---------------- making one ---------------- */

/*
 * invoicePlanFor refuses a deal whose buyer_record_id is empty, so a deal
 * made without one could never be invoiced - and that would only come out
 * weeks later, with the money already in.
 */
test("a new deal carries the buyer twice over, so it can be invoiced", async () => {
  const { store, tables } = shop({ sales: [] });

  const out = await store.create({ buyerId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", note: "two pairs" });

  const [sale] = tables.external_sales;

  assert.equal(sale.kind, "broker");
  assert.equal(sale.stage, "negotiating");
  assert.equal(sale.buyer_uuid, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "what the invoice reads");
  assert.equal(sale.buyer_record_id, "recBUYER000000001", "what the guard insists on");
  assert.equal(sale.buyer_id, "BU-00003");
  assert.equal(sale.bookkeeping_status, "not_invoiced", "nothing to invoice until a pair is bought");
  assert.equal(sale.total_selling_price, 0);
  assert.ok(out.id);
});

test("a pair cannot be added below what we would pay for it", async () => {
  const { store } = shop();

  await assert.rejects(
    store.addLine({ saleId: SALE.id, sku: "dv1748-601", size: "44", buyerPrice: 140, payout: 150 }),
    /does not cover/
  );
});

test("a pair is added with both prices and nothing computed between them", async () => {
  const { store, tables } = shop();

  const row = await store.addLine({ saleId: SALE.id, sku: "dv1748-601", size: "44", buyerPrice: 180, payout: 150, vatFilter: "margin" });

  assert.equal(row.sku, "DV1748-601", "upper-cased, as the stock holds it");
  assert.equal(row.buyer_price, 180);
  assert.equal(row.offered, 150);
  assert.equal(tables.deal_lines.length, 1);
  assert.equal(tables.deal_lines[0].vat_filter, "margin");
});

test("a pair that is already out with a consignor is dropped, not deleted", async () => {
  const { store } = shop({
    lines: [line({ status: "offered", offer_id: offer().id })],
    offers: [offer()]
  });

  await assert.rejects(store.removeLine(line().id), /Drop it instead/);
});

/* ---------------- the round ---------------- */

test("submitting offers every draft line and reports per pair", async () => {
  const { store, sent } = shop({
    lines: [line({ id: "l1" }), line({ id: "l2", sku: "IE7495", size: "42" }), line({ id: "l3", status: "agreed", offer_id: offer().id })],
    offers: [offer({ status: "partner_agreed" })]
  });

  const out = await store.submit(SALE.id);

  assert.equal(out.sent, 2, "the one that is already agreed is left alone");
  assert.deepEqual(sent.map((call) => call.path), [
    "/api/internal/broker/offer",
    "/api/internal/broker/offer"
  ]);
  assert.deepEqual(sent.map((call) => call.body.deal_line_id), ["l1", "l2"]);
});

test("the buyer price can still move while the consignor is deciding", async () => {
  const { store, tables } = shop({
    lines: [line({ status: "offered", offer_id: offer().id })],
    offers: [offer()]
  });

  await store.answer({ lineId: line().id, action: "price", buyerPrice: 175 });

  assert.equal(tables.deal_lines[0].buyer_price, 175);
});

test("a buyer price that no longer covers the payout is refused", async () => {
  const { store } = shop({
    lines: [line({ status: "countered", offer_id: offer().id })],
    offers: [offer({ status: "store_pending", consignor_counter_price: 170 })]
  });

  await assert.rejects(
    store.answer({ lineId: line().id, action: "price", buyerPrice: 165 }),
    /does not cover the 170/
  );
});

test("countering takes whole euros only, and is not sent otherwise", async () => {
  const { store, sent } = shop({
    lines: [line({ status: "countered", offer_id: offer().id })],
    offers: [offer({ status: "store_pending", consignor_counter_price: 160 })]
  });

  await assert.rejects(store.answer({ lineId: line().id, action: "counter", price: 157.5 }), /whole number/);
  assert.deepEqual(sent, []);

  const out = await store.answer({ lineId: line().id, action: "counter", price: 157 });

  assert.equal(out.did, "countered");
  assert.match(sent[0].path, /store-counter$/);
  assert.deepEqual(sent[0].body, { price: 157 });
});

test("closing needs a buyer price and hands the pair to the sale", async () => {
  const { store, sent, tables } = shop({
    lines: [line({ status: "agreed", offer_id: offer().id, buyer_price: null })],
    offers: [offer({ status: "partner_agreed", accepted_at: "2026-10-02T13:00:00.000Z" })]
  });

  await assert.rejects(store.answer({ lineId: line().id, action: "finalize" }), /What does the buyer pay/);
  assert.deepEqual(sent, []);

  const out = await store.answer({ lineId: line().id, action: "finalize", buyerPrice: 180 });

  assert.equal(out.did, "bought");
  assert.equal(sent[0].path, "/api/internal/broker/finalize");
  assert.deepEqual(sent[0].body, { deal_line_id: line().id, buyer_price: 180 });

  const [pair] = tables.external_sale_pairs;
  assert.equal(pair.inventory_unit_record_id, "recUNIT0000000001");
  assert.equal(pair.selling_price, 180);
  assert.equal(pair.purchase_price_ex_vat, 150, "the purchase as the unit fixed it");
  assert.equal(pair.purchase_vat_type, "Margin");
  assert.equal(pair.consignor_fulfillment_status, "Allocated", "the step his Confirmed tab filters on");
});

/*
 * A deal with one of five pairs bought is not a deal yet. Letting it turn
 * into a sale by itself would put it in Pending, where it can be invoiced
 * and paid, while four pairs are still being haggled over.
 */
test("buying a pair does not turn the negotiation into a sale by itself", async () => {
  const { store, tables } = shop({
    lines: [line({ status: "agreed", offer_id: offer().id })],
    offers: [offer({ status: "partner_agreed" })]
  });

  await store.answer({ lineId: line().id, action: "finalize", buyerPrice: 180 });

  assert.equal(tables.external_sales[0].stage, "negotiating", "the broker decides when it is a deal");
  assert.equal(tables.external_sales[0].bookkeeping_status, "not_invoiced");
  assert.equal(tables.external_sales[0].total_selling_price, 180, "but the total is what is really on it");
});

test("confirming draws the line: what is bought becomes the sale", async () => {
  const { store, tables, sent } = shop({
    lines: [
      line({ id: "l1", status: "confirmed", offer_id: "o1", inventory_unit_record_id: "recUNIT0000000001" }),
      line({ id: "l2", status: "offered", offer_id: "o2" }),
      line({ id: "l3", status: "draft", offer_id: null })
    ],
    offers: [
      offer({ id: "o1", status: "accepted" }),
      offer({ id: "o2", status: "open" })
    ],
    pairs: [{ id: "p1", sale_id: SALE.id, selling_price: 180, cancelled_at: null }]
  });

  const out = await store.confirmDeal(SALE.id);

  assert.equal(out.pairs, 1, "one pair bought");
  assert.equal(out.dropped, 2, "the one still out and the one never offered");

  // The round that was out is dropped through the portal, so the consignor
  // hears about it on the same terms as any other drop.
  assert.deepEqual(sent, [{ path: "/api/internal/partner-deal/discard", body: { offer_id: "o2" } }]);

  assert.equal(tables.deal_lines.find((l) => l.id === "l2").status, "cancelled");
  assert.equal(tables.deal_lines.find((l) => l.id === "l3").status, "cancelled");

  assert.equal(tables.external_sales[0].stage, "open");
  assert.equal(tables.external_sales[0].bookkeeping_status, "to_invoice");
  assert.equal(tables.external_sales[0].total_selling_price, 180);
  // The sale happened the day it was confirmed, not the day the haggling
  // started - and that is the date the invoice carries.
  assert.equal(tables.external_sales[0].sale_date, new Date().toISOString().slice(0, 10));
});

test("a deal with nothing bought cannot be confirmed", async () => {
  const { store, sent } = shop({
    lines: [line({ status: "offered", offer_id: offer().id })],
    offers: [offer()]
  });

  await assert.rejects(store.confirmDeal(SALE.id), /Nothing has been bought/);
  assert.deepEqual(sent, [], "and nobody is dropped over it");
});

test("a pair halfway through being bought holds the confirmation", async () => {
  const { store } = shop({
    lines: [
      line({ id: "l1", status: "confirmed", offer_id: "o1" }),
      line({ id: "l2", status: "agreed", offer_id: "o2" })
    ],
    offers: [offer({ id: "o1", status: "accepted" }), offer({ id: "o2", status: "processing" })],
    pairs: [{ id: "p1", sale_id: SALE.id, selling_price: 180, cancelled_at: null }]
  });

  await assert.rejects(store.confirmDeal(SALE.id), /being bought right now/);
});

test("a deal that is not a broker's own is refused outright", async () => {
  const { store } = shop({ sales: [{ ...SALE, kind: "direct" }] });

  await assert.rejects(store.get(SALE.id), /not a broker deal/);
});

/* ---------------- the clock ---------------- */

test("extending writes the new time on the round and tells nobody", async () => {
  const { store, sent, tables } = shop({
    lines: [line({ status: "offered", offer_id: offer().id })],
    offers: [offer()]
  });

  const out = await store.answer({ lineId: line().id, action: "extend" });

  assert.equal(out.did, "extended");
  assert.ok(tables.consignment_offers[0].extended_until);
  assert.deepEqual(sent, [], "a consignor hears nothing about being given more time");
});

test("there is nothing to drop on a pair that was never offered", async () => {
  const { store } = shop({ lines: [line()] });

  await assert.rejects(store.answer({ lineId: line().id, action: "discard" }), /Nothing has been offered/);
});

test("every state says who is holding it up", () => {
  for (const [name, state] of Object.entries(LINE_STATES)) {
    assert.equal(typeof state.say, "string", name);
    assert.ok(state.say.length, name);
  }

  assert.equal(LINE_STATES.accepted.done, true);
  assert.equal(LINE_STATES.open.yours, false);
  assert.equal(LINE_STATES.store_pending.yours, true);
});


/* ---------------- getting the pairs off the shelves ---------------- */

/*
 * Three pairs from one consignor are ONE parcel on ONE label. Three labels
 * would mean three boxes in the post - his money and our pair arriving
 * late - so the grouping is the point of this whole step.
 */
const bought = (id, sku, size) => line({
  id,
  sku,
  size,
  status: "confirmed",
  offer_id: `o-${id}`,
  inventory_unit_record_id: `recUNIT000000000${id}`
});

const soldOffer = (id, seller) => offer({ id: `o-${id}`, status: "accepted", seller_record_id: seller, seller_id: seller === "recCONSIGNOR1234" ? "SE-00281" : "SE-00999" });

function shipShop() {
  return shop({
    sales: [{ ...SALE, stage: "open", deal_number: 87 }],
    lines: [
      bought("1", "DV1748-601", "44"),
      bought("2", "DV1748-601", "45"),
      bought("3", "IE7495", "42")
    ],
    offers: [
      soldOffer("1", "recCONSIGNOR1234"),
      soldOffer("2", "recCONSIGNOR1234"),
      soldOffer("3", "recCONSIGNOR9999")
    ],
    pairs: [
      { id: "p1", sale_id: SALE.id, inventory_unit_record_id: "recUNIT0000000001", item_id: "CS-001", cancelled_at: null },
      { id: "p2", sale_id: SALE.id, inventory_unit_record_id: "recUNIT0000000002", item_id: "CS-002", cancelled_at: null },
      { id: "p3", sale_id: SALE.id, inventory_unit_record_id: "recUNIT0000000003", item_id: "CS-003", cancelled_at: null }
    ]
  });
}

test("what is still to come in is grouped per consignor, not per pair", async () => {
  const { store } = shipShop();

  const { groups } = await store.shipments(SALE.id);

  assert.equal(groups.length, 2, "two consignors, not three pairs");

  const big = groups.find((g) => g.seller_record_id === "recCONSIGNOR1234");
  assert.equal(big.pairs.length, 2);
  assert.deepEqual(big.pairs.map((p) => p.size), ["44", "45"]);
});

test("one label goes on every pair of that consignor, and he is told once", async () => {
  const { store, tables, uploads, sent } = shipShop();

  const out = await store.shipConsignor({
    saleId: SALE.id,
    sellerRecordId: "recCONSIGNOR1234",
    label: { name: "label.pdf", type: "application/pdf", data: "JVBERi0=" },
    tracking: "3SABCD1234567"
  });

  assert.equal(out.pairs, 2);
  assert.match(out.shipment_group, /^SHIP-000087-/);

  assert.equal(uploads.length, 1, "one label, not one per pair");
  assert.match(uploads[0].path, /^broker-labels\/EXTD-000087\//);

  const touched = tables.external_sale_pairs.filter((p) => p.shipment_group === out.shipment_group);
  assert.equal(touched.length, 2);

  for (const pair of touched) {
    assert.equal(pair.consignor_fulfillment_status, "Ready to Ship");
    assert.equal(pair.consignor_tracking_url, "3SABCD1234567");
    assert.match(pair.consignor_label_url, /^https:\/\/storage\.example\//);
  }

  // The third pair belongs to someone else and must not have moved.
  const other = tables.external_sale_pairs.find((p) => p.id === "p3");
  assert.equal(other.consignor_fulfillment_status, undefined);

  const notice = sent.find((call) => call.path === "/api/internal/broker/label-ready");
  assert.ok(notice, "and he hears about it");
  assert.equal(notice.body.pairs.length, 2, "with both pairs named, so he packs one box");
  assert.equal(notice.body.seller_record_id, "recCONSIGNOR1234");
});

test("a label needs a tracking number, and nothing is written without one", async () => {
  const { store, tables, uploads } = shipShop();

  await assert.rejects(
    store.shipConsignor({ saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234", labelUrl: "https://x/label.pdf" }),
    /tracking number/
  );

  assert.deepEqual(uploads, []);
  assert.ok(tables.external_sale_pairs.every((p) => !p.shipment_group));
});

test("the same label cannot be sent twice", async () => {
  const { store } = shipShop();

  await store.shipConsignor({
    saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234",
    labelUrl: "https://x/label.pdf", tracking: "3SABCD1234567"
  });

  await assert.rejects(
    store.shipConsignor({
      saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234",
      labelUrl: "https://x/label.pdf", tracking: "3SABCD1234567"
    }),
    /already with him/
  );
});

test("shipped is marked for the whole parcel, and only once it has a label", async () => {
  const { store, tables } = shipShop();

  await assert.rejects(
    store.markShipped({ saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234" }),
    /no label yet/
  );

  await store.shipConsignor({
    saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234",
    labelUrl: "https://x/label.pdf", tracking: "3SABCD1234567"
  });

  const out = await store.markShipped({ saleId: SALE.id, sellerRecordId: "recCONSIGNOR1234" });

  assert.equal(out.pairs, 2);
  assert.equal(tables.external_sale_pairs.filter((p) => p.consignor_shipping_status === "Shipped").length, 2);
});


/* ---------------- a deal that begins on a name ---------------- */

/*
 * The invoice address of someone new arrives once the deal is struck - that
 * is simply when people hand it over. Demanding it up front would mean no
 * deal could be started with a buyer we have not sold to before.
 */
test("a deal can begin on a name alone", async () => {
  const { store, tables } = shop({ sales: [] });

  await store.create({ buyerName: "Mike from Antwerp" });

  const [sale] = tables.external_sales;

  assert.equal(sale.buyer_name, "Mike from Antwerp");
  assert.equal(sale.buyer_uuid, null, "nobody in the system yet");
  assert.equal(sale.stage, "negotiating");
});

test("a deal needs a who, even if only a name", async () => {
  const { store } = shop({ sales: [] });

  await assert.rejects(store.create({}), /Who is the buyer/);
});

/*
 * Confirming is the moment it becomes a sale: invoiced, paid and shipped,
 * all three reading the buyer off this row. A name is not enough there.
 */
test("a deal on a name alone cannot be confirmed", async () => {
  const { store } = shop({
    sales: [{ ...SALE, buyer_uuid: null, buyer_record_id: null, buyer_name: "Mike from Antwerp" }],
    lines: [line({ status: "confirmed", offer_id: "o1", inventory_unit_record_id: "recUNIT0000000001" })],
    offers: [offer({ id: "o1", status: "accepted" })],
    pairs: [{ id: "p1", sale_id: SALE.id, selling_price: 180, cancelled_at: null }]
  });

  const { deal } = await store.get(SALE.id);

  assert.equal(deal.needs_buyer, true);
  assert.equal(deal.confirmable, false, "the button says so before he clicks it");

  await assert.rejects(store.confirmDeal(SALE.id), /still running on the name "Mike from Antwerp"/);
});

test("the buyer can be put on afterwards, and then it confirms", async () => {
  const { store, tables } = shop({
    sales: [{ ...SALE, buyer_uuid: null, buyer_record_id: null, buyer_name: "Mike from Antwerp" }],
    lines: [line({ status: "confirmed", offer_id: "o1", inventory_unit_record_id: "recUNIT0000000001" })],
    offers: [offer({ id: "o1", status: "accepted" })],
    pairs: [{ id: "p1", sale_id: SALE.id, selling_price: 180, cancelled_at: null }]
  });

  await store.attachBuyer({ saleId: SALE.id, buyerId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" });

  assert.equal(tables.external_sales[0].buyer_uuid, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
  assert.equal(tables.external_sales[0].buyer_record_id, "recBUYER000000001", "and what the invoice guard wants");

  const out = await store.confirmDeal(SALE.id);

  assert.equal(out.pairs, 1);
  assert.equal(tables.external_sales[0].stage, "open");
});

/*
 * A reply shaped right but empty would otherwise be written onto the sale
 * as a buyer with no id: the deal would read as having one, and nothing
 * could be invoiced to it.
 */
test("a buyer who comes back without an id is not a buyer", async () => {
  const { store } = shop({
    sales: [{ ...SALE, buyer_uuid: null, buyer_record_id: null, buyer_name: "Mike" }],
    kickz: async (path) => (path === "/api/internal/buyers/get" ? { ok: true, buyer: {} } : { ok: true })
  });

  await assert.rejects(
    store.attachBuyer({ saleId: SALE.id, buyerId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
    /does not exist/
  );
});

test("an invoiced deal does not change hands", async () => {
  const { store } = shop({ sales: [{ ...SALE, bookkeeping_status: "invoiced" }] });

  await assert.rejects(
    store.attachBuyer({ saleId: SALE.id, buyerId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
    /already invoiced/
  );
});

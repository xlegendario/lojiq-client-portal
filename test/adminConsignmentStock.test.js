import test from "node:test";
import assert from "node:assert/strict";

import {
  VAT_FILTERS,
  comparePrice,
  createConsignmentStockStore,
  stockRow
} from "../admin/adminConsignmentStock.js";

const offer = (extra = {}) => ({
  id: "1f0c0000-0000-4000-8000-000000000001",
  seller_id: "SE-00412",
  seller_record_id: "recCONSIGNOR12345",
  sku: "fv5029-141",
  size: "44",
  product_name: "Jordan 4 Retro Military Blue (2024)",
  brand: "Jordan",
  vat_type: "Margin",
  selling_price_suggested: 170,
  payout_price: null,
  quantity: 1,
  created_at: "2026-09-20T10:00:00.000Z",
  ...extra
});

function fakeDb(rows) {
  const asked = [];

  return {
    asked,
    db: {
      async get(pathAndQuery) {
        asked.push(pathAndQuery);
        // Only the first page has anything; the store stops on a short page.
        return /offset=0/.test(pathAndQuery) ? rows : [];
      }
    }
  };
}

const noNames = { async byIds() { return new Map(); } };

/*
 * A VAT0 consignor asking 100 costs 121 to buy. Comparing his 100 against a
 * margin consignor's 100 would make him look the cheaper of the two, and we
 * would ask the wrong man.
 */
test("a VAT0 ask is grossed up before anything is compared", () => {
  assert.equal(comparePrice(100, "VAT0"), 121);
  assert.equal(comparePrice(100, "Margin"), 100);
  assert.equal(comparePrice(100, "VAT21"), 100);
  assert.equal(comparePrice(170, "vat0"), 205.7);
});

test("an ask of nothing compares as nothing, never as zero euros cheaper", () => {
  assert.equal(comparePrice(0, "Margin"), 0);
  assert.equal(comparePrice(null, "VAT0"), 0);
  assert.equal(comparePrice("", "Margin"), 0);
});

test("the three filters are the ones a member WTB already knows", () => {
  assert.deepEqual(VAT_FILTERS.all, ["Margin", "VAT0", "VAT21"]);
  assert.deepEqual(VAT_FILTERS.margin, ["Margin"]);
  assert.deepEqual(VAT_FILTERS.b2b, ["VAT0", "VAT21"]);
});

test("a row carries both what he asks and what it costs us", () => {
  const row = stockRow(offer({ vat_type: "VAT0", selling_price_suggested: 200 }));

  assert.equal(row.ask, 200);
  assert.equal(row.compare, 242);
  assert.equal(row.sku, "FV5029-141", "SKUs are compared in upper case");
});

test("a partner's pair is marked, because it is already on our shelf", () => {
  assert.equal(stockRow(offer()).partner, false);
  assert.equal(stockRow(offer()).payout, null);

  const partner = stockRow(offer({ payout_price: 150 }));
  assert.equal(partner.partner, true);
  assert.equal(partner.payout, 150);
});

test("only pairs that are held and priced are asked for", async () => {
  const base = fakeDb([]);
  await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({});

  assert.match(base.asked[0], /quantity=gt\.0/);
  assert.match(base.asked[0], /selling_price_suggested=gt\.0/);
});

test("the tabs split the list the way the buying filter does", async () => {
  const base = fakeDb([
    offer(),
    offer({ id: "2", vat_type: "VAT0" }),
    offer({ id: "3", vat_type: "VAT21" }),
    offer({ id: "4", vat_type: "Margin" })
  ]);

  const store = createConsignmentStockStore({ db: base.db, airtable: noNames });
  const all = await store.list({ view: "all" });

  assert.deepEqual(all.counts, { all: 4, margin: 2, b2b: 2 });

  assert.equal((await store.list({ view: "margin" })).units.length, 2);
  assert.equal((await store.list({ view: "b2b" })).units.length, 2);
});

/*
 * Searching means looking for one shoe, and then the only order that helps is
 * what it costs us - that is the man to ask first. The VAT0 consignor here
 * asks the least and costs the most.
 */
test("a search puts the man who costs us least on top, not the one who asks least", async () => {
  const base = fakeDb([
    offer({ id: "1", seller_id: "SE-DEAREST", selling_price_suggested: 180, vat_type: "Margin" }),
    offer({ id: "2", seller_id: "SE-LOOKS-CHEAP", selling_price_suggested: 160, vat_type: "VAT0" }),
    offer({ id: "3", seller_id: "SE-CHEAPEST", selling_price_suggested: 170, vat_type: "Margin" })
  ]);

  const rows = (await createConsignmentStockStore({ db: base.db, airtable: noNames })
    .list({ q: "FV5029-141" })).units;

  assert.deepEqual(rows.map((r) => r.seller_id), ["SE-CHEAPEST", "SE-DEAREST", "SE-LOOKS-CHEAP"]);
  assert.deepEqual(rows.map((r) => r.compare), [170, 180, 193.6]);
});

test("without a search the newest arrivals lead, because there is no shoe yet", async () => {
  const base = fakeDb([
    offer({ id: "1", seller_id: "SE-OLDEST", created_at: "2026-01-01T10:00:00.000Z" }),
    offer({ id: "2", seller_id: "SE-NEWEST", created_at: "2026-09-30T10:00:00.000Z" })
  ]);

  const rows = (await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({})).units;

  assert.deepEqual(rows.map((r) => r.seller_id), ["SE-NEWEST", "SE-OLDEST"]);
});

/*
 * The fallback when the first consignor says no, which is the question a
 * declined offer raises and the reason this column exists.
 */
test("a row says how many other consignors hold the same pair", async () => {
  const base = fakeDb([
    offer({ id: "1", seller_id: "SE-A" }),
    offer({ id: "2", seller_id: "SE-B" }),
    offer({ id: "3", seller_id: "SE-C" }),
    offer({ id: "4", seller_id: "SE-D", size: "45" })
  ]);

  const rows = (await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({})).units;

  for (const row of rows.filter((r) => r.size === "44")) assert.equal(row.alternatives, 2);
  assert.equal(rows.find((r) => r.size === "45").alternatives, 0);
});

/*
 * One box, typed the way you would say it: the shoe and the size together.
 */
test("every word has to land, so a shoe and a size narrow together", async () => {
  const base = fakeDb([
    offer({ id: "1", size: "44" }),
    offer({ id: "2", size: "45" }),
    offer({ id: "3", sku: "U9060NRI", product_name: "New Balance 9060 Triple Black", size: "44" })
  ]);

  const store = createConsignmentStockStore({ db: base.db, airtable: noNames });

  assert.deepEqual((await store.list({ q: "military blue 44" })).units.map((r) => r.id), ["1"]);
  assert.deepEqual((await store.list({ q: "FV5029-141" })).units.map((r) => r.size).sort(), ["44", "45"]);
  assert.deepEqual((await store.list({ q: "military blue 46" })).units, []);
});

/*
 * "HQ4409" contains a 44, so searching a size used to turn up cheap pairs in
 * other sizes above the ones actually asked for.
 */
test("a row whose size matches leads, whatever it costs", async () => {
  const base = fakeDb([
    offer({ id: "cheap-other-size", sku: "HQ4409", size: "38", selling_price_suggested: 39 }),
    offer({ id: "right-size", size: "44", selling_price_suggested: 210 })
  ]);

  const rows = (await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({ q: "44" })).units;

  assert.deepEqual(rows.map((r) => r.id), ["right-size", "cheap-other-size"]);
});

test("a search looks through the SKU, product, size and consignor", async () => {
  const base = fakeDb([
    offer(),
    offer({ id: "2", sku: "U9060NRI", product_name: "New Balance 9060 Triple Black", size: "43", seller_id: "SE-00999" })
  ]);

  const store = createConsignmentStockStore({ db: base.db, airtable: noNames });

  assert.deepEqual((await store.list({ q: "9060" })).units.map((r) => r.size), ["43"]);
  assert.deepEqual((await store.list({ q: "fv5029" })).units.map((r) => r.size), ["44"]);
  assert.deepEqual((await store.list({ q: "43" })).units.map((r) => r.sku), ["U9060NRI"]);
  assert.deepEqual((await store.list({ q: "SE-00999" })).units.map((r) => r.sku), ["U9060NRI"]);

  // The tabs stay the whole picture while searching.
  assert.equal((await store.list({ q: "9060" })).counts.all, 2);
});

test("the totals say what there is to pick from", async () => {
  const base = fakeDb([
    offer({ id: "1", seller_id: "SE-A", selling_price_suggested: 180 }),
    offer({ id: "2", seller_id: "SE-B", selling_price_suggested: 170 }),
    offer({ id: "3", seller_id: "SE-A", size: "45", selling_price_suggested: 200 })
  ]);

  const out = await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({ q: "FV5029-141" });

  assert.equal(out.totals.units, 3);
  assert.equal(out.totals.pairs, 2, "two different SKU and size combinations");
  assert.equal(out.totals.consignors, 2);
  assert.equal(out.totals.cheapest, 170);
});

/*
 * A size search also turns up a SKU with those digits in it. Quoting that
 * pair's price as the cheapest would be a number for a different shoe.
 */
test("the cheapest shown is the cheapest of the pairs actually asked for", async () => {
  const base = fakeDb([
    offer({ id: "other-shoe", sku: "HQ4409", size: "38", selling_price_suggested: 39 }),
    offer({ id: "asked-for", size: "44", selling_price_suggested: 210 })
  ]);

  const out = await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({ q: "44" });

  assert.equal(out.totals.cheapest, 210);
});

test("the consignor's name comes from the Sellers Database, the id is the fallback", async () => {
  const base = fakeDb([offer(), offer({ id: "2", seller_record_id: "" })]);

  const airtable = {
    async byIds(table) {
      assert.equal(table, "Sellers Database");
      return new Map([["recCONSIGNOR12345", { "Company Name": "Kicksbymattie", "Seller ID": "SE-00412" }]]);
    }
  };

  const rows = (await createConsignmentStockStore({ db: base.db, airtable }).list({})).units;

  assert.equal(rows.find((r) => r.seller_record_id).party, "Kicksbymattie");
  assert.equal(rows.find((r) => !r.seller_record_id).party, "SE-00412");
});

test("a name lookup that fails does not take the screen down with it", async () => {
  const base = fakeDb([offer()]);
  const airtable = { async byIds() { throw new Error("Airtable is having a moment"); } };

  const rows = (await createConsignmentStockStore({ db: base.db, airtable }).list({})).units;

  assert.equal(rows[0].party, "SE-00412");
});

test("the stock is read once and held, because every view is cut from it", async () => {
  const base = fakeDb([offer()]);
  const store = createConsignmentStockStore({ db: base.db, airtable: noNames });

  await store.list({ view: "all" });
  await store.list({ view: "margin" });
  await store.count();

  assert.equal(base.asked.length, 1);
});

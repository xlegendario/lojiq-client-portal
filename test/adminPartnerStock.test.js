import test from "node:test";
import assert from "node:assert/strict";

import { MODES, createPartnerStockStore, stockRow } from "../admin/adminPartnerStock.js";

const pair = (extra = {}) => ({
  id: "1f0c0000-0000-4000-8000-000000000001",
  seller_id: "SE-00781",
  seller_record_id: "recPARTNER1234567",
  sku: "A01FW702-BLK",
  size: "42",
  product_name: "Maison Mihara Yasuhiro Peterson OG Sole",
  brand: "Maison Mihara Yasuhiro",
  vat_type: "Margin",
  mode: "both",
  partner_price: 100,
  markup: 15,
  status: "in_stock",
  tracking_number: "3SABCDEFGHIJK",
  received_at: "2026-09-12T10:00:00.000Z",
  ...extra
});

function fakeDb(rows) {
  const asked = [];

  return {
    asked,
    db: {
      async get(pathAndQuery) {
        asked.push(pathAndQuery);
        return rows;
      }
    }
  };
}

const noNames = { async byIds() { return new Map(); } };

test("the intake words are the same ones Inbound Scans uses", () => {
  assert.equal(MODES.both, "Consignment & Forwarding");
  assert.equal(stockRow(pair()).mode, "Consignment & Forwarding");
  assert.equal(stockRow(pair({ mode: "consignment" })).mode, "Consignment");
});

test("a row says what state the pair is in, in words", () => {
  assert.equal(stockRow(pair()).state, "On the shelf");
  assert.equal(stockRow(pair({ status: "sold" })).state, "Sold");
  assert.equal(stockRow(pair({ status: "forwarded" })).state, "Forwarded");
});

test("a row with no status at all counts as on the shelf", () => {
  assert.equal(stockRow(pair({ status: null })).status, "in_stock");
});

test("a price of nothing stays nothing, rather than becoming zero euros", () => {
  assert.equal(stockRow(pair({ partner_price: null })).partner_price, null);
  assert.equal(stockRow(pair({ partner_price: 99.999 })).partner_price, 100);
});

test("the views split the shelf from what has left it", async () => {
  const base = fakeDb([
    pair(),
    pair({ id: "2", status: "sold", sold_ref: "store order", inventory_unit_id: "recUNIT123456789" }),
    pair({ id: "3", status: "forwarded" }),
    pair({ id: "4", partner_price: 50 })
  ]);

  const store = createPartnerStockStore({ db: base.db, airtable: noNames });
  const all = await store.list({ view: "all" });

  assert.deepEqual(all.counts, { all: 4, in_stock: 2, sold: 1, forwarded: 1 });
  assert.equal((await store.list({ view: "in_stock" })).units.length, 2);
  assert.equal((await store.list({ view: "sold" })).units[0].sold_ref, "store order");
  assert.deepEqual(await store.count(), { in_stock: 2 });
});

/*
 * What the partner is owed is about the pairs still here. A sold pair was
 * settled when it sold, so counting it in would read as money still to find.
 */
test("the money shown is what is owed on the shelf, not on everything", async () => {
  const base = fakeDb([
    pair({ partner_price: 100 }),
    pair({ id: "2", partner_price: 60 }),
    pair({ id: "3", status: "sold", partner_price: 500 })
  ]);

  const store = createPartnerStockStore({ db: base.db, airtable: noNames });
  const all = await store.list({ view: "all" });

  assert.equal(all.totals.on_the_shelf, 160);
  assert.equal(all.totals.value, 660, "the plain total is still every row on the list");
});

/*
 * On the day this was written all 26 sold rows had an empty
 * inventory_unit_id although the purchases do exist. Surfaced rather than
 * left to be discovered during a migration, where SKU and size are all that
 * is left to match on and four sales of one shoe in one size are identical.
 */
test("a sold pair with no purchase written back on it is counted", async () => {
  const base = fakeDb([
    pair({ status: "sold" }),
    pair({ id: "2", status: "sold", inventory_unit_id: "recUNIT123456789" }),
    pair({ id: "3" })
  ]);

  const store = createPartnerStockStore({ db: base.db, airtable: noNames });

  assert.equal((await store.list({ view: "all" })).totals.unlinked, 1);
  assert.equal((await store.list({ view: "in_stock" })).totals.unlinked, 0, "only sold rows can be missing one");
});

test("the partner's name comes from the Sellers Database, the seller id is the fallback", async () => {
  const base = fakeDb([pair(), pair({ id: "2", seller_record_id: "" })]);

  const airtable = {
    async byIds(table, ids) {
      assert.equal(table, "Sellers Database");
      return new Map([["recPARTNER1234567", { "Company Name": "Hypeneedz", "Seller ID": "SE-00781" }]]);
    }
  };

  const rows = (await createPartnerStockStore({ db: base.db, airtable }).list({ view: "all" })).units;

  assert.equal(rows[0].party, "Hypeneedz");
  assert.equal(rows[1].party, "SE-00781");
});

test("a name that cannot be looked up does not take the screen down with it", async () => {
  const base = fakeDb([pair()]);
  const airtable = { async byIds() { throw new Error("Airtable is having a moment"); } };

  const rows = (await createPartnerStockStore({ db: base.db, airtable }).list({ view: "all" })).units;

  assert.equal(rows[0].party, "SE-00781");
});

test("a search looks through the SKU, product, parcel and partner", async () => {
  const base = fakeDb([
    pair(),
    pair({ id: "2", sku: "205759-610", product_name: "Nike Dunk", tracking_number: "JJD99887766", size: "45" })
  ]);

  const store = createPartnerStockStore({ db: base.db, airtable: noNames });

  assert.deepEqual((await store.list({ view: "all", q: "dunk" })).units.map((u) => u.sku), ["205759-610"]);
  assert.deepEqual((await store.list({ view: "all", q: "JJD998" })).units.map((u) => u.sku), ["205759-610"]);
  assert.deepEqual((await store.list({ view: "all", q: "a01fw702" })).units.map((u) => u.size), ["42"]);
  assert.deepEqual((await store.list({ view: "all", q: "45" })).units.map((u) => u.sku), ["205759-610"]);

  // The counts stay the whole picture, so the tabs do not move while searching.
  assert.equal((await store.list({ view: "all", q: "dunk" })).counts.all, 2);
});

test("the shelf is read once and held, because every view is cut from it", async () => {
  const base = fakeDb([pair()]);
  const store = createPartnerStockStore({ db: base.db, airtable: noNames });

  await store.list({ view: "in_stock" });
  await store.list({ view: "sold" });
  await store.count();

  assert.equal(base.asked.length, 1);
  assert.match(base.asked[0], /^partner_stock\?select=/);
  assert.match(base.asked[0], /inventory_unit_id/);
});

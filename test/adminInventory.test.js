import test from "node:test";
import assert from "node:assert/strict";

import {
  OWNED_TYPES,
  createInventoryStore,
  flagsFor,
  sellable,
  unitRow
} from "../admin/adminInventory.js";

const TODAY = new Date("2026-09-30T12:00:00.000Z");

// A pair that is genuinely on the shelf, as the base has it.
const sound = (extra = {}) => ({
  "Item ID": "KC-000039",
  "Product Name": "adidas Yeezy Boost 350 V2 Onyx",
  SKU: "HQ4540",
  Size: "42",
  Brand: "adidas",
  "VAT Type": "Margin",
  Type: "Direct",
  Source: "Regular",
  "Verification Status": "Verified",
  "Availability Status": "Available",
  "Purchase Price": 200,
  "Final Purchase Price": 200,
  "Minimum Selling Price": 225,
  "Ideal Selling Price": 235,
  "Purchase Date": "2026-06-04",
  ...extra
});

const codes = (fields) => flagsFor(fields, TODAY).map((flag) => flag.code);
const saying = (fields) => flagsFor(fields, TODAY).map((flag) => flag.say);

test("a pair on the shelf has nothing in the way of selling it", () => {
  assert.deepEqual(codes(sound()), []);
  assert.equal(sellable(sound(), TODAY), true);
});

test("a fulfilled order means the pair has gone, and says on which order", () => {
  const fields = sound({
    "Fulfillment Status (UOL)": ["Fulfilled"],
    "Shopify Order Number": ["11629"]
  });

  assert.deepEqual(codes(fields), ["shipped"]);
  assert.deepEqual(saying(fields), ["Already shipped on order 11629"]);
  assert.equal(sellable(fields, TODAY), false);
});

test("Store Fulfilled counts as gone too", () => {
  assert.deepEqual(codes(sound({ "Fulfillment Status (UOL)": ["Store Fulfilled"] })), ["shipped"]);
});

test("an order still on the way makes the pair allocated, not gone", () => {
  const fields = sound({
    "Fulfillment Status (UOL)": ["Ready to Ship"],
    "Shopify Order Number": ["13579"]
  });

  assert.deepEqual(codes(fields), ["allocated"]);
  assert.deepEqual(saying(fields), ["On open order 13579 (Ready to Ship)"]);
});

/*
 * A dead order hands the pair back, so the pair is free again. Without this
 * every unit whose order was cancelled would sit here for ever - and those
 * are exactly the pairs that end up as own stock.
 */
test("a cancelled order says nothing about the pair", () => {
  assert.deepEqual(codes(sound({ "Fulfillment Status (UOL)": ["Cancelled"] })), []);
  assert.deepEqual(codes(sound({ "Fulfillment Status (MWTB)": ["Expired"] })), []);
});

/*
 * Date Fulfilled is filled on orders that have not shipped at all - two of
 * the real ones carried it next to "Awaiting Label". So the status decides,
 * never the date.
 */
test("a delivery date on an open order does not make it shipped", () => {
  const fields = sound({
    "Fulfillment Status (UOL)": ["Awaiting Label"],
    "Shopify Order Number": ["13083"]
  });

  assert.deepEqual(codes(fields), ["allocated"]);
});

test("an external sale counts as gone", () => {
  const fields = sound({
    "Date Sold (External)": ["2026-05-02T10:00:00.000Z"],
    "External Order Number": ["ESL-000123"]
  });

  assert.deepEqual(codes(fields), ["shipped"]);
  assert.match(saying(fields)[0], /Sold externally on ESL-000123 \(2026-05-02\)/);
});

test("a member WTB behaves like a store order", () => {
  const fields = sound({ "Fulfillment Status (MWTB)": ["Fulfilled"], "Member WTB ID": ["MWTB-000412"] });

  assert.deepEqual(saying(fields), ["Already shipped on order MWTB-000412"]);
});

/*
 * The notes are typed by hand and mean too many different things to sort
 * into categories, so they are read out and hold the pair back until someone
 * has looked. Only a note that says the pair is where it should be is free.
 */
test("a condition note holds the pair back and is quoted as it stands", () => {
  const fields = sound({ "Item Condition": "Consigned At APLUG" });

  assert.deepEqual(codes(fields), ["note"]);
  assert.deepEqual(saying(fields), ["Condition says: Consigned At APLUG"]);
});

test("a note that only says the pair is here is not a problem", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "In our warehouse" })), []);
  assert.deepEqual(codes(sound({ "Item Condition": "our warehouse" })), []);
});

test("verification other than Verified or Consigned is flagged", () => {
  assert.deepEqual(codes(sound({ "Verification Status": "Cancelled" })), ["unverified"]);
  assert.deepEqual(codes(sound({ "Verification Status": "Consigned" })), []);
});

test("a pair without a SKU or size cannot be matched to a product", () => {
  assert.deepEqual(codes(sound({ SKU: "" })), ["no_sku"]);
  assert.deepEqual(codes(sound({ Size: "" })), ["no_size"]);
});

test("a floor at or below what the pair cost is flagged", () => {
  const fields = sound({ "Final Purchase Price": 149.99, "Minimum Selling Price": 127.5 });

  assert.deepEqual(codes(fields), ["no_margin"]);
  assert.match(saying(fields)[0], /127\.5 is not above the 149\.99/);
  assert.deepEqual(codes(sound({ "Minimum Selling Price": 0 })), ["no_margin"]);
  assert.deepEqual(codes(sound({ "Final Purchase Price": 0, "Purchase Price": 0 })), ["no_cost"]);
});

test("a year on the shelf is a note, not a reason to hold it back", () => {
  const fields = sound({ "Purchase Date": "2025-06-04" });

  assert.deepEqual(codes(fields), ["stale"]);
  assert.equal(flagsFor(fields, TODAY)[0].blocking, false);
  assert.equal(sellable(fields, TODAY), true);
  assert.match(saying(fields)[0], /^On the shelf for \d+ days$/);
});

test("several things wrong are all named", () => {
  const fields = sound({
    "Fulfillment Status (UOL)": ["Fulfilled"],
    "Item Condition": "Returned, is at APLUG",
    "Purchase Date": "2025-08-01"
  });

  assert.deepEqual(codes(fields), ["shipped", "note", "stale"]);
});

test("the row carries what the screen shows", () => {
  const row = unitRow({ id: "rec1234567890abcd", fields: sound() }, TODAY);

  assert.equal(row.item_id, "KC-000039");
  assert.equal(row.sku, "HQ4540");
  assert.equal(row.cost, 200);
  assert.equal(row.floor, 225);
  assert.equal(row.days, 119);
  assert.equal(row.sellable, true);
});

function fakeAirtable(records) {
  const asked = [];

  return {
    asked,
    airtable: {
      async select(table, options) {
        asked.push({ table, formula: options.formula });
        return { records, offset: "" };
      }
    }
  };
}

test("only our own pairs are asked for, and only the available ones", async () => {
  const base = fakeAirtable([]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  await store.list();

  const formula = base.asked[0].formula;

  assert.match(formula, /\{Availability Status\} = 'Available'/);
  for (const type of OWNED_TYPES) assert.ok(formula.includes(`{Type} = '${type}'`), `${type} missing`);
  assert.ok(!formula.includes("Partner Consignment"), "partner stock is not ours to sell");
});

test("the views split the list into work to do and stock to sell", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-003758", "Fulfillment Status (UOL)": ["Fulfilled"] }) },
    { id: "rec00000000000003", fields: sound({ "Item ID": "KC-000986", "Purchase Date": "2024-01-01" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  const all = await store.list({ view: "all" });

  assert.deepEqual(all.counts, { all: 3, clean: 2, flagged: 1, stale: 1 });

  // Worst first: this list is a to-do list.
  assert.equal(all.units[0].item_id, "OUT-003758");

  const flagged = await store.list({ view: "flagged" });
  assert.deepEqual(flagged.units.map((u) => u.item_id), ["OUT-003758"]);

  const clean = await store.list({ view: "clean" });
  assert.deepEqual(clean.units.map((u) => u.item_id).sort(), ["KC-000039", "KC-000986"]);
  assert.equal(clean.totals.cost, 400);

  const stale = await store.list({ view: "stale" });
  assert.deepEqual(stale.units.map((u) => u.item_id), ["KC-000986"]);

  assert.deepEqual((await store.count()), { clean: 2, flagged: 1 });
});

test("a search looks through the item number, SKU, product and size", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-003758", SKU: "5950-DGRY", "Product Name": "UGG Tasman Slipper", Size: "43" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  assert.deepEqual((await store.list({ view: "all", q: "ugg" })).units.map((u) => u.sku), ["5950-DGRY"]);
  assert.deepEqual((await store.list({ view: "all", q: "hq4540" })).units.map((u) => u.sku), ["HQ4540"]);
  assert.deepEqual((await store.list({ view: "all", q: "OUT-003758" })).units.map((u) => u.sku), ["5950-DGRY"]);
  assert.deepEqual((await store.list({ view: "all", q: "43" })).units.map((u) => u.sku), ["5950-DGRY"]);

  // The counts stay the whole picture, so the tabs do not move while searching.
  assert.deepEqual((await store.list({ view: "all", q: "ugg" })).counts.all, 2);
});

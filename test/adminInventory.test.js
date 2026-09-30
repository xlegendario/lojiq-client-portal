import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECKS,
  OWNED_TYPES,
  checksFor,
  createInventoryStore,
  locationOf,
  unitRow
} from "../admin/adminInventory.js";

const TODAY = new Date("2026-09-30T12:00:00.000Z");

// A unit that is genuinely on the shelf, as the base has it.
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

const codes = (fields) => checksFor(fields, TODAY).map((check) => check.code);
const saying = (fields) => checksFor(fields, TODAY).map((check) => check.say);

test("a unit whose fields agree has nothing to check", () => {
  assert.deepEqual(codes(sound()), []);
});

test("every check names a field to put right", () => {
  for (const [code, check] of Object.entries(CHECKS)) {
    assert.ok(check.label, `${code} has no label`);
    assert.ok(check.todo, `${code} does not say what to do`);
  }
});

/* ---------------- gone, still counted ---------------- */

test("a fulfilled order against a unit that is not Sold is the big check", () => {
  const fields = sound({
    "Availability Status": "Reserved",
    "Fulfillment Status (UOL)": ["Fulfilled"],
    "Shopify Order Number": ["11629"]
  });

  assert.deepEqual(codes(fields), ["shipped"]);
  assert.deepEqual(saying(fields), ["Shipped on order 11629, but the unit says Reserved"]);
  assert.equal(checksFor(fields, TODAY)[0].todo, "Set Availability Status to Sold");
});

test("Store Fulfilled counts as gone too", () => {
  assert.deepEqual(codes(sound({ "Fulfillment Status (UOL)": ["Store Fulfilled"] })), ["shipped"]);
});

test("a unit already on Sold is not checked against its own order", () => {
  const fields = sound({ "Availability Status": "Sold", "Fulfillment Status (UOL)": ["Fulfilled"] });

  assert.deepEqual(codes(fields), []);
});

test("an external sale counts as gone", () => {
  const fields = sound({
    "Date Sold (External)": ["2026-05-02T10:00:00.000Z"],
    "External Order Number": ["EORD-000177"]
  });

  assert.deepEqual(codes(fields), ["shipped"]);
  assert.match(saying(fields)[0], /Sold externally on EORD-000177 \(2026-05-02\), but the unit says Available/);
});

/*
 * Date Fulfilled is filled on orders that have not shipped at all - two of
 * the real ones carried it next to "Awaiting Label". So the status decides,
 * never the date, and an open order is no disagreement at all.
 */
test("an order still on the way is not a disagreement", () => {
  assert.deepEqual(codes(sound({ "Availability Status": "Reserved", "Fulfillment Status (UOL)": ["Awaiting Label"] })), []);
});

/*
 * A dead order hands the unit back, so the unit is free again. Without this
 * every unit whose order was cancelled would sit here for ever - and those
 * are exactly the units that end up as own stock.
 */
test("a cancelled order says nothing about the unit", () => {
  assert.deepEqual(codes(sound({ "Fulfillment Status (UOL)": ["Cancelled"] })), []);
  assert.deepEqual(codes(sound({ "Fulfillment Status (MWTB)": ["Expired"] })), []);
});

/* ---------------- never arrived ---------------- */

test("a note that says no shoe ever came, against a verified unit", () => {
  const fields = sound({ "Item Condition": "Seller did not ship" });

  assert.deepEqual(codes(fields), ["never_arrived"]);
  assert.equal(checksFor(fields, TODAY)[0].todo, "Set Verification Status to Cancelled or Lost");
});

test("the many ways people wrote down that a purchase fell through", () => {
  for (const note of [
    "Seller did not ship", "never shipped", "seller not shipped", "Seller Didnt Ship",
    "Jimmy never ordered", "NOT ORDERED", "never ordered ORD-009622", "Seller didnt order",
    "Never asked label", "never asked label", "Not yet label dripdrop",
    "Cancelled need refund", "REFUNDED", "GOAT Cancelled", "Order Cancelled",
    "Lost somehow?", "lost in transit", "Unnavailable", "too late", "Flaked? Not Ordered?"
  ]) {
    assert.deepEqual(codes(sound({ "Item Condition": note })), ["never_arrived"], `missed: ${note}`);
  }
});

/*
 * Matched on the negation, not on the verb. "Nando shipped" means a pair
 * that did go out; reading it as "never shipped" would write off stock we
 * actually have.
 */
test("a note about a pair that did ship is not read as one that did not", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "Nando shipped" })), ["note"]);
  assert.deepEqual(codes(sound({ "Item Condition": "Store fulfilled" })), ["note"]);
});

test("once it is written off, the note is no longer a disagreement", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "Seller did not ship", "Availability Status": "Inactive", "Verification Status": "Cancelled" })), []);
});

test("written off but still counted as stock is the other half of the same fix", () => {
  const fields = sound({ "Verification Status": "Cancelled" });

  assert.deepEqual(codes(fields), ["written_off"]);
  assert.deepEqual(saying(fields), ["Verification is Cancelled, but the unit says Available"]);
  assert.equal(checksFor(fields, TODAY)[0].todo, "Set Availability Status to Inactive");
});

/* ---------------- the rest ---------------- */

test("Reserved is meant to mean 'on an order'", () => {
  assert.deepEqual(codes(sound({ "Availability Status": "Reserved" })), ["reserved_no_order"]);
  assert.deepEqual(codes(sound({ "Availability Status": "Reserved", "Fulfillment Status (UOL)": ["Ready to Ship"] })), []);
});

test("a unit with no availability status at all is invisible everywhere", () => {
  const fields = sound({ "Availability Status": "" });

  assert.deepEqual(codes(fields), ["no_status"]);
});

test("damage is a separate call from never having arrived", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "discolored suede" })), ["flawed"]);
  assert.deepEqual(codes(sound({ "Item Condition": "Box Damage" })), ["flawed"]);
  assert.deepEqual(codes(sound({ "Item Condition": "2 left feet" })), ["flawed"]);
  assert.deepEqual(codes(sound({ "Item Condition": "failed authentication" })), ["flawed"]);
});

test("a note nobody has read is shown as it stands, never interpreted", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "Monday Gift" })), ["note"]);
  assert.deepEqual(saying(sound({ "Item Condition": "Monday Gift" })), ['"Monday Gift"']);
});

test("a note that only says the unit is here is not a problem", () => {
  assert.deepEqual(codes(sound({ "Item Condition": "In our warehouse" })), []);
  assert.deepEqual(codes(sound({ "Item Condition": "our warehouse" })), []);
});

test("a floor at or below what the unit cost is checked, but only while we could sell it", () => {
  const fields = sound({ "Final Purchase Price": 149.99, "Minimum Selling Price": 127.5 });

  assert.deepEqual(codes(fields), ["no_margin"]);
  assert.match(saying(fields)[0], /Floor 127\.5 is not above the 149\.99 it cost/);

  // A unit that is gone or written off is nobody's pricing problem.
  assert.deepEqual(codes({ ...fields, "Availability Status": "Inactive" }), []);
});

test("a year standing still is worth saying, and does not block", () => {
  const fields = sound({ "Purchase Date": "2025-06-04" });

  assert.deepEqual(codes(fields), ["stale"]);
  assert.equal(checksFor(fields, TODAY)[0].blocking, false);
  assert.match(saying(fields)[0], /^Bought \d+ days ago and still here$/);
});

test("several disagreements are all named", () => {
  const fields = sound({
    "Availability Status": "Reserved",
    "Fulfillment Status (UOL)": ["Fulfilled"],
    "Item Condition": "Returned, is at APLUG",
    "Purchase Date": "2025-08-01"
  });

  assert.deepEqual(codes(fields), ["shipped", "note", "stale"]);
});

/* ---------------- where it lies ---------------- */

test("an empty Location means our own warehouse, so nothing had to be backfilled", () => {
  assert.equal(locationOf(sound()), "Our warehouse");
  assert.equal(locationOf(sound({ Location: "APLUG.PL" })), "APLUG.PL");

  assert.equal(unitRow({ id: "rec00000000000001", fields: sound() }, TODAY).elsewhere, false);
  assert.equal(unitRow({ id: "rec00000000000001", fields: sound({ Location: "APLUG.PL" }) }, TODAY).elsewhere, true);
});

test("lying at a store is a place, not a problem", () => {
  assert.deepEqual(codes(sound({ Location: "Mentastore V.O.F." })), []);
});

test("the row carries what the screen shows, and a way back to the record", () => {
  const row = unitRow({ id: "rec1234567890abcd", fields: sound() }, TODAY, "appHoMBqKDPnVfWJY");

  assert.equal(row.item_id, "KC-000039");
  assert.equal(row.cost, 200);
  assert.equal(row.floor, 225);
  assert.equal(row.days, 119);
  assert.equal(row.sellable, true);
  assert.equal(row.airtable, "https://airtable.com/appHoMBqKDPnVfWJY/tblt1aavfuJgspt8x/rec1234567890abcd");
});

/* ---------------- the store ---------------- */

function fakeAirtable(records) {
  const asked = [];

  return {
    asked,
    airtable: {
      async select(table, options) {
        asked.push({ table, formula: options.formula, sort: options.sort });
        // Careful: "!= 'Sold'" contains "= 'Sold'".
        const sold = /[^!]= 'Sold'/.test(options.formula);
        return {
          records: records.filter((record) => (text(record.fields["Availability Status"]) === "Sold") === sold),
          offset: ""
        };
      }
    }
  };
}

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

test("only our own units are asked for, and Sold is kept out of the working set", async () => {
  const base = fakeAirtable([]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  await store.list({ view: "all" });

  const formula = base.asked[0].formula;

  assert.match(formula, /\{Availability Status\} != 'Sold'/);
  for (const type of OWNED_TYPES) assert.ok(formula.includes(`{Type} = '${type}'`), `${type} missing`);
  assert.ok(!formula.includes("Partner Consignment"), "partner stock is not ours to sell");
});

test("the views split the list by what the unit is", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-1", "Availability Status": "Reserved", "Fulfillment Status (UOL)": ["Fulfilled"] }) },
    { id: "rec00000000000003", fields: sound({ "Item ID": "OUT-2", Location: "APLUG.PL" }) },
    { id: "rec00000000000004", fields: sound({ "Item ID": "OUT-3", "Availability Status": "" }) },
    { id: "rec00000000000005", fields: sound({ "Item ID": "OUT-4", "Availability Status": "Inactive" }) },
    { id: "rec00000000000006", fields: sound({ "Item ID": "OUT-5", "Availability Status": "Sold" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });
  const all = await store.list({ view: "all" });

  assert.equal(all.counts.all, 5, "Sold is not in the working set");
  assert.equal(all.counts.in_stock, 2);
  assert.equal(all.counts.reserved, 1);
  assert.equal(all.counts.elsewhere, 1);
  assert.equal(all.counts.no_status, 1);
  assert.equal(all.counts.inactive, 1);
  assert.equal(all.counts.checks, 2);

  assert.deepEqual((await store.list({ view: "elsewhere" })).units.map((u) => u.item_id), ["OUT-2"]);
  assert.deepEqual((await store.list({ view: "no_status" })).units.map((u) => u.item_id), ["OUT-3"]);
  assert.deepEqual((await store.list({ view: "in_stock" })).units.map((u) => u.item_id).sort(), ["KC-000039", "OUT-2"]);
});

test("the checks come back grouped, with what each group is worth", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-1", "Availability Status": "Reserved", "Fulfillment Status (UOL)": ["Fulfilled"], "Final Purchase Price": 100 }) },
    { id: "rec00000000000003", fields: sound({ "Item ID": "OUT-2", "Availability Status": "Reserved", "Fulfillment Status (UOL)": ["Fulfilled"], "Final Purchase Price": 50 }) },
    { id: "rec00000000000004", fields: sound({ "Item ID": "OUT-3", "Availability Status": "" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });
  const checks = await store.list({ view: "checks" });

  const shipped = checks.groups.find((group) => group.code === "shipped");

  assert.equal(shipped.units, 2);
  assert.equal(shipped.value, 150);
  assert.equal(shipped.todo, "Set Availability Status to Sold");

  assert.equal(checks.groups.find((group) => group.code === "no_status").units, 1);
  assert.equal(checks.units.length, 3);

  // One group at a time, to work a kind of disagreement off in one go.
  const only = await store.list({ view: "checks", check: "no_status" });
  assert.deepEqual(only.units.map((u) => u.item_id), ["OUT-3"]);
  assert.equal(only.groups.length, checks.groups.length, "the groups stay the whole picture");
});

test("Sold is fetched on its own terms, newest first", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-5", "Availability Status": "Sold" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });
  const out = await store.list({ view: "sold" });

  assert.deepEqual(out.units.map((u) => u.item_id), ["OUT-5"]);
  assert.equal(out.totals.partial, true, "without a search it is only the newest page");

  const sorted = base.asked.find((call) => /[^!]= 'Sold'/.test(call.formula));
  assert.equal(sorted.sort, "Purchase Date");

  // The tab counts still come from the working set, which has no Sold in it.
  assert.equal(out.counts.in_stock, 1);

  const found = await store.list({ view: "sold", q: "OUT-5" });
  assert.equal(found.totals.partial, false);
  assert.match(base.asked.at(-1).formula, /FIND\('OUT-5'/);
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
  assert.equal((await store.list({ view: "all", q: "ugg" })).counts.all, 2);
});

test("the working set is read once and held, because every view is cut from it", async () => {
  const base = fakeAirtable([{ id: "rec00000000000001", fields: sound() }]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  await store.list({ view: "in_stock" });
  await store.list({ view: "checks" });
  await store.count();

  assert.equal(base.asked.length, 1, "three views, one read");
});

test("the sidebar count is the number of units whose fields disagree", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "OUT-1", "Availability Status": "" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  assert.deepEqual(await store.count(), { checks: 1, in_stock: 1 });
});

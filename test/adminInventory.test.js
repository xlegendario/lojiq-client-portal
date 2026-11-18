import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECKS,
  EXCLUDED_TYPES,
  kindOf,
  checksFor,
  createInventoryStore,
  locationOf,
  readSaleChange,
  saleOf,
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

/* ---------------- how it arrived ---------------- */

/*
 * Named the way Airtable names the Item ID - Source before Type, same order -
 * so the column can never contradict the number sitting next to it.
 */
test("how a pair arrived is read off Source first, then Type", () => {
  assert.equal(kindOf({ Type: "Direct", Source: "Regular" }), "Direct");
  assert.equal(kindOf({ Type: "Custom", Source: "Outsourced" }), "Outsourced");
  assert.equal(kindOf({ Type: "Consignment", Source: "Regular" }), "Consignment");
  assert.equal(kindOf({ Type: "Partner Consignment", Source: "Regular" }), "Partner");
  assert.equal(kindOf({ Type: "Return Service", Source: "Returned" }), "Return");
});

/*
 * The 87 units that are Type Direct with Source Outsourced. They carry an
 * OUT- number because the Item ID formula asks Source first, so the column
 * has to say Outsourced or it would argue with the number beside it.
 */
test("a unit bought to fill an order reads as outsourced whatever its type says", () => {
  assert.equal(kindOf({ Type: "Direct", Source: "Outsourced" }), "Outsourced");
});

/*
 * Except where Airtable would not give it an OUT- number either: consignment
 * and returns are decided before Source in that formula.
 */
test("consignment and returns are decided before Source, here too", () => {
  assert.equal(kindOf({ Type: "Consignment", Source: "Outsourced" }), "Consignment");
  assert.equal(kindOf({ Type: "Return Service", Source: "Outsourced" }), "Return");
});

test("a unit with nothing filled in says so", () => {
  assert.equal(kindOf({}), "no type");
  assert.equal(kindOf({ Type: "", Source: "Regular" }), "no type");
});

test("the row carries the name the screen shows", () => {
  const row = unitRow({ id: "rec00000000000001", fields: sound({ Type: "Custom", Source: "Outsourced" }) }, TODAY);

  assert.equal(row.type, "Custom", "Airtable's own value is kept");
  assert.equal(row.kind, "Outsourced", "and this is what the screen says");
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

/*
 * Asked for as "not Forwarding" rather than as a list of what is ours.
 *
 * A unit exists only because there was a deal, so every type but Forwarding
 * became ours at some point - and naming the ones we want would have dropped
 * the units whose type nobody has filled in, which are exactly the ones worth
 * finding.
 */
test("everything but Forwarding is asked for, and Sold is kept out of the working set", async () => {
  const base = fakeAirtable([]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  await store.list({ view: "all" });

  const formula = base.asked[0].formula;

  assert.match(formula, /\{Availability Status\} != 'Sold'/);
  assert.deepEqual(EXCLUDED_TYPES, ["Forwarding"]);
  assert.ok(formula.includes("{Type} != 'Forwarding'"), "forwarding is not ours");

  for (const type of ["Direct", "Custom", "Return Service", "Consignment", "Partner Consignment"]) {
    assert.ok(!formula.includes(`'${type}'`), `${type} should not be named at all`);
  }
});

test("consignment and partner units belong here, a unit without a type is kept", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound({ "Item ID": "CS-000982", Type: "Consignment" }) },
    { id: "rec00000000000002", fields: sound({ "Item ID": "PCS-008021", Type: "Partner Consignment" }) },
    { id: "rec00000000000003", fields: sound({ "Item ID": "KC-003707", Type: "" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });
  const all = await store.list({ view: "all" });

  assert.equal(all.counts.all, 3);
  assert.deepEqual(
    all.units.map((u) => u.item_id).sort(),
    ["CS-000982", "KC-003707", "PCS-008021"]
  );

  // Its own kind shows on the row, because it says how the pair arrived.
  assert.equal(all.units.find((u) => u.item_id === "CS-000982").type, "Consignment");
  assert.equal(all.units.find((u) => u.item_id === "KC-003707").type, "");
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

/*
 * Only the checks list says what is wrong, so only the checks list is
 * ordered by it. Elsewhere the awkward units used to sit on top with no
 * reason beside them, which reads as an arbitrary order.
 */
test("checks lead with the worst, the other views with the longest standing", async () => {
  const base = fakeAirtable([
    { id: "rec00000000000001", fields: sound({ "Item ID": "OUDSTE", "Purchase Date": "2024-01-01" }) },
    { id: "rec00000000000002", fields: sound({ "Item ID": "NIEUWSTE", "Purchase Date": "2026-09-01" }) },
    { id: "rec00000000000003", fields: sound({ "Item ID": "KAPOT", "Purchase Date": "2026-08-01", "Item Condition": "Box Damage" }) }
  ]);

  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  assert.deepEqual(
    (await store.list({ view: "in_stock" })).units.map((u) => u.item_id),
    ["OUDSTE", "KAPOT", "NIEUWSTE"],
    "longest standing first"
  );

  assert.equal((await store.list({ view: "checks" })).units[0].item_id, "KAPOT", "worst first");

  // Picking a group keeps the to-do order, whichever view it came from.
  assert.equal((await store.list({ view: "all", check: "stale" })).units[0].item_id, "OUDSTE");
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

/* ---------------- on sale ---------------- */

test("a pair is listed when ticked, Available, not Forwarding and not past its end date", () => {
  const on = { "Dump Listing?": true };

  assert.equal(saleOf(sound(on), TODAY).listed, true);
  assert.equal(saleOf(sound(), TODAY).listed, false, "not ticked");
  assert.equal(saleOf(sound({ ...on, "Availability Status": "Reserved" }), TODAY).listed, false);
  assert.equal(saleOf(sound({ ...on, Type: "Forwarding" }), TODAY).listed, false);
  assert.equal(saleOf(sound({ ...on, "Dump Until": "2026-09-30" }), TODAY).listed, true, "the last day still counts");
  assert.equal(saleOf(sound({ ...on, "Dump Until": "2026-09-29" }), TODAY).listed, false);
  assert.equal(saleOf(sound({ ...on, "Dump Until": "2026-09-29" }), TODAY).ended, true);
});

test("the ask is the sale price, or the ideal price when there is none", () => {
  assert.equal(saleOf(sound({ "Custom Selling Price": 210 }), TODAY).ask, 210);
  assert.equal(saleOf(sound(), TODAY).ask, 235);
  assert.equal(saleOf(sound({ "Custom Selling Price": 0 }), TODAY).ask, 235);
});

test("a sale price under what the pair cost is flagged, not refused", () => {
  assert.equal(saleOf(sound({ "Custom Selling Price": 180 }), TODAY).below_cost, true);
  assert.equal(saleOf(sound({ "Custom Selling Price": 200 }), TODAY).below_cost, false);
  assert.equal(saleOf(sound(), TODAY).below_cost, false);
  assert.deepEqual(readSaleChange({ price: 180 }), { "Custom Selling Price": 180 });
});

test("the change is read strictly: positive price or empty, a real date or empty", () => {
  assert.deepEqual(readSaleChange({ on: true }), { "Dump Listing?": true });
  assert.deepEqual(readSaleChange({ price: "199,5" }), { "Custom Selling Price": 199.5 });
  assert.deepEqual(readSaleChange({ price: "" }), { "Custom Selling Price": null });
  assert.deepEqual(readSaleChange({ until: "2026-11-30" }), { "Dump Until": "2026-11-30" });
  assert.deepEqual(readSaleChange({ until: null }), { "Dump Until": null });

  for (const bad of [{ price: 0 }, { price: -5 }, { price: "abc" }, { until: "30-11-2026" }, { until: "2026-02-30" }, { on: "yes" }, {}]) {
    assert.throws(() => readSaleChange(bad), undefined, JSON.stringify(bad));
  }
});

function saleAirtable(records) {
  const updates = [];

  return {
    updates,
    airtable: {
      async select(table, options) {
        const id = /RECORD_ID\(\) = '(rec\w+)'/.exec(options.formula)?.[1];
        if (id) return { records: records.filter((record) => record.id === id), offset: "" };
        return { records: records.filter((record) => text(record.fields["Availability Status"]) !== "Sold"), offset: "" };
      },
      async update(table, id, fields) {
        updates.push({ table, id, fields });
        return { id, fields };
      }
    }
  };
}

test("putting a pair on sale writes the three fields and moves the counter", async () => {
  const base = saleAirtable([
    { id: "rec00000000000001", fields: sound() },
    { id: "rec00000000000002", fields: sound({ "Item ID": "KC-2", "Dump Listing?": true, "Custom Selling Price": 300 }) }
  ]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  const before = await store.list({ view: "on_sale" });
  assert.deepEqual(before.sale, { units: 1, value: 300 });
  assert.deepEqual(before.units.map((u) => u.item_id), ["KC-2"]);

  const out = await store.setSale("rec00000000000001", { on: true, price: "250", until: "" });

  assert.deepEqual(base.updates, [{
    table: "Inventory Units",
    id: "rec00000000000001",
    fields: { "Dump Listing?": true, "Custom Selling Price": 250, "Dump Until": null }
  }]);
  assert.equal(out.unit.sale.listed, true);
  assert.deepEqual(out.sale, { units: 2, value: 550 });

  const after = await store.list({ view: "on_sale" });
  assert.equal(after.counts.on_sale, 2);
});

test("only an Available pair of ours can go on sale", async () => {
  const base = saleAirtable([
    { id: "rec00000000000001", fields: sound({ "Availability Status": "Reserved" }) },
    { id: "rec00000000000002", fields: sound({ Type: "Forwarding" }) }
  ]);
  const store = createInventoryStore({ airtable: base.airtable, now: () => TODAY });

  await assert.rejects(store.setSale("rec00000000000001", { on: true }), /Only an Available unit/);
  await assert.rejects(store.setSale("rec00000000000002", { on: true }), /Forwarding/);
  await assert.rejects(store.setSale("not-a-record", { on: true }), /Unknown unit/);
  assert.equal(base.updates.length, 0);
});

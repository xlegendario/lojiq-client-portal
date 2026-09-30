// admin/adminInventory.js
//
// Inventory: the pairs we own ourselves (30-09-2026).
//
// Everything on the marketplaces comes out of consignment_inventory, which
// holds other people's pairs. Our own stock lives only in Airtable's
// Inventory Units, so it is listed nowhere - and a pair of ours that happens
// to match a consignor's SKU and size even gets repriced to the consignor's
// price.
//
// Before any of it can be listed, "Availability Status = Available" has to be
// worth believing. On the day this was written it was not: of 157 own pairs
// marked Available, 16 had already gone out on a fulfilled order, 3 sat on an
// open one, and 11 carried a note saying they were at another store or
// damaged. Listing that lot would have been thirty orders we could not fill.
//
// So this screen does not just list the stock. Per pair it says what is wrong
// with it, and a pair is only sellable once nothing is. There is no state
// here to keep in step: the flags are read off Airtable every time, so a pair
// corrected there stops being flagged by itself.

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const many = (value) => (Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value]);
const first = (value) => text(many(value)[0]);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/*
 * The types that mean the pair is ours.
 *
 * We paid for it and it is ours to sell: Direct is bought outright, Custom is
 * sourced for an order and left over when that order went another way, and
 * Return Service is a pair we took over from the customer who returned it.
 *
 * Consignment and Partner Consignment belong to whoever sent them and are on
 * the marketplaces already; Forwarding is only passing through on its way to
 * someone else.
 */
export const OWNED_TYPES = ["Direct", "Custom", "Return Service"];

// An order in one of these took the pair with it when it shipped.
const SHIPPED = new Set(["Fulfilled", "Store Fulfilled"]);

// A dead order hands the pair back, so it says nothing about availability.
const DEAD = new Set(["Cancelled", "Expired"]);

// Verification the pair actually arrived and is ours. "Consigned" is what a
// Return Service pair gets once we have taken it over.
const SOUND = new Set(["Verified", "Consigned"]);

// A note that only confirms the pair is where it should be is not a problem.
const REASSURING = /^\s*(in\s+)?our\s+warehouse\s*$/i;

// Long enough on the shelf to be worth a look, not long enough to be wrong.
export const STALE_DAYS = 365;

export class InventoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const INVENTORY_FIELDS = [
  "Item ID", "Product Name", "SKU", "Size", "Brand", "VAT Type",
  "Purchase Price", "Final Purchase Price", "Purchase Date",
  "Type", "Source", "Verification Status", "Availability Status",
  "Margin %", "Base Costs", "Ideal Selling Price", "Minimum Selling Price",
  "Selling Price", "Selling Method", "Item Condition", "Issue Status",
  "Fulfillment Status (UOL)", "Shopify Order Number",
  "Fulfillment Status (MWTB)", "Member WTB ID",
  "Date Sold (External)", "External Order Number",
  "Product GTIN", "Picture"
];

function daysSince(value, today) {
  const when = Date.parse(text(value));
  if (!Number.isFinite(when)) return null;
  return Math.round((today.getTime() - when) / 86_400_000);
}

/*
 * What is wrong with this pair, in the words the screen shows.
 *
 * A blocking flag means the pair may not be listed: either it is not here, or
 * we cannot tell where it is. A flag that does not block is a note - worth
 * reading, no reason to hold the pair back.
 */
export function flagsFor(fields = {}, today = new Date()) {
  const flags = [];
  const add = (code, blocking, say) => flags.push({ code, blocking, say });

  const orders = [
    ...many(fields["Fulfillment Status (UOL)"]).map((status) => ({ status: text(status), ref: first(fields["Shopify Order Number"]) })),
    ...many(fields["Fulfillment Status (MWTB)"]).map((status) => ({ status: text(status), ref: first(fields["Member WTB ID"]) }))
  ].filter((order) => order.status && !DEAD.has(order.status));

  const gone = orders.filter((order) => SHIPPED.has(order.status));
  const open = orders.filter((order) => !SHIPPED.has(order.status));

  /*
   * Shipped is the one that costs money.
   *
   * Sixteen pairs stood here having left the warehouse months ago, the oldest
   * in August 2025. Their order says Fulfilled and carries the buyer's order
   * number; only Availability Status was never moved off Available.
   */
  for (const order of gone) {
    add("shipped", true, `Already shipped${order.ref ? ` on order ${order.ref}` : ""}`);
  }

  // Promised to a buyer who is still waiting for it, so not ours to offer.
  for (const order of open) {
    add("allocated", true, `On open order${order.ref ? ` ${order.ref}` : ""} (${order.status})`);
  }

  const sold = first(fields["Date Sold (External)"]);

  if (sold && !gone.length) {
    add("shipped", true, `Sold externally${first(fields["External Order Number"]) ? ` on ${first(fields["External Order Number"])}` : ""} (${sold.slice(0, 10)})`);
  }

  /*
   * The condition note, read out rather than interpreted.
   *
   * These are typed by hand and say things like "at APLUG", "paid store",
   * "NEED RETURN", "discolored suede" and "Nando shipped". Sorting that into
   * categories would mean guessing, and a wrong guess here either hides a
   * pair that is fine or lists one that is at another store. So the note is
   * shown as it stands and holds the pair back until someone has read it.
   */
  const condition = text(fields["Item Condition"]);

  if (condition && !REASSURING.test(condition)) {
    add("note", true, `Condition says: ${condition}`);
  }

  const verification = text(fields["Verification Status"]);

  if (verification && !SOUND.has(verification)) {
    add("unverified", true, `Verification is ${verification}`);
  }

  if (text(fields["Issue Status"]) === "Troubled") add("troubled", true, "Marked as troubled");

  if (!text(fields.SKU)) add("no_sku", true, "No SKU, so it cannot be matched to a product");
  if (!text(fields.Size)) add("no_size", true, "No size");

  const cost = Number(fields["Final Purchase Price"]);
  const floor = Number(fields["Minimum Selling Price"]);

  if (!(cost > 0)) {
    add("no_cost", true, "No purchase price, so there is no floor to price against");
  } else if (!(floor > cost)) {
    add("no_margin", true, floor > 0
      ? `Minimum selling price ${round2(floor)} is not above the ${round2(cost)} it cost`
      : "No minimum selling price");
  }

  const age = daysSince(fields["Purchase Date"], today);

  if (age !== null && age > STALE_DAYS) add("stale", false, `On the shelf for ${age} days`);

  return flags;
}

export function sellable(fields = {}, today = new Date()) {
  return !flagsFor(fields, today).some((flag) => flag.blocking);
}

// The pair as the list shows it.
export function unitRow(record, today = new Date()) {
  const fields = record.fields || {};
  const flags = flagsFor(fields, today);

  return {
    id: record.id,
    item_id: text(fields["Item ID"]),
    product_name: text(fields["Product Name"]),
    sku: text(fields.SKU),
    size: text(fields.Size),
    brand: text(fields.Brand),
    type: text(fields.Type),
    source: text(fields.Source),
    vat_type: text(fields["VAT Type"]),
    cost: round2(fields["Final Purchase Price"]),
    purchase_price: round2(fields["Purchase Price"]),
    floor: round2(fields["Minimum Selling Price"]),
    ideal: round2(fields["Ideal Selling Price"]),
    margin: text(fields["Margin %"]),
    purchase_date: first(fields["Purchase Date"]) || null,
    days: daysSince(fields["Purchase Date"], today),
    verification: text(fields["Verification Status"]),
    condition: text(fields["Item Condition"]),
    picture: text(many(fields.Picture)[0]?.url || many(fields.Picture)[0] || ""),
    flags,
    sellable: !flags.some((flag) => flag.blocking)
  };
}

// Which pairs a view wants. "clean" is the list we could put on a marketplace
// tomorrow; "flagged" is the work to do before that list grows.
export const VIEWS = {
  clean: (row) => row.sellable,
  flagged: (row) => !row.sellable,
  stale: (row) => row.flags.some((flag) => flag.code === "stale"),
  all: () => true
};

/*
 * deps:
 *   airtable  select (main base) - Inventory Units
 */
export function createInventoryStore({ airtable, now = () => new Date() }) {
  /*
   * Every own pair that Airtable calls Available.
   *
   * Filtered on Airtable's side, because Inventory Units holds 6.320 records
   * and all but about 157 of them are somebody else's pair or long gone. The
   * pages are read to the end: the whole point is a count that is complete,
   * and 157 records is two calls.
   */
  async function available({ formula = "" } = {}) {
    const mine = OWNED_TYPES.map((type) => `{Type} = '${type}'`).join(",");
    const where = `AND({Availability Status} = 'Available', OR(${mine})${formula ? `, ${formula}` : ""})`;
    const records = [];
    let offset = "";

    for (let page = 0; page < 20; page += 1) {
      const result = await airtable.select("Inventory Units", {
        fields: INVENTORY_FIELDS,
        formula: where,
        pageSize: 100,
        offset
      });

      records.push(...result.records);
      offset = result.offset;

      if (!offset) break;
    }

    return records;
  }

  async function rows() {
    const today = now();
    return (await available()).map((record) => unitRow(record, today));
  }

  async function list({ q = "", view = "all", limit = 500 } = {}) {
    const wanted = Math.min(Math.max(Number(limit) || 500, 10), 1000);
    const pick = VIEWS[text(view)] || VIEWS.all;
    const needle = text(q).toUpperCase();
    const all = await rows();

    const counts = {
      all: all.length,
      clean: all.filter(VIEWS.clean).length,
      flagged: all.filter(VIEWS.flagged).length,
      stale: all.filter(VIEWS.stale).length
    };

    let chosen = all.filter(pick);

    if (needle) {
      chosen = chosen.filter((row) =>
        row.sku.toUpperCase().includes(needle) ||
        row.item_id.toUpperCase().includes(needle) ||
        row.product_name.toUpperCase().includes(needle) ||
        row.size.toUpperCase() === needle);
    }

    /*
     * Worst first, because this list is a to-do list. Within that the oldest
     * pair leads: a pair that has stood here for two years is the one whose
     * story nobody remembers any more.
     */
    chosen.sort((a, b) =>
      Number(a.sellable) - Number(b.sellable) ||
      b.flags.length - a.flags.length ||
      (b.days ?? 0) - (a.days ?? 0));

    const shown = chosen.slice(0, wanted);

    return {
      units: shown,
      counts,
      totals: {
        units: chosen.length,
        shown: shown.length,
        cost: round2(chosen.reduce((sum, row) => sum + row.cost, 0)),
        floor: round2(chosen.reduce((sum, row) => sum + row.floor, 0))
      }
    };
  }

  // What the sidebar shows: the number of pairs still to be sorted out.
  async function count() {
    const all = await rows();

    return { clean: all.filter(VIEWS.clean).length, flagged: all.filter(VIEWS.flagged).length };
  }

  return { list, count, rows };
}

export function mountInventory(router, { store, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof InventoryError ? err.status : 500;
    if (status >= 500) console.error("[admin inventory]", err.message);
    res.status(status).json({ error: err instanceof InventoryError ? err.message : `Inventory failed: ${err.message}` });
  };

  router.get(["/admin/inventory", "/admin/inventory/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/inventory", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      res.json(await store.list({
        q: text(req.query.q),
        view: text(req.query.view) || "all",
        limit: req.query.limit
      }));
    } catch (err) {
      send(res, err);
    }
  });
}

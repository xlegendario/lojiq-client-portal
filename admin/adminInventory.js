// admin/adminInventory.js
//
// Inventory: everything that became ours on paper (30-09-2026).
//
// Everything on the marketplaces comes out of consignment_inventory, which
// holds pairs that are still the consignor's. Our own stock lives only in
// Airtable's Inventory Units, so it is listed nowhere - and a pair of ours
// that happens to match a consignor's SKU and size even gets repriced to the
// consignor's price.
//
// Before any of it can be listed, the statuses have to be worth believing,
// and on the day this was written they were not. Of the units that are not
// plainly Sold: some 700 had already shipped but were never moved off
// Reserved or Available, 136 had no availability status at all, 138 carried
// a note saying the pair never arrived, and 65 sat Reserved against no order.
// Together about 700 units with a status that contradicts what happened, and
// some 160 purchases that never became a shoe.
//
// So the screen has two jobs. The views say what we hold and where. The
// checks say where two fields disagree and which one to put right - a check
// is always a disagreement, never an opinion, so a unit drops off the list
// the moment the two agree again.
//
// Read-only on purpose. Correcting 700 units means a bulk write on a field
// several automations hang off, and that is its own job with its own
// homework.
//
// One exception (18-11-2026): the sale settings per pair. Own stock in Huizen
// is listed on every channel by default (the kc-own-stock job); three fields
// nothing else writes - Hold Back?, Custom Selling Price and Dump Until - keep
// a pair off, set its price, or end its listing.

import express from "express";
import fs from "fs";
import { facetsOf, filterRows, readRefine, sortRows } from "./stockRefine.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const many = (value) => (Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value]);
const first = (value) => text(many(value)[0]);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/*
 * Inventory is everything that became ours on paper.
 *
 * A unit only exists once there was a deal, so the type says how the pair
 * arrived, never who owns it now:
 *
 *   Direct              bought outright from a seller
 *   Custom              sourced to fill an order, and left over when that
 *                       order went another way
 *   Return Service      taken over from the customer who sent it back
 *   Consignment         bought from the consignor at the moment it sold, so
 *                       the unit IS the purchase - a pair still sitting with
 *                       a consignor has no unit at all, it lives in
 *                       consignment_inventory
 *   Partner Consignment taken over from the partner at intake, back when
 *                       that was the arrangement; still owed on some of them,
 *                       which is what Payment Status says
 *
 * Only Forwarding is not ours, and that is a fact rather than a reading:
 * none of its 683 units has a purchase price or a purchase date, because
 * nothing was ever bought. They pass through the warehouse on the way to
 * somebody else.
 *
 * A unit with no type at all is kept: it is a gap to fill, not a reason to
 * hide a pair.
 */
export const EXCLUDED_TYPES = ["Forwarding"];

export const AIRTABLE_TABLE_ID = "tblt1aavfuJgspt8x";

// An order in one of these took the pair with it when it shipped.
const SHIPPED = new Set(["Fulfilled", "Store Fulfilled"]);

// A dead order hands the pair back, so it says nothing about availability.
const DEAD = new Set(["Cancelled", "Expired"]);

// Verification that says the pair never became ours after all.
const WRITTEN_OFF = new Set(["Cancelled", "Rejected", "Lost"]);

// Statuses that claim the pair is still here to be sold or promised.
const CLAIMS_STOCK = new Set(["Available", "Reserved"]);

// Long enough on the shelf to be worth a look, not long enough to be wrong.
export const STALE_DAYS = 365;

/*
 * What the hand-typed condition notes turn out to mean.
 *
 * 223 of them across the units that are not Sold, and the great majority are
 * not about the shoe at all - they are about a purchase that fell through.
 * Matched on the negation rather than the verb, so "Nando shipped" does not
 * read as "never shipped".
 */
const NEVER_ARRIVED = /\b(did ?n[o']?t|didnt|never|not)\s+(ship|shipped|order|ordered|arrive|asked|label)|never\s+(ship|order|ask|really bought)|not ordered|never label|not yet label|flaked|cancel|refund|\blost\b|unnavailable|unavailable|too late/i;
const FLAWED = /damage|yellow|2 left|wrong sku|wrong size|bigger|discolor|flaw|authentication|need return/i;

// A note that only confirms the pair is where it should be is not a problem.
const REASSURING = /^\s*(in\s+)?our\s+warehouse\s*$/i;

/*
 * The checks, in the order the screen lists them.
 *
 * Every one is a disagreement between two things the base already knows, and
 * every one says which field to put right. That is what keeps the list from
 * growing opinions: if there is nothing to change, it is not a check.
 */
export const CHECKS = {
  shipped: {
    label: "Already gone, still counted as stock",
    todo: "Set Availability Status to Sold"
  },
  never_arrived: {
    label: "Never arrived, still counted as stock",
    todo: "Set Verification Status to Cancelled or Lost"
  },
  written_off: {
    label: "Written off, still counted as stock",
    todo: "Set Availability Status to Inactive"
  },
  reserved_no_order: {
    label: "Reserved against no order",
    todo: "Available if it is here, Sold if it went"
  },
  no_status: {
    label: "No availability status at all",
    todo: "Give it one - these are invisible everywhere"
  },
  flawed: {
    label: "Damaged or not as described",
    todo: "Your call: sell at a discount, return, or write off"
  },
  no_margin: {
    label: "Floor is not above what it cost",
    todo: "Check the margin and base costs on the unit"
  },
  note: {
    label: "Carries a note nobody has read",
    todo: "Read it and either act on it or clear it"
  },
  stale: {
    label: "Standing still for over a year",
    todo: "Nothing is wrong, but it is not moving either"
  }
};

// The checks that mean the unit may not be offered for sale.
const BLOCKING = new Set(["shipped", "never_arrived", "written_off", "no_status", "flawed", "no_margin", "note"]);

export class InventoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const INVENTORY_FIELDS = [
  "Item ID", "Product Name", "SKU", "Size", "Brand", "VAT Type",
  "Purchase Price", "Final Purchase Price", "Purchase Date",
  "Type", "Source", "Verification Status", "Availability Status", "Location",
  "Margin %", "Base Costs", "Ideal Selling Price", "Minimum Selling Price",
  "Selling Price", "Selling Method", "Item Condition", "Issue Status",
  "Fulfillment Status (UOL)", "Shopify Order Number",
  "Fulfillment Status (MWTB)", "Member WTB ID",
  "Date Sold (External)", "External Order Number",
  "Hold Back?", "Custom Selling Price", "Dump Until", "Cancel Status", "Picture"
];

/*
 * Listed: our own pair on every channel through consignment_inventory (the
 * kc-own-stock job in sneakerask-consignment keeps those rows). Since
 * 18-11-2026 that is the default for every pair in Huizen; Hold Back? keeps
 * one off. The rule below is the contract's, word for word - the job and
 * this screen must never disagree about whether a pair is out there.
 *
 * The ask is Custom Selling Price when it is above zero, otherwise the Ideal
 * Selling Price - in the unit's own VAT Type scale. A listed pair whose
 * Custom is under its Ideal is a deal: UNION shows it as a discount.
 */
export const SALE_FIELDS = { hold: "Hold Back?", price: "Custom Selling Price", until: "Dump Until" };

// Why a pair is not listed, in the order they are checked.
export const NOT_LISTED = {
  held_back: "held back",
  not_available: "not Available",
  forwarding: "Forwarding",
  elsewhere: "not in Huizen",
  past_dump_until: "past its Until date",
  already_shipped: "already shipped",
  verification: "verification cancelled, rejected or lost",
  written_off: "written off or lost",
  no_sku_or_size: "no SKU or size",
  no_vat_type: "no VAT type",
  no_price: "no price"
};

const SHIPPED_UOL = new Set(["Fulfilled", "Store Fulfilled"]);
const VERIFICATION_OFF = new Set(["Cancelled", "Rejected", "Lost"]);
const CANCEL_OFF = new Set(["Written Off", "Lost"]);

// Today as a date in Amsterdam, which is the day Dump Until is counted in.
export function localDay(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });
}

// A lookup arrives as a list, now and then as one joined string.
const values = (value) => many(value).flatMap((one) => text(one).split(",")).map((one) => one.trim()).filter(Boolean);

function notListedBecause(fields, { until, ask }, today) {
  const uol = values(fields["Fulfillment Status (UOL)"]);

  if (fields[SALE_FIELDS.hold] === true) return "held_back";
  if (text(fields["Availability Status"]) !== "Available") return "not_available";
  if (EXCLUDED_TYPES.includes(text(fields.Type))) return "forwarding";
  if (text(fields.Location)) return "elsewhere";
  if (until && until < localDay(today)) return "past_dump_until";
  if (uol.some((status) => SHIPPED_UOL.has(status)) && !uol.includes("Returned")) return "already_shipped";
  if (VERIFICATION_OFF.has(text(fields["Verification Status"]))) return "verification";
  if (CANCEL_OFF.has(first(fields["Cancel Status"]))) return "written_off";
  if (!text(fields.SKU) || !text(fields.Size)) return "no_sku_or_size";
  if (!first(fields["VAT Type"])) return "no_vat_type";
  if (!(ask > 0)) return "no_price";
  return "";
}

export function saleOf(fields = {}, today = new Date()) {
  const custom = Number(fields[SALE_FIELDS.price]);
  const price = Number.isFinite(custom) && custom > 0 ? round2(custom) : null;
  const until = text(fields[SALE_FIELDS.until]).slice(0, 10) || null;
  const ideal = round2(fields["Ideal Selling Price"]);
  const ask = price ?? ideal;
  const reason = notListedBecause(fields, { until, ask }, today);
  const listed = !reason;

  return {
    listed,
    reason: reason || null,
    held_back: fields[SALE_FIELDS.hold] === true,
    price,
    until,
    ask,
    deal: listed && price !== null && price < ideal
  };
}

/*
 * What the browser asked to change, as Airtable fields. A key that is left
 * out is left alone; price and until take "" or null to clear. Anything that
 * is not a clean value is refused rather than guessed at.
 */
export function readSaleChange(change = {}) {
  const fields = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(change, key);

  if (has("hold")) {
    if (typeof change.hold !== "boolean") throw new InventoryError("Hold back is either on or off.");
    fields[SALE_FIELDS.hold] = change.hold;
  }

  if (has("price")) {
    const raw = change.price === null || change.price === undefined ? "" : String(change.price).trim().replace(",", ".");

    if (!raw) {
      fields[SALE_FIELDS.price] = null;
    } else {
      const price = Number(raw);

      if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(price) || price <= 0) {
        throw new InventoryError("The sale price has to be a positive number, or empty.");
      }

      fields[SALE_FIELDS.price] = round2(price);
    }
  }

  if (has("until")) {
    const raw = change.until === null || change.until === undefined ? "" : String(change.until).trim();

    if (!raw) {
      fields[SALE_FIELDS.until] = null;
    } else {
      const parsed = new Date(`${raw}T00:00:00Z`);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
        throw new InventoryError("Until has to be a date (YYYY-MM-DD), or empty.");
      }

      fields[SALE_FIELDS.until] = raw;
    }
  }

  if (!Object.keys(fields).length) throw new InventoryError("Nothing to change.");

  return fields;
}

function daysSince(value, today) {
  const when = Date.parse(text(value));
  if (!Number.isFinite(when)) return null;
  return Math.round((today.getTime() - when) / 86_400_000);
}

// What the orders on this unit say happened to it.
function ordersOn(fields) {
  const all = [
    ...many(fields["Fulfillment Status (UOL)"]).map((status) => ({ status: text(status), ref: first(fields["Shopify Order Number"]) })),
    ...many(fields["Fulfillment Status (MWTB)"]).map((status) => ({ status: text(status), ref: first(fields["Member WTB ID"]) }))
  ].filter((order) => order.status && !DEAD.has(order.status));

  const sold = first(fields["Date Sold (External)"]);

  return {
    gone: all.filter((order) => SHIPPED.has(order.status)),
    open: all.filter((order) => !SHIPPED.has(order.status)),
    externally: sold ? { ref: first(fields["External Order Number"]), on: sold.slice(0, 10) } : null
  };
}

/*
 * Where two things the base knows disagree, and which one to put right.
 */
export function checksFor(fields = {}, today = new Date()) {
  const found = [];
  const add = (code, say) => found.push({ code, say, todo: CHECKS[code].todo, blocking: BLOCKING.has(code) });

  const availability = text(fields["Availability Status"]);
  const verification = text(fields["Verification Status"]);
  const condition = text(fields["Item Condition"]);
  const orders = ordersOn(fields);

  /*
   * Gone, but still counted. The big one: 700 units, most of them left on
   * Reserved after their order was fulfilled, because nothing moves the unit
   * on when the order completes.
   */
  if (availability !== "Sold") {
    for (const order of orders.gone) {
      add("shipped", `Shipped${order.ref ? ` on order ${order.ref}` : ""}, but the unit says ${availability || "nothing"}`);
    }

    if (!orders.gone.length && orders.externally) {
      add("shipped", `Sold externally${orders.externally.ref ? ` on ${orders.externally.ref}` : ""} (${orders.externally.on}), but the unit says ${availability || "nothing"}`);
    }
  }

  /*
   * The note says no shoe ever came, but the unit is still verified. These
   * are purchases that fell through - the seller never posted, or it was
   * never ordered in the first place.
   */
  if (condition && NEVER_ARRIVED.test(condition) && !WRITTEN_OFF.has(verification)) {
    add("never_arrived", `"${condition}", but verification says ${verification || "nothing"}`);
  }

  /*
   * The other way round: written off, yet still counted as sellable stock.
   * An empty status counts as claiming stock too - nothing says otherwise,
   * and "set it to Inactive" is a better answer than "give it a status".
   */
  if (WRITTEN_OFF.has(verification) && (CLAIMS_STOCK.has(availability) || !availability)) {
    add("written_off", `Verification is ${verification}, but the unit says ${availability || "nothing"}`);
  }

  // Promised to nobody. Reserved is meant to mean "on an order".
  if (availability === "Reserved" && !orders.gone.length && !orders.open.length && !orders.externally) {
    add("reserved_no_order", "Reserved, but there is no order on it");
  }

  /*
   * No status at all. 136 units, €23.894: they are in no view, no count and
   * no rollup, so nobody has ever had to decide about them.
   */
  if (!availability) add("no_status", "Availability Status is empty");

  if (condition && FLAWED.test(condition) && !NEVER_ARRIVED.test(condition)) {
    add("flawed", `"${condition}"`);
  }

  // Anything else somebody wrote down. Shown, never interpreted.
  if (condition && !REASSURING.test(condition) && !NEVER_ARRIVED.test(condition) && !FLAWED.test(condition)) {
    add("note", `"${condition}"`);
  }

  // Only worth saying about a pair we still think we can sell.
  if (CLAIMS_STOCK.has(availability) || !availability) {
    const cost = Number(fields["Final Purchase Price"]);
    const floor = Number(fields["Minimum Selling Price"]);

    if (cost > 0 && !(floor > cost)) {
      add("no_margin", floor > 0
        ? `Floor ${round2(floor)} is not above the ${round2(cost)} it cost`
        : "There is no minimum selling price");
    }
  }

  const age = daysSince(fields["Purchase Date"], today);

  if (age !== null && age > STALE_DAYS && availability !== "Sold") {
    add("stale", `Bought ${age} days ago and still here`);
  }

  return found;
}

// Where the pair lies. Empty means our own warehouse: only a pair that is
// somewhere else gets the field filled, so nothing had to be backfilled.
export function locationOf(fields = {}) {
  return text(fields.Location) || "Our warehouse";
}

/*
 * What to call how the pair arrived, worked out exactly the way Airtable
 * works out the Item ID - Source before Type, in the same order.
 *
 * Two fields say this and they do not always agree: 87 units are Type Direct
 * with Source Outsourced, and they carry an OUT- number because the Item ID
 * formula asks Source first. Naming them the same way means the column can
 * never contradict the number sitting next to it, and a pair bought to fill
 * an order reads as "Outsourced" whatever its type happens to say.
 *
 * "Custom" stays the value in Airtable. This is what the screen calls it.
 */
export function kindOf(fields = {}) {
  const type = text(fields.Type);

  if (type === "Consignment") return "Consignment";
  if (type === "Return Service") return "Return";
  if (text(fields.Source) === "Outsourced") return "Outsourced";
  if (type === "Partner Consignment") return "Partner";
  if (type === "Forwarding") return "Forwarding";

  // Anything Source does not claim keeps the name Airtable gives it. Every
  // Custom unit there is today has Source Outsourced and is caught above; one
  // that ever turns up without it would read as Custom, which is the truth.
  return type || "no type";
}

// The SKU Master photo, small: the Picture lookup is a list of attachments.
function pictureOf(value) {
  const shot = (Array.isArray(value) ? value : []).find((item) => item && typeof item === "object" && item.url);
  return shot ? text(shot.thumbnails?.large?.url || shot.thumbnails?.small?.url || shot.url) : "";
}

export function unitRow(record, today = new Date(), baseId = "") {
  const fields = record.fields || {};
  const checks = checksFor(fields, today);

  return {
    id: record.id,
    item_id: text(fields["Item ID"]),
    product_name: text(fields["Product Name"]),
    picture: pictureOf(fields.Picture),
    sku: text(fields.SKU),
    size: text(fields.Size),
    brand: text(fields.Brand),
    type: text(fields.Type),
    source: text(fields.Source),
    kind: kindOf(fields),
    vat_type: text(fields["VAT Type"]),
    availability: text(fields["Availability Status"]),
    verification: text(fields["Verification Status"]),
    location: locationOf(fields),
    elsewhere: Boolean(text(fields.Location)),
    condition: text(fields["Item Condition"]),
    cost: round2(fields["Final Purchase Price"]),
    floor: round2(fields["Minimum Selling Price"]),
    ideal: round2(fields["Ideal Selling Price"]),
    margin: text(fields["Margin %"]),
    sale: saleOf(fields, today),
    purchase_date: first(fields["Purchase Date"]) || null,
    days: daysSince(fields["Purchase Date"], today),
    checks,
    sellable: !checks.some((check) => check.blocking),
    airtable: baseId ? `https://airtable.com/${baseId}/${AIRTABLE_TABLE_ID}/${record.id}` : ""
  };
}

/*
 * The views, over the units that are not Sold.
 *
 * Sold is an archive of 3.495 units and is fetched on its own terms - see
 * `sold` below - so it is deliberately not one of these.
 */
export const VIEWS = {
  in_stock: (row) => row.availability === "Available",
  reserved: (row) => row.availability === "Reserved",
  elsewhere: (row) => row.elsewhere,
  no_status: (row) => !row.availability,
  inactive: (row) => row.availability === "Inactive",
  /*
   * Only what actually needs putting right. Standing still for a year is
   * worth knowing and is its own group, but it is not a disagreement - and
   * counting it here put 952 of 1.059 units on the to-do list, which is the
   * same as having no list.
   */
  checks: (row) => row.checks.some((check) => check.blocking),
  // On the channels right now, by the same rule the kc-own-stock job uses.
  listed: (row) => row.sale.listed,
  // Listed below its Ideal price: what UNION shows as a discount.
  deals: (row) => row.sale.deal,
  // Here and Available, yet not out there - each with the reason why.
  not_listed: (row) => row.availability === "Available" && !row.sale.listed,
  all: () => true
};

/*
 * deps:
 *   airtable  select (main base) - Inventory Units
 *   baseId    only to link a row through to the record in Airtable
 */
export function createInventoryStore({ airtable, baseId = "", now = () => new Date(), cacheMs = 180_000 }) {
  // "not Forwarding" rather than a list of what is ours, so a type nobody
  // has filled in yet still turns up instead of quietly falling out.
  const owned = EXCLUDED_TYPES.map((type) => `{Type} != '${type}'`).join(", ");

  async function pages(formula, { sort = "", cap = 40 } = {}) {
    const records = [];
    let offset = "";

    for (let page = 0; page < cap; page += 1) {
      const result = await airtable.select("Inventory Units", {
        fields: INVENTORY_FIELDS,
        formula,
        sort,
        pageSize: 100,
        offset
      });

      records.push(...result.records);
      offset = result.offset;

      if (!offset) break;
    }

    return records;
  }

  /*
   * Everything of ours that is not plainly Sold: about 1.059 units, eleven
   * calls. Held for a few minutes because every view and every count is cut
   * from this one list, and the base's rate limit is shared with the portal,
   * the WMS and every sync.
   */
  let cache = { at: 0, promise: null };

  function working() {
    if (!cache.promise || Date.now() - cache.at > cacheMs) {
      cache = {
        at: Date.now(),
        promise: pages(`AND(${owned}, {Availability Status} != 'Sold')`)
          .then((records) => {
            const today = now();
            return records.map((record) => unitRow(record, today, baseId));
          })
      };

      cache.promise.catch(() => { cache = { at: 0, promise: null }; });
    }

    return cache.promise;
  }

  const matches = (row, needle) =>
    row.sku.toUpperCase().includes(needle) ||
    row.item_id.toUpperCase().includes(needle) ||
    row.product_name.toUpperCase().includes(needle) ||
    row.size.toUpperCase() === needle;

  /*
   * Worst first, because the checks list doubles as a to-do list. Within
   * that the oldest leads: a unit that has stood here for two years is the
   * one whose story nobody remembers any more.
   */
  const worstFirst = (a, b) =>
    Number(a.sellable) - Number(b.sellable) ||
    b.checks.length - a.checks.length ||
    (b.days ?? 0) - (a.days ?? 0);

  /*
   * Everywhere else the longest standing leads, and nothing else.
   *
   * The other views do not carry the column that says what is wrong, so
   * sorting them by that put the awkward units on top with no reason given
   * next to them - which reads as an arbitrary order.
   */
  const longestFirst = (a, b) => (b.days ?? 0) - (a.days ?? 0);

  /*
   * The counter: the shelf (in stock, at cost), what of it is listed and
   * what that asks together, and how many of those are deals.
   */
  const saleTotals = (rows) => {
    const listed = rows.filter(VIEWS.listed);
    const stock = rows.filter(VIEWS.in_stock);
    return {
      units: listed.length,
      value: round2(listed.reduce((sum, row) => sum + row.sale.ask, 0)),
      deals: listed.filter(VIEWS.deals).length,
      stock_units: stock.length,
      stock_cost: round2(stock.reduce((sum, row) => sum + (row.cost || 0), 0))
    };
  };

  function summarise(rows) {
    const counts = { all: rows.length };
    for (const [name, pick] of Object.entries(VIEWS)) counts[name] = rows.filter(pick).length;

    const groups = [];

    for (const [code, check] of Object.entries(CHECKS)) {
      const hit = rows.filter((row) => row.checks.some((one) => one.code === code));
      if (!hit.length) continue;

      groups.push({
        code,
        label: check.label,
        todo: check.todo,
        units: hit.length,
        value: round2(hit.reduce((sum, row) => sum + row.cost, 0))
      });
    }

    return { counts, groups, sale: saleTotals(rows) };
  }

  /*
   * refine: sort and filters, the same on all three stock screens
   * (stockRefine.js). all: every row, for the export - the screen itself
   * still asks for a page.
   */
  async function list({ view = "in_stock", check = "", q = "", limit = 500, refine = {}, all = false } = {}) {
    const wanted = all ? Infinity : Math.min(Math.max(Number(limit) || 500, 10), 2000);
    const needle = text(q).toUpperCase();

    if (text(view) === "sold") return sold({ q: needle, limit: wanted, refine });

    const rows = await working();
    const { counts, groups, sale } = summarise(rows);

    /*
     * A chosen group stands on its own, over everything we hold. Filtering
     * it through the view as well would hide the stale group behind the
     * checks view, which does not carry stale units.
     */
    let chosen = check
      ? rows.filter((row) => row.checks.some((one) => one.code === check))
      : rows.filter(VIEWS[text(view)] || VIEWS.all);

    if (needle) chosen = chosen.filter((row) => matches(row, needle));

    const facets = facetsOf(chosen, "inventory");
    chosen = filterRows(chosen, "inventory", refine);

    if (!sortRows(chosen, "inventory", refine)) {
      chosen.sort(check || text(view) === "checks" ? worstFirst : longestFirst);
    }

    const shown = chosen.slice(0, wanted);

    return {
      units: shown,
      counts,
      groups,
      sale,
      facets,
      totals: {
        units: chosen.length,
        shown: shown.length,
        cost: round2(chosen.reduce((sum, row) => sum + row.cost, 0))
      }
    };
  }

  /*
   * Sold, which is 3.495 units and growing.
   *
   * Reading it whole would be 35 Airtable calls for an archive nobody scrolls
   * through, so it is asked for by the newest first and searched on Airtable's
   * side. Its counts come from the working set, which does not hold Sold, so
   * the tab shows what came back rather than a total.
   */
  async function sold({ q = "", limit = 200, refine = {} } = {}) {
    const needle = text(q).toUpperCase().replace(/'/g, "\\'");
    const search = needle
      ? `, OR(FIND('${needle}', UPPER({SKU} & '')) > 0, FIND('${needle}', UPPER({Item ID} & '')) > 0, FIND('${needle}', UPPER({Product Name} & '')) > 0)`
      : "";

    const records = await pages(
      `AND(${owned}, {Availability Status} = 'Sold'${search})`,
      { sort: "Purchase Date", cap: needle ? 10 : 2 }
    );

    const today = now();
    const read = records.map((record) => unitRow(record, today, baseId));
    const facets = facetsOf(read, "inventory");
    const refined = filterRows(read, "inventory", refine);
    sortRows(refined, "inventory", refine);

    const rows = refined.slice(0, limit);
    const { counts, groups, sale } = summarise(await working());

    return {
      units: rows,
      counts,
      groups,
      sale,
      facets,
      totals: {
        units: rows.length,
        shown: rows.length,
        cost: round2(rows.reduce((sum, row) => sum + row.cost, 0)),
        partial: !needle
      }
    };
  }

  // What the sidebar shows: the units whose status contradicts what happened.
  async function count() {
    const rows = await working();

    return {
      checks: rows.filter(VIEWS.checks).length,
      in_stock: rows.filter(VIEWS.in_stock).length
    };
  }

  /*
   * Hold one pair back or let it go out again, or set its sale price or end
   * date.
   *
   * The unit is read fresh first: the working set can be minutes old, and a
   * pair that sold in the meantime must not go back on the channels.
   */
  async function setSale(id, change = {}) {
    const recordId = text(id);
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new InventoryError("Unknown unit.");

    const fields = readSaleChange(change);

    const { records } = await airtable.select("Inventory Units", {
      fields: INVENTORY_FIELDS,
      formula: `RECORD_ID() = '${recordId}'`,
      pageSize: 1
    });

    const record = records[0];
    if (!record) throw new InventoryError("That unit is not in Inventory Units.", 404);

    const current = record.fields || {};

    if (EXCLUDED_TYPES.includes(text(current.Type))) {
      throw new InventoryError("A Forwarding unit is not ours to sell.", 409);
    }

    if (text(current["Availability Status"]) !== "Available") {
      throw new InventoryError(`Only an Available unit has sale settings; this one is ${text(current["Availability Status"]) || "without a status"}.`, 409);
    }

    const today = now();
    const before = saleOf(current, today);

    await airtable.update("Inventory Units", recordId, fields);

    // Airtable leaves an emptied field out of a record, so the row does too.
    const merged = { ...current, ...fields };
    for (const [name, value] of Object.entries(fields)) if (value === null) delete merged[name];

    const row = unitRow({ id: recordId, fields: merged }, today, baseId);

    /*
     * Into the working set as well, rather than reading it all again: eleven
     * calls for one checkbox would eat into the rate limit everything else
     * shares.
     */
    let sale = null;

    if (cache.promise) {
      try {
        const rows = await cache.promise;
        const at = rows.findIndex((one) => one.id === recordId);
        if (at >= 0) rows[at] = row;
        else rows.push(row);
        sale = saleTotals(rows);
      } catch {
        // The next read rebuilds it.
      }
    }

    return { unit: row, before, sale, written: fields };
  }

  return { list, sold, count, working, setSale };
}

export function mountInventory(router, { store, audit = null, pageFile }) {
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
        view: text(req.query.view) || "in_stock",
        check: text(req.query.check),
        q: text(req.query.q),
        limit: req.query.limit,
        refine: readRefine(req.query, "inventory")
      }));
    } catch (err) {
      send(res, err);
    }
  });

  // Sale settings, one pair at a time: Hold Back?, Custom Selling Price, Dump Until.
  router.post("/api/admin/inventory/:id/sale", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const body = req.body || {};
      const change = {};

      for (const key of ["hold", "price", "until"]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) change[key] = body[key];
      }

      const out = await store.setSale(req.params.id, change);

      audit?.record({
        actor: req.admin,
        action: "Inventory sale settings",
        source: "inventory",
        recordId: out.unit.id,
        label: [out.unit.item_id, out.unit.sku, out.unit.size].filter(Boolean).join(" "),
        details: {
          changed: out.written,
          before: { hold: out.before.held_back, price: out.before.price, until: out.before.until }
        }
      })?.catch?.(() => {});

      res.json({ unit: out.unit, sale: out.sale });
    } catch (err) {
      send(res, err);
    }
  });
}

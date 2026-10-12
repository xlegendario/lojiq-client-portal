// admin/adminEarnings.js
//
// The Earnings screen: what each of the three channels earned, and when.
//
// The reading is split exactly the way the data is. Airtable's Inventory
// Units carry a store order and a Member WTB alike, one row per pair, with
// the profit already worked out there by formula; Supabase carries the
// external sales, one row per deal, where the profit is worked out in
// admin/earnings.js because there is no column for it.
//
// Two joins are needed that neither source makes for itself:
//
//   A Member WTB's date. The unit's own Sales Date is the fulfilment date
//   of a store order or the date an external sale was sold - for a Member
//   WTB neither happened, and the field is empty on every single one of
//   them. The date comes from the WTB's own Paid At.
//
//   A unit that also hangs off an external sale. It would otherwise be
//   counted twice: once as the pair it is and once inside the deal.
//
// Everything is read, nothing is written.

import express from "express";
import fs from "node:fs";

import {
  unitEarning, unitChannel, unitWtbId, externalEarning, inPeriod, totals, byMonth, earningsCsv, CHANNELS
} from "./earnings.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const UNITS = "Inventory Units";
export const MEMBER_WTBS = "Member WTBs";

// What a sold unit has to say for itself. Asked for by name, because the
// table has a hundred and seven fields and we want nine of them.
const UNIT_FIELDS = [
  "Item ID", "SKU", "Size", "Product Name", "VAT Type", "Selling Method",
  "Sales Date", "Date Fulfilled", "Purchase Price", "Selling Price", "Final Selling Price",
  "Gross Profit", "Gross Profit (after TAX)", "Marketplace Commission", "Net Profit",
  "Member WTB ID", "Shopify Order Number", "Store Name", "UOL Order Source",
  "Unfulfilled Orders Log", "Member WTBs", "External Sales Log",
  // What tells the three apart where the links are silent.
  "Ticket Number", "External Deal ID", "Affiliates Sales Log", "Date Sold (External)"
];

export const ORDERS = "Unfulfilled Orders Log";

/*
 * The order number a sold pair belongs to.
 *
 * A Member WTB carries its own (MWTB-000415) and an external sale is a
 * deal in its own right (EXTD-000098), but a store order's number lives on
 * the order and the unit only holds a link to it. The Shopify number is
 * the shop's own and nothing here is filed under it; the Ticket Number is
 * an ORD on some rows and a raw marketplace id on others.
 *
 * So the orders behind this period are read by id, fifty at a time. That
 * is three extra calls for a month and some thirty for a year - which is
 * why a lookup of Order ID on Inventory Units would be worth adding: the
 * number would then come with the unit and this would fall away. Until
 * then the unit is asked for it, and a lookup that does appear is
 * preferred over this, so adding it later is a straight saving.
 */
async function orderNumbers(airtable, units, known) {
  const ids = [...new Set(units
    .filter((unit) => !text(first(unit["Order ID (UOL)"])))
    .flatMap((unit) => unit["Unfulfilled Orders Log"] || [])
    .filter((id) => !known.has(id)))];

  if (!ids.length || typeof airtable?.byIds !== "function") return known;

  const found = await airtable.byIds(ORDERS, ids, ["Order ID"]).catch(() => new Map());

  for (const [id, fields] of found) known.set(id, text(fields["Order ID"]));

  /*
    Asked for once and then kept. An order's number is not going to change,
    so an id that has been looked up never has to be looked up again - which
    is what makes the second year as quick as a month. Nothing is forgotten
    on purpose: at fifty bytes a row the whole order book would be a couple
    of megabytes, and the service restarts long before that matters.
  */
  for (const id of ids) if (!known.has(id)) known.set(id, "");

  return known;
}

// A day either side of the period, so nothing is lost to how Airtable
// reads a date. The exact cut is made here afterwards, in inPeriod.
const shift = (date, days) => {
const when = new Date(`${date}T00:00:00Z`);

if (Number.isNaN(when.getTime())) return "";

when.setUTCDate(when.getUTCDate() + days);

return when.toISOString().slice(0, 10);
};

/*
 * Which sold units to ask Airtable for.
 *
 * All 4.393 of them is forty-four pages and ten seconds, which is no way
 * to open a screen. A month is a fraction of that - but the undated ones
 * have to come along whatever the period, because a Member WTB has no
 * Sales Date at all and would otherwise never be in any month. There are
 * 470 of those and they are cheap; the saving is on the rest.
 */
export function soldFormula({ from = "", to = "" } = {}) {
const window = [];

if (from && shift(from, -1)) window.push(`IS_AFTER({Sales Date}, "${shift(from, -1)}")`);
if (to && shift(to, 1)) window.push(`IS_BEFORE({Sales Date}, "${shift(to, 1)}")`);

const sold = '{Availability Status} = "Sold"';

return window.length
  ? `AND(${sold}, OR({Sales Date} = BLANK(), ${window.length > 1 ? `AND(${window.join(", ")})` : window[0]}))`
  : sold;
}

/*
 * deps:
 *   airtable   the admin reader - select(table, { formula, fields, ... })
 *   db         createSupabaseRest, for the external sales
 *   cacheMs    how long an answer stands. A month of earnings is not a
 *              live figure and the two sources are slow to ask.
 */
export function createEarningsStore({ airtable = null, db = null, cacheMs = 120_000 } = {}) {
  let held = { at: 0, promise: null };

  // id -> ORD-000000, for as long as the service runs. See orderNumbers.
  const orderBook = new Map();

  async function readAll(table, { formula = "", fields = [], pages = 60 } = {}) {
    const rows = [];
    let offset = "";

    for (let page = 0; page < pages; page += 1) {
      const result = await airtable.select(table, { formula, fields, pageSize: 100, offset });

      rows.push(...(result?.records || []));
      offset = result?.offset || "";

      if (!offset) break;
    }

    return rows;
  }

  async function soldUnits(period) {
    if (!airtable) return [];

    const records = await readAll(UNITS, { formula: soldFormula(period), fields: UNIT_FIELDS });

    return records.map((record) => record.fields || {});
  }

  /*
   * The Member WTBs that became a deal, and when.
   *
   * Confirmed is the line: an offer that was sent and never answered is
   * not earnings, and of 153 WTBs seventeen are confirmed. Created Time
   * rather than Paid At, because the deal is made when it is confirmed -
   * ten of those seventeen are still waiting for the money, and dating
   * them on payment would keep them out of every month until it arrives.
   *
   * Created Time rather than Date, which is the same day on every row we
   * have and can be edited by hand where Created Time cannot.
   */
  async function confirmedWtbs() {
    if (!airtable) return new Map();

    const records = await readAll(MEMBER_WTBS, {
      formula: '{Purchase Status} = "Confirmed"',
      fields: ["Member WTB ID", "Created Time", "Date", "Payment Status"]
    });

    const found = new Map();

    for (const record of records) {
      const id = text(record.fields?.["Member WTB ID"]);

      if (!id) continue;

      found.set(id, {
        id,
        created: text(record.fields?.["Created Time"]) || text(record.fields?.Date),
        paid: text(record.fields?.["Payment Status"]) === "Paid"
      });
    }

    return found;
  }

  async function externalSales() {
    if (!db?.configured) return [];

    const sales = await db.get("external_sales?select=*&order=sale_date.desc");
    const pairs = await db.get("external_sale_pairs?select=*");

    const bySale = new Map();

    for (const pair of pairs || []) {
      if (!bySale.has(pair.sale_id)) bySale.set(pair.sale_id, []);
      bySale.get(pair.sale_id).push(pair);
    }

    /*
      A cancelled deal earned nothing: the pairs came back and the money
      went back with them. It is left out rather than shown at zero, the
      same way a cancelled order is not a sale.

      A broker deal still being negotiated is not a deal yet either - no
      pairs, no total, nothing to invoice - and the External Sales screen
      keeps it on its own until the first pair is really bought. Three of
      them were standing in October at nothing a line.

      Written as "not negotiating" rather than "open", which is what that
      screen asks Supabase for: a row that somehow has no stage at all is
      money we took, and on this screen it is worse to lose a sale than to
      show one deal too many.
    */
    return (sales || [])
      .filter((sale) => sale.payment_status !== "cancelled" && !sale.cancelled_at)
      .filter((sale) => sale.stage !== "negotiating")
      .map((sale) => externalEarning(sale, bySale.get(sale.id) || []));
  }

  async function build(period) {
    const [units, wtbs, external] = await Promise.all([
      soldUnits(period),
      confirmedWtbs(),
      externalSales()
    ]);

    /*
      A pair whose deal lives in Supabase is counted there, as part of that
      deal, and must not be counted here as well. The Airtable link is
      empty on every one of them since the move, so the EXTD number on the
      unit is what gives it away - thirteen were being booked twice.

      The external sales of before that one are a different matter: they
      are on the old Affiliate Sales Log, carry no EXTD number and exist
      nowhere else, so they are read here.
    */
    const bySupabase = new Set(external.map((row) => row.reference));

    const mine = units.filter((unit) => {
      if ((unit["External Sales Log"] || []).length) return false;

      const deal = text(unit["External Deal ID"]) || text(unit["Ticket Number"]);

      return !(deal.startsWith("EXTD-") && bySupabase.has(deal));
    });

    const orders = await orderNumbers(airtable, mine, orderBook);

    const fromAirtable = mine.map((unit) => unitEarning(unit, {
      wtb: wtbs.get(unitWtbId(unit)) || null,
      order: orders.get((unit["Unfulfilled Orders Log"] || [])[0]) || ""
    }))
      /*
        A pair the channel cannot place, and a Member WTB that was never
        confirmed, are not earnings. They are not dropped in silence: both
        come back with no date, which is where the screen shows them.
      */
      .filter((row) => row.channel);

    return [...fromAirtable, ...external];
  }

  /*
   * Held per period, because that is what was asked of Airtable. Opening
   * the same month again, or stepping between the four tabs of it, costs
   * nothing; a different month is read once and then also stands.
   */
  function everything({ from = "", to = "" } = {}) {
    const key = `${from}|${to}`;

    if (held.key !== key || !held.promise || Date.now() - held.at > cacheMs) {
      held = { key, at: Date.now(), promise: build({ from, to }) };
      held.promise.catch(() => { held = { at: 0, promise: null }; });
    }

    return held.promise;
  }

  /*
   * The screen's one answer: the lines of a period, what they come to, and
   * the months behind them.
   */
  async function earnings({ from = "", to = "", channel = "" } = {}) {
    const all = await everything({ from, to });
    const wanted = CHANNELS.includes(channel) ? all.filter((row) => row.channel === channel) : all;

    /*
      A pair with no selling price on it is not a sale this can report.
      Most of them are the StockX years: bought, gone, and what they went
      for was never written back on the unit. Counting them would put
      their purchase in the figures against nothing at all - 135.930 euro
      of cost against 73.511 of sales, which says the business lost money
      it did not lose.

      They are counted and named, not dropped: the number is the size of
      what is missing, and it belongs on the screen.
    */
    const priced = wanted.filter((row) => row.selling !== null || row.gross_after_tax !== null);
    const unpriced = wanted.length - priced.length;

    const { rows, undated } = inPeriod(priced, { from, to });

    return {
      from,
      to,
      channel: CHANNELS.includes(channel) ? channel : "",
      rows,
      totals: totals(rows),
      months: byMonth(rows),
      /*
        Lines that earned money and cannot be placed in a month. Handed back
        rather than dropped: a pair nobody can date is a thing to fix, and
        silently leaving it out is how a whole channel went missing.

        Only the ones that carry money. Of the 470 sold units with no date,
        214 hang off no order at all and most have no selling price either -
        marked sold by hand, or left behind by a migration. They are counted
        rather than listed, so the number is still in front of him without
        two hundred empty lines under it.
      */
      undated: undated.map((row) => ({
        channel: row.channel, reference: row.reference, order: row.order, item: row.item,
        product: row.product, sku: row.sku, size: row.size,
        selling: row.selling, gross_after_tax: row.gross_after_tax
      })),
      // Sold, but with no selling price anywhere on them. See above.
      without_price: unpriced
    };
  }

  return { earnings, everything, refresh: () => { held = { at: 0, promise: null }; } };
}

export function mountEarnings(router, { store, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  router.get(["/admin/earnings", "/admin/earnings/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/earnings", async (req, res) => {
    try {
      res.json(await store.earnings({
        from: text(req.query?.from),
        to: text(req.query?.to),
        channel: text(req.query?.channel)
      }));
    } catch (err) {
      console.error("[admin earnings]", err.message);
      res.status(500).json({ error: `Earnings could not be read: ${err.message}` });
    }
  });

  router.post("/api/admin/earnings/export", express.json({ limit: "4mb" }), async (req, res) => {
    try {
      const { rows } = await store.earnings({
        from: text(req.body?.from),
        to: text(req.body?.to),
        channel: text(req.body?.channel)
      });

      const stamp = new Date().toISOString().slice(0, 10);

      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="earnings-${stamp}.csv"`);
      res.send(earningsCsv(rows));
    } catch (err) {
      console.error("[admin earnings export]", err.message);
      res.status(500).json({ error: `The file could not be made: ${err.message}` });
    }
  });
}

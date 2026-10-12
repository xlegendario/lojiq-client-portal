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

import { unitEarning, externalEarning, inPeriod, totals, byMonth, earningsCsv, CHANNELS } from "./earnings.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const UNITS = "Inventory Units";
export const MEMBER_WTBS = "Member WTBs";

// What a sold unit has to say for itself. Asked for by name, because the
// table has a hundred and seven fields and we want nine of them.
const UNIT_FIELDS = [
  "Item ID", "SKU", "Size", "Product Name", "VAT Type", "Selling Method",
  "Sales Date", "Date Fulfilled", "Purchase Price", "Selling Price", "Final Selling Price",
  "Gross Profit", "Gross Profit (after TAX)", "Marketplace Commission", "Net Profit",
  "Member WTB ID", "Shopify Order Number", "Store Name", "UOL Order Source",
  "Unfulfilled Orders Log", "Member WTBs", "External Sales Log"
];

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
 * When each Member WTB was paid for.
 *
 * Paid At rather than the day it was asked for: a WTB can sit open for a
 * week, and the money arriving is the day the deal was made.
 */

/*
 * deps:
 *   airtable   the admin reader - select(table, { formula, fields, ... })
 *   db         createSupabaseRest, for the external sales
 *   cacheMs    how long an answer stands. A month of earnings is not a
 *              live figure and the two sources are slow to ask.
 */
export function createEarningsStore({ airtable = null, db = null, cacheMs = 120_000 } = {}) {
  let held = { at: 0, promise: null };

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

  async function wtbPaidAt() {
    if (!airtable) return new Map();

    const records = await readAll(MEMBER_WTBS, {
      formula: '{Payment Status} = "Paid"',
      fields: ["Member WTB ID", "Paid At", "Date"]
    });

    const when = new Map();

    for (const record of records) {
      const id = text(record.fields?.["Member WTB ID"]);

      if (id) when.set(id, text(record.fields?.["Paid At"]) || text(record.fields?.Date));
    }

    return when;
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
    */
    return (sales || [])
      .filter((sale) => sale.payment_status !== "cancelled" && !sale.cancelled_at)
      .map((sale) => externalEarning(sale, bySale.get(sale.id) || []));
  }

  async function build(period) {
    const [units, paidAt, external] = await Promise.all([
      soldUnits(period),
      wtbPaidAt(),
      externalSales()
    ]);

    const fromAirtable = units
      // A unit that is also on an external sale is counted there, as part of
      // that deal. Counting it here as well would book the pair twice.
      .filter((unit) => !(unit["External Sales Log"] || []).length)
      .map((unit) => unitEarning(unit, { paidAt: paidAt.get(text(unit["Member WTB ID"])) || "" }));

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
    const { rows, undated } = inPeriod(wanted, { from, to });

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
      undated: undated
        .filter((row) => row.selling !== null || row.gross_after_tax !== null)
        .map((row) => ({
          channel: row.channel, reference: row.reference, sku: row.sku, size: row.size,
          selling: row.selling, gross_after_tax: row.gross_after_tax
        })),
      undated_without_money: undated.filter((row) => row.selling === null && row.gross_after_tax === null).length
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

// admin/earnings.js
//
// What a deal earned, across the three ways we sell.
//
// The money lives in two places and neither of them is the order:
//
//   Store orders    Airtable's Inventory Units, one row per pair, with the
//   Member WTBs     profit worked out there by formula. The order tables
//                   only look it up, so this reads the unit itself.
//   External sales  Supabase, one row per deal. There is no profit column
//                   there, so it is worked out here - the same sum Airtable
//                   used while it still held these deals.
//
// The date is the one thing none of them shares. A unit's own "Sales Date"
// is the fulfilment date of a store order, or the date an external sale was
// sold; for a Member WTB it is empty, every single time, because neither of
// those two things happened. So the date is taken per channel at its source
// and never from one field pretending to cover all three.
//
// Nothing here is recomputed that Airtable already works out. The profit a
// store order shows is the profit Airtable shows, to the cent, including
// when a formula over there is wrong - the point of this screen is to see
// the figures the business runs on, not a second opinion on them.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const money = (value) => {
  const number = num(value);
  return number === null ? null : Math.round(number * 100) / 100;
};

// Airtable hands a lookup back as an array even when it holds one thing.
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const CHANNELS = ["Store orders", "Member WTBs", "External sales"];

// The day out of a date, a date-time, or a lookup holding either.
export function day(value) {
  const found = text(first(value));
  return /^\d{4}-\d{2}-\d{2}/.test(found) ? found.slice(0, 10) : "";
}

/* ---------------- a pair sold through Airtable ---------------- */

/*
 * One sold unit, as a line on the screen.
 *
 * paidAt is the Member WTB's own payment date, looked up by the caller: the
 * unit cannot see it. Without it a Member WTB has no date at all, and a row
 * with no date falls out of every period - which is exactly what hid this
 * whole channel until now.
 */
export function unitEarning(unit = {}, { paidAt = "", order = "" } = {}) {
  const wtb = text(first(unit["Member WTB ID"]));
  const channel = wtb ? "Member WTBs" : "Store orders";

  return {
    channel,
    date: channel === "Member WTBs"
      ? day(paidAt) || day(unit["Sales Date"])
      : day(unit["Sales Date"]) || day(unit["Date Fulfilled"]),
    /*
      The number the deal is known by: MWTB-000415, ORD-004554. Not the
      Shopify number, which is the shop's own and is not what anything
      here is filed under, and not the Ticket Number, which holds an ORD
      on some rows and a raw marketplace id on others.

      A pair that hangs off no order at all keeps its unit number, which
      is the only thing it has - and those are exactly the rows worth
      looking up, so leaving the cell empty would be the wrong kind of
      honest.
    */
    reference: wtb || text(order) || text(first(unit["Order ID (UOL)"])) || text(unit["Item ID"]),
    order: wtb || text(order) || text(first(unit["Order ID (UOL)"])),
    shop_order: text(first(unit["Shopify Order Number"])),
    item: text(unit["Item ID"]),
    sku: text(unit.SKU),
    size: text(unit.Size),
    product: text(unit["Product Name"]),
    // Where it went out: a shop name for a marketplace, else how it was sold.
    where: text(first(unit["Store Name"]))
      || text(first(unit["UOL Order Source"]))
      || text(unit["Selling Method"]),
    vat_type: text(unit["VAT Type"]),
    purchase: money(unit["Purchase Price"]),
    selling: money(unit["Final Selling Price"] ?? unit["Selling Price"]),
    commission: money(unit["Marketplace Commission"]) ?? 0,
    gross: money(unit["Gross Profit"]),
    gross_after_tax: money(unit["Gross Profit (after TAX)"]),
    pairs: 1
  };
}

/* ---------------- a deal sold outside ---------------- */

/*
 * One external sale, as a line on the screen.
 *
 * Per deal and not per pair, because that is how the money is known: of the
 * pairs in Supabase only a handful carry a selling price of their own, and
 * the rest only exist inside a deal total. Splitting that total over them
 * would be an invention.
 *
 * The sum is the one Airtable used while it still held these deals - the
 * total, less the shipping, less what the pairs cost - and over the 53 deals
 * both systems hold it lands on the same cent for 49 of them. The four that
 * differ differ in the purchase price itself, not in this arithmetic.
 *
 * A cancelled pair is left out of the cost: the deal's own total has already
 * come down for it, and counting its purchase would charge us twice.
 */
export function externalEarning(sale = {}, pairs = []) {
  const live = pairs.filter((pair) => !pair.cancelled_at);
  const purchase = live.reduce((sum, pair) => sum + (num(pair.purchase_price_ex_vat) || 0), 0);
  const selling = num(sale.total_selling_price) || 0;
  const shipping = num(sale.shipping_costs) || 0;
  const gross = money(selling - shipping - purchase);

  const names = [...new Set(live.map((pair) => text(pair.product_name)).filter(Boolean))];

  return {
    channel: "External sales",
    date: day(sale.sale_date) || day(sale.created_at),
    reference: sale.deal_number ? `EXTD-${String(sale.deal_number).padStart(6, "0")}` : text(sale.id),
    order: sale.deal_number ? `EXTD-${String(sale.deal_number).padStart(6, "0")}` : "",
    shop_order: "",
    item: "",
    sku: live.length === 1 ? text(live[0].sku) : "",
    size: live.length === 1 ? text(live[0].size) : "",
    product: names.length <= 1
      ? (names[0] || "")
      : `${names[0]} and ${names.length - 1} other${names.length > 2 ? "s" : ""}`,
    where: text(sale.buyer_company) || text(sale.buyer_name),
    vat_type: text(sale.legacy_selling_vat_type) || text(first(live.map((p) => p.selling_vat_type))),
    purchase: money(purchase),
    selling: money(selling),
    // A marketplace takes a cut; a buyer we sell to ourselves does not.
    commission: 0,
    gross,
    // The same flat step Airtable took: the margin is what is taxed.
    gross_after_tax: money(gross / 1.21),
    pairs: live.length,
    shipping: money(shipping)
  };
}

/* ---------------- the screen ---------------- */

/*
 * The lines of one period, newest first.
 *
 * A line with no date is not silently dropped: it is handed back separately,
 * because a pair that earned money and cannot be placed in a month is worth
 * seeing. That is how the Member WTBs were hiding.
 */
export function inPeriod(rows = [], { from = "", to = "" } = {}) {
  const kept = [];
  const undated = [];

  for (const row of rows) {
    if (!row.date) { undated.push(row); continue; }
    if (from && row.date < from) continue;
    if (to && row.date > to) continue;

    kept.push(row);
  }

  kept.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { rows: kept, undated };
}

const add = (a, b) => (a === null && b === null ? null : Math.round(((a || 0) + (b || 0)) * 100) / 100);

/*
 * What a set of lines comes to.
 *
 * Kept per channel as well as over the whole, because the first question of
 * any month is which of the three carried it.
 */
export function totals(rows = []) {
  const empty = () => ({
    deals: 0, pairs: 0, purchase: null, selling: null, commission: null, gross: null, gross_after_tax: null
  });

  const all = empty();
  const byChannel = new Map(CHANNELS.map((name) => [name, empty()]));

  for (const row of rows) {
    for (const into of [all, byChannel.get(row.channel)]) {
      if (!into) continue;

      into.deals += 1;
      into.pairs += row.pairs || 1;
      into.purchase = add(into.purchase, row.purchase);
      into.selling = add(into.selling, row.selling);
      into.commission = add(into.commission, row.commission);
      into.gross = add(into.gross, row.gross);
      into.gross_after_tax = add(into.gross_after_tax, row.gross_after_tax);
    }
  }

  return { all, channels: CHANNELS.map((name) => ({ channel: name, ...byChannel.get(name) })) };
}

/*
 * The months a set of lines falls in, newest first, each with its own total.
 * One number a month is what makes a year readable.
 */
export function byMonth(rows = []) {
  const months = new Map();

  for (const row of rows) {
    const month = row.date.slice(0, 7);

    if (!month) continue;
    if (!months.has(month)) months.set(month, []);

    months.get(month).push(row);
  }

  return [...months]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, lines]) => ({ month, ...totals(lines).all }));
}

/* ---------------- the file ---------------- */

const cell = (value) => {
  const written = text(value);
  return /[",\n]/.test(written) ? `"${written.replace(/"/g, '""')}"` : written;
};

const COLUMNS = [
  ["Date", (r) => r.date],
  ["Channel", (r) => r.channel],
  ["Reference", (r) => r.reference],
  ["SKU", (r) => r.sku],
  ["Size", (r) => r.size],
  ["Product", (r) => r.product],
  ["Where", (r) => r.where],
  ["Pairs", (r) => r.pairs],
  ["VAT type", (r) => r.vat_type],
  ["Purchase price", (r) => r.purchase],
  ["Selling price", (r) => r.selling],
  ["Marketplace commission", (r) => r.commission],
  ["Gross profit", (r) => r.gross],
  ["Gross profit (after TAX)", (r) => r.gross_after_tax]
];

/*
 * Comma separated and quoted, which is the one that opens in columns here.
 * The amounts go out with a dot, because a spreadsheet reading a comma as a
 * thousands separator turns 1,50 into 150 and says nothing about it.
 */
export function earningsCsv(rows = []) {
  const lines = [COLUMNS.map(([name]) => cell(name)).join(",")];

  for (const row of rows) {
    lines.push(COLUMNS.map(([, read]) => {
      const value = read(row);
      return cell(typeof value === "number" ? value.toFixed(2) : value);
    }).join(","));
  }

  return `${lines.join("\n")}\n`;
}

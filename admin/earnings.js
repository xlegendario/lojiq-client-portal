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

export const CHANNELS = ["Store orders", "Member WTBs", "External sales", "Forwarding"];

// The day out of a date, a date-time, or a lookup holding either.
export function day(value) {
  const found = text(first(value));
  return /^\d{4}-\d{2}-\d{2}/.test(found) ? found.slice(0, 10) : "";
}

/* ---------------- a pair sold through Airtable ---------------- */

/*
 * Which of the three a sold pair went out through.
 *
 * The links say it where they are filled, and the ticket number says it
 * where they are not - a pair sold since the external sales moved to
 * Supabase has no Airtable row to link to, only "EXTD-000113" written on
 * it. Reading the links alone put 4.141 of 4.397 sold pairs under store
 * orders, external ones included, and those were then counted a second
 * time inside their deal.
 *
 * The Affiliate Sales Log is the external sales of before the current one:
 * the same channel under its old name, running to May 2026 and never
 * carrying an EXTD number. It belongs with external sales, which is what
 * it was, and not under a name the business no longer uses.
 *
 * Anything else - a ticket number from a marketplace and nothing else, or
 * nothing at all - is not placed. Forty-five of them, and calling them
 * store orders would be a guess dressed as a fact.
 */
export function unitChannel(unit = {}) {
  const linked = (name) => Boolean((unit[name] || []).length);
  const ticket = text(unit["Ticket Number"]);

  // A cancelled order is not a sale, whatever else is written on the pair.
  if (text(first(unit["Fulfillment Status (UOL)"])) === "Cancelled") return "";

  if (linked("External Sales Log")
    || text(unit["External Deal ID"]).startsWith("EXTD-")
    || ticket.startsWith("EXTD-")) return "External sales";

  if (linked("Member WTBs") || (unit["Member WTB ID"] || []).length || ticket.startsWith("MWTB-")) {
    return "Member WTBs";
  }

  if (linked("Affiliates Sales Log")) return "External sales";
  if (linked("Unfulfilled Orders Log")) return "Store orders";

  return "";
}

// The Member WTB a pair belongs to, by the number it is known by.
export const unitWtbId = (unit = {}) => {
  const found = text(first(unit["Member WTB ID"])) || text(unit["Ticket Number"]);
  return found.startsWith("MWTB-") ? found : "";
};

/*
 * One sold unit, as a line on the screen.
 *
 * Each channel is dated at its own source, because no field on the unit
 * covers all three. A store order has Date Fulfilled, which is the one
 * Dario works from. An external sale of the old kind has Date Sold
 * (External) - named for a channel it no longer describes, since it comes
 * off the Affiliate Sales Log. A Member WTB has neither, so the date is
 * the WTB's own Created Time, handed in by the caller.
 */
export function unitEarning(unit = {}, { wtb = null, order = "" } = {}) {
  const channel = unitChannel(unit);

  /*
    The moment, not only the day. Two orders fulfilled an hour apart are
    the same date, and sorting on the date alone left today's newest
    somewhere in the middle of today.
  */
  const moment = channel === "Member WTBs"
    ? text(first(wtb?.created))
    : channel === "External sales"
      ? text(first(unit["Date Sold (External)"])) || text(first(unit["Sales Date"]))
      : text(first(unit["Date Fulfilled"])) || text(first(unit["Sales Date"]));

  const when = day(moment);

  const wtbId = unitWtbId(unit);

  return {
    channel,
    date: when,
    at: when ? moment : "",
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
    reference: wtbId || text(order) || text(first(unit["Order ID (UOL)"])) || text(unit["Item ID"]),
    order: wtbId || text(order) || text(first(unit["Order ID (UOL)"])),
    shop_order: text(first(unit["Shopify Order Number"])),
    item: text(unit["Item ID"]),
    // What the order is doing, so a pair that has not gone out yet can be
    // told from one that has without leaving the screen.
    status: text(first(unit["Fulfillment Status (UOL)"])),
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

  /*
   * FIXED - an excl. VAT cost taken off an incl. VAT price.
   *
   * The pairs are bought excl. VAT, and the deal total is what the buyer
   * pays. On a 21% sale those sit 21% apart, and the difference was counted
   * as profit: EXTD-000127 on 14-10-2026 read EUR 99.51 on three pairs that
   * made EUR 10 each.
   *
   * It could not show before. Every one of the thirty-three external pairs
   * until that deal was margin goods, where the price IS the gross one and
   * nothing has to come off it. Reverse-charged pairs are net already, so
   * only a 21% sale needs the step.
   *
   * A deal with no route recorded at all is one of the old Airtable ones,
   * and those were margin goods - so it keeps the margin treatment rather
   * than being read as untaxed.
   */
  const route = text(sale.legacy_selling_vat_type)
    || text(first(live.map((pair) => pair.selling_vat_type)));

  const sellingExVat = route === "VAT21" ? selling / 1.21 : selling;

  const gross = money(sellingExVat - shipping - purchase);

  const names = [...new Set(live.map((pair) => text(pair.product_name)).filter(Boolean))];

  return {
    channel: "External sales",
    status: text(sale.stage) === "negotiating" ? "Draft" : text(sale.shipping_status) || text(sale.payment_status),
    date: day(sale.sale_date) || day(sale.created_at),
    // sale_date is a day; created_at is the moment, and that is what tells
    // two deals of the same day apart.
    at: `${day(sale.sale_date) || day(sale.created_at)}T${text(sale.created_at).slice(11) || "00:00:00"}`,
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
    vat_type: route,
    purchase: money(purchase),
    /*
     * On the same scale as every other line, and as the totals under them.
     *
     * A unit reports its Final Selling Price, which is excl. VAT - margin
     * goods excepted, where the price IS the gross one. A deal total is what
     * the buyer pays, so a 21% sale stood 21% above every row around it and
     * was added to the month that way.
     */
    selling: money(sellingExVat),
    // A marketplace takes a cut; a buyer we sell to ourselves does not.
    commission: 0,
    gross,
    /*
     * The same flat step Airtable took, and only where it belongs: under the
     * margin scheme the margin itself is taxed. On a 21% sale that tax came
     * off the price above, and on a reverse-charged one there is none - so
     * taking it again would be taking it twice.
     */
    gross_after_tax: route === "VAT21" || route === "VAT0" ? gross : money(gross / 1.21),
    pairs: live.length,
    shipping: money(shipping)
  };
}

/* ---------------- a parcel forwarded for a partner ---------------- */

/*
 * One forward, as a line on the screen.
 *
 * Nothing is bought and nothing is sold: the pairs are the partner's and
 * they stay his. What we earn is the fee for moving them.
 *
 * The sum is not worked out here. Forwarding Payments already shows these
 * same forwards with these same figures, and two screens doing the same
 * arithmetic is how they come to disagree - so the caller hands in what
 * forwardMoney() made of it, and this only shapes it into a line.
 *
 * Note what that says: the profit is the whole fee. The shipping is not
 * taken off it, because the partner pays that on top - payable is fee plus
 * shipping. Taking it off was my first guess and it was wrong.
 */
export function forwardEarning(log = {}, money_ = {}) {
  const shown = log.forwarding_number
    ? `FWD-${String(log.forwarding_number).padStart(6, "0")}`
    : text(log.id);

  const pairs = Number(log.pair_count) || 0;

  return {
    channel: "Forwarding",
    status: text(log.payment_status) === "paid" ? "Paid" : text(log.shipping_status) || text(log.payment_status),
    date: day(log.forwarding_date) || day(log.created_at),
    at: `${day(log.forwarding_date) || day(log.created_at)}T${text(log.created_at).slice(11) || "00:00:00"}`,
    reference: shown,
    order: shown,
    shop_order: "",
    item: "",
    sku: "",
    size: "",
    product: `${pairs} pair${pairs === 1 ? "" : "s"} forwarded`,
    where: text(log.seller_name) || text(log.seller_id),
    vat_type: "Margin",
    // Nothing was bought: the pairs belong to the partner throughout.
    purchase: null,
    selling: money(money_.fee),
    commission: 0,
    gross: money(money_.profit),
    gross_after_tax: money(money_.profit_ex_vat),
    pairs,
    shipping: money(money_.shipping)
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

  // Newest first, to the minute where there is one.
  const moment = (row) => row.at || row.date;

  kept.sort((a, b) => (moment(a) < moment(b) ? 1 : moment(a) > moment(b) ? -1 : 0));

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
    deals: 0,
    pairs: 0,
    forwarded: 0,
    purchase: null,
    selling: null,
    fee: null,
    commission: null,
    gross: null,
    gross_after_tax: null
  });

  const all = empty();
  const byChannel = new Map(CHANNELS.map((name) => [name, empty()]));

  for (const row of rows) {
    /*
      A forwarded pair is not a pair we sold and its fee is not turnover:
      the pairs are the partner's and we are paid for moving them. Added
      into the same two columns they made July read as 407 pairs against
      20.579 euro, when 115 were sold and 292 were carried - two different
      things stacked on top of each other.

      So they are counted beside the sales rather than inside them. The
      profit below is still the two together, because earning is earning.
    */
    const carried = row.channel === "Forwarding";

    for (const into of [all, byChannel.get(row.channel)]) {
      if (!into) continue;

      into.deals += 1;

      if (carried) {
        into.forwarded += row.pairs || 0;
        into.fee = add(into.fee, row.selling);
      } else {
        into.pairs += row.pairs || 1;
        into.selling = add(into.selling, row.selling);
      }

      into.purchase = add(into.purchase, row.purchase);
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

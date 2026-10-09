// admin/wtbMatch.js
//
// Matching a want-to-buy against everything we can actually get hold of.
//
// A WTB arrives in Discord as a line of text or a screenshot, and answering it
// means opening the warehouse, the consignment stock and the partner stock one
// after another and reading them by eye. This does that in one pass: paste the
// request, see what it was understood to be, and get every unit we hold for it
// with what it costs us.
//
// Everything here is pure. The reading of the three sources happens elsewhere;
// this decides what was asked and what counts as an answer.
//
// What the stock actually looks like, measured 09-10-2026 across all three:
//
//   warehouse    164 available units, 33 size values, not one odd notation
//   consignment  21283 rows, the same notations plus 110 clothing sizes
//   partner      1305 rows, the same, plus S/M/L/XL and 557 Crocs size ranges
//
// Two size families, then: plain and half sizes (42, 42.5) and the adidas
// thirds (36 2/3, 37 1/3). No SKU carries the same foot under two spellings.
// That matters more than it sounds: because a request is matched on its SKU
// first, sizes only ever have to agree within one SKU. A size range like
// "42-43" belongs to one Crocs article and can only ever be hit by a request
// for that article, so it needs no special handling at all.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/*
 * A size as everything here compares it.
 *
 * Case and spacing go, because "42 2/3", "42  2/3" and "42 2/3 " are one size
 * written by three people. Thirds written as a decimal are folded onto the
 * fraction the catalogue uses - nobody stocks "37.33", but a request typed in
 * a hurry says it - and a trailing ".0" is dropped so "42.0" finds 42.
 */
export function sizeKey(value) {
  let size = text(value).toUpperCase().replace(/\s+/g, " ");

  if (!size) return "";

  // "37 1/3" and "371/3" are the same request.
  size = size.replace(/^(\d+)\s*(\d\/\d)$/, "$1 $2");

  const decimal = /^(\d+)[.,](\d+)$/.exec(size);

  if (decimal) {
    const whole = decimal[1];
    const rest = decimal[2];

    if (/^0+$/.test(rest)) return whole;
    if (rest === "5" || rest === "50") return `${whole}.5`;
    if (/^3+$/.test(rest)) return `${whole} 1/3`;
    if (/^6+7?$/.test(rest)) return `${whole} 2/3`;
  }

  return size;
}

// A SKU as everything here compares it. Exact, case-insensitive, and nothing
// else: a SKU with a stray space is a different article, not a near miss.
export const skuKey = (value) => text(value).toUpperCase().replace(/\s+/g, "");

/*
 * What a want-to-buy is asking for.
 *
 * Takes what is pasted in, whatever shape it came in: the "sku,size" csv the
 * partner makes with a chatbot, or the raw line from Discord -
 *
 *   DM7866-202 - Jordan 1 Retro Low OG SP Travis Scott Velvet Brown 42 + 42.5 + 43 + 44
 *
 * A SKU is the first run of letters, digits and dashes that holds a digit and
 * is not itself a size; the sizes are every size-shaped word after it. Lines
 * that hold no SKU are handed back as they came, so the screen can say which
 * line it could not read rather than quietly dropping it.
 */
const CLOTHING = /^(XXS|XS|S|M|L|XL|XXL|XXXL)$/i;
const RANGE = /^\d{1,2}-\d{1,2}$/;
const NUMBER = /^(\d{1,2})(?:[.,]\d+)?(?: \d\/\d)?$/;
const SKU_WORD = /^[A-Z0-9]+(?:[-/][A-Z0-9]+)*$/i;

/*
 * A word that is a size.
 *
 * The bound on the number is what keeps a product name out: "Jordan 1" and
 * "Dunk Low 85" are not requests for a size 1 or an 85. Everything in all
 * three sources sits between 35 and 49, so 15 to 60 is wide enough for a
 * child's size and narrow enough to ignore the name of the shoe.
 */
function isSize(word) {
  const value = text(word);

  if (CLOTHING.test(value) || RANGE.test(value)) return true;

  const number = NUMBER.exec(value);

  if (!number) return false;

  const whole = Number(number[1]);

  return whole >= 15 && whole <= 60;
}

export function parseRequest(input) {
  const lines = text(input).split(/\r?\n/);
  const rows = [];
  const unreadable = [];

  for (const raw of lines) {
    const line = text(raw);
    if (!line) continue;

    // The csv shape first: two fields and the second one is a size.
    const csv = line.split(/[;,\t]/).map((part) => text(part));

    if (csv.length === 2 && csv[0] && isSize(csv[1]) && !isSize(csv[0])) {
      rows.push({ sku: skuKey(csv[0]), size: sizeKey(csv[1]), line });
      continue;
    }

    /*
      Otherwise a sentence. The article is whatever is in brackets, because
      that is how a WTB is written here -

        WTB New Balance 9060 Triple Black (U9060BPM) 38 EU

      and the name is full of numbers that look like one. Reading left to
      right picked "9060" out of New Balance 9060, which is a model and not
      an article, and threw away every line whose brackets were the only
      thing that held a SKU. The last pair of brackets wins, so a "(Women's)"
      earlier in the name cannot take its place.
    */
    const words = line.split(/[\s+,;|]+/).map((word) => text(word)).filter(Boolean);
    let at = -1;
    let bracketed = "";
    let tailFrom = "";

    for (const found of line.matchAll(/\(([A-Za-z0-9][A-Za-z0-9\-/]*)\)/g)) {
      if (!/\d/.test(found[1]) || isSize(found[1]) || found[1].length < 4) continue;

      bracketed = found[1];
      tailFrom = line.slice(found.index + found[0].length);
    }

    if (!bracketed) {
      at = words.findIndex(
        (word) => /\d/.test(word) && SKU_WORD.test(word) && !isSize(word) && word.length >= 4
      );

      if (at === -1) {
        unreadable.push(line);
        continue;
      }
    }

    /*
      A size written with a space - "37 1/3" - arrives as two words, so the
      pairs are put back together before anything is thrown away. Doing it the
      other way round loses the "2/3", which is not a size on its own.
    */
    // The sizes are whatever follows the article, wherever it was found.
    const tail = bracketed
      ? tailFrom.split(/[\s+,;|]+/).map((word) => text(word)).filter(Boolean)
      : words.slice(at + 1);
    const joined = [];

    for (let i = 0; i < tail.length; i += 1) {
      if (/^\d{1,2}$/.test(tail[i]) && /^\d\/\d$/.test(tail[i + 1] || "")) {
        joined.push(`${tail[i]} ${tail[i + 1]}`);
        i += 1;
        continue;
      }

      if (isSize(tail[i])) joined.push(tail[i]);
    }

    if (!joined.length) {
      unreadable.push(line);
      continue;
    }

    const sku = skuKey(bracketed || words[at]);

    for (const size of joined) rows.push({ sku, size: sizeKey(size), line });
  }

  // The same pair asked for twice is one question.
  const seen = new Set();
  const wanted = [];

  for (const row of rows) {
    const key = `${row.sku}|${row.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push(row);
  }

  return { wanted, unreadable };
}

/*
 * Every unit we hold for what was asked.
 *
 * One asked-for pair can come back several times over - the same shoe from the
 * warehouse and from two consignors is three offers at three prices, and which
 * one to use is a judgement nobody here should make for him. So they all come
 * back, cheapest first, and a pair we do not have comes back too, empty, so a
 * gap in the list cannot be mistaken for a gap in the reading.
 */
export function matchStock(wanted = [], stock = []) {
  const shelf = new Map();

  for (const unit of stock) {
    const key = `${skuKey(unit.sku)}|${sizeKey(unit.size)}`;
    if (!shelf.has(key)) shelf.set(key, []);
    shelf.get(key).push(unit);
  }

  return wanted.map((row) => {
    const found = [...(shelf.get(`${row.sku}|${row.size}`) || [])].sort((a, b) => {
      const left = Number(a.cost);
      const right = Number(b.cost);

      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;

      return text(a.source).localeCompare(text(b.source));
    });

    return { sku: row.sku, size: row.size, line: row.line, options: found };
  });
}

/* ---------------- the three shelves, in one shape ---------------- */

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
};

/*
 * Our own stock, out of the Airtable Inventory Units, as unitRow leaves it.
 *
 * Only what is actually free: a unit promised to an order is not an answer to
 * a new one. Its cost is what we paid, because the pair is already ours.
 */
export const warehouseOption = (unit) => ({
  source: "Warehouse",
  id: text(unit.id),
  reference: text(unit.item_id),
  sku: skuKey(unit.sku),
  size: sizeKey(unit.size),
  product_name: text(unit.product_name),
  seller: "",
  quantity: 1,
  cost: money(unit.cost),
  cost_means: "what we paid for it",
  vat_type: text(unit.vat_type),
  location: text(unit.location),
  note: text(unit.condition)
});

/*
 * A consignor's pair. His asking price is our cost, not his payout: the
 * payout is what is left after us, and offering on it would be offering on
 * money we never had.
 */
export const consignmentOption = (row) => ({
  source: "Consignment",
  id: text(row.id),
  reference: "",
  sku: skuKey(row.sku),
  size: sizeKey(row.size),
  product_name: text(row.product_name),
  seller: text(row.seller_id),
  quantity: Number(row.quantity) || 0,
  cost: money(row.ask),
  cost_means: "what the consignor asks",
  vat_type: text(row.vat_type),
  // A partner's pair is already on our shelf; a consignor's still has to come.
  location: row.partner ? "Our warehouse" : "With the consignor",
  note: ""
});

/*
 * Partner stock. Only what is on the shelf - reserved is promised to a deal
 * that may still happen, and sold or forwarded is gone.
 */
export const partnerOption = (row) => ({
  source: "Partner",
  id: text(row.id),
  reference: "",
  sku: skuKey(row.sku),
  size: sizeKey(row.size),
  product_name: text(row.product_name),
  seller: text(row.seller_id),
  quantity: 1,
  cost: money(row.partner_price),
  cost_means: "what the partner charges",
  vat_type: text(row.vat_type),
  location: "Our warehouse",
  note: text(row.mode)
});

/*
 * Everything we can actually get hold of, in one list.
 *
 * Each source decides for itself what "available" means, because each means
 * something different by it, and a pair that is spoken for must not turn up
 * as an offer.
 */
export function shelf({ warehouse = [], consignment = [], partner = [] } = {}) {
  return [
    ...warehouse
      .filter((unit) => text(unit.availability).toLowerCase() === "available")
      .map(warehouseOption),
    ...consignment
      .filter((row) => (Number(row.quantity) || 0) > 0)
      .map(consignmentOption),
    ...partner
      .filter((row) => text(row.status) === "in_stock")
      .map(partnerOption)
  ];
}

// admin/stockRefine.js
//
// Sorting and filtering, the same on all three stock screens (07-10-2026):
// Inventory, Partner Stock and Consignment Stock.
//
// Each screen keeps its own views and its own search. This adds what was
// asked for on top of them - sort on size, price, name and so on, and
// narrow down on brand, size, VAT type and the one or two things only that
// screen has - and the export reads the very same rows, so a file never
// holds something other than what the screen showed.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/*
 * Where a size falls in a list.
 *
 * Shoe sizes are numbers with the odd third ("42 2/3") or half ("36.5", or
 * "36,5" when someone typed it the Dutch way). Clothing is letters. Anything
 * else - "OS", a typo - goes last, alphabetically, so it is never lost in
 * the middle.
 */
const LETTERS = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];

export function sizeKey(size) {
  const plain = text(size).toUpperCase().replace(/^(EU|US|UK)\s*/, "");
  const letter = LETTERS.indexOf(plain);

  if (letter >= 0) return [1, letter];

  const number = plain.replace(",", ".").match(/^(\d+(?:\.\d+)?)(?:\s+(\d)\/(\d))?/);

  if (number) return [0, Number(number[1]) + (number[2] ? Number(number[2]) / Number(number[3]) : 0)];

  return [2, 0];
}

export function compareSizes(a, b) {
  const [groupA, valueA] = sizeKey(a);
  const [groupB, valueB] = sizeKey(b);

  return groupA - groupB || valueA - valueB || text(a).localeCompare(text(b), "nl");
}

/*
 * What each screen's rows call the things we sort and filter on.
 *
 * `facets` are the dropdowns: every value that occurs in the current view,
 * so a dropdown never offers something that would leave the table empty.
 * Consignment Stock filters its single offers before they are grouped into
 * pairs, which is why its accessors read an offer's fields - a consignor
 * filter then picks that consignor's offer, not a pair he happens to be the
 * cheapest on.
 */
export const KINDS = {
  inventory: {
    price: (row) => row.cost,
    date: (row) => row.purchase_date,
    facets: {
      brand: (row) => row.brand,
      size: (row) => row.size,
      vat: (row) => row.vat_type,
      kind: (row) => row.kind,
      location: (row) => row.location
    }
  },
  partner: {
    price: (row) => row.partner_price,
    date: (row) => row.received_at,
    facets: {
      brand: (row) => row.brand,
      size: (row) => row.size,
      vat: (row) => row.vat_type,
      mode: (row) => row.mode,
      partner: (row) => row.seller_id
    }
  },
  consignment: {
    price: (row) => row.compare,
    date: (row) => row.added_at,
    facets: {
      brand: (row) => row.brand,
      size: (row) => row.size,
      consignor: (row) => row.seller_id
    }
  }
};

export const SORTS = ["size", "price", "name", "sku", "brand", "date"];

// Only what the screen knows about, cleaned, whatever the browser sent.
export function readRefine(query = {}, kind) {
  const config = KINDS[kind];
  const refine = { sort: "", dir: "asc", min: null, max: null };

  for (const name of Object.keys(config.facets)) refine[name] = text(query[name]).slice(0, 100);

  if (SORTS.includes(text(query.sort))) refine.sort = text(query.sort);
  if (text(query.dir) === "desc") refine.dir = "desc";

  const min = Number(query.min);
  const max = Number(query.max);

  if (text(query.min) && Number.isFinite(min)) refine.min = min;
  if (text(query.max) && Number.isFinite(max)) refine.max = max;

  return refine;
}

// Every value the view holds, per dropdown, in an order a person expects.
export function facetsOf(rows, kind) {
  const out = {};

  for (const [name, read] of Object.entries(KINDS[kind].facets)) {
    const values = [...new Set(rows.map((row) => text(read(row))).filter(Boolean))];
    out[name] = values.sort(name === "size" ? compareSizes : (a, b) => a.localeCompare(b, "nl"));
  }

  return out;
}

export function filterRows(rows, kind, refine = {}) {
  const config = KINDS[kind];
  const picked = Object.keys(config.facets).filter((name) => text(refine[name]));

  return rows.filter((row) => {
    for (const name of picked) {
      if (text(config.facets[name](row)) !== text(refine[name])) return false;
    }

    const price = Number(config.price(row));

    if (refine.min !== null && refine.min !== undefined && !(price >= refine.min)) return false;
    if (refine.max !== null && refine.max !== undefined && !(price <= refine.max)) return false;

    return true;
  });
}

/*
 * The chosen order, with a sensible second key so rows that tie do not
 * shuffle between two loads: a size list reads per shoe, a name list per
 * size within the shoe.
 *
 * Returns false when no sort was chosen, so a screen keeps its own order -
 * Inventory's checks list is worst-first on purpose.
 */
export function sortRows(rows, kind, refine = {}) {
  if (!refine.sort) return false;

  const config = KINDS[kind];
  const flip = refine.dir === "desc" ? -1 : 1;
  const name = (row) => text(row.product_name);
  const bySku = (a, b) => text(a.sku).localeCompare(text(b.sku), "nl");
  const bySize = (a, b) => compareSizes(a.size, b.size);

  // Empty prices and dates go last whichever way round.
  const missingLast = (read) => (a, b) => {
    const left = read(a);
    const right = read(b);

    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;

    return (left < right ? -1 : left > right ? 1 : 0) * flip;
  };

  const price = (row) => {
    const value = config.price(row);
    return value === null || value === undefined || value === "" ? null : Number(value);
  };

  const date = (row) => text(config.date(row)) || null;

  const order = {
    size: (a, b) => bySize(a, b) * flip || bySku(a, b),
    price: (a, b) => missingLast(price)(a, b) || bySku(a, b) || bySize(a, b),
    name: (a, b) => name(a).localeCompare(name(b), "nl") * flip || bySize(a, b),
    sku: (a, b) => bySku(a, b) * flip || bySize(a, b),
    brand: (a, b) => text(a.brand).localeCompare(text(b.brand), "nl") * flip || name(a).localeCompare(name(b), "nl") || bySize(a, b),
    date: (a, b) => missingLast(date)(a, b) || bySku(a, b) || bySize(a, b)
  }[refine.sort];

  rows.sort(order);
  return true;
}

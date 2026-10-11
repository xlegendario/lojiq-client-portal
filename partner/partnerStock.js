// partner/partnerStock.js
//
// The Stock tab of the partner dashboard: the partner's own pairs, counted two
// ways.
//
// By product: what is on the shelf now, per SKU, per size, and per size the
// days those pairs came in. By arrival: every day pairs came in, with how many
// came, how many we sold for him, how many he forwarded, and how many are
// still here. A day stands in for a delivery; the partner asked to keep his
// deliveries apart, and the day they were scanned in is how he recognises
// one.
//
// Only counts leave the server: no prices, no buyers, no order references.

import { compareSizes } from "../admin/stockRefine.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

// Physically here. A reserved pair is promised to a deal that is not
// confirmed yet, but it is still on our shelf.
const ON_SHELF = new Set(["in_stock", "reserved"]);
const LEFT = new Set(["in_stock", "reserved", "sold", "forwarded"]);

const PAGE = 1000;
const COLUMNS = "id,sku,size,product_name,brand,image_url,status,received_at,warehouse";

// The calendar day a pair came in, on the clock of the warehouse.
const dayOf = (() => {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" });

  return (iso) => {
    const date = new Date(iso);

    return Number.isNaN(date.getTime()) ? "" : format.format(date);
  };
})();

const bump = (map, key, make) => {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
};

/*
 * rows: partner_stock rows of one partner.
 * Returns { totals, products, arrivals } ready for the page.
 */
export function summarizeStock(rows) {
  const products = new Map();
  const arrivals = new Map();
  const warehouses = new Map();

  let onShelf = 0;

  for (const row of rows || []) {
    const status = text(row.status);

    if (!LEFT.has(status)) continue;

    const sku = text(row.sku).toUpperCase();
    const size = text(row.size);
    const day = dayOf(row.received_at);
    const warehouse = text(row.warehouse) || "lojiq";
    const here = ON_SHELF.has(status);

    // By arrival: every pair that ever came in, whatever became of it.
    const arrival = bump(arrivals, `${day}|${warehouse}`, () => ({
      date: day,
      warehouse,
      received: 0,
      left: 0,
      sold: 0,
      forwarded: 0,
      products: new Map()
    }));

    arrival.received += 1;
    if (here) arrival.left += 1;
    if (status === "sold") arrival.sold += 1;
    if (status === "forwarded") arrival.forwarded += 1;

    // Per SKU within that day: a day often brings more than one product, and
    // the partner recognises a delivery by what was in it.
    const arrivalProduct = bump(arrival.products, sku, () => ({
      sku,
      name: text(row.product_name),
      image: text(row.image_url),
      received: 0,
      left: 0,
      sold: 0,
      forwarded: 0,
      sizes: new Map()
    }));
    arrivalProduct.received += 1;
    if (here) arrivalProduct.left += 1;
    if (status === "sold") arrivalProduct.sold += 1;
    if (status === "forwarded") arrivalProduct.forwarded += 1;
    if (!arrivalProduct.image && row.image_url) arrivalProduct.image = text(row.image_url);

    const arrivalSize = bump(arrivalProduct.sizes, size, () => ({ size, received: 0, left: 0 }));
    arrivalSize.received += 1;
    if (here) arrivalSize.left += 1;

    if (!here) continue;

    // By product: only what is on the shelf now.
    onShelf += 1;
    warehouses.set(warehouse, (warehouses.get(warehouse) || 0) + 1);

    const product = bump(products, sku, () => ({
      sku,
      name: text(row.product_name),
      brand: text(row.brand),
      image: text(row.image_url),
      count: 0,
      warehouses: new Map(),
      sizes: new Map()
    }));

    product.count += 1;
    product.warehouses.set(warehouse, (product.warehouses.get(warehouse) || 0) + 1);
    if (!product.name && row.product_name) product.name = text(row.product_name);
    if (!product.image && row.image_url) product.image = text(row.image_url);

    const sizeEntry = bump(product.sizes, size, () => ({ size, count: 0, onHold: 0, warehouses: new Map(), arrivals: new Map() }));
    sizeEntry.count += 1;
    sizeEntry.warehouses.set(warehouse, (sizeEntry.warehouses.get(warehouse) || 0) + 1);
    if (status === "reserved") sizeEntry.onHold += 1;

    const sizeArrival = bump(sizeEntry.arrivals, `${day}|${warehouse}`, () => ({ date: day, warehouse, count: 0 }));
    sizeArrival.count += 1;
  }

  // Per warehouse, the biggest first: "Lojiq 12 · H23 13" reads as a split.
  const byWarehouse = (map) => [...map].map(([warehouse, count]) => ({ warehouse, count })).sort((a, b) => b.count - a.count || a.warehouse.localeCompare(b.warehouse));

  const newestFirst = (a, b) => b.date.localeCompare(a.date) || a.warehouse.localeCompare(b.warehouse);

  return {
    totals: {
      on_shelf: onShelf,
      products: products.size,
      warehouses: byWarehouse(warehouses)
    },
    products: [...products.values()]
      .map((product) => ({
        ...product,
        warehouses: byWarehouse(product.warehouses),
        sizes: [...product.sizes.values()]
          .sort((a, b) => compareSizes(a.size, b.size))
          .map((entry) => ({
            ...entry,
            warehouses: byWarehouse(entry.warehouses),
            arrivals: [...entry.arrivals.values()].sort((a, b) => a.date.localeCompare(b.date))
          }))
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    arrivals: [...arrivals.values()]
      .map((arrival) => ({
        ...arrival,
        products: [...arrival.products.values()]
          .map((product) => ({ ...product, sizes: [...product.sizes.values()].sort((a, b) => compareSizes(a.size, b.size)) }))
          .sort((a, b) => b.left - a.left || b.received - a.received || a.name.localeCompare(b.name))
      }))
      .sort(newestFirst)
  };
}

// Every pair of one partner, a page at a time: Supabase hands out at most a
// thousand rows per request, and a partner has more than that.
export async function loadPartnerPairs(db, sellerRecordId) {
  const rows = [];
  const seller = encodeURIComponent(sellerRecordId);

  for (let offset = 0; ; offset += PAGE) {
    const page = await db.get(
      `partner_stock?select=${COLUMNS}&seller_record_id=eq.${seller}&order=id.asc&limit=${PAGE}&offset=${offset}`
    );

    rows.push(...(page || []));
    if (!page || page.length < PAGE) return rows;
  }
}

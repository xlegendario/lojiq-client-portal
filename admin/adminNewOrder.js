// admin/adminNewOrder.js
//
// New Order: a store order made by hand, for a sale that never came through
// the store's Shopify (Tienne Milano's "Private" orders).
//
// They used to be made by duplicating the previous one in Airtable, which
// copied what belongs to that order alone. Fulfillment Sent? came along, so
// the invoice step took the new order for one Make had already invoiced and
// sent nothing (ORD-028069, ORD-030112). This writes only what a new order
// needs and leaves the rest to the engine, as for an order from Shopify:
//
//   Pending + Match Risk Level Low   autoAllocateBestUnit looks for a pair,
//                                    partner stock included
//   Custom Offer + Offer Accepted?   the price the store pays; the consignor
//                                    confirm keeps it (KC d32aff1) and
//                                    calculateLinkedUnitPrice uses it, for a
//                                    fixed-price store through Offer To Store
//   Selling Price                    Target and Maximum Buying Price are
//                                    formulas on it; without it the
//                                    consignment offer has no ceiling
//
// With a seller and payout given, the pair is already known: a Manual Deal is
// made the way that button makes one, and auto_allocate_attempted_at is set
// so the engine does not go looking for a second pair at the same time.

import { ACTIONS } from "./adminActions.js";
import { TABLES } from "./adminViews.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export class NewOrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const quote = (value) => `'${text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const amount = (value) => {
  const n = Number(text(value).replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
};

/*
 * The next "Private N" for a store: one past the highest number it has, by
 * number and not by text, so Private 10 follows Private 9. A store without
 * one starts at 1.
 */
export function nextPrivateNumber(orderNumbers) {
  let highest = 0;

  for (const value of orderNumbers || []) {
    const match = /^\s*private\s+(\d+)\s*$/i.exec(text(value));
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  return `Private ${highest + 1}`;
}

export function newOrderFields({ merchantId, orderNumber, sku, size, product, sellingPrice, storePrice, now = new Date() }) {
  const name = text(product?.product_name);
  const image = text(product?.image);

  return {
    Client: [merchantId],
    "Shopify Order Number": orderNumber,
    "SKU (Soft)": text(sku).toUpperCase(),
    Size: text(size),
    "Product Name": name,
    // No Shopify product behind a private order; the name is ours either way.
    "Shopify Product Name": name,
    Brand: text(product?.brand),
    ...(image ? { Picture: [{ url: image }] } : {}),
    "Selling Price": sellingPrice,
    "Custom Offer": storePrice,
    "Offer Accepted?": true,
    "Order Date": now.toISOString(),
    "Order Source": "Shopify",
    "Outsourcing Region": "EU Only",
    "Automation Engine Enabled": true,
    "Match Risk Level": "Low",
    "Fulfillment Status": "Pending"
  };
}

export async function lookupProduct({ sku, deps }) {
  const clean = text(sku).toUpperCase();
  if (!clean) throw new NewOrderError("Enter a SKU.");

  const answer = await deps.callKc("/api/internal/sku-lookup", { sku: clean });

  return answer?.found
    ? { found: true, source: answer.source, product_name: text(answer.product_name), brand: text(answer.brand), image: text(answer.image) }
    : { found: false };
}

export async function listMerchants(deps) {
  const merchants = [];
  let offset = "";

  do {
    const page = await deps.airtable.select(TABLES.merchants, { fields: ["Store Name"], pageSize: 100, offset });

    for (const record of page.records) {
      const name = text(record.fields?.["Store Name"]);
      if (name) merchants.push({ id: record.id, name });
    }

    offset = page.offset;
  } while (offset);

  return merchants.sort((a, b) => a.name.localeCompare(b.name));
}

async function privateNumbersOf(storeName, deps) {
  const numbers = [];
  let offset = "";

  do {
    const page = await deps.airtable.select(TABLES.store, {
      formula: `AND(TRIM({Store Name} & '') = ${quote(storeName)}, FIND('private', LOWER({Shopify Order Number} & '')))`,
      fields: ["Shopify Order Number"],
      pageSize: 100,
      offset
    });

    numbers.push(...page.records.map((record) => record.fields?.["Shopify Order Number"]));
    offset = page.offset;
  } while (offset);

  return numbers;
}

export async function createNewOrder({ input, deps, now = new Date() }) {
  const merchantId = text(input.store_id);
  const sku = text(input.sku).toUpperCase();
  const size = text(input.size);
  const sellingPrice = amount(input.selling_price);
  const storePrice = amount(input.store_price);

  if (!/^rec[A-Za-z0-9]{14}$/.test(merchantId)) throw new NewOrderError("Choose the store.");
  if (!sku) throw new NewOrderError("Enter the SKU.");
  if (!size) throw new NewOrderError("Enter the size.");
  if (sellingPrice === null) throw new NewOrderError("Enter the selling price: the buying prices are worked out from it.");
  if (storePrice === null) throw new NewOrderError("Enter what the store pays.");

  const withDeal = Boolean(text(input.seller) || text(input.payout));

  // byIds answers the fields themselves, keyed by record id.
  const merchantFields = (await deps.airtable.byIds(TABLES.merchants, [merchantId], ["Store Name"])).get(merchantId);
  const storeName = text(merchantFields?.["Store Name"]);
  if (!storeName) throw new NewOrderError("That store was not found.", 404);

  // Name and brand as typed win; otherwise the lookup fills them.
  const looked = await lookupProduct({ sku, deps }).catch(() => ({ found: false }));
  const product = {
    product_name: text(input.product_name) || looked.product_name || "",
    brand: text(input.brand) || looked.brand || "",
    image: looked.image || ""
  };

  if (!product.product_name) {
    throw new NewOrderError(`No product found for ${sku} in SKU Master or on StockX. Type the product name and brand yourself.`);
  }

  const orderNumber = nextPrivateNumber(await privateNumbersOf(storeName, deps));
  const fields = newOrderFields({ merchantId, orderNumber, sku, size, product, sellingPrice, storePrice, now });

  if (withDeal) fields.auto_allocate_attempted_at = now.toISOString();

  const created = await deps.airtable.create(TABLES.store, fields);
  const freshFields =
    (await deps.airtable.byIds(TABLES.store, [created.id], ["Order ID", "Fulfillment Status", "Custom Offer", "Offer Accepted?"])).get(created.id) ||
    created.fields ||
    {};
  const fresh = { id: created.id, fields: freshFields };
  const orderId = text(freshFields["Order ID"]) || created.id;

  let dealNote = "";

  if (withDeal) {
    try {
      const deal = await ACTIONS.manual_deal.run({
        record: fresh,
        input: { seller: input.seller, payout: input.payout, vat: input.vat },
        deps
      });
      dealNote = ` ${deal.message}`;
    } catch (err) {
      // The order stands; only the deal is missing, and it can be made with
      // Manual Deal on the order itself.
      dealNote = ` The order is made, but the Manual Deal was not: ${err.message} Use Manual Deal on ${orderId}.`;
    }
  }

  return {
    id: created.id,
    order_id: orderId,
    order_number: orderNumber,
    message:
      `${orderId} made for ${storeName}: ${orderNumber}, ${product.product_name} ${size}, store pays € ${storePrice}.` +
      (withDeal ? dealNote : " The engine now looks for a pair."),
    changed: { order: created.id, order_number: orderNumber, store: storeName, sku, size, custom_offer: storePrice, selling_price: sellingPrice, manual_deal: withDeal }
  };
}

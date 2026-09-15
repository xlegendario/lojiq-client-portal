// admin/adminPayouts.js
//
// Payouts: what we still owe sellers. Every Inventory Unit on Payment Status
// "To Pay", grouped per seller with their Payout Info, so it can be paid by
// hand in the bank and then marked Paid here.
//
// No export and no IBAN parsing, on purpose: Dario pays each seller himself
// and only needs the list, the amount and the payout details in one place.
// Sellers Database is only read.
//
// Note: "To Pay" is set as soon as a unit is sold or allocated, before it has
// shipped. Shipping Status is shown and filterable for that reason; nothing
// is filtered out by default.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const UNIT_TABLE = "Inventory Units";
const SELLERS = "Sellers Database";

export const PAYOUT_FIELDS = [
  "Item ID", "Type", "Product Name", "SKU", "Size", "Picture", "VAT Type",
  "Purchase Price", "Shipping Deduction", "Final Purchase Price", "Payment Status", "Purchase Date",
  "Verification Status", "Availability Status",
  "Seller ID", "Seller Name", "Seller Company Name", "Seller ID (Lookup)",
  "Unfulfilled Orders Log", "Shopify Order Number", "Store Name", "Shipping Status", "Tracking URL (from Unfulfilled Orders Log)",
  "Member WTBs", "Member WTB ID", "Shipping Status (MWTB)", "Tracking URL (MWTB)"
];

export const SELLER_FIELDS = ["Seller ID", "Full Name", "Company Name", "Discord", "Payout Info"];

export const SHIPPING_FILTERS = ["all", "shipped", "delivered", "shipped_or_delivered", "not_shipped"];

class PayoutError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const money = (value) => {
  const n = Number(first(value));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const webUrl = (value) => {
  const raw = text(first(value));
  return /^https?:\/\//i.test(raw) ? raw : "";
};

async function selectAll(airtable, table, options) {
  const records = [];
  let offset = "";

  do {
    const page = await airtable.select(table, { ...options, pageSize: 100, offset });
    records.push(...page.records);
    offset = page.offset;
  } while (offset && records.length < 5000);

  return records;
}

function unitRow(record, sellers, orderIds = new Map()) {
  const f = record.fields || {};
  const sellerId = first(f["Seller ID"]);
  const seller = sellers.get(sellerId) || {};

  const onOrder = Boolean(first(f["Unfulfilled Orders Log"]));
  const onWtb = Boolean(first(f["Member WTBs"])) || Boolean(first(f["Member WTB ID"]));
  const picture = Array.isArray(f.Picture) && f.Picture[0] ? f.Picture[0].thumbnails?.small?.url || f.Picture[0].url || "" : "";

  let reference = "";
  // The unit has no Order ID lookup; it is read from the linked order.
  const orderId = onOrder ? text(orderIds.get(first(f["Unfulfilled Orders Log"]))) : "";
  if (onOrder) reference = [orderId, text(first(f["Store Name"])), text(first(f["Shopify Order Number"]))].filter(Boolean).join(" · ");
  else if (onWtb) reference = text(first(f["Member WTB ID"]));

  return {
    id: record.id,
    seller_record_id: sellerId || "",
    item: text(f["Item ID"]),
    type: text(f.Type),
    product: text(f["Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    picture,
    vat: text(f["VAT Type"]),
    purchase: money(f["Purchase Price"]),
    deduction: money(f["Shipping Deduction"]),
    amount: money(f["Final Purchase Price"]),
    verification: text(f["Verification Status"]),
    availability: text(f["Availability Status"]),
    reference,
    shipping: onOrder ? text(first(f["Shipping Status"])) : onWtb ? text(first(f["Shipping Status (MWTB)"])) : "",
    track: onOrder ? webUrl(f["Tracking URL (from Unfulfilled Orders Log)"]) : onWtb ? webUrl(f["Tracking URL (MWTB)"]) : "",
    date: text(f["Purchase Date"]),
    seller: {
      id: text(seller["Seller ID"]) || text(first(f["Seller ID (Lookup)"])),
      // Company Name when there is one, otherwise the person.
      name: text(seller["Company Name"]) || text(seller["Full Name"]) || text(first(f["Seller Company Name"])) || text(first(f["Seller Name"])) || "Unknown seller",
      person: text(seller["Full Name"]) || text(first(f["Seller Name"])),
      // The Discord name is how most sellers are recognised.
      discord: text(seller.Discord),
      payout_info: text(seller["Payout Info"])
    }
  };
}

function matchesShipping(row, filter) {
  switch (filter) {
    case "shipped": return row.shipping === "Shipped";
    case "delivered": return row.shipping === "Delivered";
    case "shipped_or_delivered": return row.shipping === "Shipped" || row.shipping === "Delivered";
    case "not_shipped": return row.shipping !== "Shipped" && row.shipping !== "Delivered";
    default: return true;
  }
}

async function loadSellers(airtable, ids) {
  const sellers = new Map();
  const unique = [...new Set(ids.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 50) {
    const found = await airtable.byIds(SELLERS, unique.slice(i, i + 50), SELLER_FIELDS);
    for (const [id, fields] of found) sellers.set(id, fields);
  }

  return sellers;
}

async function loadOrderIds(airtable, ids) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 50) {
    const found = await airtable.byIds("Unfulfilled Orders Log", unique.slice(i, i + 50), ["Order ID"]);
    for (const [id, fields] of found) out.set(id, fields["Order ID"]);
  }

  return out;
}

// Every unit on To Pay, grouped per seller: the seller owed the most on top.
export async function loadPayouts(airtable, { shipping = "all", type = "", search = "" } = {}) {
  const records = await selectAll(airtable, UNIT_TABLE, { formula: `{Payment Status} = 'To Pay'`, fields: PAYOUT_FIELDS });
  const sellers = await loadSellers(airtable, records.map((record) => first(record.fields?.["Seller ID"])));

  const needle = text(search).toLowerCase();
  const orderIds = await loadOrderIds(airtable, records.map((record) => first(record.fields?.["Unfulfilled Orders Log"])));
  const allRows = records.map((record) => unitRow(record, sellers, orderIds));

  const rows = allRows.filter((row) => {
    if (!matchesShipping(row, shipping)) return false;
    if (type && row.type !== type) return false;
    if (needle && ![row.seller.name, row.seller.person, row.seller.discord, row.seller.id, row.item, row.reference, row.product, row.sku].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });

  const groups = new Map();

  for (const row of rows) {
    const key = row.seller_record_id || `unknown:${row.seller.name}`;

    if (!groups.has(key)) groups.set(key, { key, seller: row.seller, rows: [], total: 0 });

    const group = groups.get(key);
    group.rows.push(row);
    group.total = Math.round((group.total + row.amount) * 100) / 100;
  }

  const list = [...groups.values()];
  for (const group of list) group.rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  list.sort((a, b) => b.total - a.total);

  return {
    groups: list,
    count: rows.length,
    total: Math.round(list.reduce((sum, group) => sum + group.total, 0) * 100) / 100,
    types: [...new Set(allRows.map((row) => row.type).filter(Boolean))].sort()
  };
}

// Mark these units Paid: the seller has been paid by hand in the bank.
export async function markUnitsPaid({ ids, airtable }) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(text).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];

  if (!clean.length) throw new PayoutError("Select at least one unit.", 400);
  if (clean.length > 200) throw new PayoutError("Mark at most 200 units paid at once.", 400);

  const found = await airtable.byIds(UNIT_TABLE, clean, ["Item ID", "Payment Status", "Final Purchase Price", "Seller ID", "Seller ID (Lookup)"]);

  for (const id of clean) {
    const f = found.get(id);
    if (!f) throw new PayoutError("One of the selected units no longer exists. Refresh the list.", 404);
    if (text(f["Payment Status"]) !== "To Pay") {
      throw new PayoutError(`${text(f["Item ID"]) || id} is not on To Pay anymore (${text(f["Payment Status"]) || "empty"}). Refresh the list.`);
    }
  }

  const sellerIds = new Set(clean.map((id) => first(found.get(id)["Seller ID"]) || ""));
  if (sellerIds.size > 1) throw new PayoutError("Mark units paid one seller at a time.", 400);

  for (const id of clean) {
    await airtable.update(UNIT_TABLE, id, { "Payment Status": "Paid" });
  }

  const total = Math.round(clean.reduce((sum, id) => sum + money(found.get(id)["Final Purchase Price"]), 0) * 100) / 100;

  return {
    count: clean.length,
    total,
    seller: text(first(found.get(clean[0])["Seller ID (Lookup)"])),
    units: clean.map((id) => ({ id, item: text(found.get(id)["Item ID"]) }))
  };
}

export { PayoutError };

// admin/adminViews.js
//
// Every list in the admin portal, described once: which table it reads, which
// records belong on the tab, and which columns it shows. The server builds its
// Airtable queries from this and the page draws its tables from the same
// description, so a tab or a column is added in one place.
//
// Tabs and column names follow the Whimsical Dario and his partner drew.
// Where a Whimsical name is not the Airtable field name, the field is chosen
// from its formula:
//   Target Price            -> Target Buying Price   (store, target margin)
//   Maximum Price           -> Maximum Buying Price  (store, minimum margin)
//   Max Buying Price        -> Final Outsource Buying Price          (max seller payout)
//   Max Buying Price (VAT0) -> Final Outsource Buying Price (VAT 0%)
//   Payment Status          -> Invoice Status on a store order: what the store
//                              pays us. "Payment Status" on the order log and
//                              on units is the seller side. Only on Member
//                              WTBs is the buyer's payment called Payment Status.

export const TABLES = {
  store: "Unfulfilled Orders Log",
  queue: "Pending Intake Queue",
  mwtb: "Member WTBs",
  units: "Inventory Units",
  merchants: "Merchants"
};

/* ---------------- formula helpers ---------------- */

// Airtable string literal. Backslashes first, or an escaped quote could be
// turned back into a closing one.
export function formulaString(value) {
  const text = value === null || value === undefined ? "" : String(value);

  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const anyOf = (field, values) =>
  `OR(${values.map((value) => `{${field}} = ${formulaString(value)}`).join(",")})`;

/* ---------------- columns ---------------- */

// A column reads one field. `type` decides how the page draws it; `link` names
// a second field holding the address the value should open.
const col = (key, label, field, type = "text", extra = {}) => ({ key, label, field, type, ...extra });

const STORE = {
  orderId: col("order_id", "Order ID", "Order ID", "id"),
  store: col("store", "Store Name", "Store Name"),
  shopify: col("shopify", "Shopify Order Number", "Shopify Order Number"),
  product: col("product", "Product", "Shopify Product Name"),
  sku: col("sku", "SKU", "SKU", "mono"),
  size: col("size", "Size", "Size"),
  selling: col("selling", "Selling Price", "Selling Price", "money"),
  date: col("date", "Date", "Order Date", "date"),
  fulfillment: col("fulfillment", "Fulfillment Status", "Fulfillment Status", "status"),

  target: col("target", "Target Price", "Target Buying Price", "money"),
  maximum: col("maximum", "Maximum Price", "Maximum Buying Price", "money"),
  maxBuying: col("max_buying", "Max Buying Price", "Final Outsource Buying Price", "money"),
  maxBuyingVat0: col("max_buying_vat0", "Max Buying Price (VAT0)", "Final Outsource Buying Price (VAT 0%)", "money"),
  offer: col("offer", "Offer to Store", "Offer To Store", "money"),
  eta: col("eta", "Offer ETA", "Estimated Time"),
  offerVat: col("offer_vat", "Offer VAT Type", "Offer VAT Type"),

  finalPrice: col("final_price", "Final Price", "Final Buying Price", "money"),
  fulfilmentDate: col("fulfilment_date", "Fulfillment Date", "Fulfilment Date", "date"),
  purchase: col("purchase", "Purchase Price", "Purchase Price (Lookup)", "money"),
  vat: col("vat", "VAT Type", "VAT Type"),
  seller: col("seller", "Seller", "Seller ID (Lookup)", "seller"),

  invoice: col("invoice", "Invoice Status", "Invoice Status", "status"),

  shipping: col("shipping", "Shipping Status", "Shipping Status", "status"),
  label: col("label", "Shipping Label", "Shipping Label URL (Permanent)", "url", { fallback: "Shipping Label" }),
  tracking: col("tracking", "Tracking Number", "Tracking Number", "mono", { link: "Tracking URL" }),
  notes: col("notes", "Shipping Notes", "Shipping Notes"),
  issue: col("issue", "Issue Note", "Issue Notes")
};

const QUEUE = {
  queueId: col("queue_id", "Queued Order ID", "Queued Order ID", "id"),
  store: col("store", "Store Name", "Store Name"),
  shopify: col("shopify", "Shopify Order Number", "Shopify Order Number"),
  product: col("product", "Product", "Shopify Product Name"),
  sku: col("sku", "SKU", "SKU (Soft)", "mono"),
  size: col("size", "Size", "Size"),
  selling: col("selling", "Selling Price", "Shopify Selling Price", "money"),
  date: col("date", "Date", "Order Date", "date"),
  age: col("age", "Order Age (Hours)", "Order Age (Hours)", "hours")
};

const MWTB = {
  wtbId: col("wtb_id", "Member WTB ID", "Member WTB ID", "id"),
  buyer: col("buyer", "Buyer", "Buyer Name"),
  product: col("product", "Product", "Product Name"),
  sku: col("sku", "SKU", "SKU", "mono"),
  size: col("size", "Size", "Size"),
  maxPrice: col("max_price", "Max Price", "Max Price", "money"),
  date: col("date", "Date", "Date", "date"),
  fulfillment: col("fulfillment", "Fulfillment Status", "Fulfillment Status", "status"),

  lowest: col("lowest", "Current Lowest Offer", "Current Lowest Offer", "money"),
  offer: col("offer", "Offer to Buyer", "Offer To Buyer", "money"),
  eta: col("eta", "Offer ETA", "", "fixed", { value: "24 - 72 hours" }),
  offerVat: col("offer_vat", "Offer VAT Type", "Lowest Offer VAT Type"),

  finalPrice: col("final_price", "Final Price", "Final Buying Price", "money"),
  purchase: col("purchase", "Purchase Price", "", "unit", { unitField: "Purchase Price", unitType: "money" }),
  vat: col("vat", "VAT Type", "VAT Type"),
  seller: col("seller", "Seller", "", "seller"),

  payment: col("payment", "Payment Status", "Payment Status", "status"),

  shipping: col("shipping", "Shipping Status", "Shipping Status", "status"),
  label: col("label", "Shipping Label", "Shipping Label Permanent URL", "url", { fallback: "Shipping Label" }),
  tracking: col("tracking", "Tracking Number", "Tracking Number", "mono", { link: "Tracking URL" })
};

/* ---------------- statuses ---------------- */

const OPEN = ["Pending", "Outsource"];

// "Fulfilled" to Dario and his partner means: we have a unit for it. From
// Allocated on, whatever happens after.
const STORE_FULFILLED = ["Allocated", "Awaiting Label", "Requested Label", "Label Error", "Ready to Ship", "Fulfilled"];
const MWTB_FULFILLED = ["Allocated", "Requested Label", "Ready to Ship", "Fulfilled"];

/* ---------------- views ---------------- */

const storeBase = [STORE.orderId, STORE.store, STORE.shopify, STORE.product, STORE.sku, STORE.size, STORE.selling, STORE.date];
const storePrices = [STORE.target, STORE.maximum, STORE.maxBuying, STORE.maxBuyingVat0, STORE.offer, STORE.eta, STORE.offerVat];
const storeDeal = [STORE.finalPrice, STORE.fulfilmentDate, STORE.purchase, STORE.vat, STORE.seller];
const storeShip = [STORE.shipping, STORE.label, STORE.tracking, STORE.notes];

const mwtbBase = [MWTB.wtbId, MWTB.buyer, MWTB.product, MWTB.sku, MWTB.size, MWTB.maxPrice, MWTB.date];
const mwtbPrices = [MWTB.lowest, MWTB.offer, MWTB.eta, MWTB.offerVat];
const mwtbDeal = [MWTB.finalPrice, MWTB.purchase, MWTB.vat, MWTB.seller];
const mwtbShip = [MWTB.shipping, MWTB.label, MWTB.tracking];

const delivered = `{Shipping Status} = 'Delivered'`;

const TABS = [
  // ----- Store Orders -----
  {
    key: "queued", section: "store", source: "queue", label: "Queued Orders",
    formula: `AND(NOT({Order Taken?}), NOT({Queue Skipped?}))`,
    columns: Object.values(QUEUE),
    sort: "Order Date"
  },
  {
    key: "general", section: "store", source: "store", label: "General",
    formula: "",
    columns: [...storeBase, STORE.fulfillment]
  },
  {
    key: "open", section: "store", source: "store", label: "Open Orders",
    formula: anyOf("Fulfillment Status", OPEN),
    columns: [...storeBase, ...storePrices]
  },
  {
    key: "offers", section: "store", source: "store", label: "Offers",
    // Same rule as the store's own Offers tab in the client portal.
    formula: `AND(${anyOf("Fulfillment Status", OPEN)}, {Offer To Store} != BLANK(), NOT({Offer Denied?}))`,
    columns: [...storeBase, ...storePrices]
  },
  {
    key: "fulfilled", section: "store", source: "store", label: "Fulfilled",
    formula: anyOf("Fulfillment Status", STORE_FULFILLED),
    columns: [...storeBase, STORE.fulfillment, ...storeDeal, STORE.invoice, ...storeShip]
  },
  {
    key: "allocated", section: "store", source: "store", label: "Allocated",
    formula: anyOf("Fulfillment Status", ["Allocated", "Awaiting Label"]),
    columns: [...storeBase, ...storeDeal]
  },
  {
    key: "labels", section: "store", source: "store", label: "Labels Requested",
    formula: `{Fulfillment Status} = 'Requested Label'`,
    columns: [...storeBase, ...storeDeal]
  },
  {
    key: "ready", section: "store", source: "store", label: "Ready To Ship",
    formula: `AND({Fulfillment Status} = 'Ready to Ship', NOT(${anyOf("Shipping Status", ["Shipped", "Delivered"])}))`,
    columns: [...storeBase, ...storeDeal, ...storeShip]
  },
  {
    key: "delayed", section: "store", source: "store", label: "Shipment Delayed",
    // The formula the delay warnings and penalties already run on, limited to
    // orders still waiting to ship. On its own the trigger stays set on
    // Fulfilled, Cancelled and Store Fulfilled orders that never got a
    // shipping status - 418 of 442 on 15-09-2026.
    formula: `AND({Shipment Delay Trigger} != '', ${anyOf("Fulfillment Status", ["Allocated", "Awaiting Label", "Requested Label", "Label Error", "Ready to Ship"])})`,
    columns: [...storeBase, ...storeDeal, ...storeShip]
  },
  {
    key: "shipped", section: "store", source: "store", label: "Shipped",
    formula: `{Shipping Status} = 'Shipped'`,
    columns: [...storeBase, ...storeDeal, ...storeShip]
  },
  {
    key: "delivered", section: "store", source: "store", label: "Delivered",
    formula: delivered,
    columns: [...storeBase, ...storeDeal, STORE.invoice, ...storeShip]
  },
  {
    key: "completed", section: "store", source: "store", label: "Completed",
    // Delivered, and the store has paid the invoice.
    formula: `AND(${delivered}, {Invoice Status} = 'Paid')`,
    columns: [...storeBase, ...storeDeal, STORE.invoice, ...storeShip]
  },
  {
    key: "issues", section: "store", source: "store", label: "Issues",
    formula: `{Issue Status} = 'Troubled'`,
    columns: [...storeBase, ...storeDeal, ...storeShip, STORE.issue]
  },

  // ----- Member WTBs -----
  {
    key: "general", section: "mwtb", source: "mwtb", label: "General",
    formula: `{Fulfillment Status} != 'Draft'`,
    columns: [...mwtbBase, MWTB.fulfillment]
  },
  {
    key: "open", section: "mwtb", source: "mwtb", label: "Open WTBs",
    formula: anyOf("Fulfillment Status", OPEN),
    columns: [...mwtbBase, ...mwtbPrices]
  },
  {
    key: "offers", section: "mwtb", source: "mwtb", label: "Offers",
    // Same rule as the Manual Orders Offers tab in the client portal.
    formula: `AND(${anyOf("Fulfillment Status", OPEN)}, OR({Offer To Buyer} > 0, {Current Lowest Offer} > 0))`,
    columns: [...mwtbBase, ...mwtbPrices]
  },
  {
    key: "fulfilled", section: "mwtb", source: "mwtb", label: "Fulfilled",
    formula: anyOf("Fulfillment Status", MWTB_FULFILLED),
    columns: [...mwtbBase, MWTB.fulfillment, ...mwtbDeal, MWTB.payment, ...mwtbShip]
  },
  {
    key: "allocated", section: "mwtb", source: "mwtb", label: "Allocated",
    formula: `{Fulfillment Status} = 'Allocated'`,
    columns: [...mwtbBase, ...mwtbDeal]
  },
  {
    key: "labels", section: "mwtb", source: "mwtb", label: "Labels Requested",
    formula: `{Fulfillment Status} = 'Requested Label'`,
    columns: [...mwtbBase, ...mwtbDeal]
  },
  {
    key: "ready", section: "mwtb", source: "mwtb", label: "Ready To Ship",
    formula: `AND({Fulfillment Status} = 'Ready to Ship', NOT(${anyOf("Shipping Status", ["Shipped", "Delivered"])}))`,
    columns: [...mwtbBase, ...mwtbDeal, ...mwtbShip]
  },
  {
    key: "shipped", section: "mwtb", source: "mwtb", label: "Shipped",
    formula: `{Shipping Status} = 'Shipped'`,
    columns: [...mwtbBase, ...mwtbDeal, ...mwtbShip]
  },
  {
    key: "delivered", section: "mwtb", source: "mwtb", label: "Delivered",
    formula: delivered,
    columns: [...mwtbBase, ...mwtbDeal, MWTB.payment, ...mwtbShip]
  },
  {
    key: "completed", section: "mwtb", source: "mwtb", label: "Completed",
    // Trusted only means the deal went ahead before payment; it is not paid.
    formula: `AND(${delivered}, {Payment Status} = 'Paid')`,
    columns: [...mwtbBase, ...mwtbDeal, MWTB.payment, ...mwtbShip]
  }
];

// A picture is the quickest way to recognise a pair, so it opens every list.
const PICTURE = col("picture", "Picture", "Picture", "image");

export const VIEWS = TABS.map((view) => ({
  ...view,
  columns: [PICTURE, ...view.columns.filter((column) => column.type !== "image")]
}));

export function findView(section, key) {
  return VIEWS.find((view) => view.section === section && view.key === key) || null;
}

/* ---------------- query building ---------------- */

// Free-text search, done by Airtable so it holds across pages.
const SEARCH_FIELDS = {
  store: ["Order ID", "Shopify Order Number", "SKU", "Shopify Product Name", "Tracking Number", "Store Name"],
  queue: ["Queued Order ID", "Shopify Order Number", "SKU (Soft)", "Shopify Product Name", "Store Name"],
  mwtb: ["Member WTB ID", "SKU", "Product Name", "Tracking Number", "Buyer Name"]
};

export function searchFormula(source, query) {
  const needle = String(query || "").trim().toLowerCase();
  const fields = SEARCH_FIELDS[source];

  if (!needle || !fields) return "";

  const haystack = fields.map((field) => `{${field}} & ''`).join(` & ' ' & `);

  return `SEARCH(${formulaString(needle)}, LOWER(${haystack}))`;
}

// The whole filterByFormula for one request: the tab, then the filters.
export function buildListFormula(view, { store = "", buyer = "", search = "" } = {}) {
  const parts = [];

  if (view.formula) parts.push(view.formula);

  if (store && (view.source === "store" || view.source === "queue")) {
    parts.push(`TRIM({Store Name} & '') = ${formulaString(String(store).trim())}`);
  }

  if (buyer && view.source === "mwtb") {
    parts.push(`SEARCH(${formulaString(String(buyer).trim().toLowerCase())}, LOWER({Buyer Name} & ''))`);
  }

  const searchPart = searchFormula(view.source, search);
  if (searchPart) parts.push(searchPart);

  if (!parts.length) return "";

  return parts.length === 1 ? parts[0] : `AND(${parts.join(",")})`;
}

// Every field a view needs from Airtable, so a request asks for those only.
export function fieldsFor(view) {
  const fields = new Set();

  for (const column of view.columns) {
    if (column.field) fields.add(column.field);
    if (column.link) fields.add(column.link);
    if (column.fallback) fields.add(column.fallback);
  }

  if (view.source === "store" || view.source === "mwtb") {
    fields.add("Linked Inventory Unit");
    fields.add("Fulfillment Status");
  }

  return [...fields];
}

export function sortFieldFor(view) {
  if (view.sort) return view.sort;
  return view.source === "mwtb" ? "Date" : "Order Date";
}

/* ---------------- side panel ---------------- */

// Everything shown when a row is opened, grouped the way it is looked at.
const f = (label, field, type = "text", extra = {}) => ({ label, field, type, ...extra });

export const PANELS = {
  store: [
    { title: "Order", fields: [
      f("Order ID", "Order ID", "id"), f("Store Name", "Store Name"), f("Shopify Order Number", "Shopify Order Number"),
      f("Order Source", "Order Source"), f("Marketplace", "Marketplace"), f("Date", "Order Date", "date"),
      f("Fulfillment Status", "Fulfillment Status", "status")
    ] },
    { title: "Product", fields: [
      f("Product", "Shopify Product Name"), f("SKU", "SKU", "mono"), f("Size", "Size"),
      f("Selling Price", "Selling Price", "money"), f("Picture", "Picture", "image")
    ] },
    { title: "Prices & offer", fields: [
      f("Target Price", "Target Buying Price", "money"), f("Maximum Price", "Maximum Buying Price", "money"),
      f("Max Buying Price", "Final Outsource Buying Price", "money"), f("Max Buying Price (VAT0)", "Final Outsource Buying Price (VAT 0%)", "money"),
      f("Custom Offer", "Custom Offer", "money"), f("Offer to Store", "Offer To Store", "money"),
      f("Offer ETA", "Estimated Time"), f("Offer VAT Type", "Offer VAT Type")
    ] },
    { title: "Deal", fields: [
      f("Final Price", "Final Buying Price", "money"), f("Fulfillment Date", "Fulfilment Date", "date"),
      f("Purchase Price", "Purchase Price (Lookup)", "money"), f("VAT Type", "VAT Type")
    ] },
    { title: "Store invoice", fields: [
      f("Invoice Price", "Invoice Price (VAT Included)", "money"), f("Invoice Status", "Invoice Status", "status"),
      f("Payment Link", "Payment Link", "url"), f("Paid At", "Paid At", "date")
    ] },
    { title: "Shipping", fields: [
      f("Shipping Status", "Shipping Status", "status"),
      f("Shipping Label", "Shipping Label URL (Permanent)", "url", { fallback: "Shipping Label" }),
      f("Tracking Number", "Tracking Number", "mono", { link: "Tracking URL" }), f("Shipping Notes", "Shipping Notes")
    ] },
    { title: "Issue & notes", fields: [
      f("Issue Status", "Issue Status", "status"), f("Issue Note", "Issue Notes", "long"), f("Notes", "Notes", "long")
    ] }
  ],

  mwtb: [
    { title: "Want to buy", fields: [
      f("Member WTB ID", "Member WTB ID", "id"), f("Buyer", "Buyer Name"), f("Date", "Date", "date"),
      f("Purchase Status", "Purchase Status", "status"), f("Fulfillment Status", "Fulfillment Status", "status")
    ] },
    { title: "Product", fields: [
      f("Product", "Product Name"), f("SKU", "SKU", "mono"), f("Size", "Size"),
      f("Max Price", "Max Price", "money"), f("Picture", "Picture", "image")
    ] },
    { title: "Offer", fields: [
      f("Current Lowest Offer", "Current Lowest Offer", "money"), f("Custom Offer", "Custom Offer", "money"),
      f("Offer to Buyer", "Offer To Buyer", "money"), f("Offer VAT Type", "Lowest Offer VAT Type")
    ] },
    { title: "Deal & invoice", fields: [
      f("Final Price", "Final Buying Price", "money"), f("Invoice Price", "Invoice Price", "money"), f("VAT Type", "VAT Type"),
      f("Payment Status", "Payment Status", "status"), f("Payment Link", "Payment Link", "url"), f("Paid At", "Paid At", "date")
    ] },
    { title: "Shipping", fields: [
      f("Shipping Status", "Shipping Status", "status"),
      f("Shipping Label", "Shipping Label Permanent URL", "url", { fallback: "Shipping Label" }),
      f("Tracking Number", "Tracking Number", "mono", { link: "Tracking URL" })
    ] },
    { title: "Notes", fields: [f("Buyer Notes", "Buyer Notes", "long"), f("Internal Notes", "Internal Notes", "long")] }
  ],

  queue: [
    { title: "Queued order", fields: [
      f("Queued Order ID", "Queued Order ID", "id"), f("Store Name", "Store Name"), f("Shopify Order Number", "Shopify Order Number"),
      f("Date", "Order Date", "date"), f("Order Age (Hours)", "Order Age (Hours)", "hours"), f("Match Risk Level", "Match Risk Level", "status")
    ] },
    { title: "Product", fields: [
      f("Product", "Shopify Product Name"), f("SKU", "SKU (Soft)", "mono"), f("Size", "Size"),
      f("Selling Price", "Shopify Selling Price", "money"), f("Picture", "Picture", "image")
    ] },
    { title: "Notes", fields: [f("Notes", "Notes", "long")] }
  ]
};

// The unit behind an order or want-to-buy: who supplied it and whether they
// have been paid. Shown under the record in the side panel.
export const UNIT_PANEL = {
  title: "Inventory unit",
  fields: [
    f("Item ID", "Item ID", "id"), f("Seller", "Seller Name"), f("Seller ID", "Seller ID (Lookup)", "mono"),
    f("Type", "Type"), f("Purchase Price", "Purchase Price", "money"), f("Final Purchase Price", "Final Purchase Price", "money"),
    f("Seller Payment Status", "Payment Status", "status")
  ]
};

export const UNIT_FIELDS = [...new Set([...UNIT_PANEL.fields.map((field) => field.field), "Seller Company Name"])];

export function panelFields(source) {
  // The intake queue has no unit yet.
  const fields = new Set(source === "queue" ? [] : ["Linked Inventory Unit"]);

  for (const group of PANELS[source] || []) {
    for (const field of group.fields) {
      fields.add(field.field);
      if (field.link) fields.add(field.link);
      if (field.fallback) fields.add(field.fallback);
    }
  }

  return [...fields];
}

// What the page needs to draw the navigation and the tables.
export function publicViews() {
  return VIEWS.map(({ key, section, source, label, columns }) => ({
    key,
    section,
    source,
    label,
    columns: columns.map(({ key: columnKey, label: columnLabel, type }) => ({ key: columnKey, label: columnLabel, type }))
  }));
}

// admin/adminPayments.js
//
// Open Payments: everything stores and members still owe us, over all stores,
// grouped per store.
//
// The rule is the one the store's own Open Payments tab uses: from Requested
// Label onward there is something to pay for, and a payment that expired,
// was cancelled or failed still has to be made. A Member WTB on Trusted is
// not open - the deal went ahead on trust, as the client portal counts it.
//
// Mark paid is for money that came in by bank transfer. It does what a paid
// Mollie batch does today (settlePaidBatch in index.js), recorded as its own
// Payment Batch with provider Bank Transfer so Payment History and the
// bookkeeping read it like any other payment.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

const PAYABLE = ["Requested Label", "Ready to Ship", "Fulfilled"];
const OPEN_INVOICE = ["Pending", "Awaiting Payment", "Pending Payment", "Expired", "Cancelled", "Failed"];
const OPEN_MWTB = ["Pending", "Requested", "Awaiting Payment", "Pending Payment", "Expired", "Cancelled", "Failed"];

export const PAYMENT_TABLES = {
  store: {
    table: "Unfulfilled Orders Log",
    statusField: "Invoice Status",
    open: OPEN_INVOICE,
    amountFields: ["Invoice Price (VAT Included)"],
    batchLinkField: "Linked Orders",
    idField: "Order ID",
    numberField: "Shopify Order Number",
    dateField: "Order Date",
    fields: ["Order ID", "Store Name", "Client", "Shopify Order Number", "Shopify Product Name", "SKU", "Size", "Picture",
      "Invoice Price (VAT Included)", "Invoice Status", "Payment Link", "Payment Batches", "Order Date", "Fulfillment Status"]
  },
  mwtb: {
    table: "Member WTBs",
    statusField: "Payment Status",
    open: OPEN_MWTB,
    // Invoice Price first, as the client portal reads it.
    amountFields: ["Invoice Price", "Final Buying Price"],
    batchLinkField: "Linked Member WTBs",
    idField: "Member WTB ID",
    numberField: "Member WTB ID",
    dateField: "Date",
    fields: ["Member WTB ID", "Buyer Seller ID", "Buyer Name", "Product Name", "SKU", "Size", "Picture",
      "Invoice Price", "Final Buying Price", "Payment Status", "Payment Link", "Payment Batches", "Date", "Fulfillment Status"]
  }
};

const BATCHES = "Payment Batches";

class PaymentError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const quote = (value) => `'${text(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const anyOf = (field, values) => `OR(${values.map((value) => `{${field}} = ${quote(value)}`).join(",")})`;

export function openPaymentFormula(source) {
  const spec = PAYMENT_TABLES[source];
  return `AND(${anyOf("Fulfillment Status", PAYABLE)}, ${anyOf(spec.statusField, spec.open)})`;
}

function amountOf(source, f) {
  for (const field of PAYMENT_TABLES[source].amountFields) {
    const n = Number(first(f[field]));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return 0;
}

async function selectAll(airtable, table, options) {
  const records = [];
  let offset = "";

  do {
    const page = await airtable.select(table, { ...options, pageSize: 100, offset });
    records.push(...page.records);
    offset = page.offset;
  } while (offset && records.length < 2000);

  return records;
}

/*
 * Merchants by id, and which merchant a seller record belongs to. A Member
 * WTB is bought by a seller record; when that seller is a store, the money
 * belongs under the store's name like its store orders.
 */
export async function loadMerchantIndex(airtable) {
  const merchants = await selectAll(airtable, "Merchants", { fields: ["Store Name", "Seller ID"] });
  const byId = new Map();
  const bySeller = new Map();

  for (const merchant of merchants) {
    const name = text(merchant.fields?.["Store Name"]);
    byId.set(merchant.id, name);
    for (const sellerId of merchant.fields?.["Seller ID"] || []) bySeller.set(sellerId, { id: merchant.id, name });
  }

  return { byId, bySeller };
}

function rowFor(source, record, merchants) {
  const f = record.fields || {};
  const spec = PAYMENT_TABLES[source];

  let store = "";
  let merchantId = "";

  if (source === "store") {
    store = text(first(f["Store Name"]));
    merchantId = text(first(f.Client));
  } else {
    const merchant = merchants.bySeller.get(first(f["Buyer Seller ID"]));
    store = merchant?.name || text(first(f["Buyer Name"])) || "Unknown buyer";
    merchantId = merchant?.id || "";
  }

  const picture = Array.isArray(f.Picture) && f.Picture[0] ? f.Picture[0].thumbnails?.small?.url || f.Picture[0].url || "" : "";
  const link = text(f["Payment Link"]);

  return {
    id: record.id,
    source,
    store,
    merchant_id: merchantId,
    label: text(f[spec.idField]),
    number: source === "store" ? text(f["Shopify Order Number"]) : "",
    product: text(f["Shopify Product Name"] || f["Product Name"]),
    sku: text(first(f.SKU)),
    size: text(f.Size),
    picture,
    amount: amountOf(source, f),
    status: text(f[spec.statusField]),
    fulfillment: text(f["Fulfillment Status"]),
    link: /^https?:\/\//i.test(link) ? link : "",
    date: text(f[spec.dateField])
  };
}

// Every open amount, grouped per store, oldest first inside a group and the
// store with the oldest open amount on top.
export async function loadOpenPayments(airtable, { stores = [], storeMode = "include", search = "", kind = "all" } = {}) {
  const merchants = await loadMerchantIndex(airtable);
  const sources = kind === "store" ? ["store"] : kind === "mwtb" ? ["mwtb"] : ["store", "mwtb"];

  const lists = await Promise.all(
    sources.map((source) =>
      selectAll(airtable, PAYMENT_TABLES[source].table, { formula: openPaymentFormula(source), fields: PAYMENT_TABLES[source].fields })
        .then((records) => records.map((record) => rowFor(source, record, merchants)))
    )
  );

  const wanted = new Set(stores.map(text).filter(Boolean));
  const needle = text(search).toLowerCase();

  const rows = lists.flat().filter((row) => {
    if (wanted.size && (storeMode === "exclude" ? wanted.has(row.store) : !wanted.has(row.store))) return false;
    if (needle && ![row.store, row.label, row.number, row.product, row.sku].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });

  const groups = new Map();

  for (const row of rows) {
    if (!groups.has(row.store)) groups.set(row.store, { store: row.store, rows: [], total: 0, oldest: "" });
    const group = groups.get(row.store);
    group.rows.push(row);
    group.total = Math.round((group.total + row.amount) * 100) / 100;
    if (row.date && (!group.oldest || row.date < group.oldest)) group.oldest = row.date;
  }

  const list = [...groups.values()];

  for (const group of list) group.rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  list.sort((a, b) => (a.oldest || "9").localeCompare(b.oldest || "9"));

  return {
    groups: list,
    total: Math.round(list.reduce((sum, group) => sum + group.total, 0) * 100) / 100,
    count: rows.length
  };
}

/*
 * Mark these open amounts paid by bank transfer.
 *
 * deps: airtable (select, byIds, update, create), tellKickzPaid(memberWtbIds),
 *       archiveMollieLink(linkId) -> "" or a sentence when it could not.
 */
export async function markPaidByBankTransfer({ targets, deps }) {
  const clean = (Array.isArray(targets) ? targets : [])
    .map((target) => ({ source: text(target?.source), id: text(target?.id) }))
    .filter((target) => PAYMENT_TABLES[target.source] && /^rec[A-Za-z0-9]{14}$/.test(target.id));

  if (!clean.length) throw new PaymentError("Select at least one open amount.", 400);
  if (clean.length > 100) throw new PaymentError("Mark at most 100 amounts paid at once.", 400);

  const merchants = await loadMerchantIndex(deps.airtable);

  // Read every selected record fresh, inside its own table.
  const records = [];
  for (const source of Object.keys(PAYMENT_TABLES)) {
    const ids = clean.filter((target) => target.source === source).map((target) => target.id);
    if (!ids.length) continue;

    const found = await deps.airtable.byIds(PAYMENT_TABLES[source].table, ids, PAYMENT_TABLES[source].fields);

    for (const id of ids) {
      if (!found.has(id)) throw new PaymentError("One of the selected amounts no longer exists. Refresh the list.", 404);
      records.push({ source, id, fields: found.get(id), row: rowFor(source, { id, fields: found.get(id) }, merchants) });
    }
  }

  for (const item of records) {
    const spec = PAYMENT_TABLES[item.source];

    if (!PAYABLE.includes(item.row.fulfillment)) {
      throw new PaymentError(`${item.row.label} is not payable yet (status ${item.row.fulfillment || "empty"}).`);
    }
    if (!spec.open.includes(item.row.status)) {
      throw new PaymentError(`${item.row.label} is not open anymore (${spec.statusField}: ${item.row.status || "empty"}). Refresh the list.`);
    }
    if (!(item.row.amount > 0)) throw new PaymentError(`${item.row.label} has no invoice amount.`);
  }

  const storeNames = [...new Set(records.map((item) => item.row.store))];
  if (storeNames.length > 1) throw new PaymentError("Mark amounts paid one store at a time.", 400);

  // Mollie links these amounts are already on. One the customer has started
  // paying is left alone; one that also covers amounts outside this
  // selection would be half settled, so that is refused too.
  const selectedIds = new Set(records.map((item) => item.id));
  const batchIds = [...new Set(records.flatMap((item) => item.fields["Payment Batches"] || []))];
  const batches = batchIds.length
    ? await deps.airtable.byIds(BATCHES, batchIds, ["Batch ID", "Payment Status", "Linked Orders", "Linked Member WTBs", "Mollie Payment Link ID"])
    : new Map();

  const toCancel = [];

  for (const [batchId, batch] of batches) {
    const batchStatus = text(batch["Payment Status"]);
    const label = text(batch["Batch ID"]) || batchId;

    if (batchStatus === "Pending Payment") {
      throw new PaymentError(`${label} has a payment in progress at Mollie. Wait for it to finish before marking this paid.`);
    }

    if (batchStatus !== "Awaiting Payment") continue;

    const covered = [...(batch["Linked Orders"] || []), ...(batch["Linked Member WTBs"] || [])];
    const outside = covered.filter((id) => !selectedIds.has(id));

    if (outside.length) {
      throw new PaymentError(`${label} is one payment link for more amounts than you selected. Select all ${covered.length} of them, or let the store cancel that link first.`);
    }

    toCancel.push({ id: batchId, label, linkId: text(batch["Mollie Payment Link ID"]) });
  }

  const paidAt = new Date().toISOString();
  const total = Math.round(records.reduce((sum, item) => sum + item.row.amount, 0) * 100) / 100;
  const merchantId = records.map((item) => item.row.merchant_id).find(Boolean);
  const buyers = [...new Set(records.filter((item) => item.source === "mwtb").map((item) => first(item.fields["Buyer Seller ID"])).filter(Boolean))];

  const batchFields = {
    "Order Numbers": records.map((item) => item.row.number || item.row.label).join(", "),
    Amount: total,
    "Payment Status": "Paid",
    "Payment Provider": "Bank Transfer",
    "Paid At": paidAt
  };

  if (merchantId) batchFields.Store = [merchantId];
  if (buyers.length) batchFields.Buyer = buyers;

  for (const [source, spec] of Object.entries(PAYMENT_TABLES)) {
    const ids = records.filter((item) => item.source === source).map((item) => item.id);
    if (ids.length) batchFields[spec.batchLinkField] = ids;
  }

  const created = await deps.airtable.create(BATCHES, batchFields);
  const newBatchId = created.id;

  const notes = [];

  for (const batch of toCancel) {
    await deps.airtable.update(BATCHES, batch.id, { "Payment Status": "Cancelled" });

    // The link itself would otherwise still take money for amounts that are now paid.
    if (batch.linkId) {
      const note = await deps.archiveMollieLink(batch.linkId);
      if (note) notes.push(`${batch.label}: ${note}`);
    }
  }

  for (const item of records) {
    const spec = PAYMENT_TABLES[item.source];

    await deps.airtable.update(spec.table, item.id, {
      [spec.statusField]: "Paid",
      "Paid At": paidAt,
      "Payment Link": "",
      "Payment Batches": [...new Set([...(item.fields["Payment Batches"] || []), newBatchId])]
    });
  }

  // The seller's label step waits for this on the Kickz Caviar side.
  const memberWtbIds = records.filter((item) => item.source === "mwtb").map((item) => item.id);
  if (memberWtbIds.length) {
    const note = await deps.tellKickzPaid(memberWtbIds);
    if (note) notes.push(note);
  }

  return {
    store: storeNames[0],
    count: records.length,
    total,
    batch_record_id: newBatchId,
    cancelled: toCancel.map((batch) => batch.label),
    labels: records.map((item) => item.row.label),
    targets: records.map((item) => ({ source: item.source, id: item.id, label: item.row.label })),
    notes
  };
}

export { PaymentError };

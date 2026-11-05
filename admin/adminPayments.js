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
      "Invoice Price (VAT Included)", "Invoice Status", "Rompslomp Invoice Number", "Payment Link", "Payment Batches", "Order Date", "Fulfillment Status",
      "Shipping Status", "Tracking URL"]
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
      "Invoice Price", "Final Buying Price", "Payment Status", "Payment Link", "Payment Batches", "Date", "Fulfillment Status",
      "Shipping Status", "Tracking URL"]
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
  const tracking = text(f["Tracking URL"]);

  return {
    id: record.id,
    source,
    store,
    merchant_id: merchantId,
    label: text(f[spec.idField]),
    number: source === "store" ? text(f["Shopify Order Number"]) : "",
    // Only store orders are invoiced through Rompslomp; a Member WTB has none.
    invoice: source === "store" ? text(f["Rompslomp Invoice Number"]) : "",
    product: text(f["Shopify Product Name"] || f["Product Name"]),
    sku: text(first(f.SKU)),
    size: text(f.Size),
    picture,
    amount: amountOf(source, f),
    status: text(f[spec.statusField]),
    fulfillment: text(f["Fulfillment Status"]),
    shipping: text(f["Shipping Status"]),
    track: /^https?:\/\//i.test(tracking) ? tracking : "",
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
    if (needle && ![row.store, row.label, row.number, row.invoice, row.product, row.sku].join(" ").toLowerCase().includes(needle)) return false;
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
export async function markPaidByBankTransfer({ targets, deps, paidAt: when = "" }) {
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

  // The day the money came in, when the caller knows it (Rompslomp's bank line).
  const paidAt = when && Number.isFinite(Date.parse(when)) ? new Date(when).toISOString() : new Date().toISOString();
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

/*
 * Following Rompslomp for store orders paid by bank transfer.
 *
 * Stores that do not pay through the dashboard's Mollie link transfer the
 * money, and Dario links the bank line to the invoice in Rompslomp. This
 * finds those invoices and marks their orders paid here, the same way Mark
 * paid does, on the day the money came in.
 *
 * Rompslomp's invoice only says paid or unpaid, not when. The day comes from
 * the booked bank line: the one naming the invoice number, or else the one
 * with exactly the invoice's amount from the customer's name. Neither found,
 * it is the day this saw it paid - checked every half hour, that is the day
 * Dario booked it.
 *
 * An invoice settled by a credit note is "paid" too, without any money; one
 * a credit note refers to is left alone.
 */

const SETTLED = ["paid", "overpaid"];
const PAGE = 100;
const MAX_PAGES = 30;

const normRef = (value) => text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
const dayOf = (value) => text(value).slice(0, 10);

// Does this bank text name this invoice? KC202609-208 is not in KC202609-2089.
export function mentionsInvoice(description, invoiceNumber) {
  const haystack = normRef(description);
  const needle = normRef(invoiceNumber);
  if (needle.length < 5) return false;

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!/[0-9]/.test(haystack[at + needle.length] || "")) return true;
  }
  return false;
}

// The invoice numbers credit notes were made for ("Creditfactuur voor factuur: KC...").
export function creditedNumbers(creditInvoices) {
  const out = new Set();
  for (const credit of creditInvoices || []) {
    const found = /factuur:\s*([A-Z0-9-]*[0-9][A-Z0-9-]*)/i.exec(text(credit.description));
    if (found) out.add(normRef(found[1]));
  }
  return out;
}

/*
 * The day an invoice was paid, from Rompslomp's booked bank lines, or null.
 * Returns { date: "YYYY-MM-DD", how }.
 */
export function paymentDateFor(invoice, payments) {
  const from = dayOf(invoice.date);
  const after = (payments || []).filter((p) => dayOf(p.paid_at) && dayOf(p.paid_at) >= from);

  // A transfer that names the invoice. When there are several (paid in
  // parts), the last one made it paid.
  const named = after.filter((p) => mentionsInvoice(p.description, invoice.invoice_number));
  if (named.length) {
    return { date: named.map((p) => dayOf(p.paid_at)).sort().at(-1), how: "invoice number" };
  }

  const amount = Number(invoice.price_with_vat);
  const name = normRef(invoice.cached_contact?.name);
  if (name.length >= 4 && Number.isFinite(amount)) {
    const exact = after
      .filter((p) => Math.abs(Number(p.amount) - amount) < 0.005 && normRef(p.description).includes(name))
      .map((p) => dayOf(p.paid_at))
      .sort();
    if (exact.length) return { date: exact[0], how: "amount and name" };
  }

  return null;
}

async function readPages(rompslomp, path, key, { stopBefore = "" } = {}) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const join = path.includes("?") ? "&" : "?";
    const rows = (await rompslomp.read(`${path}${join}per_page=${PAGE}&page=${page}`))?.[key] || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    // Bank lines come newest first: once past the oldest day needed, stop.
    if (stopBefore && dayOf(rows.at(-1)?.paid_at) < stopBefore) break;
  }
  return out;
}

/*
 * deps:
 *   airtable   select (main base)
 *   rompslomp  createRompslomp (read, getInvoice)
 *   markPaid   (targets, paidAt) -> markPaidByBankTransfer's result
 */
export async function followRompslompPayments({ deps, now = new Date(), limit = 40 }) {
  const formula = `AND(${openPaymentFormula("store")}, {Rompslomp Invoice ID} != '', {Rompslomp Credit Invoice Number} = '')`;
  const records = await selectAll(deps.airtable, PAYMENT_TABLES.store.table, {
    formula,
    fields: ["Order ID", "Store Name", "Rompslomp Invoice ID", "Rompslomp Invoice Number"]
  });

  const orders = records.map((record) => ({
    id: record.id,
    label: text(record.fields?.["Order ID"]) || record.id,
    store: text(first(record.fields?.["Store Name"])),
    invoiceId: text(record.fields?.["Rompslomp Invoice ID"]),
    invoiceNumber: text(record.fields?.["Rompslomp Invoice Number"])
  }));

  const result = { checked: orders.length, marked: [], skipped: [], errors: [] };
  if (!orders.length) return result;

  // One list of what is still open there; only what falls out of it is read.
  const unpaid = new Set((await readPages(deps.rompslomp, "/sales_invoices?selection=unpaid", "sales_invoices")).map((i) => text(i.id)));
  const candidates = orders.filter((order) => !unpaid.has(order.invoiceId)).slice(0, limit);
  if (!candidates.length) return result;

  const paid = [];
  for (const order of candidates) {
    try {
      const invoice = await deps.rompslomp.getInvoice(order.invoiceId);
      if (!invoice) {
        result.skipped.push({ label: order.label, invoice: order.invoiceNumber, reason: "invoice not found in Rompslomp" });
      } else if (invoice.status === "published" && SETTLED.includes(text(invoice.payment_status))) {
        paid.push({ order, invoice });
      }
    } catch (err) {
      result.errors.push({ labels: [order.label], message: err.message });
    }
  }
  if (!paid.length) return result;

  const oldest = paid.map((p) => dayOf(p.invoice.date)).filter(Boolean).sort()[0] || dayOf(now.toISOString());

  const credits = await readPages(deps.rompslomp, `/sales_invoices?selection=credit_invoices&search[from]=${oldest}`, "sales_invoices");
  const credited = creditedNumbers(credits);

  const payments = await readPages(deps.rompslomp, "/payments?selection=booked", "payments", { stopBefore: oldest });

  // Per store and per day: one Payment Batch for what one transfer paid.
  const groups = new Map();
  for (const { order, invoice } of paid) {
    const number = text(invoice.invoice_number) || order.invoiceNumber;
    if (credited.has(normRef(number))) {
      result.skipped.push({ label: order.label, invoice: number, reason: "a credit note refers to this invoice" });
      continue;
    }

    const found = paymentDateFor(invoice, payments);
    const date = found?.date || dayOf(now.toISOString());
    const key = `${order.store}|${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ order, number, date, how: found?.how || "date not found, today" });
  }

  for (const items of groups.values()) {
    // Noon, so the day stays the day in every timezone.
    const paidAt = `${items[0].date}T12:00:00.000Z`;
    const tries = [items];
    let whole = true;

    while (tries.length) {
      const batch = tries.shift();
      try {
        const out = await deps.markPaid(batch.map((item) => ({ source: "store", id: item.order.id })), paidAt);
        for (const item of batch) {
          result.marked.push({ id: item.order.id, label: item.order.label, store: item.order.store, invoice: item.number, date: item.date, how: item.how, batch_record_id: out?.batch_record_id || "", notes: out?.notes || [] });
        }
      } catch (err) {
        // One order that cannot be settled (a Mollie payment in progress,
        // a link shared with other orders) does not stop the rest.
        if (whole && batch.length > 1) {
          tries.push(...batch.map((item) => [item]));
        } else {
          result.errors.push({ labels: batch.map((item) => item.order.label), message: err.message });
        }
      }
      whole = false;
    }
  }

  return result;
}

export { PaymentError };

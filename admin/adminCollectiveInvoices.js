// admin/adminCollectiveInvoices.js
//
// Collective invoices for self-billing stores (APLUG.PL).
//
// A store on Invoice Mode "Self-billing" invoices us itself, once a month, so
// the engine (storeOrderFulfillmentInvoice) makes no invoice for its orders
// and leaves them on Bookkeeping Status "Awaiting self-billing". They still
// have to reach the books. Here Dario ticks the pairs of a month and books
// them in one go: one Rompslomp sales invoice per VAT route, dated the last
// day of that month, with one line per pair, and one journal entry
// (Voorraadcorrectie) per invoice for what the pairs cost us. Nothing is
// mailed - the store has its own document.
//
// The VAT routes and accounts are the engine's (src/lib/storeInvoicing.js in
// airtable-automation-engine), copied one to one: Margin and VAT0 cannot share
// an invoice, so a month with both gets two.
//
// Every id is written to the orders the moment Rompslomp returns it, and the
// invoice carries an api_reference made from the pairs on it, so a run that
// dies halfway is finished by running it again rather than invoiced twice.

import crypto from "crypto";
import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const ORDERS = "Unfulfilled Orders Log";
const AWAITING = "Awaiting self-billing";

export class CollectiveInvoiceError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const ORDER_FIELDS = [
  "Order ID", "Shopify Order Number", "Product Name", "Shopify Product Name", "SKU", "Size", "Picture",
  "VAT Type", "Client Country", "Final Buying Price", "Fulfillment Status", "Shipping Status", "Tracking URL",
  "Fulfilment Date", "Order Date", "Linked Inventory Unit", "Client", "Store Name", "Bookkeeping Status",
  "Rompslomp Invoice ID", "Rompslomp Invoice Number", "Rompslomp Journal Entry ID"
];

/* ---------------- the engine's bookkeeping rules ---------------- */

const ROMPSLOMP = {
  revenueAccountId: 589136361,
  revenueAccountPath: "profit.revenue.sneakers_custom",
  stockAccountId: 1981496874,
  stockAccountPath: "activa.current_assets.voorraad_scout_custom",
  costAccountPath: "profit.costs.sneakers_custom",
  marginCostAccountPath: "profit.costs.sneakers_marge_custom",
  marginTemplateId: 322464949
};

// Same five routes as the engine's invoicePlan; see the comment there.
export function invoicePlan({ vatType, storeCountry, clientCountry }) {
  const vat = text(vatType);
  const storeIsNl = text(storeCountry) === "Netherlands";
  const clientIsNl = text(clientCountry) === "Netherlands";

  const dutch = { vatTypeId: 701184043, label: "VAT21", withVatNumber: false };
  const reverse = { vatTypeId: 775036437, label: "VAT0", withVatNumber: true };

  if (vat === "Margin") {
    return {
      route: "Margin", label: "Margin", vatTypeId: 688369464, templateId: ROMPSLOMP.marginTemplateId, withVatNumber: false,
      lineAccount: false, costAccountId: 1537847149, costAccountPath: ROMPSLOMP.marginCostAccountPath, costAmountField: "Final Purchase Price"
    };
  }

  if (vat === "VAT0") {
    return {
      route: storeIsNl ? "VAT0, store in NL" : "VAT0, store not NL", ...(storeIsNl ? dutch : reverse),
      templateId: null, lineAccount: true, costAccountId: 306471935, costAmountField: "Final Purchase Price"
    };
  }

  if (vat === "VAT21") {
    return {
      route: clientIsNl ? "VAT21, client in NL" : "VAT21, client not NL", ...(clientIsNl ? dutch : reverse),
      templateId: null, lineAccount: true, costAccountId: 306471935, costAmountField: "Final Purchase Price (ex. VAT)"
    };
  }

  return null;
}

// Pairs that can share one invoice and one journal entry: same VAT type, same
// template, same cost account. The two reverse-charge routes meet here.
const groupKey = (plan) => `${plan.label}|${plan.vatTypeId}|${plan.templateId || ""}|${plan.costAccountId}`;

/* ---------------- dates ---------------- */

const amsterdamDay = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(d);
};

export const monthOf = (value) => amsterdamDay(value).slice(0, 7);

export function lastDayOf(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(month))) throw new CollectiveInvoiceError("Pick a month.", 400);
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Due 7 days after the invoice date, as every other store invoice.
export function dueDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/* ---------------- bodies ---------------- */

export function invoiceReference(month, plan, orderIds) {
  const hash = crypto.createHash("sha1").update([...orderIds].sort().join(",")).digest("hex").slice(0, 10);
  return `collective-${month}-${plan.label}-${hash}`;
}

export function collectiveInvoiceBody({ plan, pairs, contact, storeName, month, date, reference }) {
  return {
    sales_invoice: {
      date,
      due_date: dueDate(date),
      payment_method: "pay_transfer",
      description: `${storeName} self-billing ${month}`,
      contact_id: contact.id,
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: plan.templateId,
      vat_number: plan.withVatNumber ? contact.vat_number || null : null,
      api_reference: reference,
      payment_reference: null,
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: pairs.map((pair) => ({
        description: pair.product,
        extended_description: [pair.size, pair.order_id].filter(Boolean).join(" · "),
        price_per_unit: String(pair.price),
        vat_rate: "",
        vat_type_id: plan.vatTypeId,
        quantity: "1.0",
        ...(plan.lineAccount ? { account_id: ROMPSLOMP.revenueAccountId, account_path: ROMPSLOMP.revenueAccountPath } : {})
      }))
    }
  };
}

export function journalBody({ plan, invoiceNumber, date, amount }) {
  return {
    journal_entry: {
      description: `Voorraadcorrectie ${invoiceNumber}`,
      date,
      lines: [
        { account_id: plan.costAccountId, account_path: plan.costAccountPath || ROMPSLOMP.costAccountPath, debit_amount: String(amount), credit_amount: null },
        { account_id: ROMPSLOMP.stockAccountId, account_path: ROMPSLOMP.stockAccountPath, debit_amount: null, credit_amount: String(amount) }
      ]
    }
  };
}

// The store's contact among Rompslomp's search results: the exact name wins.
export function pickContact(contacts, storeName) {
  const list = Array.isArray(contacts) ? contacts : [];
  const wanted = text(storeName).toLowerCase();
  const name = (c) => text(c?.company_name || c?.name).toLowerCase();
  return list.find((c) => name(c) === wanted) || list[0] || null;
}

/* ---------------- the store ---------------- */

/*
 * deps:
 *   airtable   select, byIds, update (admin/adminRouter.js)
 *   rompslomp  createRompslomp (admin/externalSalesInvoicing.js)
 */
export function createCollectiveInvoicesStore({ airtable, rompslomp }) {
  async function selectAll(table, options) {
    const records = [];
    let offset = "";

    do {
      const page = await airtable.select(table, { ...options, pageSize: 100, offset });
      records.push(...page.records);
      offset = page.offset;
    } while (offset && records.length < 3000);

    return records;
  }

  async function selfBillingStores() {
    const merchants = await selectAll("Merchants", {
      formula: `{Invoice Mode} = 'Self-billing'`,
      fields: ["Store Name", "Country", "Rompslomp Contact ID"]
    });

    return merchants
      .map((m) => ({ id: m.id, name: text(m.fields?.["Store Name"]), country: text(m.fields?.Country), contact_id: text(m.fields?.["Rompslomp Contact ID"]) }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function pairFrom(record, store) {
    const f = record.fields || {};
    const plan = invoicePlan({ vatType: first(f["VAT Type"]), storeCountry: store.country, clientCountry: first(f["Client Country"]) });
    const picture = Array.isArray(f.Picture) && f.Picture[0] ? f.Picture[0].thumbnails?.small?.url || f.Picture[0].url || "" : "";
    const tracking = text(f["Tracking URL"]);

    return {
      id: record.id,
      order_id: text(f["Order ID"]),
      shopify: text(f["Shopify Order Number"]),
      product: text(f["Product Name"] || f["Shopify Product Name"]),
      sku: text(first(f.SKU)),
      size: text(f.Size),
      picture,
      vat_type: text(first(f["VAT Type"])),
      route: plan?.label || "",
      price: round2(Number(f["Final Buying Price"]) || 0),
      fulfillment: text(f["Fulfillment Status"]),
      shipping: text(f["Shipping Status"]),
      track: /^https?:\/\//i.test(tracking) ? tracking : "",
      fulfilled_at: text(f["Fulfilment Date"]),
      month: f["Fulfillment Status"] === "Fulfilled" ? monthOf(f["Fulfilment Date"]) : "",
      order_date: text(f["Order Date"]),
      unit_id: text(first(f["Linked Inventory Unit"])),
      invoice_id: text(f["Rompslomp Invoice ID"]),
      invoice_number: text(f["Rompslomp Invoice Number"]),
      journal_id: text(f["Rompslomp Journal Entry ID"]),
      bookkeeping: text(f["Bookkeeping Status"])
    };
  }

  // Every pair of the store still waiting for its collective invoice.
  async function list({ store: storeId = "" } = {}) {
    const stores = await selfBillingStores();
    const store = stores.find((s) => s.id === text(storeId)) || stores[0] || null;
    if (!store) return { stores, store: null, pairs: [] };

    const records = await selectAll(ORDERS, { formula: `{Bookkeeping Status} = '${AWAITING}'`, fields: ORDER_FIELDS });

    // Client is a link, which a formula only sees by name; the id is checked here.
    const pairs = records
      .filter((r) => first(r.fields?.Client) === store.id)
      .map((r) => pairFrom(r, store))
      .sort((a, b) => (a.fulfilled_at || a.order_date || "").localeCompare(b.fulfilled_at || b.order_date || ""));

    return { stores, store, pairs };
  }

  async function contactFor(store) {
    if (store.contact_id) {
      const contact = await rompslomp.getContact(store.contact_id).catch(() => null);
      if (contact) return contact;
    }

    const contact = pickContact(await rompslomp.searchContacts(store.name), store.name);
    if (!contact) throw new CollectiveInvoiceError(`No Rompslomp customer found for "${store.name}". Make the contact in Rompslomp first.`);

    await airtable.update("Merchants", store.id, { "Rompslomp Contact ID": String(contact.id) });
    return contact;
  }

  async function journalFor({ plan, invoiceNumber, date, amount }) {
    const description = `Voorraadcorrectie ${invoiceNumber}`;
    const existing = (await rompslomp.recentJournals()).find((j) => text(j.description) === description);
    if (existing) return { journal: existing, made: false };
    return { journal: await rompslomp.createJournal(journalBody({ plan, invoiceNumber, date, amount })), made: true };
  }

  /*
   * Book the ticked pairs of one store as that month's collective invoice(s).
   */
  async function book({ store: storeId, month, ids }) {
    const date = lastDayOf(month);
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(text).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];

    if (!wanted.length) throw new CollectiveInvoiceError("Tick at least one pair.", 400);
    if (wanted.length > 200) throw new CollectiveInvoiceError("Book at most 200 pairs at once.", 400);
    if (!rompslomp?.configured) throw new CollectiveInvoiceError("Invoicing needs ROMPSLOMP_API_TOKEN on this service.", 503);

    const store = (await selfBillingStores()).find((s) => s.id === text(storeId));
    if (!store) throw new CollectiveInvoiceError("That store is not on self-billing.", 400);

    // Read fresh, inside the orders table, and check every pair may be booked.
    const found = await airtable.byIds(ORDERS, wanted, ORDER_FIELDS);
    const pairs = [];

    for (const id of wanted) {
      if (!found.has(id)) throw new CollectiveInvoiceError("One of the ticked pairs no longer exists. Refresh the list.", 404);
      const fields = found.get(id);
      const pair = pairFrom({ id, fields }, store);
      const label = pair.order_id || id;

      if (first(fields.Client) !== store.id) throw new CollectiveInvoiceError(`${label} is not ${store.name}'s.`);
      if (pair.bookkeeping !== AWAITING) throw new CollectiveInvoiceError(`${label} is not awaiting self-billing anymore (${pair.bookkeeping || "empty"}). Refresh the list.`);
      if (!(pair.price > 0)) throw new CollectiveInvoiceError(`${label} has no Final Buying Price.`);
      if (!pair.unit_id) throw new CollectiveInvoiceError(`${label} has no Linked Inventory Unit.`);

      pair.plan = invoicePlan({ vatType: first(fields["VAT Type"]), storeCountry: store.country, clientCountry: first(fields["Client Country"]) });
      if (!pair.plan) throw new CollectiveInvoiceError(`${label} has no invoice route for VAT Type "${pair.vat_type || "empty"}".`);

      // An id without a number: made but never published, outside this flow.
      if (pair.invoice_id && !pair.invoice_number) throw new CollectiveInvoiceError(`${label} has an invoice without a number. Check it in Rompslomp.`);

      pairs.push(pair);
    }

    // What each pair cost us, from its unit, as the engine books it.
    const units = await airtable.byIds("Inventory Units", pairs.map((p) => p.unit_id), ["Final Purchase Price", "Final Purchase Price (ex. VAT)"]);

    for (const pair of pairs) {
      const raw = Number((units.get(pair.unit_id) || {})[pair.plan.costAmountField]);
      if (!Number.isFinite(raw)) throw new CollectiveInvoiceError(`${pair.order_id}: the unit has no ${pair.plan.costAmountField}.`);
      pair.cost = round2(raw);
    }

    const groups = new Map();
    for (const pair of pairs) {
      const key = groupKey(pair.plan);
      if (!groups.has(key)) groups.set(key, { plan: pair.plan, pairs: [] });
      groups.get(key).pairs.push(pair);
    }

    const contact = await contactFor(store);
    const done = [];
    const notes = [];

    for (const group of groups.values()) {
      const { plan } = group;
      const total = round2(group.pairs.reduce((sum, p) => sum + p.price, 0));
      const cost = round2(group.pairs.reduce((sum, p) => sum + p.cost, 0));
      const reference = invoiceReference(month, plan, group.pairs.map((p) => p.id));

      // An invoice already on the pairs from an earlier, half-finished run.
      const onPairs = [...new Set(group.pairs.map((p) => p.invoice_id).filter(Boolean))];
      if (onPairs.length > 1 || (onPairs.length === 1 && group.pairs.some((p) => p.invoice_id !== onPairs[0]))) {
        throw new CollectiveInvoiceError("Some of these pairs are already on another collective invoice. Tick exactly the pairs of that run to finish it.");
      }

      let invoice = onPairs.length ? await rompslomp.getInvoice(onPairs[0]) : await rompslomp.findInvoice(reference);
      if (!invoice) invoice = await rompslomp.createInvoice(collectiveInvoiceBody({ plan, pairs: group.pairs, contact, storeName: store.name, month, date, reference }));
      if (invoice.status !== "published" || !invoice.invoice_number) invoice = await rompslomp.publishInvoice(invoice.id);

      const invoiceId = String(invoice.id);
      const invoiceNumber = text(invoice.invoice_number);

      // Saved first, whatever comes next: an invoice that exists in Rompslomp
      // must be visible on its orders.
      for (const pair of group.pairs) {
        if (pair.invoice_id === invoiceId && pair.invoice_number === invoiceNumber) continue;
        await airtable.update(ORDERS, pair.id, { "Rompslomp Invoice ID": invoiceId, "Rompslomp Invoice Number": invoiceNumber });
      }

      const came = round2(invoice.price_with_vat);
      if (Number.isFinite(came) && Math.abs(came - total) > 0.01) {
        notes.push(`${invoiceNumber} came out at €${came.toFixed(2)}, the pairs add up to €${total.toFixed(2)}. Check it in Rompslomp.`);
      }

      let journalId = group.pairs.map((p) => p.journal_id).find(Boolean) || "";
      if (!journalId) {
        const { journal, made } = await journalFor({ plan, invoiceNumber, date: text(invoice.date) || date, amount: cost });
        journalId = String(journal.id);
        if (!made) notes.push(`Voorraadcorrectie ${invoiceNumber} was already there and is taken over.`);
      }

      /*
        Invoiced, and Invoice Sent At as the engine's "done" mark: with it and
        Fulfillment Sent? on the order the engine leaves it alone. Without it
        the next status change would put a Ready to Ship pair back on
        Awaiting self-billing.
      */
      const now = new Date().toISOString();
      for (const pair of group.pairs) {
        await airtable.update(ORDERS, pair.id, {
          "Rompslomp Journal Entry ID": journalId,
          "Bookkeeping Status": "Invoiced",
          "Invoice Sent At": now,
          "Fulfillment Sent?": true
        });
      }

      done.push({ invoice_number: invoiceNumber, invoice_id: invoiceId, route: plan.label, count: group.pairs.length, total, cost, journal_id: journalId, orders: group.pairs.map((p) => p.order_id) });
    }

    return { store: store.name, month, date, invoices: done, notes };
  }

  return { list, book };
}

export function mountCollectiveInvoices(router, { store, audit, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[admin collective invoices]", err.message);
    res.status(status).json({ error: err instanceof CollectiveInvoiceError || status < 500 || /Rompslomp|Invoicing/.test(err.message) ? err.message : `Collective invoices failed: ${err.message}` });
  };

  router.get(["/admin/collective-invoices", "/admin/collective-invoices/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/collective-invoices", async (req, res) => {
    try {
      res.json(await store.list({ store: text(req.query.store) }));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/collective-invoices/book", express.json({ limit: "50kb" }), async (req, res) => {
    try {
      const result = await store.book({ store: text(req.body?.store), month: text(req.body?.month), ids: req.body?.ids });
      await audit.record({
        actor: req.admin,
        action: "collective_invoice_booked",
        source: "collective_invoices",
        label: `${result.store} ${result.month}`,
        details: { invoices: result.invoices.map((i) => ({ number: i.invoice_number, route: i.route, count: i.count, total: i.total, orders: i.orders })) }
      }).catch(() => {});
      res.json(result);
    } catch (err) {
      send(res, err);
    }
  });
}

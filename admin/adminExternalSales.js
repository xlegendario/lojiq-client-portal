// admin/adminExternalSales.js
//
// External Sales: sales of our own stock to outside buyers. They live in
// Supabase; see admin/externalSalesSync.js for how Airtable's External Sales
// Log feeds them until the WMS writes to Supabase itself.
//
// This screen shows every deal with its money, its parcels (a label and its
// tracking number, one row per parcel) and a checks list: everything that is
// missing or does not add up, each with the deal it is on.
//
// Every change goes through the action log, like the other buttons.

import express from "express";
import fs from "fs";
import { LABEL_TYPES, labelUpload, trackingList } from "./adminForwarding.js";
import {
  EXTERNAL_SALES_LOG,
  ExternalSalesError,
  createExternalSalesSync,
  createSupabaseRest,
  dealId,
  round2,
  saleMoney
} from "./externalSalesSync.js";
import { createExternalSalesInvoicing, createRompslomp } from "./externalSalesInvoicing.js";
import { createOutboundMaker } from "./externalSalesCreate.js";
import { createExternalSalesPayments } from "./externalSalesPayments.js";

export { ExternalSalesError };

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TABS = {
  pending: (s) => s.shipping_status === "pending",
  ready: (s) => s.shipping_status === "ready_to_ship",
  shipped: (s) => s.shipping_status === "shipped",
  cancelled: (s) => s.shipping_status === "cancelled",
  all: () => true
};

const DAY = 86_400_000;
const PAYMENT_DAYS = 7;

// When a deal's payment is due: 7 days after its first invoice, or after
// the sale when there is no invoice yet.
export function dueDate(sale, invoices = []) {
  // sent_at is when the invoice went out (for migrated invoices: when it was
  // published in Rompslomp); created_at is only when it reached Supabase.
  // An invoice can be published long after it was made (EXTD-000077: made
  // in April, published in September), so the earlier of the sale and the
  // invoice counts.
  const dates = [
    ...invoices.filter((i) => i.kind === "sale").map((i) => new Date(i.sent_at || i.created_at).getTime()),
    new Date(sale.sale_date || sale.created_at).getTime()
  ].filter(Number.isFinite);
  const from = dates.length ? Math.min(...dates) : NaN;
  return Number.isFinite(from) ? new Date(from + PAYMENT_DAYS * DAY) : null;
}

/*
 * The one thing to do next on a deal, in the order work happens: the
 * invoice, the label, Pack & Ship, then the money. `tone` colours it:
 * bad (wrong or late), wait (needs someone), move (in progress), good (done).
 */
export function nextStep({ sale, parcels = [], invoices = [], now = Date.now() }) {
  if (sale.payment_status === "cancelled" || sale.shipping_status === "cancelled") return { key: "cancelled", tone: "", text: "Cancelled" };
  if (sale.bookkeeping_status === "to_invoice") return { key: "invoice", tone: "bad", text: "Create the invoice" };
  if (sale.shipping_status === "pending") return { key: "label", tone: "wait", text: "Add a label and its tracking number" };
  if (sale.shipping_status === "ready_to_ship") return { key: "pack", tone: "move", text: "Ready for Pack & Ship" };

  if (["pending", "partially_paid"].includes(sale.payment_status)) {
    const due = dueDate(sale, invoices);
    const late = due && now > due.getTime();
    const dueText = due ? due.toISOString().slice(0, 10).split("-").reverse().join("-") : "";
    return {
      key: late ? "overdue" : "payment",
      tone: late ? "bad" : "wait",
      text: `${late ? "Payment overdue" : "Waiting for payment"}: €${Number(sale.total_selling_price || 0).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${dueText ? `, due ${dueText}` : ""}`
    };
  }

  return { key: "done", tone: "good", text: "Done" };
}

/*
 * Everything that is missing or does not add up.
 *
 * error    wrong in the books or the money
 * warning  needs someone to act
 * info     expected for now, listed so nothing is forgotten
 */
export function externalSalesChecks({ sales, pairsBySale, parcelsBySale, invoicesBySale, sync, now = Date.now() }) {
  const checks = [];
  const byId = new Map(sales.map((s) => [s.id, s]));
  const add = (key, severity, title, hint, items) => {
    const open = items.filter((item) => !byId.get(item.id)?.dismissed_checks?.[key]).map((item) => ({ ...item, key }));
    if (open.length) checks.push({ key, severity, title, hint, items: open });
  };

  const live = sales.filter((s) => s.payment_status !== "cancelled");
  const row = (s, detail = "") => ({ id: s.id, deal: dealId(s), buyer: s.buyer_name || "", detail });

  if (sync?.error) {
    checks.push({ key: "sync_down", severity: "error", title: "The Airtable sync failed", hint: "New outbounds and payments from Airtable are not coming in. The message says why.", items: [{ id: "", deal: "", buyer: "", detail: sync.error }] });
  }

  add("sync_errors", "error", "Deals the sync could not read", "Open the deal in Airtable and fix what the message says; the next sync picks it up.",
    (sync?.errors || []).map((e) => ({ id: "", deal: e.deal, buyer: "", detail: e.message })));

  add("missing_in_airtable", "error", "In Supabase, gone from Airtable", "The External Sales Log row was deleted. Check whether the deal really is off.",
    (sync?.missing || []).map((m) => ({ id: m.sale, deal: m.deal, buyer: "", detail: "" })));

  add("cancelled_invoiced", "error", "Cancelled, but invoiced", "Needs a credit invoice and a reversing journal entry.",
    sales.filter((s) => s.payment_status === "cancelled" && s.bookkeeping_status === "invoiced").map((s) => row(s)));

  add("invoice_without_journal", "error", "Invoice without its journal entry", "The stock correction (Voorraadcorrectie) is missing in Rompslomp.",
    sales.flatMap((s) => (invoicesBySale.get(s.id) || []).filter((i) => i.kind === "sale" && !i.journal_entry_id).map((i) => row(s, i.invoice_number || i.rompslomp_invoice_id))));

  add("purchase_missing", "error", "Pair without purchase price or VAT type", "Fill in VAT Type and Final Purchase Price on the Inventory Unit; the sync reads it again.",
    live.flatMap((s) => (pairsBySale.get(s.id) || []).filter((p) => !p.purchase_vat_type || !(Number(p.purchase_price_ex_vat) > 0)).map((p) => row(s, `${p.item_id || p.inventory_unit_record_id} ${p.sku || ""} ${p.size || ""}`.trim()))));

  add("no_pairs", "error", "Deal without pairs", "Link the Inventory Units to the deal in Airtable.",
    live.filter((s) => !(pairsBySale.get(s.id) || []).length).map((s) => row(s)));

  add("no_buyer", "error", "Deal without buyer", "Link the buyer in Airtable; the invoice needs one.",
    live.filter((s) => !s.buyer_record_id).map((s) => row(s)));

  const moneyOf = (s) => saleMoney(s, pairsBySale.get(s.id) || []);


  add("mixed_vat", "warning", "Mixed VAT types, no price per pair", "Enter the selling price per pair: the invoice and the profit need to know which part is margin and which is VAT.",
    live.filter((s) => s.bookkeeping_status === "to_invoice" && moneyOf(s).selling_ex_vat === null && (pairsBySale.get(s.id) || []).length).map((s) => row(s)));

  add("pair_prices_sum", "warning", "Prices per pair do not add up", "The prices per pair must add up to the deal's selling price.",
    live.filter((s) => {
      const pairs = pairsBySale.get(s.id) || [];
      if (!pairs.length || pairs.some((p) => p.selling_price === null || p.selling_price === undefined)) return false;
      return Math.abs(pairs.reduce((sum, p) => sum + Number(p.selling_price), 0) - Number(s.total_selling_price)) > 0.01;
    }).map((s) => row(s, `€ ${(pairsBySale.get(s.id) || []).reduce((sum, p) => sum + Number(p.selling_price), 0).toFixed(2)} vs € ${Number(s.total_selling_price).toFixed(2)}`)));

  add("paid_not_shipped", "warning", "Paid, not shipped after 3 days", "Check whether it left; Pack & Ship marks it Shipped.",
    live.filter((s) => s.payment_status === "paid" && ["pending", "ready_to_ship"].includes(s.shipping_status) && now - new Date(s.paid_at || s.sale_date || s.created_at).getTime() > 3 * DAY).map((s) => row(s, s.shipping_status === "pending" ? "no label yet" : "ready to ship")));

  // Only for deals made since the switch (22-09-2026): before that a
  // tracking number was optional, and those deals are long delivered.
  add("shipped_no_tracking", "warning", "Shipped without tracking", "Add the tracking number to its parcel.",
    live.filter((s) => s.shipping_status === "shipped" && !s.airtable_record_id && !(parcelsBySale.get(s.id) || []).some((p) => p.tracking_number)).map((s) => row(s)));

  add("labels_short", "warning", "Fewer labels than expected", "The outbound asked for more labels than the deal has.",
    live.filter((s) => s.shipping_status === "ready_to_ship" && s.labels_needed > (parcelsBySale.get(s.id) || []).filter((p) => p.label_url).length).map((s) => row(s, `${(parcelsBySale.get(s.id) || []).filter((p) => p.label_url).length} of ${s.labels_needed}`)));

  add("invoice_not_sent", "warning", "Invoice not mailed to the buyer", "Open the deal and click Send invoice again - the message there says why it failed.",
    live.filter((s) => (invoicesBySale.get(s.id) || []).some((i) => i.kind === "sale" && !i.sent_at && new Date(i.created_at).getTime() > Date.parse("2026-09-22"))).map((s) => row(s)));

  add("unpaid_old", "warning", "Payment overdue", "Past the 7 days on the invoice. If it was paid: link the payment to the invoice in Rompslomp (the deal follows within 10 minutes) or use Mark as paid. If not: Send reminder.",
    live.filter((s) => {
      if (!["pending", "partially_paid"].includes(s.payment_status)) return false;
      if (!(invoicesBySale.get(s.id) || []).some((i) => i.kind === "sale")) return false;
      const due = dueDate(s, invoicesBySale.get(s.id) || []);
      return due && now > due.getTime();
    }).map((s) => row(s, s.payment_status === "partially_paid" ? "partially paid" : `due ${dueDate(s, invoicesBySale.get(s.id) || []).toISOString().slice(0, 10)}`)));

  add("to_invoice", "error", "No invoice yet", "Open the deal and click Create invoice. It says what is still missing, if anything.",
    live.filter((s) => s.bookkeeping_status === "to_invoice").map((s) => row(s)));

  return checks;
}

export function createExternalSalesStore({ airtable, supabaseUrl, serviceKey, callWms, rompslompToken = "", rompslompCompanyId = "1296508534", sendMail = null, mailFrom = "noreply@kickzcaviar.nl", replyTo = "info@kickzcaviar.nl", mollieApiKey = "", paymentRedirectUrl = "https://kickzcaviar.com", paymentWebhookUrl = "", airtableSync = false, fetchImpl = fetch }) {
  const db = createSupabaseRest({ supabaseUrl, serviceKey, fetchImpl });
  const rompslomp = createRompslomp({ token: rompslompToken, companyId: rompslompCompanyId, fetchImpl });

  async function mollie(path, { method = "GET", body } = {}) {
    if (!text(mollieApiKey)) throw new ExternalSalesError("Payment links need MOLLIE_API_KEY on this service.", 503);
    const response = await fetchImpl(`https://api.mollie.com/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${mollieApiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ExternalSalesError(`Mollie said no: ${data.detail || data.title || response.status}`, 502);
    return data;
  }

  const payments = createExternalSalesPayments({
    db,
    airtable,
    rompslomp,
    mollie,
    links: { redirectUrl: paymentRedirectUrl, webhookUrl: paymentWebhookUrl }
  });

  const invoicing = createExternalSalesInvoicing({
    db,
    airtable,
    rompslomp,
    sendMail: async (message) => {
      if (!sendMail) throw new ExternalSalesError("Mail is not configured on this service.", 503);
      return sendMail(message);
    },
    mailFrom,
    replyTo
  });

  const storeLabel = async ({ dealId: deal, filename, mime, bytes }) => {
    const stored = await callWms("/api/upload-label-file", {
      folder: "external-sales",
      file_name: `${deal}-${filename}`,
      file_data_url: `data:${mime};base64,${bytes.toString("base64")}`
    });
    if (!stored?.url) throw new Error("The WMS did not store the label.");
    return { url: stored.url, filename: stored.filename || `${deal}-${filename}` };
  };

  const sync = createExternalSalesSync({ airtable, db, storeLabel, fetchImpl, enabled: airtableSync });
  let syncError = "";

  async function runSync(options = {}) {
    try {
      const result = await sync.run(options);
      if (!options.airtableId) syncError = "";
      return result;
    } catch (err) {
      if (!options.airtableId) syncError = err.message;
      throw err;
    }
  }

  const syncState = () => {
    const last = sync.lastRun();
    return { at: last?.at || null, ms: last?.ms || 0, deals: last?.deals || 0, changed: last?.changed || [], errors: last?.errors || [], warnings: last?.warnings || [], missing: last?.missing || [], error: syncError };
  };

  async function loadAll() {
    const [sales, pairs, parcels, links, invoices] = await Promise.all([
      db.get("external_sales?select=*&order=deal_number.desc&limit=10000"),
      db.get("external_sale_pairs?select=*&limit=50000"),
      db.get("shipments?select=*&external_sale_id=not.is.null&order=created_at.asc&limit=50000"),
      db.get("external_sale_invoice_deals?select=*&limit=50000"),
      db.get("external_sale_invoices?select=*&limit=10000")
    ]);

    const group = (rows, key) => rows.reduce((map, r) => map.set(r[key], [...(map.get(r[key]) || []), r]), new Map());
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));
    const invoicesBySale = new Map();
    for (const link of links) {
      const invoice = invoiceById.get(link.invoice_id);
      if (invoice) invoicesBySale.set(link.sale_id, [...(invoicesBySale.get(link.sale_id) || []), invoice]);
    }

    return { sales, pairsBySale: group(pairs, "sale_id"), parcelsBySale: group(parcels, "external_sale_id"), invoicesBySale };
  }

  function listRow(s, data) {
    const pairs = data.pairsBySale.get(s.id) || [];
    const parcels = data.parcelsBySale.get(s.id) || [];
    return {
      id: s.id,
      deal: dealId(s),
      airtable_record_id: s.airtable_record_id,
      buyer_name: s.buyer_name,
      buyer_company: s.buyer_company,
      buyer_country: s.buyer_country,
      sale_date: s.sale_date,
      skus: [...new Set(pairs.map((p) => p.sku).filter(Boolean))],
      payment_status: s.payment_status,
      shipping_status: s.shipping_status,
      bookkeeping_status: s.bookkeeping_status,
      labels_needed: s.labels_needed,
      labels: parcels.filter((p) => p.label_url).length,
      tracking: parcels.map((p) => p.tracking_number).filter(Boolean),
      invoices: (data.invoicesBySale.get(s.id) || []).map((i) => i.invoice_number).filter(Boolean),
      money: saleMoney(s, pairs),
      next: nextStep({ sale: s, parcels, invoices: data.invoicesBySale.get(s.id) || [] })
    };
  }

  async function list(tab = "all") {
    const data = await loadAll();
    const keep = TABS[tab] || TABS.all;
    return data.sales.filter(keep).map((s) => listRow(s, data));
  }

  async function saleById(id) {
    if (!UUID.test(text(id))) throw new ExternalSalesError("Unknown deal.");
    const [sale] = await db.get(`external_sales?select=*&id=eq.${text(id)}`);
    if (!sale) throw new ExternalSalesError("That deal no longer exists.", 404);
    return sale;
  }

  async function detail(id) {
    const sale = await saleById(id);
    const [pairs, parcels, links] = await Promise.all([
      db.get(`external_sale_pairs?select=*&sale_id=eq.${sale.id}&order=created_at.asc`),
      db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`),
      db.get(`external_sale_invoice_deals?select=invoice_id&sale_id=eq.${sale.id}`)
    ]);
    const invoices = links.length
      ? await db.get(`external_sale_invoices?select=*&id=in.(${links.map((l) => `"${l.invoice_id}"`).join(",")})`)
      : [];

    const due = dueDate(sale, invoices);
    return {
      sale: { ...sale, deal: dealId(sale) },
      pairs,
      parcels,
      invoices,
      money: saleMoney(sale, pairs),
      next: nextStep({ sale, parcels, invoices }),
      due_date: due ? due.toISOString().slice(0, 10) : null
    };
  }

  async function checks() {
    return externalSalesChecks({ ...(await loadAll()), sync: syncState() });
  }

  async function counts() {
    const data = await loadAll();
    const all = externalSalesChecks({ ...data, sync: syncState() });
    return {
      pending: data.sales.filter(TABS.pending).length,
      ready: data.sales.filter(TABS.ready).length,
      checks: all.filter((c) => c.severity !== "info").reduce((sum, c) => sum + c.items.length, 0)
    };
  }

  /* ----- edits ----- */

  const parcelOf = async (id) => {
    if (!UUID.test(text(id))) throw new ExternalSalesError("Unknown parcel.");
    const [parcel] = await db.get(`shipments?select=*&id=eq.${text(id)}`);
    if (!parcel?.external_sale_id) throw new ExternalSalesError("That parcel no longer exists.", 404);
    return parcel;
  };

  const cleanTracking = (value) => {
    const tracking = text(value).replace(/\s+/g, "");
    if (tracking && !/^[A-Za-z0-9-]{6,40}$/.test(tracking)) throw new ExternalSalesError("That is not a tracking number: letters and digits only, 6 to 40 long.");
    return tracking || null;
  };

  // A new parcel: a label, a tracking number, or both.
  async function addParcel(id, { file, tracking }) {
    const sale = await saleById(id);
    const number = cleanTracking(tracking);
    const kind = file ? labelUpload(file) : null;

    if (file && !kind) throw new ExternalSalesError("The label must be a PDF, JPEG or PNG file.");
    if (!kind && !number) throw new ExternalSalesError("Add a label, a tracking number, or both.");

    return sync.edit(sale, async (fresh, parcels) => {
      if (number && parcels.some((p) => p.tracking_number === number)) throw new ExternalSalesError(`${number} is already on this deal.`);

      const stored = kind ? await storeLabel({ dealId: dealId(fresh), filename: `${number || "label"}.${kind.ext}`, mime: kind.mime, bytes: file }) : null;
      await db.insert("shipments", [{
        external_sale_id: fresh.id,
        tracking_number: number,
        label_url: stored?.url || null,
        label_filename: stored?.filename || null,
        airtable_attachment_id: null
      }]);
    });
  }

  // A label added to a parcel that had only its tracking number, or replaced.
  async function setParcelLabel(parcelId, file) {
    const parcel = await parcelOf(parcelId);
    const kind = labelUpload(file);
    if (!kind) throw new ExternalSalesError("The label must be a PDF, JPEG or PNG file.");
    const sale = await saleById(parcel.external_sale_id);

    return sync.edit(sale, async (fresh) => {
      const stored = await storeLabel({ dealId: dealId(fresh), filename: `${parcel.tracking_number || "label"}.${kind.ext}`, mime: kind.mime, bytes: file });
      await db.patch(`shipments?id=eq.${parcel.id}`, { label_url: stored.url, label_filename: stored.filename, airtable_attachment_id: null });
    });
  }

  async function setParcelTracking(parcelId, tracking) {
    const parcel = await parcelOf(parcelId);
    const number = cleanTracking(tracking);
    if (!number && !parcel.label_url) throw new ExternalSalesError("A parcel without a label needs its tracking number. Remove the parcel instead.");
    const sale = await saleById(parcel.external_sale_id);

    return sync.edit(sale, async (fresh, parcels) => {
      if (number && parcels.some((p) => p.id !== parcel.id && p.tracking_number === number)) throw new ExternalSalesError(`${number} is already on another parcel of this deal.`);
      await db.patch(`shipments?id=eq.${parcel.id}`, { tracking_number: number });
    });
  }

  async function removeParcel(parcelId) {
    const parcel = await parcelOf(parcelId);
    const sale = await saleById(parcel.external_sale_id);
    return sync.edit(sale, async () => {
      await db.remove(`shipments?id=eq.${parcel.id}`);
    });
  }

  async function markShipped(id) {
    const sale = await saleById(id);
    if (sale.shipping_status === "cancelled") throw new ExternalSalesError("This deal is cancelled.");
    return sync.edit(sale, async (fresh) => {
      if (fresh.shipping_status !== "shipped") {
        await db.patch(`external_sales?id=eq.${fresh.id}`, { shipping_status: "shipped", shipped_at: new Date().toISOString() });
      }
    });
  }

  // Shipping costs still belong to Airtable until step 5: written there and
  // read back.
  async function setShippingCosts(id, value) {
    const costs = Number(String(value).replace(",", "."));
    if (!Number.isFinite(costs) || costs < 0) throw new ExternalSalesError("Shipping costs cannot be negative.");
    const sale = await saleById(id);
    if (!sale.airtable_record_id) throw new ExternalSalesError("This deal is not in Airtable.");

    return sync.edit(sale, async (fresh) => {
      await airtable.update(EXTERNAL_SALES_LOG, fresh.airtable_record_id, { "Shipping Costs": round2(costs) });
      return { reload: true, mirror: false };
    });
  }

  async function setNotes(id, notes) {
    const sale = await saleById(id);
    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, { notes: text(notes) || null });
    return saved;
  }

  /*
   * Whether a deal goes to the books. Only by hand between "to invoice" and
   * "not invoiced" (APLUG's self-billing, a test deal); "invoiced" and
   * "credited" are set by the invoicing itself, never by hand.
   */
  async function setBookkeeping(id, status, reason) {
    const sale = await saleById(id);
    if (!["to_invoice", "not_invoiced"].includes(status)) throw new ExternalSalesError("Only 'to invoice' and 'not invoiced' can be set by hand.");
    if (["invoiced", "credited"].includes(sale.bookkeeping_status)) throw new ExternalSalesError("This deal is already in the books; that needs a credit invoice, not a switch.");
    if (status === "not_invoiced" && !text(reason)) throw new ExternalSalesError("Say why this deal is not invoiced.");

    const notes = status === "not_invoiced" ? [text(sale.notes), `Not invoiced: ${text(reason)}`].filter(Boolean).join("\n") : sale.notes;
    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, { bookkeeping_status: status, notes });
    return saved;
  }

  // Selling price per pair; empty clears it. The VAT type follows the
  // purchase and the buyer (see sellingVatType) and is not typed.
  async function setPairPrices(id, prices) {
    const sale = await saleById(id);
    if (["invoiced", "credited"].includes(sale.bookkeeping_status)) throw new ExternalSalesError("This deal is invoiced; its prices are on the invoice.");

    const pairs = await db.get(`external_sale_pairs?select=id,selling_price&sale_id=eq.${sale.id}`);
    const known = new Set(pairs.map((p) => p.id));
    const changed = [];

    for (const entry of prices || []) {
      if (!known.has(entry?.id)) throw new ExternalSalesError("That pair is not on this deal.");
      const raw = text(entry.selling_price).replace(",", ".");
      const price = raw === "" ? null : Number(raw);
      if (price !== null && (!Number.isFinite(price) || price < 0)) throw new ExternalSalesError("A price cannot be negative.");
      await db.patch(`external_sale_pairs?id=eq.${entry.id}`, { selling_price: price === null ? null : round2(price) });
      changed.push({ id: entry.id, to: price });
    }

    return changed;
  }

  // Reads the purchase of every pair again from Airtable. Only before the
  // deal is invoiced: after that the books have the old numbers.
  async function refreshPurchase(id) {
    const sale = await saleById(id);
    if (["invoiced", "credited"].includes(sale.bookkeeping_status)) throw new ExternalSalesError("This deal is invoiced; its purchase is booked.");

    const pairs = await db.get(`external_sale_pairs?select=*&sale_id=eq.${sale.id}`);
    const units = await airtable.byIds("Inventory Units", pairs.map((p) => p.inventory_unit_record_id), ["VAT Type", "Final Purchase Price", "Final Purchase Price (ex. VAT)"]);
    const changed = [];

    for (const pair of pairs) {
      const u = units.get(pair.inventory_unit_record_id);
      if (!u) continue;
      const vat = ["Margin", "VAT0", "VAT21"].includes(text(u["VAT Type"])) ? text(u["VAT Type"]) : null;
      const price = round2(vat === "VAT21" ? u["Final Purchase Price (ex. VAT)"] : u["Final Purchase Price"]);
      if (vat === pair.purchase_vat_type && price === Number(pair.purchase_price_ex_vat)) continue;
      await db.patch(`external_sale_pairs?id=eq.${pair.id}`, { purchase_vat_type: vat, purchase_price_ex_vat: price });
      changed.push({ item: pair.item_id, from: { vat: pair.purchase_vat_type, price: Number(pair.purchase_price_ex_vat) }, to: { vat, price } });
    }

    // The selling VAT follows the purchase: let the sync set it again.
    if (changed.length && sale.airtable_record_id) await runSync({ airtableId: sale.airtable_record_id });
    return changed;
  }

  const outbounds = createOutboundMaker({ db, airtable, invoicing, payments });

  /*
   * Pack & Ship (block 3). Only deals made in Supabase: one that came from
   * the Airtable External Sales Log is still packed from there until it has
   * shipped, so no deal shows twice. Ready to Ship with at least one tracking
   * number, as Pack & Ship always asked.
   */
  async function packShipList() {
    // With the Airtable sync on, a deal from the External Sales Log is still
    // packed from there; with it off (block 5) every deal is packed from here.
    const fromAirtable = sync.enabled ? "&airtable_record_id=is.null" : "";
    const sales = await db.get(`external_sales?select=id,deal_number,buyer_name,buyer_company&shipping_status=eq.ready_to_ship${fromAirtable}&order=deal_number.asc&limit=500`);
    if (!sales.length) return [];
    const parcels = await db.get(`shipments?select=external_sale_id,tracking_number&external_sale_id=in.(${sales.map((x) => `"${x.id}"`).join(",")})`);
    return sales
      .map((sale) => ({
        id: sale.id,
        deal: dealId(sale),
        buyer: text(sale.buyer_company) || text(sale.buyer_name),
        tracking_count: parcels.filter((p) => p.external_sale_id === sale.id && p.tracking_number).length
      }))
      .filter((option) => option.tracking_count > 0);
  }

  async function packShipGet(id) {
    const sale = await saleById(id);
    const [pairs, parcels] = await Promise.all([
      db.get(`external_sale_pairs?select=*&sale_id=eq.${sale.id}&order=created_at.asc`),
      db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`)
    ]);
    const units = pairs.length ? await airtable.byIds("Inventory Units", pairs.map((p) => p.inventory_unit_record_id), ["Product GTIN"]) : new Map();
    return {
      id: sale.id,
      deal: dealId(sale),
      shipping_status: sale.shipping_status,
      tracking_numbers: parcels.map((p) => p.tracking_number).filter(Boolean),
      labels: parcels.filter((p) => p.label_url).map((p) => ({ url: p.label_url, filename: p.label_filename || "label.pdf" })),
      items: pairs.map((p) => ({
        id: p.inventory_unit_record_id,
        gtin: text(units.get(p.inventory_unit_record_id)?.["Product GTIN"]),
        product_name: text(p.product_name),
        sku: text(p.sku),
        size: text(p.size)
      }))
    };
  }

  // Shipped: the WMS sets the units on Sold, as it does for every outbound.
  async function packShipShip(id, itemsPerParcel) {
    const sale = await saleById(id);
    if (sale.shipping_status !== "ready_to_ship") {
      throw new ExternalSalesError(`${dealId(sale)} is ${sale.shipping_status.replace(/_/g, " ")}, not ready to ship.`, 409);
    }
    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, {
      shipping_status: "shipped",
      shipped_at: new Date().toISOString(),
      items_per_parcel: text(itemsPerParcel) || null
    });
    return saved;
  }

  // A check set aside on purpose, with the reason; it no longer shows.
  async function dismissCheck(id, key, reason, by) {
    const sale = await saleById(id);
    if (!text(key)) throw new ExternalSalesError("Which check?");
    if (!text(reason)) throw new ExternalSalesError("Say why this can stay as it is.");
    const dismissed = { ...(sale.dismissed_checks || {}), [text(key)]: { reason: text(reason), by: text(by), at: new Date().toISOString() } };
    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, { dismissed_checks: dismissed });
    return saved;
  }

  // Invoicing starts from the deal as Airtable has it now.
  async function freshFromAirtable(id) {
    const sale = await saleById(id);
    if (sale.airtable_record_id) {
      const out = await runSync({ airtableId: sale.airtable_record_id });
      if (out.errors.length) throw new ExternalSalesError(`Could not read ${dealId(sale)} from Airtable first: ${out.errors[0].message}`, 502);
    }
    return sale;
  }

  return {
    configured: db.configured,
    invoicePreview: async (id) => { await freshFromAirtable(id); return invoicing.preview(id); },
    invoice: async (id, options) => { await freshFromAirtable(id); return invoicing.invoice(id, options); },
    mailInvoices: (id, options) => invoicing.mailInvoices(id, options),
    invoicePdf: (invoiceRowId) => invoicing.invoicePdf(invoiceRowId),
    credit: (id, invoiceId) => invoicing.credit(id, invoiceId),
    link: (id, rompslompInvoiceId) => invoicing.link(id, rompslompInvoiceId),
    packShipList,
    packShipGet,
    packShipShip,
    checkPayments: (options) => payments.checkRompslomp(options),
    markPaid: (id, input) => payments.markPaid(id, input),
    paymentLink: (id, options) => payments.paymentLink(id, options),
    settleFromBatch: (dealIds, options) => payments.settleFromBatch(dealIds, options),
    mollieSuggestions: () => payments.mollieSuggestions(),
    linkMolliePayment: (id, paymentId) => payments.linkMolliePayment(id, paymentId),
    dismissCheck,
    airtableSync: sync.enabled,
    outboundPreview: (input) => outbounds.preview(input),
    outboundCreate: (input) => outbounds.create(input),
    runSync,
    syncState,
    list,
    detail,
    checks,
    counts,
    addParcel,
    setParcelLabel,
    setParcelTracking,
    removeParcel,
    markShipped,
    setShippingCosts,
    setNotes,
    setBookkeeping,
    setPairPrices,
    refreshPurchase
  };
}

export function mountExternalSales(router, { store, audit, pageFile, internalSecret = "" }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof ExternalSalesError ? err.status : 500;
    if (status >= 500) console.error("[admin external sales]", err.message);
    res.status(status).json({ error: err instanceof ExternalSalesError ? err.message : `External Sales failed: ${err.message}` });
  };

  const log = (req, action, sale, details) =>
    audit.record({ actor: req.admin, action, source: "external_sales", recordId: sale.id, label: dealId(sale), details }).catch(() => {});

  const detailFor = async (res, id) => res.json(await store.detail(id));

  router.get(["/admin/external-sales", "/admin/external-sales/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/external-sales", async (req, res) => {
    try {
      // The sidebar counts come along: counting in Supabase costs nothing, so
      // they are never behind the list the way the cached admin counts are.
      const [sales, counts] = await Promise.all([store.list(text(req.query.tab) || "all"), store.counts()]);
      res.json({ sales, counts, sync: store.syncState() });
    } catch (err) {
      send(res, err);
    }
  });

  // Paid Mollie payments no batch knows, suggested for the open deals.
  router.get("/api/admin/external-sales/mollie-suggestions", async (req, res) => {
    try {
      res.json({ suggestions: await store.mollieSuggestions() });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/external-sales/checks", async (req, res) => {
    try {
      res.json({ checks: await store.checks(), sync: store.syncState() });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/external-sales/get", async (req, res) => {
    try {
      const out = await store.detail(req.query.id);
      const history = [
        ...(await audit.forRecord(out.sale.id).catch(() => [])),
        ...(out.sale.airtable_record_id ? await audit.forRecord(out.sale.airtable_record_id).catch(() => []) : [])
      ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      res.json({ ...out, history });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/sync", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const result = await store.runSync();
      res.json({ sync: store.syncState(), changed: result.changed.length, errors: result.errors.length });
    } catch (err) {
      send(res, err);
    }
  });

  // A new parcel. The body is the label file, or empty for tracking only.
  router.post("/api/admin/external-sales/parcel", express.raw({ type: [...LABEL_TYPES, "application/octet-stream"], limit: "10mb" }), async (req, res) => {
    try {
      const file = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
      const sale = await store.addParcel(req.query.sale, { file, tracking: req.query.tracking });
      await log(req, "external_sale_parcel_added", sale, { tracking: text(req.query.tracking) || null, label: Boolean(file) });
      await detailFor(res, sale.id);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/parcel/label", express.raw({ type: LABEL_TYPES, limit: "10mb" }), async (req, res) => {
    try {
      const sale = await store.setParcelLabel(req.query.id, req.body);
      await log(req, "external_sale_parcel_label", sale, { parcel: text(req.query.id) });
      await detailFor(res, sale.id);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/parcel/tracking", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const sale = await store.setParcelTracking(req.body?.id, req.body?.tracking_number);
      await log(req, "external_sale_parcel_tracking", sale, { parcel: text(req.body?.id), tracking: text(req.body?.tracking_number) || null });
      await detailFor(res, sale.id);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/parcel/remove", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const sale = await store.removeParcel(req.body?.id);
      await log(req, "external_sale_parcel_removed", sale, { parcel: text(req.body?.id) });
      await detailFor(res, sale.id);
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/external-sales/invoice/preview", async (req, res) => {
    try {
      res.json(await store.invoicePreview(req.query.id));
    } catch (err) {
      send(res, err);
    }
  });

  // Invoice(s), journal entries and the mail - see externalSalesInvoicing.js.
  router.post("/api/admin/external-sales/invoice", express.json({ limit: "10kb" }), async (req, res) => {
    let before = null;
    try {
      before = (await store.detail(req.body?.id)).sale;
      const out = await store.invoice(before.id, { mail: req.body?.mail !== false });
      await log(req, "external_sale_invoiced", before, { log: out.log });
      res.json({ ...(await store.detail(before.id)), log: out.log });
    } catch (err) {
      // Half done is still written down: what exists is on the deal.
      if (before) await log(req, "external_sale_invoice_failed", before, { error: err.message });
      send(res, err);
    }
  });

  router.get("/api/admin/external-sales/invoice/pdf", async (req, res) => {
    try {
      const { filename, pdf } = await store.invoicePdf(text(req.query.id));
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `inline; filename="${filename}"`);
      res.set("Cache-Control", "no-store");
      res.send(pdf);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/invoice/mail", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const before = (await store.detail(req.body?.id)).sale;
      // A test goes to the signed-in admin, never to an address from the browser.
      const out = await store.mailInvoices(before.id, { testTo: req.body?.test ? req.admin.email : "" });
      await log(req, out.test ? "external_sale_invoice_test_mail" : "external_sale_invoice_mailed", before, out);
      res.json({ ...(await store.detail(before.id)), log: [`${out.test ? "Test mail with" : "Mailed"} ${out.invoices.join(", ")} to ${out.to}`] });
    } catch (err) {
      send(res, err);
    }
  });

  /*
   * Create Outbound in the WMS (block 2). Not behind the admin login: the WMS
   * sends the secret it already shares with the portals (x-kc-secret).
   */
  const fromWms = (req, res) => {
    const secret = text(req.headers["x-kc-secret"]);
    if (!text(internalSecret) || secret !== text(internalSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

  router.post("/api/internal/external-sales/preview", express.json({ limit: "200kb" }), async (req, res) => {
    if (!fromWms(req, res)) return;
    try {
      res.json({ ok: true, preview: await store.outboundPreview(req.body || {}) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/external-sales/create", express.json({ limit: "200kb" }), async (req, res) => {
    if (!fromWms(req, res)) return;
    try {
      const out = await store.outboundCreate(req.body || {});
      await audit.record({
        actor: { email: "wms", name: text(req.body?.created_by) || "WMS Create Outbound" },
        action: "external_sale_created",
        source: "external_sales",
        recordId: out.id,
        label: out.deal,
        details: { pairs: out.pairs, total: out.total, invoice: out.invoice_log, invoice_error: out.invoice_error || null }
      }).catch(() => {});
      res.json({ ok: true, ...out });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/external-sales/pack-ship/list", express.json({ limit: "10kb" }), async (req, res) => {
    if (!fromWms(req, res)) return;
    try {
      res.json({ ok: true, sales: await store.packShipList() });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/external-sales/pack-ship/get", express.json({ limit: "10kb" }), async (req, res) => {
    if (!fromWms(req, res)) return;
    try {
      res.json({ ok: true, sale: await store.packShipGet(req.body?.id) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/external-sales/pack-ship/ship", express.json({ limit: "20kb" }), async (req, res) => {
    if (!fromWms(req, res)) return;
    try {
      const sale = await store.packShipShip(req.body?.id, req.body?.items_per_parcel);
      await audit.record({
        actor: { email: "wms", name: "WMS Pack & Ship" },
        action: "external_sale_shipped",
        source: "external_sales",
        recordId: sale.id,
        label: dealId(sale),
        details: { items_per_parcel: sale.items_per_parcel }
      }).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      send(res, err);
    }
  });

  // An invoice made by hand, taken over by the deal.
  router.post("/api/admin/external-sales/invoice/link", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const before = (await store.detail(req.body?.id)).sale;
      const out = await store.link(before.id, text(req.body?.rompslomp_invoice_id));
      await log(req, "external_sale_invoice_linked", before, out);
      res.json({ ...(await store.detail(before.id)), log: out.log });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/external-sales/invoice/credit", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const before = (await store.detail(req.body?.id)).sale;
      const out = await store.credit(before.id, text(req.body?.invoice_id));
      await log(req, "external_sale_credited", before, out);
      res.json({ ...(await store.detail(before.id)), log: [`Credit ${out.credit} for ${out.of}`] });
    } catch (err) {
      send(res, err);
    }
  });

  // Everything else on a deal, one change per call.
  router.post("/api/admin/external-sales/update", express.json({ limit: "50kb" }), async (req, res) => {
    try {
      const id = req.body?.id;
      const before = (await store.detail(id)).sale;
      let details;

      if (req.body?.mark_shipped) {
        await store.markShipped(id);
        details = { shipping_status: { from: before.shipping_status, to: "shipped" } };
      } else if (req.body?.shipping_costs !== undefined) {
        await store.setShippingCosts(id, req.body.shipping_costs);
        details = { shipping_costs: { from: Number(before.shipping_costs), to: text(req.body.shipping_costs) } };
      } else if (req.body?.notes !== undefined) {
        await store.setNotes(id, req.body.notes);
        details = { notes: { from: before.notes, to: text(req.body.notes) } };
      } else if (req.body?.bookkeeping_status) {
        await store.setBookkeeping(id, text(req.body.bookkeeping_status), req.body.reason);
        details = { bookkeeping_status: { from: before.bookkeeping_status, to: text(req.body.bookkeeping_status) }, reason: text(req.body.reason) || null };
      } else if (Array.isArray(req.body?.pair_prices)) {
        details = { pair_prices: await store.setPairPrices(id, req.body.pair_prices) };
      } else if (req.body?.refresh_purchase) {
        details = { purchase: await store.refreshPurchase(id) };
      } else if (req.body?.mark_paid) {
        const saved = await store.markPaid(id, req.body.mark_paid);
        details = { payment: { from: before.payment_status, to: saved.payment_status, amount: text(req.body.mark_paid.amount) || "all", date: text(req.body.mark_paid.date) || null, note: text(req.body.mark_paid.note) || null } };
      } else if (req.body?.payment_link) {
        details = { payment_link: await store.paymentLink(id, { fresh: Boolean(req.body.payment_link.fresh) }) };
      } else if (req.body?.reminder) {
        details = { reminder: await store.mailInvoices(id, { reminder: true }) };
      } else if (req.body?.link_mollie) {
        details = { mollie: await store.linkMolliePayment(id, text(req.body.link_mollie.payment_id)).then((out) => ({ batch: out.batch, payment: text(req.body.link_mollie.payment_id) })) };
      } else if (req.body?.dismiss_check) {
        await store.dismissCheck(id, req.body.dismiss_check.key, req.body.dismiss_check.reason, req.admin?.name || req.admin?.email);
        details = { dismissed: text(req.body.dismiss_check.key), reason: text(req.body.dismiss_check.reason) };
      } else {
        throw new ExternalSalesError("Nothing to change.");
      }

      await log(req, "external_sale_update", before, details);
      await detailFor(res, before.id);
    } catch (err) {
      send(res, err);
    }
  });
}

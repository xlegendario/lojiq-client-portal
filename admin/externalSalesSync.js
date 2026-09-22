// admin/externalSalesSync.js
//
// External Sales live in Supabase (external_sales, external_sale_pairs,
// shipments, external_sale_invoices). Until the WMS writes there itself (step
// 5 of the plan), a new outbound still lands in Airtable's External Sales
// Log, and Pack & Ship still reads that table. So for now:
//
//   Airtable leads the deal: buyer, pairs, prices, payment, "Shipped".
//     The sync copies it into Supabase every few minutes and before every
//     edit in the admin.
//   Supabase leads the parcels: a label and its tracking number together.
//     Every edit in the admin is written back to Airtable as the flat lists
//     Pack & Ship reads (Tracking Numbers, Shipping Labels, Shipping Status).
//
// A label is known by its Airtable attachment id, so nothing is ever copied
// twice. Labels copied over in step 2 had no id yet; the first sync finds them
// by file name.

import { trackingList } from "./adminForwarding.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
export const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

export const EXTERNAL_SALES_LOG = "External Sales Log";

const PAYMENT = { "Pending": "pending", "Partially Paid": "partially_paid", "Paid": "paid", "Cancelled": "cancelled" };
const AIRTABLE_SHIPPING = { pending: "Pending", ready_to_ship: "Ready to Ship", shipped: "Shipped" };
const INVOICED = new Set(["invoiced", "credited"]);

const SALE_FIELDS = [
  "External Deal ID", "Buyer ID", "Buyer Name", "Sale Date", "Created", "Total Selling Price", "Shipping Costs",
  "Payment Status", "Payment Note", "Shipping Status", "Amount of Labels", "Items per Parcel",
  "Tracking Numbers", "Shipping Labels", "Linked Inventory Units"
];
const UNIT_FIELDS = ["Item ID", "Product Name", "SKU", "Size", "VAT Type", "Final Purchase Price", "Final Purchase Price (ex. VAT)", "Picture"];

export const dealId = (sale) => `EXTD-${String(sale?.deal_number ?? "").padStart(6, "0")}`;

/* ---------------- rules ---------------- */

/*
 * The VAT a pair is sold under, from how it was bought.
 *
 * A margin pair is always sold under the margin scheme. Anything else is 21%,
 * unless the buyer is a business abroad with a VAT id: then it is 0% (VAT
 * reverse-charged). A private buyer abroad pays 21%.
 */
export function sellingVatType(purchaseVatType, buyer = {}) {
  if (purchaseVatType === "Margin") return "Margin";
  if (!purchaseVatType) return null;

  const abroad = text(buyer.buyer_country_code) && text(buyer.buyer_country_code).toUpperCase() !== "NL";
  return abroad && text(buyer.buyer_vat_id) ? "VAT0" : "VAT21";
}

/*
 * The money on one deal. Same formula as the external_sales_money view.
 *
 * Selling excl. VAT per pair when every pair has its own price, otherwise from
 * the deal total and the one VAT type all its pairs share. A deal with mixed
 * VAT types and no prices per pair cannot be split: it gets no profit rather
 * than a wrong one.
 */
// Margin VAT is over the margin only; the tile says so.
function vatLabel(types) {
  const set = new Set(types.filter(Boolean));
  if (set.size === 1 && set.has("Margin")) return "VAT on the margin";
  if (set.size === 1 && set.has("VAT0")) return "VAT (0%, reverse-charged)";
  if (set.size === 1 && set.has("VAT21")) return "VAT 21%";
  return "VAT";
}

export function saleMoney(sale, pairs) {
  const purchase = round2(pairs.reduce((sum, pair) => sum + Number(pair.purchase_price_ex_vat || 0), 0));
  const shipping = round2(sale.shipping_costs);
  const pricedPerPair = pairs.length > 0 && pairs.every((pair) => pair.selling_price !== null && pair.selling_price !== undefined && pair.selling_vat_type);

  const exVat = (amount, vat, cost) =>
    vat === "VAT21" ? amount / 1.21
      // No VAT on a negative margin: a loss stays the whole loss.
      : vat === "Margin" ? amount - (Math.max(0, amount - cost) * 21) / 121
        : vat === "VAT0" ? amount
          : null;

  let sellingExVat = null;

  if (pricedPerPair) {
    sellingExVat = pairs.reduce((sum, pair) => sum + exVat(Number(pair.selling_price), pair.selling_vat_type, Number(pair.purchase_price_ex_vat || 0)), 0);
  } else if (sale.legacy_selling_vat_type) {
    sellingExVat = exVat(Number(sale.total_selling_price || 0), sale.legacy_selling_vat_type, purchase);
  }

  return {
    pairs: pairs.length,
    selling: round2(sale.total_selling_price),
    selling_ex_vat: sellingExVat === null ? null : round2(sellingExVat),
    purchase,
    shipping,
    profit: sellingExVat === null ? null : round2(sellingExVat - shipping - purchase),
    priced_per_pair: pricedPerPair,
    vat_label: vatLabel(pricedPerPair ? pairs.map((p) => p.selling_vat_type) : [sale.legacy_selling_vat_type])
  };
}

/*
 * A label file name reduced to what survives being copied: no deal number
 * prefix, no extension, letters and digits only. "label_astro (5).pdf" and
 * "EXTD-000069-label_astro__5_.pdf" are the same label.
 */
export function labelKey(name) {
  let base = text(name).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  let previous = null;

  while (previous !== base) {
    previous = base;
    base = base.replace(/^extd-?\d{6}[-_ ]*/, "");
  }

  return base.replace(/[^a-z0-9]/g, "");
}

// What the sale's shipping status is from its parcels. Cancelled and Shipped
// are never undone by an edit; Airtable's own Ready to Ship is kept.
export function shippingStatusFor({ current, cancelled, airtableStatus = "", parcels }) {
  if (cancelled) return "cancelled";
  if (current === "shipped" || airtableStatus === "Shipped") return "shipped";
  if (parcels > 0 || airtableStatus === "Ready to Ship") return "ready_to_ship";
  return "pending";
}

/* ---------------- Supabase ---------------- */

export class ExternalSalesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createSupabaseRest({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  async function request(pathAndQuery, { method = "GET", body, prefer = "" } = {}) {
    if (!configured) throw new ExternalSalesError("External Sales needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this service.", 503);

    const response = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });

    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;

    if (!response.ok) throw new ExternalSalesError(text(data?.message) || `Supabase answered ${response.status}.`, 502);
    return data;
  }

  return {
    configured,
    get: (path) => request(path),
    insert: (table, rows) => request(table, { method: "POST", body: rows, prefer: "return=representation" }),
    patch: (path, fields) => request(path, { method: "PATCH", body: fields, prefer: "return=representation" }),
    remove: (path) => request(path, { method: "DELETE" })
  };
}

const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(",")})`;

async function inChunks(ids, load) {
  const out = [];
  for (let i = 0; i < ids.length; i += 80) out.push(...(await load(ids.slice(i, i + 80))));
  return out;
}

/* ---------------- sync ---------------- */

/*
 * deps:
 *   airtable   select, byIds, update (the main base)
 *   db         createSupabaseRest
 *   storeLabel ({ dealId, filename, mime, bytes }) -> { url, filename }
 *   fetchImpl  to download an Airtable attachment
 */
export function createExternalSalesSync({ airtable, db, storeLabel, fetchImpl = fetch, enabled = true }) {
  let chain = Promise.resolve();
  let lastRun = null;

  // Everything that touches a deal runs one at a time: the sync every few
  // minutes and every edit, so an edit never races the sync over a label.
  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  }

  async function airtableSales(airtableId = "") {
    if (airtableId) {
      const { records } = await airtable.select(EXTERNAL_SALES_LOG, { formula: `RECORD_ID() = '${airtableId}'`, fields: SALE_FIELDS, pageSize: 1, maxRecords: 1 });
      return records;
    }

    const records = [];
    let offset = "";
    do {
      const page = await airtable.select(EXTERNAL_SALES_LOG, { fields: SALE_FIELDS, pageSize: 100, offset });
      records.push(...page.records);
      offset = page.offset;
    } while (offset);
    return records;
  }

  async function copyLabel(attachment, deal) {
    const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`label ${attachment.filename} could not be downloaded (${response.status})`);

    const bytes = Buffer.from(await response.arrayBuffer());
    const mime = ["image/jpeg", "image/png"].includes(attachment.type) ? attachment.type : "application/pdf";

    return storeLabel({ dealId: deal, filename: attachment.filename || "label.pdf", mime, bytes });
  }

  // One Airtable deal into Supabase. Returns what changed, for the log.
  async function syncDeal(record, current, context) {
    const f = record.fields || {};
    const extdId = text(f["External Deal ID"]);
    const dealNumber = Number(extdId.replace(/\D/g, ""));
    if (!dealNumber) throw new Error(`${record.id} has no External Deal ID`);

    const cancelled = f["Payment Status"] === "Cancelled";
    const buyerRecordId = text(first(f["Buyer ID"])) || null;
    const changes = [];
    let sale = current;

    /* deal */

    const fields = {
      sale_date: text(f["Sale Date"]) || text(f["Created"]).slice(0, 10) || null,
      total_selling_price: round2(f["Total Selling Price"]),
      shipping_costs: round2(f["Shipping Costs"]),
      payment_status: PAYMENT[f["Payment Status"]] || "pending",
      payment_note: text(f["Payment Note"]) || null,
      labels_needed: Number(f["Amount of Labels"]) || 0,
      items_per_parcel: text(f["Items per Parcel"]) || null
    };

    /*
     * The buyer comes from Supabase public.buyers (22-09-2026), found by the
     * Airtable row the deal links to - or one merged into it. Copied onto the
     * deal as it is now until the deal is invoiced; after that the invoice
     * says who it was.
     */
    const buyer = context.buyerFor(buyerRecordId);
    if (!INVOICED.has(sale?.bookkeeping_status)) {
      if (!buyer && buyerRecordId) {
        context.warnings.push({ sale: sale?.id || null, message: `${extdId}: buyer ${buyerRecordId} is not in Supabase buyers.` });
      }
      Object.assign(fields, {
        buyer_record_id: buyer?.airtable_record_id || buyerRecordId,
        buyer_uuid: buyer?.id || null,
        buyer_id: buyer ? `BU-${String(buyer.buyer_number).padStart(5, "0")}` : null,
        buyer_name: text(buyer?.full_name) || text(buyer?.company_name) || text(first(f["Buyer Name"])) || null,
        buyer_company: text(buyer?.company_name) || null,
        buyer_email: text(buyer?.email) || null,
        buyer_country: text(buyer?.country) || null,
        buyer_country_code: text(buyer?.country_code) || null,
        buyer_vat_id: text(buyer?.vat_id) || null
      });
    } else if (buyer && !sale.buyer_uuid) {
      fields.buyer_uuid = buyer.id;
    }

    // Only on the change itself: a deal that was paid before step 2 has no
    // date, and today would be a wrong one.
    if (fields.payment_status === "paid" && (!sale || sale.payment_status !== "paid") && !sale?.paid_at) fields.paid_at = new Date().toISOString();
    if (cancelled && (!sale || sale.payment_status !== "cancelled") && !sale?.cancelled_at) fields.cancelled_at = new Date().toISOString();

    if (!sale) {
      const aplug = /aplug/i.test(text(first(f["Buyer Name"])));
      [sale] = await db.insert("external_sales", [{
        ...fields,
        airtable_record_id: record.id,
        deal_number: dealNumber,
        created_at: text(f["Created"]) || undefined,
        shipping_status: cancelled ? "cancelled" : "pending",
        bookkeeping_status: cancelled || aplug ? "not_invoiced" : "to_invoice",
        notes: aplug ? "APLUG: self-billing" : null,
        synced_at: new Date().toISOString()
      }]);
      changes.push("created");
    } else {
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => String(sale[key] ?? "") !== String(value ?? "")));

      // Money comes back from Postgres as "450.00"; compare as numbers.
      for (const key of ["total_selling_price", "shipping_costs"]) {
        if (key in changed && Number(sale[key]) === Number(fields[key])) delete changed[key];
      }

      if (cancelled && sale.bookkeeping_status === "to_invoice") changed.bookkeeping_status = "not_invoiced";

      if (Object.keys(changed).length) {
        [sale] = await db.patch(`external_sales?id=eq.${sale.id}`, { ...changed, synced_at: new Date().toISOString() });
        changes.push(...Object.keys(changed));
      }
    }

    const invoiced = INVOICED.has(sale.bookkeeping_status);

    /* pairs */

    const unitIds = (f["Linked Inventory Units"] || []).filter(Boolean);
    let pairs = context.pairs.get(sale.id) || [];

    const purchaseOf = (unitId) => {
      // Every key always present: Supabase takes a batch only when all its
      // rows have the same keys.
      const u = context.units.get(unitId) || {};
      const vat = text(u["VAT Type"]) || null;
      const price = vat === "VAT21" ? u["Final Purchase Price (ex. VAT)"] : u["Final Purchase Price"];
      return {
        item_id: text(u["Item ID"]) || null,
        sku: text(u["SKU"]) || null,
        size: text(u["Size"]) || null,
        product_name: text(u["Product Name"]) || null,
        image_url: text(first(u["Picture"])?.thumbnails?.small?.url || first(u["Picture"])?.url) || null,
        purchase_vat_type: ["Margin", "VAT0", "VAT21"].includes(vat) ? vat : null,
        purchase_price_ex_vat: round2(price)
      };
    };

    const known = new Set(pairs.map((pair) => pair.inventory_unit_record_id));
    const added = unitIds.filter((id) => !known.has(id)).map((id) => ({ sale_id: sale.id, inventory_unit_record_id: id, ...purchaseOf(id) }));

    if (added.length) {
      pairs = [...pairs, ...(await db.insert("external_sale_pairs", added))];
      changes.push(`${added.length} pair(s) added`);
    }

    const gone = pairs.filter((pair) => !unitIds.includes(pair.inventory_unit_record_id));
    if (gone.length && !invoiced) {
      await db.remove(`external_sale_pairs?id=${inList(gone.map((pair) => pair.id))}`);
      pairs = pairs.filter((pair) => !gone.includes(pair));
      changes.push(`${gone.length} pair(s) removed`);
    } else if (gone.length) {
      context.warnings.push({ sale: sale.id, message: `${gone.length} pair(s) were unlinked in Airtable after the deal was invoiced - kept here.` });
    }

    // The purchase is fixed at the moment of sale. Only a pair whose purchase
    // was missing is read again - that is a fix, not a change.
    for (const pair of pairs) {
      if (pair.purchase_vat_type && Number(pair.purchase_price_ex_vat) > 0) continue;
      const fresh = purchaseOf(pair.inventory_unit_record_id);
      if (!fresh?.purchase_vat_type || !(fresh.purchase_price_ex_vat > 0)) continue;

      const [row] = await db.patch(`external_sale_pairs?id=eq.${pair.id}`, fresh);
      Object.assign(pair, row);
      changes.push(`purchase of ${pair.item_id || pair.inventory_unit_record_id} filled in`);
    }

    // Selling VAT per pair follows the buyer until the deal is invoiced.
    if (!invoiced) {
      for (const pair of pairs) {
        const vat = sellingVatType(pair.purchase_vat_type, sale);
        if (vat === pair.selling_vat_type) continue;
        const [row] = await db.patch(`external_sale_pairs?id=eq.${pair.id}`, { selling_vat_type: vat });
        Object.assign(pair, row);
      }

      const types = [...new Set(pairs.map((pair) => pair.selling_vat_type))];
      const legacy = types.length === 1 && types[0] ? types[0] : null;

      if (legacy !== sale.legacy_selling_vat_type) {
        [sale] = await db.patch(`external_sales?id=eq.${sale.id}`, { legacy_selling_vat_type: legacy });
      }
    }

    /* parcels */

    let parcels = context.shipments.get(sale.id) || [];
    const attachments = f["Shipping Labels"] || [];
    const airtableTracking = trackingList(f["Tracking Numbers"]);

    const linked = new Set(parcels.map((p) => p.airtable_attachment_id).filter(Boolean));
    const unlinked = parcels.filter((p) => p.label_url && !p.airtable_attachment_id);
    const newLabels = [];

    for (const attachment of attachments) {
      if (linked.has(attachment.id)) continue;

      const match =
        unlinked.find((p) => p.label_filename === attachment.filename) ||
        unlinked.find((p) => labelKey(p.label_filename) === labelKey(attachment.filename));

      if (match) {
        await db.patch(`shipments?id=eq.${match.id}`, { airtable_attachment_id: attachment.id });
        match.airtable_attachment_id = attachment.id;
        unlinked.splice(unlinked.indexOf(match), 1);
        continue;
      }

      newLabels.push(attachment);
    }

    const knownTracking = new Set(parcels.map((p) => p.tracking_number).filter(Boolean));
    const newTracking = airtableTracking.filter((t) => !knownTracking.has(t));
    const rows = [];

    for (const attachment of newLabels) {
      const stored = await copyLabel(attachment, dealId(sale));
      rows.push({ external_sale_id: sale.id, label_url: stored.url, label_filename: stored.filename, airtable_attachment_id: attachment.id, tracking_number: null });
    }

    // A tracking number goes onto a label that has none, when they come in
    // equal numbers - the way the WMS sends them. Otherwise it is its own
    // parcel; nothing is guessed.
    const waiting = [...parcels.filter((p) => p.label_url && !p.tracking_number), ...rows];
    if (newTracking.length && waiting.length === newTracking.length) {
      for (const [i, parcel] of waiting.entries()) {
        if (parcel.id) {
          await db.patch(`shipments?id=eq.${parcel.id}`, { tracking_number: newTracking[i] });
          parcel.tracking_number = newTracking[i];
        } else {
          parcel.tracking_number = newTracking[i];
        }
      }
    } else {
      for (const tracking of newTracking) {
        rows.push({ external_sale_id: sale.id, label_url: null, label_filename: null, airtable_attachment_id: null, tracking_number: tracking });
      }
    }

    if (rows.length) {
      parcels = [...parcels, ...(await db.insert("shipments", rows))];
      changes.push(`${rows.length} parcel(s) from Airtable`);
    }

    /* shipping status */

    const airtableStatus = text(f["Shipping Status"]);
    const status = shippingStatusFor({ current: sale.shipping_status, cancelled, airtableStatus, parcels: parcels.length });

    if (status !== sale.shipping_status) {
      [sale] = await db.patch(`external_sales?id=eq.${sale.id}`, {
        shipping_status: status,
        ...(status === "shipped" && !sale.shipped_at ? { shipped_at: new Date().toISOString() } : {})
      });
      changes.push(`shipping ${status}`);
    }

    // Parcels that arrived by hand in Airtable, with the status left on
    // Pending: put it on Ready to Ship there too, so Pack & Ship sees it.
    if (status === "ready_to_ship" && airtableStatus !== "Ready to Ship") {
      await airtable.update(EXTERNAL_SALES_LOG, record.id, { "Shipping Status": "Ready to Ship" });
    }

    return { sale, pairs, parcels, changes };
  }

  // Everything the deals need from Airtable and Supabase, in as few calls as
  // possible.
  async function context(records, all) {
    const ids = records.map((r) => r.id);
    const sales = all
      ? await db.get("external_sales?select=*&limit=10000")
      : await inChunks(ids, (chunk) => db.get(`external_sales?select=*&airtable_record_id=${inList(chunk)}`));

    const saleIds = sales.map((s) => s.id);
    const pairsRows = saleIds.length ? await inChunks(saleIds, (chunk) => db.get(`external_sale_pairs?select=*&sale_id=${inList(chunk)}`)) : [];
    const shipmentRows = saleIds.length ? await inChunks(saleIds, (chunk) => db.get(`shipments?select=*&external_sale_id=${inList(chunk)}&order=created_at.asc`)) : [];

    const group = (rows, key) => rows.reduce((map, row) => map.set(row[key], [...(map.get(row[key]) || []), row]), new Map());
    const pairs = group(pairsRows, "sale_id");
    const byAirtable = new Map(sales.map((s) => [s.airtable_record_id, s]));

    const unitIds = [];

    // Every buyer, by the Airtable row a deal links to and by the rows of
    // duplicates merged into it. A few hundred rows: one call.
    const buyerRows = await db.get("buyers?select=*&limit=10000");
    const buyerByRecord = new Map();
    for (const b of buyerRows) {
      for (const id of [b.airtable_record_id, b.airtable_ext_record_id, ...(b.airtable_aliases || [])]) {
        if (id) buyerByRecord.set(id, b);
      }
    }

    for (const record of records) {
      const sale = byAirtable.get(record.id);

      const had = new Map((sale ? pairs.get(sale.id) || [] : []).map((p) => [p.inventory_unit_record_id, p]));
      for (const unit of record.fields["Linked Inventory Units"] || []) {
        const pair = had.get(unit);
        if (!pair || !pair.purchase_vat_type || !(Number(pair.purchase_price_ex_vat) > 0)) unitIds.push(unit);
      }
    }

    return {
      sales,
      byAirtable,
      pairs,
      shipments: group(shipmentRows, "external_sale_id"),
      buyerFor: (recordId) => (recordId ? buyerByRecord.get(recordId) || null : null),
      units: unitIds.length ? await airtable.byIds("Inventory Units", unitIds, UNIT_FIELDS) : new Map(),
      warnings: []
    };
  }

  // The whole log, or one deal (by its Airtable record id).
  async function runUnlocked({ airtableId = "" } = {}) {
    const started = Date.now();
    const all = !airtableId;
    const records = await airtableSales(airtableId);
    const ctx = await context(records, all);

    const result = { at: new Date().toISOString(), deals: records.length, changed: [], errors: [], warnings: ctx.warnings, missing: [], ms: 0 };
    const synced = new Map();

    for (const record of records) {
      try {
        const out = await syncDeal(record, ctx.byAirtable.get(record.id) || null, ctx);
        synced.set(record.id, out);
        if (out.changes.length) result.changed.push({ sale: out.sale.id, deal: dealId(out.sale), changes: out.changes });
      } catch (err) {
        result.errors.push({ airtable_id: record.id, deal: text(record.fields?.["External Deal ID"]) || record.id, message: err.message });
        console.error("[external sales sync]", record.id, err.message);
      }
    }

    if (all) {
      const inAirtable = new Set(records.map((r) => r.id));
      result.missing = ctx.sales
        .filter((s) => s.airtable_record_id && !inAirtable.has(s.airtable_record_id))
        .map((s) => ({ sale: s.id, deal: dealId(s) }));
    }

    result.ms = Date.now() - started;

    if (all) lastRun = result;
    else if (lastRun) {
      // A single deal that now syncs clears its own old error.
      lastRun.errors = lastRun.errors.filter((e) => e.airtable_id !== airtableId).concat(result.errors);
    }

    return { ...result, synced, record: records[0] || null };
  }

  /*
   * Off since block 5 (22-09-2026): new outbounds are made in Supabase, and
   * the deals from before get their payment from Rompslomp. With the sync
   * off, nothing is read from or written to the External Sales Log.
   */
  const idle = () => ({ at: null, deals: 0, changed: [], errors: [], warnings: [], missing: [], ms: 0, synced: new Map(), record: null, off: true });
  const run = (options) => (enabled ? exclusive(() => runUnlocked(options)) : Promise.resolve(idle()));

  /*
   * Writes a deal's parcels back to Airtable, the way Pack & Ship reads them.
   *
   * Called inside an edit, after the edit changed Supabase. A label Airtable
   * already has is sent back by its attachment id (Airtable keeps an
   * attachment only that way); a new one by its URL, and the id Airtable
   * gives it is stored on the parcel.
   */
  async function mirror(sale, parcels, record) {
    if (!sale.airtable_record_id) return;

    const present = new Set((record?.fields?.["Shipping Labels"] || []).map((a) => a.id));
    const labels = parcels
      .filter((p) => p.label_url)
      .map((p) => (p.airtable_attachment_id && present.has(p.airtable_attachment_id) ? { id: p.airtable_attachment_id } : { url: p.label_url, filename: p.label_filename || "label.pdf" }));

    const fields = {
      "Tracking Numbers": [...new Set(parcels.map((p) => p.tracking_number).filter(Boolean))].join(", "),
      "Shipping Labels": labels
    };

    const wanted = AIRTABLE_SHIPPING[sale.shipping_status];
    const now = text(record?.fields?.["Shipping Status"]);
    // Label(s) Generated was set by hand; an empty deal does not undo it.
    if (wanted && wanted !== now && !(wanted === "Pending" && now === "Label(s) Generated")) fields["Shipping Status"] = wanted;

    const updated = await airtable.update(EXTERNAL_SALES_LOG, sale.airtable_record_id, fields);

    // The labels that went by URL come back with a new id; Airtable keeps the
    // file name it was given, so that is how they are found.
    const sentByUrl = parcels.filter((p) => p.label_url && !(p.airtable_attachment_id && present.has(p.airtable_attachment_id)));

    for (const attachment of updated?.fields?.["Shipping Labels"] || []) {
      if (present.has(attachment.id)) continue;

      const parcel = sentByUrl.find((p) => (p.label_filename || "label.pdf") === attachment.filename);
      if (!parcel) continue;

      await db.patch(`shipments?id=eq.${parcel.id}`, { airtable_attachment_id: attachment.id });
      parcel.airtable_attachment_id = attachment.id;
      sentByUrl.splice(sentByUrl.indexOf(parcel), 1);
    }
  }

  /*
   * An edit to one deal: read it fresh from Airtable first (so the edit starts
   * from what is there now), change Supabase, write the parcels back.
   *
   * change(sale, parcels) -> { reload?: true } after it has written.
   */
  function edit(sale, change) {
    return exclusive(async () => {
      let record = null;

      if (enabled && sale.airtable_record_id) {
        const out = await runUnlocked({ airtableId: sale.airtable_record_id });
        if (out.errors.length) throw new ExternalSalesError(`Could not read ${dealId(sale)} from Airtable first: ${out.errors[0].message}`, 502);
        record = out.record;
        sale = out.synced.get(sale.airtable_record_id)?.sale || sale;
      }

      const parcels = await db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`);
      const result = (await change(sale, parcels)) || {};

      const after = await db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`);
      const [fresh] = await db.get(`external_sales?select=*&id=eq.${sale.id}`);
      const status = shippingStatusFor({ current: fresh.shipping_status, cancelled: fresh.payment_status === "cancelled", parcels: after.length });

      let saved = fresh;
      if (status !== fresh.shipping_status) {
        [saved] = await db.patch(`external_sales?id=eq.${fresh.id}`, {
          shipping_status: status,
          ...(status === "shipped" && !fresh.shipped_at ? { shipped_at: new Date().toISOString() } : {})
        });
      }

      if (enabled && result.mirror !== false) await mirror(saved, after, record);

      // Airtable changed underneath: read the deal back so Supabase matches.
      if (enabled && result.reload && saved.airtable_record_id) await runUnlocked({ airtableId: saved.airtable_record_id });

      return saved;
    });
  }

  return { run, edit, lastRun: () => lastRun, enabled };
}

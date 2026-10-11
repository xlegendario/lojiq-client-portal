// partner/partnerForward.js
//
// "Send pairs": the partner makes his own forward from the dashboard.
//
// He picks quantities per SKU and size, never single pairs; which pairs go is
// decided here, in the same order the WMS's Create Outbound uses (the Kickz
// Caviar portal's orderPairsForForwarding): pairs that came in only to be
// forwarded first, then pairs that may also be sold, the dearest first so the
// cheapest stays listed, oldest first within that.
//
// The forward itself is made by the Kickz Caviar portal's
// /api/internal/forwarding/create, exactly as Create Outbound makes one: it
// takes the pairs off the shelf all or nothing, writes forwarding_log, and
// takes them off the sales channels. Pack & Ship and the admin's Forward
// Service see it straight away.
//
// A partner can make a forward, never change or cancel one.

import { compareSizes } from "../admin/stockRefine.js";
import { displayId } from "../admin/adminForwarding.js";
import { labelFromDataUrl, typedTrackingOk } from "./labelReader.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const PAGE = 1000;
const COLUMNS = "id,sku,size,product_name,brand,image_url,mode,partner_price,markup,forwarding_fee,received_at";
const FORWARDABLE_MODES = new Set(["forwarding", "both"]);

// Only what is on our own shelf: a pair in another warehouse is not ours to
// pack, and a forward made here is packed by us.
export const OWN_WAREHOUSE = "lojiq";

export const MAX_PAIRS = 500;

export class ForwardError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const listingPrice = (pair) => Number(pair.partner_price) + Number(pair.markup || 0);

// Same order as orderPairsForForwarding in the Kickz Caviar portal.
export function pickOrder(a, b) {
  const aOnly = a.mode === "forwarding" ? 0 : 1;
  const bOnly = b.mode === "forwarding" ? 0 : 1;

  if (aOnly !== bOnly) return aOnly - bOnly;
  if (aOnly === 1) {
    const byPrice = listingPrice(b) - listingPrice(a);
    if (byPrice) return byPrice;
  }

  return String(a.received_at).localeCompare(String(b.received_at)) || String(a.id).localeCompare(String(b.id));
}

const feeOf = (pair, defaultFee) => {
  const own = pair.forwarding_fee;
  return round2(own === null || own === undefined || own === "" ? defaultFee : own);
};

// The pairs per SKU and size, each list in the order they would be taken.
function groupPairs(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    if (!FORWARDABLE_MODES.has(text(row.mode))) continue;

    const key = `${text(row.sku).toUpperCase()}|${text(row.size)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const list of groups.values()) list.sort(pickOrder);

  return groups;
}

/*
 * What the partner can choose from: per product, per size, how many can go
 * and the fee of each pair in the order they would go, so the page can add up
 * the fee for any number without asking again. No pair ids, no prices.
 */
export function summarizeForwardable(rows, defaultFee) {
  const products = new Map();

  for (const [key, pairs] of groupPairs(rows)) {
    const [sku, size] = key.split("|");
    const first = pairs[0];

    if (!products.has(sku)) {
      products.set(sku, { sku, name: text(first.product_name), brand: text(first.brand), image: text(first.image_url), count: 0, sizes: [] });
    }

    const product = products.get(sku);
    product.count += pairs.length;
    if (!product.image && first.image_url) product.image = text(first.image_url);
    product.sizes.push({ size, available: pairs.length, fees: pairs.map((pair) => feeOf(pair, defaultFee)) });
  }

  return [...products.values()]
    .map((product) => ({ ...product, sizes: product.sizes.sort((a, b) => compareSizes(a.size, b.size)) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// The lines the page sent, cleaned: one per SKU and size, whole numbers.
export function cleanLines(input) {
  const merged = new Map();

  for (const line of Array.isArray(input) ? input : []) {
    const sku = text(line?.sku).toUpperCase();
    const size = text(line?.size);
    const qty = Number(line?.qty);

    if (!sku || !size || !Number.isInteger(qty) || qty <= 0) continue;

    const key = `${sku}|${size}`;
    merged.set(key, { sku, size, qty: (merged.get(key)?.qty || 0) + qty });
  }

  const lines = [...merged.values()];
  const total = lines.reduce((sum, line) => sum + line.qty, 0);

  if (!lines.length) throw new ForwardError("no_pairs");
  if (total > MAX_PAIRS) throw new ForwardError("too_many_pairs");

  return lines;
}

// The pairs for the lines (and their ids), or the lines that no longer have enough.
export function pickPairs(rows, lines) {
  const groups = groupPairs(rows);
  const picked = [];
  const short = [];

  for (const line of lines) {
    const pairs = groups.get(`${line.sku}|${line.size}`) || [];

    if (pairs.length < line.qty) short.push({ ...line, available: pairs.length });
    else picked.push(...pairs.slice(0, line.qty));
  }

  return { ids: picked.map((pair) => pair.id), picked, short };
}

/*
 * The invoice the partner asked for, checked before anything is made:
 *   - one product per invoice, so there is one price to fill in (Dario,
 *     11-10-2026: he sells per SKU, and every extra field is a chance to
 *     get it wrong)
 *   - a buyer that is his
 *   - a price above the fee of every pair, or what he gets would be negative
 */
export function checkInvoice({ invoice, lines, picked, defaultFee }) {
  const skus = new Set(lines.map((line) => line.sku));
  if (skus.size !== 1) throw new ForwardError("invoice_one_product");

  const price = round2(String(invoice?.price_per_pair ?? "").replace(",", "."));
  if (!(price > 0)) throw new ForwardError("invoice_no_price");
  if (price > 100000) throw new ForwardError("invoice_price_too_high");

  const highestFee = Math.max(0, ...picked.map((pair) => feeOf(pair, defaultFee)));
  if (price <= highestFee) throw new ForwardError("invoice_price_below_fee", 400, { fee: highestFee });

  const buyerId = text(invoice?.buyer_id);
  if (!/^[0-9a-f-]{36}$/i.test(buyerId)) throw new ForwardError("invoice_no_buyer");

  return { price, buyerId };
}

export async function loadForwardable(db, sellerRecordId) {
  const rows = [];
  const seller = encodeURIComponent(sellerRecordId);

  for (let offset = 0; ; offset += PAGE) {
    const page = await db.get(
      `partner_stock?select=${COLUMNS}&seller_record_id=eq.${seller}&status=eq.in_stock&warehouse=eq.${OWN_WAREHOUSE}&order=id.asc&limit=${PAGE}&offset=${offset}`
    );

    rows.push(...(page || []));
    if (!page || page.length < PAGE) return rows;
  }
}

// Most labels one forward takes: more boxes than this is a mistake.
export const MAX_LABELS = 20;

/*
 * The labels the partner added, checked: every forward has at least one,
 * every label is a real PDF or picture, and every label has its tracking
 * number(s) - read from it or typed. Returns the files and all numbers.
 */
export function checkLabels(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) throw new ForwardError("label_missing");
  if (list.length > MAX_LABELS) throw new ForwardError("too_many_labels");

  const seen = new Set();
  const labels = list.map((item) => {
    const file = labelFromDataUrl(item?.data_url);
    if (!file) throw new ForwardError("bad_label");

    const numbers = (Array.isArray(item?.tracking) ? item.tracking : [item?.tracking]).filter((n) => text(n));
    if (!numbers.length) throw new ForwardError("label_no_tracking");

    const tracking = numbers.map((n) => {
      const ok = typedTrackingOk(n);
      if (!ok) throw new ForwardError("bad_tracking");
      if (seen.has(ok.tracking)) throw new ForwardError("label_twice");
      seen.add(ok.tracking);
      return ok.tracking;
    });

    return { file, tracking, name: text(item?.name) };
  });

  return { labels, tracking: [...seen] };
}

// A tracking number that is already on a forward: that label was used.
export async function usedTracking(db, numbers) {
  if (!numbers.length) return null;
  const list = numbers.map((n) => `"${n}"`).join(",");
  const [hit] = await db.get(`forwarding_log?select=forwarding_number,tracking_numbers&tracking_numbers=ov.{${list}}&limit=1`);
  if (!hit) return null;
  return { forward: displayId(hit), tracking: (hit.tracking_numbers || []).find((n) => numbers.includes(n)) };
}

/*
 * Makes the forward.
 *
 * deps:
 *   db          createSupabaseRest
 *   callKc      (path, body) => Kickz Caviar portal, internal secret
 *   callWms     (path, body) => WMS
 */
export async function createPartnerForward({ db, callKc, callWms, buyers = null, invoicing = null }, partner, body, { defaultFee = 0 } = {}) {
  const lines = cleanLines(body?.lines);

  // A forward always comes with its label(s), never "later on WhatsApp".
  const { labels: files, tracking } = checkLabels(body?.labels);
  const used = await usedTracking(db, tracking);
  if (used) throw new ForwardError("label_used", 409, { used });

  const { ids, picked, short } = pickPairs(await loadForwardable(db, partner.sellerRecordId), lines);
  if (short.length) throw new ForwardError("pairs_gone", 409, { short });

  // Everything about the invoice is checked before the pairs are touched.
  let invoice = null;
  let buyer = null;
  let hold = null;

  if (body?.invoice) {
    if (!invoicing?.configured || !buyers) throw new ForwardError("invoice_unavailable", 503);

    invoice = checkInvoice({ invoice: body.invoice, lines, picked, defaultFee });
    if (!(await buyers.owns(partner.sellerRecordId, invoice.buyerId))) throw new ForwardError("invoice_no_buyer");

    [buyer] = await db.get(`buyers?select=*&id=eq.${invoice.buyerId}`);
    if (!buyer) throw new ForwardError("invoice_no_buyer");

    // The first invoice to a buyer that looks like one of ours waits for Dario.
    hold = await buyers.duplicateCheck(partner.sellerRecordId, invoice.buyerId);
  }

  // The labels go to storage first, so the forward is made with them in one go.
  const labels = [];
  for (const label of files) {
    const stored = await callWms("/api/upload-label-file", {
      folder: "forwarding",
      file_name: `${partner.sellerId}-${label.tracking[0]}.${label.file.ext}`,
      file_data_url: `data:${label.file.mime};base64,${label.file.buffer.toString("base64")}`,
      tracking: label.tracking[0]
    });

    labels.push({ url: stored.url, filename: stored.filename, tracking: label.tracking.join(", "), uploaded_at: new Date().toISOString() });
  }

  const data = await callKc("/api/internal/forwarding/create", {
    seller_record_id: partner.sellerRecordId,
    pair_ids: ids,
    shipping_costs: 0,
    labels_needed: 0,
    tracking_numbers: tracking,
    labels,
    buyer: buyer
      ? {
          record_id: text(buyer.airtable_record_id) || null,
          buyer_id: buyer.buyer_number ? `BU-${String(buyer.buyer_number).padStart(5, "0")}` : null,
          name: text(buyer.company_name) || text(buyer.full_name),
          country: text(buyer.country)
        }
      : null,
    notes: `Made by ${partner.name} in the partner dashboard${invoice ? ", with invoice" : ""}`
  });

  const forward = data.forward || {};
  const result = {
    id: forward.id,
    display_id: forward.display_id,
    pairs: ids.length,
    shipping_status: forward.shipping_status,
    invoice: null
  };

  if (!invoice) return result;

  /*
   * The pairs are off the shelf from here on, whatever happens to the
   * invoice. A failure to even write it down is logged loudly; the forward
   * stands and the admin sees a forward without its invoice.
   */
  try {
    const row = await invoicing.open({
      forward: { ...forward, unit_forwarding_fee: forward.unit_forwarding_fee ?? defaultFee },
      pairs: data.pairs?.length ? data.pairs : picked,
      partner,
      buyerId: invoice.buyerId,
      pricePerPair: invoice.price,
      hold
    });

    result.invoice = { status: row.status, total: Number(row.total), fee: Number(row.fee_total), you_receive: Number(row.purchase_total) };

    // Rompslomp takes a few seconds; the partner does not wait for it.
    if (row.status === "to_invoice") invoicing.run(row.id).catch(() => {});
  } catch (err) {
    console.error(`[partner] ${forward.display_id} made, but its invoice was NOT written down:`, err.message);
    result.invoice = { status: "failed" };
  }

  return result;
}

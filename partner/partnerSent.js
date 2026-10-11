// partner/partnerSent.js
//
// The Sent tab: every forward of the partner, newest first, with where it is
// (waiting for a label, ready, sent), its tracking numbers, what was in it,
// and the fee - counted exactly as the admin's Forward Service counts it
// (forwardMoney), so the partner and Finance never show two amounts.
//
// Labels are not handed out: their stored address is public and carries the
// buyer's name and address. Tracking numbers are enough to follow a parcel.

import { compareSizes } from "../admin/stockRefine.js";
import { displayId, forwardMoney } from "../admin/adminForwarding.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const MAX_FORWARDS = 300;
const PAGE = 1000;
const FORWARD_COLUMNS =
  "id,forwarding_number,pair_count,unit_forwarding_fee,shipping_costs,tracking_numbers,shipping_status,payment_status,shipped_at,created_at";
const PAIR_COLUMNS = "forwarding_log_id,sku,size,product_name,image_url,forwarding_fee";

// Still with us first, then the rest; newest first within each.
const OPEN = new Set(["awaiting_label", "ready_to_ship"]);

/*
 * Where an invoiced forward is, for the partner, in one word:
 *   preparing  the invoice is being made (or waits for Dario: same buyer?)
 *   waiting    sent to the buyer, not paid yet
 *   to_pay     the buyer paid; we owe the partner
 *   paid       the partner is paid
 * A failed run is still "preparing" to him - fixing it is ours to do.
 */
export function invoiceStage(row) {
  if (row.status !== "invoiced") return "preparing";
  if (row.partner_payout_status === "paid") return "paid";
  if (row.buyer_payment_status === "paid") return "to_pay";
  return "waiting";
}

export function invoiceView(row, buyer) {
  if (!row) return null;

  return {
    stage: invoiceStage(row),
    buyer: buyer ? text(buyer.company_name) || text(buyer.full_name) : "",
    number: text(row.invoice_number),
    has_pdf: Boolean(row.invoice_id),
    price_per_pair: Number(row.price_per_pair),
    total: Number(row.total),
    fee: Number(row.fee_total),
    you_receive: Number(row.purchase_total),
    paid_at: row.partner_paid_at || null
  };
}

export function summarizeForwards(forwards, pairs, invoices = [], buyers = []) {
  const invoiceOf = new Map((invoices || []).map((row) => [text(row.forwarding_log_id), row]));
  const buyerOf = new Map((buyers || []).map((row) => [text(row.id), row]));

  const byForward = new Map();

  for (const pair of pairs || []) {
    const id = text(pair.forwarding_log_id);
    if (!byForward.has(id)) byForward.set(id, []);
    byForward.get(id).push(pair);
  }

  return (forwards || [])
    .map((row) => {
      const own = byForward.get(text(row.id)) || [];
      const products = new Map();

      for (const pair of own) {
        const sku = text(pair.sku).toUpperCase();
        if (!products.has(sku)) products.set(sku, { sku, name: text(pair.product_name), image: text(pair.image_url), sizes: new Map() });

        const product = products.get(sku);
        const size = text(pair.size);
        product.sizes.set(size, (product.sizes.get(size) || 0) + 1);
        if (!product.image && pair.image_url) product.image = text(pair.image_url);
      }

      return {
        id: text(row.id),
        display_id: displayId(row),
        created_at: row.created_at,
        shipped_at: row.shipped_at || null,
        status: text(row.shipping_status) || "awaiting_label",
        pairs: Number(row.pair_count) || own.length,
        tracking: (row.tracking_numbers || []).map(text).filter(Boolean),
        fee: forwardMoney(row, own.length ? own : null).payable,
        fee_paid: text(row.payment_status) === "paid",
        invoice: invoiceView(invoiceOf.get(text(row.id)), buyerOf.get(text(invoiceOf.get(text(row.id))?.buyer_id))),
        products: [...products.values()]
          .map((product) => ({
            ...product,
            sizes: [...product.sizes].map(([size, count]) => ({ size, count })).sort((a, b) => compareSizes(a.size, b.size))
          }))
          .sort((a, b) => b.sizes.length - a.sizes.length || a.name.localeCompare(b.name))
      };
    })
    .sort((a, b) => (OPEN.has(b.status) ? 1 : 0) - (OPEN.has(a.status) ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
}

export async function loadForwards(db, sellerRecordId) {
  const seller = encodeURIComponent(sellerRecordId);
  const forwards = await db.get(
    `forwarding_log?select=${FORWARD_COLUMNS}&seller_record_id=eq.${seller}&order=created_at.desc&limit=${MAX_FORWARDS}`
  );

  const ids = (forwards || []).map((row) => row.id);
  const pairs = [];

  // A forward's pairs, read by forward id in batches the URL can carry.
  for (let i = 0; i < ids.length; i += 50) {
    const list = ids.slice(i, i + 50).map((id) => `"${id}"`).join(",");

    for (let offset = 0; ; offset += PAGE) {
      const page = await db.get(
        `partner_stock?select=${PAIR_COLUMNS}&seller_record_id=eq.${seller}&forwarding_log_id=in.(${list})&order=id.asc&limit=${PAGE}&offset=${offset}`
      );

      pairs.push(...(page || []));
      if (!page || page.length < PAGE) break;
    }
  }

  const invoices = await db.get(
    `forward_invoices?select=forwarding_log_id,buyer_id,status,invoice_id,invoice_number,price_per_pair,total,fee_total,purchase_total,buyer_payment_status,partner_payout_status,partner_paid_at&seller_record_id=eq.${seller}`
  ).catch(() => []);
  const buyerIds = [...new Set((invoices || []).map((row) => row.buyer_id).filter(Boolean))];
  const buyers = buyerIds.length
    ? await db.get(`buyers?select=id,company_name,full_name&id=in.(${buyerIds.map((id) => `"${id}"`).join(",")})`)
    : [];

  return summarizeForwards(forwards, pairs, invoices, buyers);
}

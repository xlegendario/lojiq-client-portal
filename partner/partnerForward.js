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
import { trackingList } from "../admin/adminForwarding.js";

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

// The pair ids for the lines, or the lines that no longer have enough.
export function pickPairs(rows, lines) {
  const groups = groupPairs(rows);
  const ids = [];
  const short = [];

  for (const line of lines) {
    const pairs = groups.get(`${line.sku}|${line.size}`) || [];

    if (pairs.length < line.qty) short.push({ ...line, available: pairs.length });
    else ids.push(...pairs.slice(0, line.qty).map((pair) => pair.id));
  }

  return { ids, short };
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

// A label the partner attached: a PDF, JPEG or PNG as a data URL.
export function labelFile(dataUrl) {
  const match = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(text(dataUrl));
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length < 100) return null;
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf", buffer };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", buffer };
  if (buffer.subarray(0, 4).toString("hex") === "89504e47") return { mime: "image/png", ext: "png", buffer };

  return null;
}

/*
 * Makes the forward.
 *
 * deps:
 *   db          createSupabaseRest
 *   callKc      (path, body) => Kickz Caviar portal, internal secret
 *   callWms     (path, body) => WMS
 */
export async function createPartnerForward({ db, callKc, callWms }, partner, body) {
  const lines = cleanLines(body?.lines);
  const tracking = trackingList(body?.tracking);

  if (tracking.some((number) => !/^[A-Za-z0-9-]{6,40}$/.test(number))) throw new ForwardError("bad_tracking");

  let label = null;
  if (text(body?.label)) {
    label = labelFile(body.label);
    if (!label) throw new ForwardError("bad_label");
  }

  const { ids, short } = pickPairs(await loadForwardable(db, partner.sellerRecordId), lines);
  if (short.length) throw new ForwardError("pairs_gone", 409, { short });

  // The label goes to storage first, so the forward is made with it in one go.
  const labels = [];
  if (label) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const stored = await callWms("/api/upload-label-file", {
      folder: "forwarding",
      file_name: `${partner.sellerId}-${stamp}${tracking[0] ? `-${tracking[0]}` : ""}.${label.ext}`,
      file_data_url: `data:${label.mime};base64,${label.buffer.toString("base64")}`,
      tracking: tracking[0] || ""
    });

    labels.push({ url: stored.url, filename: stored.filename, tracking: tracking[0] || null, uploaded_at: new Date().toISOString() });
  }

  const data = await callKc("/api/internal/forwarding/create", {
    seller_record_id: partner.sellerRecordId,
    pair_ids: ids,
    shipping_costs: 0,
    labels_needed: 0,
    tracking_numbers: tracking,
    labels,
    buyer: null,
    notes: `Made by ${partner.name} in the partner dashboard`
  });

  const forward = data.forward || {};

  return {
    id: forward.id,
    display_id: forward.display_id,
    pairs: ids.length,
    shipping_status: forward.shipping_status
  };
}

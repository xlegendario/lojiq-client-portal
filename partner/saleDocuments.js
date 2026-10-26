// partner/saleDocuments.js
//
// A partner's own sale documents: the sales invoice and purchase declaration
// he gives his buyer, in his own name, made with our dashboard.
//
// He enters the buyer, what he sold (products from our catalogue or anything
// he types himself), the delivery date and the account the buyer pays into,
// and signs. Dario then fills in our fee per line and releases it; only then
// does the document get its number and can it be downloaded.
//
// What this never does: book anything. The sale is his, the money goes from
// his buyer to him, and Lojiq is not on the document. Our fee is the only
// money that is ours, and it is invoiced to him separately.
//
// Everything he signed is kept as he signed it (seller, buyer, lines, total,
// account, the declaration and the terms version), with a hash over all of it
// and the signature, the time, his IP address and his browser - the record of
// his instruction, should anyone ever ask who made the document.

import crypto from "crypto";

import { TERMS_VERSION, termsHash } from "./sellerTerms.js";

export const DECLARATION = "The supplier declares that no VAT has been deducted as input tax on the goods listed in this document.";
export const PRIVATE_NOTE = "No VAT charged – the supplier is a private individual and not registered for VAT.";

export const MAX_LINES = 60;
export const MAX_QTY = 100000;
const MAX_SIGNATURE_BYTES = 400 * 1024;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const money = (value) => round2(String(value ?? "").replace(",", "."));

export class DocumentError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const documentNumber = (row) => (row?.doc_number ? `INV-${String(row.doc_number).padStart(4, "0")}` : "");

// The day in Amsterdam, as YYYY-MM-DD.
export const amsterdamDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

/* ---------------- what he entered ---------------- */

/*
 * The lines, checked and with their totals. A product from the catalogue
 * carries its sizes, and its quantity is what the sizes add up to; anything
 * else (creases, a bag) is a name, a quantity and a price.
 */
export function cleanLines(input) {
  const raw = Array.isArray(input) ? input : [];
  if (!raw.length) throw new DocumentError("no_lines");
  if (raw.length > MAX_LINES) throw new DocumentError("too_many_lines");

  return raw.map((line) => {
    const kind = line?.kind === "other" ? "other" : "product";
    const sizes = (Array.isArray(line?.sizes) ? line.sizes : [])
      .map((s) => ({ size: text(s?.size).slice(0, 20), qty: Number(s?.qty) }))
      .filter((s) => s.size && s.qty > 0);

    for (const s of sizes) if (!Number.isInteger(s.qty) || s.qty > MAX_QTY) throw new DocumentError("bad_qty");

    const qty = kind === "product" && sizes.length ? sizes.reduce((sum, s) => sum + s.qty, 0) : Number(line?.qty);
    const price = money(line?.unit_price);
    const name = text(line?.name).slice(0, 160);
    const sku = kind === "product" ? text(line?.sku).toUpperCase().slice(0, 40) : "";

    if (!name && !sku) throw new DocumentError("line_needs_name");
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new DocumentError("bad_qty");
    if (!(price > 0) || price > 1_000_000) throw new DocumentError("bad_price");

    return {
      kind,
      sku,
      name,
      image: kind === "product" ? text(line?.image).slice(0, 600) : "",
      sizes: kind === "product" ? sizes : [],
      qty,
      unit_price: price,
      total: round2(qty * price)
    };
  });
}

// An IBAN as a bank writes it, checked with its own check digits.
export function cleanIban(value) {
  const iban = text(value).replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return "";

  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;

  return rest === 1 ? iban : "";
}

export const formatIban = (iban) => text(iban).replace(/(.{4})/g, "$1 ").trim();

export function cleanPayment(input = {}) {
  const iban = cleanIban(input.iban);
  const holder = text(input.holder).slice(0, 120);

  if (!iban) throw new DocumentError("bad_iban");
  if (!holder) throw new DocumentError("no_holder");

  return { iban, holder };
}

export function cleanDeliveryDate(value, today) {
  const day = text(value) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) throw new DocumentError("bad_date");
  return day;
}

/*
 * His signature, drawn on the page and sent as a JPEG: a PDF takes a JPEG
 * as it is, with no decoding of our own. The width and height come from the
 * JPEG's own frame header.
 */
export function readSignature(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(text(dataUrl));
  if (!match) throw new DocumentError("no_signature");

  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 200 || bytes.length > MAX_SIGNATURE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new DocumentError("no_signature");

  const size = jpegSize(bytes);
  if (!size) throw new DocumentError("no_signature");

  return { bytes, ...size, dataUrl: `data:image/jpeg;base64,${match[1]}` };
}

export function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    // Any start-of-frame marker except the ones that are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/* ---------------- the parties ---------------- */

// The seller as the Sellers Database has him.
export function sellerParty(sellerId, fields = {}) {
  return {
    seller_id: text(fields["Seller ID"]) || sellerId,
    name: text(fields["Company Name"]) || text(fields["Full Name"]),
    address: text(fields.Address),
    zipcode: text(fields.Zipcode),
    city: text(fields.City),
    country: text(fields.Country),
    vat_id: text(fields["VAT ID"])
  };
}

// The buyer as the buyers table has him, at the moment of signing.
export function buyerParty(row = {}) {
  return {
    id: text(row.id),
    company_name: text(row.company_name),
    full_name: text(row.full_name),
    email: text(row.email),
    vat_id: text(row.vat_id),
    address: text(row.address),
    address_line_2: text(row.address_line_2),
    zipcode: text(row.zipcode),
    city: text(row.city),
    country: text(row.country)
  };
}

export const buyerName = (b = {}) => {
  const company = text(b.company_name);
  const person = text(b.full_name);
  return company && person ? `${company} (${person})` : company || person;
};

/*
 * The hash of everything he signed. The signature is in it by its own hash,
 * so changing a price, a size or the account afterwards no longer matches.
 */
export function contentHash(doc) {
  const signed = {
    seller: doc.seller,
    buyer: doc.buyer,
    lines: (doc.lines || []).map(({ kind, sku, name, sizes, qty, unit_price, total }) => ({ kind, sku, name, sizes, qty, unit_price, total })),
    total: doc.total,
    delivery_date: doc.delivery_date,
    payment: doc.payment,
    declaration: doc.declaration,
    terms_version: doc.terms_version,
    signature: crypto.createHash("sha256").update(text(doc.signature)).digest("hex")
  };
  return crypto.createHash("sha256").update(JSON.stringify(signed)).digest("hex");
}

/* ---------------- fees ---------------- */

export const FEE_TYPES = ["percent", "per_item"];

// Our fee on one line: a percentage of the line, or an amount per item.
export function lineFee(line, type, value) {
  const v = money(value);
  if (!FEE_TYPES.includes(type) || !(v >= 0)) throw new DocumentError("bad_fee");
  if (type === "percent" && v > 100) throw new DocumentError("bad_fee");
  return round2(type === "percent" ? (line.total * v) / 100 : line.qty * v);
}

const lineKey = (line) => (line.sku ? `sku:${line.sku}` : `name:${text(line.name).toLowerCase()}`);

/*
 * What Dario charged last time for the same product, so the next document
 * comes pre-filled; and the last fee of all for anything new.
 */
export function feeDefaults(approved = []) {
  const bySku = {};
  let last = null;

  const newestFirst = [...approved].sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)));
  for (const row of newestFirst) {
    for (const line of row.lines || []) {
      if (!FEE_TYPES.includes(line.fee_type)) continue;
      const fee = { type: line.fee_type, value: Number(line.fee_value) };
      if (!last) last = fee;
      if (!bySku[lineKey(line)]) bySku[lineKey(line)] = fee;
    }
  }

  return { by_key: bySku, last };
}

export const defaultFeeFor = (defaults, line) => defaults?.by_key?.[lineKey(line)] || defaults?.last || { type: "per_item", value: 0 };

/* ---------------- what each side sees ---------------- */

export function partnerView(row) {
  const released = row.status === "approved";
  return {
    id: row.id,
    number: documentNumber(row),
    status: row.status,
    created_at: row.created_at,
    issue_date: row.issue_date || null,
    delivery_date: row.delivery_date,
    buyer: buyerName(row.buyer),
    total: Number(row.total),
    lines: (row.lines || []).map((line) => ({
      kind: line.kind,
      sku: line.sku,
      name: line.name,
      image: line.image,
      sizes: line.sizes,
      qty: line.qty,
      unit_price: line.unit_price,
      total: line.total,
      fee: released ? Number(line.fee || 0) : null
    })),
    fee_total: released ? Number(row.fee_total || 0) : null,
    receive: released ? round2(Number(row.total) - Number(row.fee_total || 0)) : null,
    reject_reason: row.reject_reason || "",
    buyer_paid: Boolean(row.buyer_paid_at)
  };
}

export function adminView(row) {
  const { signature, ...rest } = row;
  return { ...rest, number: documentNumber(row), buyer_label: buyerName(row.buyer), has_signature: Boolean(signature) };
}

/* ---------------- the store ---------------- */

/*
 * deps:
 *   db        createSupabaseRest
 *   sellerOf  (sellerRecordId, sellerId) -> Sellers Database fields
 *   owns      (sellerRecordId, buyerId) -> whether the buyer is his
 *   renderPdf (row, { draft }) -> { pdf } (partner/saleDocumentPdf.js)
 */
export function createSaleDocuments({ db, sellerOf, owns, renderPdf, now = () => new Date() }) {
  const configured = Boolean(db?.configured);

  async function load(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id)) && !/^id\d+$/.test(text(id))) throw new DocumentError("not_found", 404);
    const [row] = await db.get(`partner_sale_documents?select=*&id=eq.${encodeURIComponent(text(id))}`);
    if (!row) throw new DocumentError("not_found", 404);
    return row;
  }

  async function seller(account) {
    const fields = await sellerOf(account.sellerRecordId, account.sellerId);
    return sellerParty(account.sellerId, fields || {});
  }

  /* ----- terms ----- */

  async function acceptance(sellerRecordId) {
    const rows = await db.get(
      `partner_terms_acceptances?select=terms_version,accepted_at&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&terms_version=eq.${encodeURIComponent(TERMS_VERSION)}&order=accepted_at.desc&limit=1`
    );
    return rows?.[0] || null;
  }

  async function acceptTerms(account, { ip = "", agent = "" } = {}) {
    const party = await seller(account);
    const [row] = await db.insert("partner_terms_acceptances", [{
      seller_record_id: account.sellerRecordId,
      seller_id: account.sellerId,
      partner_user_id: account.id || null,
      terms_version: TERMS_VERSION,
      terms_hash: termsHash(party),
      accepted_at: now().toISOString(),
      ip: text(ip).slice(0, 80),
      user_agent: text(agent).slice(0, 400)
    }]);
    return row;
  }

  /* ----- what he signs ----- */

  // The document as it would be, from what he entered: for the preview and
  // for the request itself.
  async function draft(account, input = {}) {
    const party = await seller(account);
    if (party.vat_id) throw new DocumentError("vat_registered", 409);
    if (!party.name || !party.address || !party.country) throw new DocumentError("seller_incomplete", 409);

    const buyerId = text(input.buyer_id);
    if (!(await owns(account.sellerRecordId, buyerId))) throw new DocumentError("no_buyer");
    const [buyerRow] = await db.get(`buyers?select=*&id=eq.${buyerId}`);
    if (!buyerRow) throw new DocumentError("no_buyer");

    const lines = cleanLines(input.lines);

    return {
      seller_record_id: account.sellerRecordId,
      seller_id: account.sellerId,
      buyer_id: buyerId,
      seller: party,
      buyer: buyerParty(buyerRow),
      lines,
      total: round2(lines.reduce((sum, line) => sum + line.total, 0)),
      delivery_date: cleanDeliveryDate(input.delivery_date, amsterdamDay(now())),
      payment: cleanPayment(input.payment || {}),
      vat_note: PRIVATE_NOTE,
      declaration: DECLARATION,
      terms_version: TERMS_VERSION
    };
  }

  async function preview(account, input) {
    const doc = await draft(account, input);
    return renderPdf({ ...doc, status: "draft", created_at: now().toISOString() }, { draft: true });
  }

  async function request(account, input = {}, { ip = "", agent = "" } = {}) {
    if (!(await acceptance(account.sellerRecordId))) throw new DocumentError("terms_not_accepted", 409);

    const doc = await draft(account, input);
    const signature = readSignature(input.signature);
    const signedAt = now().toISOString();

    const row = {
      ...doc,
      status: "requested",
      signature: signature.dataUrl,
      signed_at: signedAt,
      signed_ip: text(ip).slice(0, 80),
      signed_agent: text(agent).slice(0, 400)
    };
    row.content_hash = contentHash(row);

    const [saved] = await db.insert("partner_sale_documents", [row]);
    return saved;
  }

  async function list(sellerRecordId) {
    return (await db.get(`partner_sale_documents?select=*&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&order=created_at.desc`)) || [];
  }

  // The account on his last document, so he types it once.
  async function lastPayment(sellerRecordId) {
    const [row] = await db.get(`partner_sale_documents?select=payment&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&order=created_at.desc&limit=1`);
    return row?.payment || null;
  }

  async function setBuyerPaid(sellerRecordId, id, paid) {
    const row = await load(id);
    if (row.seller_record_id !== sellerRecordId) throw new DocumentError("not_found", 404);
    if (row.status !== "approved") throw new DocumentError("not_released", 409);

    const [saved] = await db.patch(`partner_sale_documents?id=eq.${row.id}`, {
      buyer_paid_at: paid ? now().toISOString() : null,
      updated_at: now().toISOString()
    });
    return saved;
  }

  /* ----- Dario's side ----- */

  async function all() {
    return (await db.get("partner_sale_documents?select=*&order=created_at.desc&limit=500")) || [];
  }

  async function defaultsFor(sellerRecordId) {
    const approved = await db.get(`partner_sale_documents?select=lines,approved_at&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&status=eq.approved`);
    return feeDefaults(approved || []);
  }

  /*
   * Our fee on every line, then the number and the date: the document
   * exists from here on. fees is [{ type, value }] in the order of the lines.
   */
  async function approve(id, fees, by) {
    const row = await load(id);
    if (row.status !== "requested") throw new DocumentError("not_open", 409);

    const list = Array.isArray(fees) ? fees : [];
    if (list.length !== (row.lines || []).length) throw new DocumentError("fee_per_line");

    const lines = row.lines.map((line, i) => {
      const type = text(list[i]?.type);
      const value = money(list[i]?.value);
      return { ...line, fee_type: type, fee_value: value, fee: lineFee(line, type, value) };
    });
    const feeTotal = round2(lines.reduce((sum, line) => sum + line.fee, 0));
    if (feeTotal > Number(row.total)) throw new DocumentError("fee_above_total");

    const [last] = await db.get(`partner_sale_documents?select=doc_number&seller_record_id=eq.${encodeURIComponent(row.seller_record_id)}&doc_number=not.is.null&order=doc_number.desc&limit=1`);
    const number = Number(last?.doc_number || 0) + 1;
    const stamp = now();

    const released = {
      lines,
      fee_total: feeTotal,
      status: "approved",
      doc_number: number,
      issue_date: amsterdamDay(stamp),
      approved_at: stamp.toISOString(),
      approved_by: text(by).slice(0, 120),
      updated_at: stamp.toISOString()
    };
    const { pdf } = await renderPdf({ ...row, ...released });
    released.pdf_hash = crypto.createHash("sha256").update(pdf).digest("hex");

    const [saved] = await db.patch(`partner_sale_documents?id=eq.${row.id}&status=eq.requested`, released);
    if (!saved) throw new DocumentError("not_open", 409);
    return saved;
  }

  async function reject(id, reason) {
    const row = await load(id);
    if (row.status !== "requested") throw new DocumentError("not_open", 409);
    if (!text(reason)) throw new DocumentError("reason_needed");

    const [saved] = await db.patch(`partner_sale_documents?id=eq.${row.id}`, {
      status: "rejected",
      reject_reason: text(reason).slice(0, 500),
      updated_at: now().toISOString()
    });
    return saved;
  }

  async function pdf(row) {
    return renderPdf(row, { draft: row.status !== "approved" });
  }

  return { configured, load, acceptance, acceptTerms, draft, preview, request, list, lastPayment, setBuyerPaid, all, defaultsFor, approve, reject, pdf };
}

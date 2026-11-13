// admin/woovinPayouts.js
//
// Booking a Woovin payout from its PDF (Finance › Woovin Payouts).
//
// Woovin pays out per payout: one bank line covers many orders, minus their
// fees, minus a penalty now and then, minus the price of a sale that came
// back after it was paid out. The only document is the "Payout invoice #NNNN"
// PDF, which is at the same time Woovin's invoice for its fees. Dario drops
// it here; this reads it, checks every row against Airtable, the Woovin API
// and Rompslomp, shows what will be booked, and books it on his click:
//
//   paid order        a sales invoice at the price, dated on the sale, with
//                     its Voorraadcorrectie - unless it is invoiced already
//                     (September was done by hand) - and the Airtable fields
//   refunded, payout 0  nothing to invoice: Bookkeeping Status → Cancelled
//   penalty           (compensation only) no sale, the amount is a fee;
//                     Bookkeeping Status → Cancelled
//   correction        a credit invoice, the one the Returns flow made if it
//                     did (same api_reference), and its marketplace_settle
//                     todo ticked
//   the fees          one expense from Woovin B.V. on Transacties at 21%,
//                     one line per order so the VAT rounds as Woovin's does;
//                     the PDF goes on it by hand, Rompslomp's API cannot put
//                     a file on an expense (see purchaseExpense.js)
//   settlement        a Kruisposten payment per document: +price per
//                     invoice, −price per credit, −fees for the expense.
//                     They add up to the bank line, which goes to Kruisposten
//                     too, so every document is paid 1:1 and Kruisposten ends
//                     on zero.
//
// Nothing is booked when the payout does not add up: Σ price − Σ credits −
// fees has to be Σ total payout on the cent (Woovin rounds per row, so a
// cent of rounding is shown and left to settle by hand).
//
// Safe to run again after a failure: invoices are found back by their
// api_reference (the order's record id, as on the September invoices),
// credits by the Returns flow's reference, the expense by its line text, the
// Voorraadcorrectie and the Kruisposten payments by their description.

import express from "express";
import crypto from "crypto";
import fs from "fs";
import zlib from "zlib";

import { creditInvoiceBody } from "./externalSalesInvoicing.js";
import { invoicePlan } from "./adminCollectiveInvoices.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const cents = (value) => Math.round(Number(value || 0) * 100);
const euro = (value) => `€ ${Number(value || 0).toFixed(2).replace(".", ",")}`;

export class WoovinPayoutError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/* ---------------- what is fixed ---------------- */

const ORDERS = "Unfulfilled Orders Log";
const UNITS = "Inventory Units";
const TO_BOOK = "To book – marketplace";

/*
 * Kickz Caviar's books in Rompslomp (the company the API calls "Payout by
 * Kickz Caviar B.V."). The ids below only exist there, so another company is
 * refused rather than booked into with ids that mean nothing.
 */
export const COMPANY_ID = "1296508534";
export const WOOVIN_CUSTOMER = 712701648; // WOOVIN B.V. K00587, on the September invoices
export const WOOVIN_SUPPLIER = 220090713; // WOOVIN B.V. L02614, on the #7138 fee expense
export const FEE_ACCOUNT = { id: 365526741, path: "profit.costs.transacties_custom" }; // Kosten • Transacties
export const VAT_HIGH = { id: 701184043, rate: 0.21 };
const VAT_NONE = 688369464; // vrijgesteld
export const KRUISPOSTEN = { id: 950141831, path: "activa.liquid_assets.kruisposten_custom" };
const STOCK = { id: 1981496874, path: "activa.current_assets.voorraad_scout_custom" };

/*
 * The last day of a VAT period that has been filed. A sale on or before it
 * is invoiced today instead (Dario's rule for invoices that come in late,
 * 31-10-2026), so a filed return never changes. Q3 2026 was filed on
 * 31-10-2026; move this on when Q4 is filed, or set BOOKS_CLOSED_UNTIL.
 */
export const BOOKS_CLOSED_UNTIL = "2026-09-30";

// Woovin's first payout to us came in September 2026; the overview starts there.
export const OVERVIEW_FROM = "2026-09-01";

const ORDER_FIELDS = [
  "Order ID", "Marketplace Sale ID", "Marketplace", "Order Source", "Fulfillment Status", "Bookkeeping Status",
  "Rompslomp Invoice ID", "Rompslomp Invoice Number", "Rompslomp Credit Invoice Number", "Rompslomp Journal Entry ID",
  "Selling Price", "Order Date", "Linked Inventory Unit", "Product Name", "Size", "SKU", "VAT Type", "Picture"
];
const UNIT_FIELDS = ["Item ID", "VAT Type", "Final Purchase Price", "Final Purchase Price (ex. VAT)"];

/* ---------------- dates ---------------- */

const amsterdamDay = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(d);
};

export const todayIn = (now = new Date()) => amsterdamDay(now);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "Oct 28, 2026 16:57:30" → "2026-10-28"
export function payoutDate(value) {
  const m = text(value).match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!m || !MONTHS[m[1].toLowerCase()]) return "";
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function plusDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---------------- reading the PDF ---------------- */

/*
 * Woovin's payout invoice is made by dompdf: every piece of text is a
 * literal string in a BT ... ET block, positioned with Td and written in
 * two-byte codes that are the characters themselves. That is all this
 * reads; it is not a general PDF reader, and a file it does not recognise
 * is refused rather than guessed at.
 */
function objectsOf(buffer) {
  const raw = buffer.toString("latin1");
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;

  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endobj", start);
    if (end < 0) break;
    const body = raw.slice(start, end);
    const s = body.search(/stream\r?\n/);
    let dict = body;
    let stream = null;

    if (s >= 0) {
      dict = body.slice(0, s);
      const from = start + s + body.slice(s).match(/^stream\r?\n/)[0].length;
      const to = raw.lastIndexOf("endstream", end);
      let bytes = buffer.subarray(from, to);
      if (/\/FlateDecode/.test(dict)) {
        try {
          bytes = zlib.inflateSync(bytes);
        } catch {
          try { bytes = zlib.inflateSync(bytes.subarray(0, Math.max(0, bytes.length - 1))); } catch { bytes = Buffer.alloc(0); }
        }
      }
      stream = bytes;
    }

    objects.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }

  return objects;
}

const refsIn = (value) => [...String(value || "").matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]));

// The pages in order, each with the content streams it is drawn from.
function pagesOf(objects) {
  const root = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict));
  const kids = root ? refsIn(root.dict.match(/\/Kids\s*\[([^\]]*)\]/)?.[1]) : [];
  const pages = kids.length
    ? kids.map((id) => objects.get(id)).filter(Boolean)
    : [...objects.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.dict));

  return pages.map((page) => {
    const contents = page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/)?.[1] || "";
    return refsIn(contents).map((id) => objects.get(id)?.stream).filter(Boolean);
  });
}

// A literal string "(...)" starting at i: its bytes and where it ends.
function literalAt(s, i) {
  const out = [];
  let depth = 0;

  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      const n = s[j + 1];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 }[n];
      if (esc !== undefined) { out.push(esc); j += 1; continue; }
      if (/[0-7]/.test(n || "")) {
        const oct = s.slice(j + 1, j + 4).match(/^[0-7]{1,3}/)[0];
        out.push(parseInt(oct, 8) & 255);
        j += oct.length;
        continue;
      }
      if (n === "\r" || n === "\n") { j += n === "\r" && s[j + 2] === "\n" ? 2 : 1; continue; }
      continue;
    }
    if (c === "(") { depth += 1; if (depth === 1) continue; }
    if (c === ")") { depth -= 1; if (depth === 0) return { bytes: out, end: j + 1 }; }
    out.push(c.charCodeAt(0) & 255);
  }

  return { bytes: out, end: s.length };
}

// Two-byte codes when the high bytes are mostly zero (dompdf), else latin1.
function decode(bytes) {
  const highZero = bytes.filter((b, i) => i % 2 === 0 && b === 0).length;
  if (bytes.length >= 2 && bytes.length % 2 === 0 && highZero >= bytes.length / 4) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return Buffer.from(bytes).toString("latin1");
}

const SHOWS = new Set(["Tj", "TJ", "'", "\""]);

// Every piece of text with where it stands: { page, x, y, text }.
export function pdfTextRuns(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new WoovinPayoutError("That is not a PDF.", 400);
  }

  const runs = [];
  pagesOf(objectsOf(buffer)).forEach((streams, index) => {
    for (const stream of streams) {
      const s = stream.toString("latin1");
      let x = 0;
      let y = 0;
      let nums = [];
      let pending = [];
      let i = 0;

      while (i < s.length) {
        const c = s[i];
        if (c === "(") {
          const lit = literalAt(s, i);
          pending.push(decode(lit.bytes));
          i = lit.end;
          continue;
        }
        if (c === "<" && s[i + 1] !== "<") {
          const end = s.indexOf(">", i);
          const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s+/g, "");
          const bytes = [];
          for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
          pending.push(decode(bytes));
          i = end < 0 ? s.length : end + 1;
          continue;
        }
        if (/[\s[\]]/.test(c)) { i += 1; continue; }

        const token = s.slice(i).match(/^\/[^\s()<>[\]{}/%]*|^[^\s()<>[\]{}/%]+|^./)[0];
        i += token.length;

        if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(token)) { nums.push(Number(token)); continue; }
        if (token.startsWith("/")) continue;

        if (token === "BT") { x = 0; y = 0; }
        else if (token === "Td" || token === "TD") { x += nums.at(-2) || 0; y += nums.at(-1) || 0; }
        else if (token === "Tm") { x = nums.at(-2) || 0; y = nums.at(-1) || 0; }
        else if (SHOWS.has(token)) {
          const value = pending.join("");
          if (value.trim()) runs.push({ page: index + 1, x, y, text: value });
        }

        nums = [];
        if (SHOWS.has(token)) pending = [];
      }
    }
  });

  return runs;
}

// The text as lines: runs on the same height of a page, left to right.
export function pdfLines(buffer) {
  const runs = pdfTextRuns(buffer);
  const lines = [];

  for (const run of runs) {
    const line = lines.find((l) => l.page === run.page && Math.abs(l.y - run.y) < 2);
    if (line) line.runs.push(run);
    else lines.push({ page: run.page, y: run.y, runs: [run] });
  }

  return lines
    .sort((a, b) => a.page - b.page || b.y - a.y)
    .map((l) => l.runs.sort((a, b) => a.x - b.x).map((r) => r.text.trim()).filter(Boolean));
}

/* ---------------- the payout ---------------- */

// "€1.234,56", "-€24,20", "€-24,20" → number; null when it is not an amount.
export function amount(value) {
  const m = text(value).replace(/\s/g, "").match(/^(-?)€?(-?)([\d.]+,\d{2})$/);
  if (!m) return null;
  const n = Number(m[3].replace(/\./g, "").replace(",", "."));
  return m[1] || m[2] ? -n : n;
}

const FOOTER = [
  ["fee", /^Total transaction fee/i],
  ["processing", /^Total payment processing/i],
  ["compensation", /^Total compensation/i],
  ["taxable", /^Taxable amount/i],
  ["vat", /^VAT on fees/i]
];

/*
 * The payout from the lines of its PDF:
 *   { number, date, rows: [{ section, ref, price, processing, fee,
 *     compensation, vat, total }], footer: { fee, processing, compensation,
 *     taxable, vat } }
 * A row has 5 amounts, or 6 on the PDFs that have the COMPENSATION column.
 */
export function parsePayoutLines(lines) {
  const joined = lines.map((l) => l.join(" "));
  const number = joined.map((l) => l.match(/Payout invoice #(\d+)/i)?.[1]).find(Boolean);
  const dateText = joined.map((l) => l.match(/Date:\s*(.+)$/)?.[1]).find(Boolean);
  if (!number) throw new WoovinPayoutError("This is not a Woovin payout invoice: no \"Payout invoice #\" on it.", 400);

  const rows = [];
  const footer = { fee: 0, processing: 0, compensation: 0, taxable: null, vat: null };
  let section = null;
  let withCompensation = false;

  for (const line of lines) {
    const head = line[0] || "";
    if (/^ORDERS$/i.test(head)) { section = "order"; continue; }
    if (/^CORRECTIONS$/i.test(head)) { section = "correction"; continue; }
    if (/^REFERENCE$/i.test(head)) { withCompensation = line.some((c) => /^COMPENSATION$/i.test(c)); continue; }

    const label = line.slice(0, -1).join(" ");
    const foot = FOOTER.find(([, re]) => re.test(label));
    if (foot && amount(line.at(-1)) !== null) {
      footer[foot[0]] = amount(line.at(-1));
      section = null;
      continue;
    }

    if (!section || !/^\d{4,}$/.test(head)) continue;
    const values = line.slice(1).map(amount);
    const want = withCompensation ? 6 : 5;
    if (values.length !== want || values.some((v) => v === null)) {
      throw new WoovinPayoutError(`Row ${head} on payout #${number} could not be read (${line.join(" ")}).`, 422);
    }
    const [price, processing, fee, ...rest] = values;
    const [compensation, vat, total] = withCompensation ? rest : [0, ...rest];
    rows.push({ section, ref: head, price, processing, fee, compensation, vat, total });
  }

  if (footer.taxable === null || footer.vat === null) {
    throw new WoovinPayoutError(`Payout #${number}: the totals at the bottom could not be read.`, 422);
  }
  if (!rows.length) throw new WoovinPayoutError(`Payout #${number} has no rows.`, 422);

  return { number, dateText: text(dateText), date: payoutDate(dateText), rows, footer };
}

export function parsePayoutPdf(buffer) {
  return parsePayoutLines(pdfLines(buffer));
}

/* ---------------- the plan ---------------- */

/*
 * What a row is:
 *   sale        paid out: total > 0
 *   refunded    nothing paid and no fees: refunded before the payout
 *   penalty     only a compensation (and its VAT): we pay, nothing is sold
 *   correction  in CORRECTIONS: a sale taken back after it was paid out
 */
export function kindOf(row) {
  if (row.section === "correction") return "correction";
  if (row.total > 0) return "sale";
  if (row.compensation > 0 && !row.processing && !row.fee) return "penalty";
  if (!row.total && !row.processing && !row.fee && !row.compensation && !row.vat) return "refunded";
  return "unknown";
}

const feeBase = (row) => round2(row.processing + row.fee + row.compensation);

// Woovin's API: order_price and fees in cents.
function apiCheck(row, data) {
  if (!data) return { status: "", notes: [] };
  if (data.error) return { status: "", notes: [`Woovin API: ${data.error}`] };

  const notes = [];
  const fees = Object.fromEntries((data.fees || []).map((f) => [f.type, Number(f.amount) / 100]));
  const price = Number(data.order_price) / 100;

  if (Math.abs(Math.abs(price) - Math.abs(row.price)) > 0.005) notes.push(`Woovin API price ${euro(price)}`);
  if (row.section === "order" && row.total > 0) {
    const diff = [
      ["processing", row.processing, fees.payment_processing_fee],
      ["fee", row.fee, fees.vendor_fee],
      ["VAT", row.vat, fees.vendor_fee_tax]
    ].filter(([, pdf, api]) => api !== undefined && Math.abs(pdf - api) > 0.015);
    if (diff.length) notes.push(`Woovin API ${diff.map(([k, , api]) => `${k} ${euro(api)}`).join(", ")}`);
    if (data.status && data.status !== "completed") notes.push(`Woovin says "${data.status}" now (payout ${euro(Number(data.payout) / 100)}): a correction follows on a later payout`);
  }
  return { status: text(data.status), created: text(data.created_at), notes };
}

const isCredit = (invoice) => Number(invoice?.price_with_vat) < 0;

/*
 * The plan for one payout. Pure, so it can be read and tested without any
 * of the services:
 *   payout     parsePayoutLines(...)
 *   orders     Map ref → { id, fields } (Unfulfilled Orders Log)
 *   units      Map record id → fields (Inventory Units)
 *   invoices   every invoice to WOOVIN_CUSTOMER (credits too)
 *   api        Map ref → Woovin order data, or { error }
 *   expense    the fee expense already in Rompslomp, or null
 *   payments   Kruisposten payments already made for this payout
 */
export function planPayout({ payout, orders = new Map(), units = new Map(), invoices = [], api = new Map(), expense = null, payments = [], closedUntil = BOOKS_CLOSED_UNTIL, today = todayIn() }) {
  const problems = [];
  const warnings = [];
  const tag = `Woovin payout #${payout.number}`;
  const paymentsDone = new Map(payments.map((p) => [text(p.description), p]));

  const invoiceOf = (ref, record) => {
    const fields = record?.fields || {};
    return invoices.find((i) => !isCredit(i) && text(fields["Rompslomp Invoice ID"]) && String(i.id) === text(fields["Rompslomp Invoice ID"])) ||
      invoices.find((i) => !isCredit(i) && record && i.api_reference === record.id) ||
      invoices.find((i) => !isCredit(i) && new RegExp(`\\bWoovin ${ref}\\b`).test(text(i.description))) ||
      null;
  };

  const rows = payout.rows.map((row) => {
    const kind = kindOf(row);
    const record = orders.get(row.ref) || null;
    const f = record?.fields || {};
    const unitId = first(f["Linked Inventory Unit"]);
    const unit = unitId ? units.get(unitId) || null : null;
    const check = apiCheck(row, api.get(row.ref));
    const out = {
      ref: row.ref, section: row.section, kind,
      price: row.price, processing: row.processing, fee: row.fee, compensation: row.compensation, vat: row.vat, total: row.total,
      record_id: record?.id || "", order_id: text(f["Order ID"]), product: text(f["Product Name"]), size: text(f.Size), sku: text(f.SKU),
      picture: text(first(f.Picture)?.thumbnails?.small?.url || first(f.Picture)?.url),
      fulfillment: text(f["Fulfillment Status"]), bookkeeping: text(f["Bookkeeping Status"]),
      api_status: check.status, notes: [...check.notes], problems: [],
      action: "", invoice: null, kruispost: 0, airtable: null
    };

    if (Math.abs(round2(row.price - feeBase(row) - row.vat) - row.total) > 0.015 && kind === "sale") {
      out.problems.push(`Price minus fees is ${euro(row.price - feeBase(row) - row.vat)}, the PDF says ${euro(row.total)}.`);
    }

    if (kind === "sale") {
      if (!record) out.problems.push("No order in Airtable has this Marketplace Sale ID.");
      const existing = invoiceOf(row.ref, record);
      const saleDay = amsterdamDay(check.created || f["Order Date"]) || "";
      out.sale_date = saleDay;

      if (existing) {
        out.invoice = { id: existing.id, number: existing.invoice_number, open: Number(existing.open_amount), amount: Number(existing.price_with_vat), date: existing.date };
        out.action = `Invoiced already: ${existing.invoice_number}`;
        if (Math.abs(Number(existing.price_with_vat) - row.price) > 0.005) out.problems.push(`${existing.invoice_number} is ${euro(existing.price_with_vat)}, Woovin paid out on ${euro(row.price)}.`);
        const description = `${tag}: ${existing.invoice_number} (${out.order_id || row.ref})`;
        if (!paymentsDone.has(description) && Number(existing.open_amount) + 0.005 < row.price) {
          out.problems.push(`${existing.invoice_number} has only ${euro(existing.open_amount)} open: it is paid already, so this payout cannot pay it.`);
        }
        if (record && text(f["Bookkeeping Status"]) !== "Invoiced") {
          out.airtable = { "Rompslomp Invoice ID": String(existing.id), "Rompslomp Invoice Number": text(existing.invoice_number), "Bookkeeping Status": "Invoiced" };
        }
      } else if (record) {
        const vatType = text(first(unit?.["VAT Type"]) || first(f["VAT Type"]));
        // Woovin B.V. buys, in the Netherlands, so a VAT pair is 21% Dutch VAT.
        const route = invoicePlan({ vatType, storeCountry: "Netherlands", clientCountry: "Netherlands" });
        if (!route) out.problems.push(`The pair has no VAT type${unit ? ` (${text(unit["Item ID"])})` : ""}, so the invoice route is unknown.`);
        if (["Invoiced", "Invoiced by Make"].includes(text(f["Bookkeeping Status"]))) {
          out.problems.push(`Airtable says "${text(f["Bookkeeping Status"])}" but no Woovin invoice for it was found in Rompslomp.`);
        }
        if (!saleDay) out.problems.push("No sale date: neither Woovin nor Airtable has one.");
        const cost = route && unit ? round2(unit[route.costAmountField]) : 0;
        if (route && !(cost > 0)) out.notes.push("No purchase price on the unit: the Voorraadcorrectie is left to do by hand.");
        const date = saleDay && saleDay > closedUntil ? saleDay : today;
        if (saleDay && saleDay <= closedUntil) out.notes.push(`Sold ${saleDay}, in a VAT period that is filed: dated today.`);
        out.invoice = null;
        out.new_invoice = { date, route: route?.label || "", vat_type: vatType, cost, unit_id: unitId || "", item_id: text(unit?.["Item ID"]) };
        out.action = `New invoice, ${route?.label || "?"}, dated ${date}`;
      }
      out.kruispost = row.price;
    } else if (kind === "correction") {
      const original = invoiceOf(row.ref, record);
      out.sale_date = "";
      if (!record) out.problems.push("No order in Airtable has this Marketplace Sale ID.");
      if (!original) out.problems.push("No invoice to credit was found in Rompslomp.");
      const reference = original && record ? `credit-${original.id}-${record.id}` : "";
      const credit = invoices.find((i) => isCredit(i) && ((reference && i.api_reference === reference) || (text(f["Rompslomp Credit Invoice Number"]) && i.invoice_number === text(f["Rompslomp Credit Invoice Number"]))));
      out.original = original ? { id: original.id, number: original.invoice_number } : null;
      out.credit = credit ? { id: credit.id, number: credit.invoice_number, amount: Number(credit.price_with_vat) } : null;
      out.credit_reference = reference;
      if (credit && Math.abs(Math.abs(Number(credit.price_with_vat)) - Math.abs(row.price)) > 0.005) {
        out.problems.push(`Credit ${credit.invoice_number} is ${euro(credit.price_with_vat)}, Woovin corrects ${euro(row.price)}.`);
      }
      out.action = credit ? `Credited already: ${credit.invoice_number}` : original ? `Credit invoice for ${original.invoice_number}` : "Credit invoice";
      out.kruispost = -Math.abs(row.price);
    } else if (kind === "refunded" || kind === "penalty") {
      const existing = invoiceOf(row.ref, record);
      const credited = record && invoices.some((i) => isCredit(i) && text(i.api_reference).endsWith(`-${record.id}`));
      if (existing && !credited) out.problems.push(`${existing.invoice_number} was made for it but Woovin never paid it out: credit it first (Returns).`);
      const bk = text(f["Bookkeeping Status"]);
      if (record && (!bk || bk === TO_BOOK)) out.airtable = { "Bookkeeping Status": "Cancelled" };
      out.action = kind === "penalty"
        ? `No sale: ${euro(row.compensation + row.vat)} penalty, part of the fees`
        : "Refunded before the payout: no invoice";
      if (!record) out.notes.push("Not in Airtable: nothing to update.");
    } else {
      out.problems.push("This row is neither a sale, a refund, a penalty nor a correction.");
    }

    return out;
  });

  // The PDF has to add up with itself before anything is booked.
  // A correction is taken off, whichever sign the PDF prints it with.
  const signed = (r, value) => (r.section === "correction" ? -Math.abs(value) : value);
  const feeRows = round2(payout.rows.reduce((s, r) => s + signed(r, feeBase(r)), 0));
  const vatRows = round2(payout.rows.reduce((s, r) => s + signed(r, r.vat), 0));
  const footer = payout.footer;
  const fees = round2(footer.taxable + footer.vat);
  const sales = round2(rows.filter((r) => r.kind === "sale").reduce((s, r) => s + r.price, 0));
  const credits = round2(rows.filter((r) => r.kind === "correction").reduce((s, r) => s + Math.abs(r.price), 0));
  const bank = round2(payout.rows.reduce((s, r) => s + signed(r, r.total), 0));
  const pdfDifference = round2(sales - credits - fees - bank);

  if (Math.abs(feeRows - footer.taxable) > 0.005) problems.push(`The rows have ${euro(feeRows)} in fees, the totals say ${euro(footer.taxable)} excl. VAT.`);
  if (Math.abs(vatRows - footer.vat) > 0.005) problems.push(`The rows have ${euro(vatRows)} VAT on fees, the totals say ${euro(footer.vat)}.`);
  if (Math.abs(pdfDifference) > 0.025) problems.push(`Sales ${euro(sales)} − credits ${euro(credits)} − fees ${euro(fees)} is not the payout ${euro(bank)} (${euro(pdfDifference)} apart).`);

  // The expense: one line per order with fees, so the VAT rounds per row as
  // Woovin rounds it. Rompslomp rounds per line too.
  const feeLines = rows.filter((r) => feeBase(r) !== 0).map((r) => ({
    ref: r.ref, order_id: r.order_id, kind: r.kind, base: round2(signed(r, feeBase(r))),
    processing: r.processing, fee: r.fee, compensation: r.compensation
  }));
  /*
   * Woovin's VAT per row is not always 21% of that row rounded (the two fees
   * are taxed apart), so 21% per line can miss its total by a cent. The
   * difference goes on a line of its own without VAT: the expense then is
   * Woovin's invoice to the cent, which is what the payment has to match, and
   * the VAT claimed is at most a cent under theirs.
   */
  const lineVat = round2(feeLines.reduce((s, l) => s + Math.round(l.base * VAT_HIGH.rate * 100) / 100, 0));
  const vatRounding = round2(footer.vat - lineVat);
  if (!expense && Math.abs(vatRounding) > 0.05) problems.push(`At 21% per line the VAT on fees comes to ${euro(lineVat)}, Woovin says ${euro(footer.vat)}: too far apart to be rounding.`);
  /*
   * An expense booked by hand is paid for what it is, so its Kruisposten
   * payment matches it 1:1. Woovin regenerates its PDFs: #7138 said 56,15
   * VAT when Dario booked it and 56,14 a month later, so a cent or two
   * apart is rounding, more is a different invoice.
   */
  const feesBooked = expense ? round2(expense.total) : fees;
  if (expense && Math.abs(feesBooked - fees) > 0.025) {
    problems.push(`The fee expense for #${payout.number} is in Rompslomp already at ${euro(expense.total)}, the PDF says ${euro(fees)}.`);
  } else if (expense && feesBooked !== fees) {
    warnings.push(`The fee expense ${expense.invoice_number || expense.id} was booked at ${euro(feesBooked)}, this PDF says ${euro(fees)} (Woovin recalculated it). It is paid for its own ${euro(feesBooked)}.`);
  }

  const difference = round2(sales - credits - feesBooked - bank);
  if (difference && Math.abs(difference) <= 0.025) {
    warnings.push(`Sales − credits − fees comes to ${euro(sales - credits - feesBooked)}, the payout is ${euro(bank)}. Book the ${euro(-difference)} left on Kruisposten as afrondingsverschil by hand.`);
  }

  const expenseDate = payout.date && payout.date > closedUntil ? payout.date : today;
  if (!expense && payout.date && payout.date <= closedUntil) warnings.push(`The payout is dated ${payout.date}, in a filed VAT period: the fee expense is dated today.`);
  if (!payout.date) problems.push(`The date "${payout.dateText}" could not be read.`);

  for (const r of rows) for (const p of r.problems) problems.push(`${r.order_id || r.ref}: ${p}`);

  // The Kruisposten payments, in the order they are made.
  const settle = [
    ...rows.filter((r) => r.kind === "sale" || r.kind === "correction").map((r) => ({ ref: r.ref, kind: r.kind, amount: round2(r.kruispost), order_id: r.order_id })),
    { ref: "", kind: "fees", amount: -feesBooked, order_id: "" }
  ];
  const settled = round2(settle.reduce((s, p) => s + p.amount, 0));

  return {
    number: payout.number,
    date: payout.date,
    date_text: payout.dateText,
    tag,
    rows,
    counts: {
      sales: rows.filter((r) => r.kind === "sale").length,
      new_invoices: rows.filter((r) => r.kind === "sale" && !r.invoice).length,
      invoiced: rows.filter((r) => r.kind === "sale" && r.invoice).length,
      refunded: rows.filter((r) => r.kind === "refunded").length,
      penalties: rows.filter((r) => r.kind === "penalty").length,
      corrections: rows.filter((r) => r.kind === "correction").length,
      airtable: rows.filter((r) => r.airtable).length
    },
    totals: { sales, credits, fee_taxable: footer.taxable, fee_vat: footer.vat, fees, fees_booked: feesBooked, bank, difference, settled },
    fee_lines: feeLines,
    vat_rounding: vatRounding,
    expense: expense ? { id: expense.id, number: expense.invoice_number, total: Number(expense.total), date: expense.date } : null,
    expense_date: expenseDate,
    settle,
    payments_done: [...paymentsDone.keys()],
    problems,
    warnings,
    bookable: problems.length === 0
  };
}

/* ---------------- Rompslomp bodies ---------------- */

export function salesInvoiceBody({ row, contactId = WOOVIN_CUSTOMER }) {
  const route = invoicePlan({ vatType: row.new_invoice.vat_type, storeCountry: "Netherlands", clientCountry: "Netherlands" });
  const price = route.vatTypeId === VAT_HIGH.id ? (row.price / 1.21).toFixed(5) : row.price.toFixed(2);
  const line = {
    description: row.product || `Woovin ${row.ref}`,
    extended_description: row.size || "",
    price_per_unit: price,
    quantity: "1.0",
    vat_rate: "",
    vat_type_id: route.vatTypeId
  };
  if (route.lineAccount) {
    line.account_id = 589136361;
    line.account_path = "profit.revenue.sneakers_custom";
  }

  return {
    sales_invoice: {
      date: row.new_invoice.date,
      due_date: plusDays(row.new_invoice.date, 7),
      payment_method: "pay_transfer",
      description: `${row.order_id} (Woovin ${row.ref})`,
      contact_id: contactId,
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: route.templateId,
      vat_number: null,
      api_reference: row.record_id,
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: [line]
    }
  };
}

export function stockJournalBody({ row, invoiceNumber }) {
  const route = invoicePlan({ vatType: row.new_invoice.vat_type, storeCountry: "Netherlands", clientCountry: "Netherlands" });
  const value = Number(row.new_invoice.cost).toFixed(2);
  return {
    journal_entry: {
      description: `Voorraadcorrectie ${invoiceNumber}`,
      date: row.new_invoice.date,
      lines: [
        { account_id: route.costAccountId, account_path: route.costAccountPath || "profit.costs.sneakers_custom", debit_amount: value, credit_amount: null },
        { account_id: STOCK.id, account_path: STOCK.path, debit_amount: null, credit_amount: value }
      ]
    }
  };
}

const nl = (n) => Number(n).toFixed(2).replace(".", ",");

export function feeExpenseBody({ plan }) {
  const tag = `Woovin payout invoice #${plan.number}`;
  return {
    expense: {
      date: plan.expense_date,
      state: "published",
      currency: "eur",
      contact_id: WOOVIN_SUPPLIER,
      type_account_id: FEE_ACCOUNT.id,
      invoice_lines: plan.fee_lines.map((l) => ({
        description: `${tag} · ${l.order_id || l.ref}`,
        extended_description: [
          l.kind === "penalty" ? `compensation ${nl(l.compensation)}` : `transaction fee ${nl(l.fee)} + processing ${nl(l.processing)}${l.compensation ? ` + compensation ${nl(l.compensation)}` : ""}`,
          l.kind === "correction" ? "(correction)" : "",
          `Woovin ${l.ref}`
        ].filter(Boolean).join(" · "),
        price_per_unit: l.base.toFixed(2),
        quantity: "1.0",
        vat_rate: String(VAT_HIGH.rate),
        vat_type_id: VAT_HIGH.id
      })).concat(plan.vat_rounding ? [{
        description: `${tag} · afronding btw`,
        extended_description: `Woovin rounds the VAT per fee: ${nl(plan.totals.fee_vat)} on their invoice, ${nl(plan.totals.fee_vat - plan.vat_rounding)} at 21% per line`,
        price_per_unit: plan.vat_rounding.toFixed(2),
        quantity: "1.0",
        vat_rate: "0",
        vat_type_id: VAT_NONE
      }] : [])
    }
  };
}

const expenseTotal = (expense) => round2((expense?.invoice_lines || []).reduce((s, l) => s + Number(l.price_without_vat || l.price_per_unit || 0) + Number(l.vat_amount || 0), 0));
const expenseVat = (expense) => round2((expense?.invoice_lines || []).reduce((s, l) => s + Number(l.vat_amount || 0), 0));

const paymentText = (plan, s, document) =>
  s.kind === "fees" ? `${plan.tag}: kosten ${document}` : `${plan.tag}: ${document} (${s.order_id || `Woovin ${s.ref}`})`;

/* ---------------- the work ---------------- */

/*
 * deps:
 *   airtable     select, byIds, update (main base)
 *   rompslomp    createRompslomp, Kickz Caviar's company
 *   fetchImpl    for the Woovin API
 *   woovinToken  WOOVIN_API_TOKEN; without it the API check is skipped and said so
 *   returnsFlow  () => createReturns(...), to tick a credit's marketplace_settle todo
 */
export function createWoovinPayouts({ airtable, rompslomp, fetchImpl = fetch, woovinToken = "", woovinBase = "https://woovin.com/api/v1", returnsFlow = () => null, closedUntil = BOOKS_CLOSED_UNTIL, now = () => new Date(), pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const jobs = new Map();

  function ready() {
    if (!rompslomp?.configured) throw new WoovinPayoutError("Booking needs ROMPSLOMP_API_TOKEN on this service.", 503);
    if (String(rompslomp.companyId) !== COMPANY_ID) throw new WoovinPayoutError(`Woovin payouts are booked in company ${COMPANY_ID} only; this service points at ${rompslomp.companyId}.`, 503);
  }

  async function woovinOrder(ref) {
    if (!text(woovinToken)) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetchImpl(`${woovinBase}/orders/${encodeURIComponent(ref)}`, {
          headers: { Authorization: `Bearer ${woovinToken}`, Accept: "application/json", "User-Agent": "Mozilla/5.0 (lojiq-admin)" },
          signal: AbortSignal.timeout(20_000)
        });
        if (response.status === 429) { await pause(3000 * (attempt + 1)); continue; }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return { error: `${response.status}` };
        return data?.data || { error: "empty answer" };
      } catch (err) {
        if (attempt === 3) return { error: err.message };
      }
    }
    return { error: "rate limited" };
  }

  async function ordersByRef(refs) {
    const out = new Map();
    for (let i = 0; i < refs.length; i += 30) {
      const chunk = refs.slice(i, i + 30);
      const { records } = await airtable.select(ORDERS, {
        formula: `OR(${chunk.map((r) => `{Marketplace Sale ID} = '${r}'`).join(",")})`,
        fields: ORDER_FIELDS,
        pageSize: 100
      });
      for (const record of records) {
        const ref = text(record.fields?.["Marketplace Sale ID"]);
        if (!out.has(ref) || text(record.fields?.Marketplace) === "Woovin") out.set(ref, record);
      }
    }
    return out;
  }

  /*
   * The fee expense, if it is there. Rompslomp ignores the date filter on
   * expenses but lists them newest date first, so this reads pages until it
   * is past the payout's date (the expense is dated on it, or later when that
   * period is filed).
   */
  async function feeExpenseOf(payout) {
    const until = plusDays(payout.date || todayIn(now()), -7);
    const tag = `Woovin payout invoice #${payout.number}`;
    for (let page = 1; page <= 80; page++) {
      const rows = await rompslomp.listExpenses({ page });
      const hit = rows.find((e) => Number(e.contact_id) === WOOVIN_SUPPLIER && (e.invoice_lines || []).some((l) => text(l.description).startsWith(tag)));
      if (hit) return { ...hit, total: expenseTotal(hit) };
      if (rows.length < 100 || text(rows.at(-1)?.date) < until) break;
    }
    return null;
  }

  /*
   * The Kruisposten payments made for this payout. Rompslomp lists payments
   * newest paid_at first, and ours are dated on the payout, so this reads
   * until it is past that date - a fixed number of pages missed #7138's
   * (page 9 of them on 13-11-2026) as soon as enough newer ones came in, and
   * would have made them twice.
   */
  async function paymentsOf(tag, date) {
    const until = plusDays(date || todayIn(now()), -3);
    const out = [];
    for (let page = 1; page <= 200; page++) {
      const rows = (await rompslomp.read(`/payments?page=${page}&per_page=100`))?.payments || [];
      out.push(...rows.filter((p) => text(p.description).startsWith(`${tag}:`)));
      if (rows.length < 100 || text(rows.at(-1)?.paid_at).slice(0, 10) < until) break;
    }
    return out;
  }

  async function gather(buffer) {
    ready();
    const payout = parsePayoutPdf(buffer);
    const refs = [...new Set(payout.rows.map((r) => r.ref))];
    const orders = await ordersByRef(refs);
    const unitIds = [...orders.values()].map((o) => first(o.fields?.["Linked Inventory Unit"])).filter(Boolean);
    const units = unitIds.length ? await airtable.byIds(UNITS, unitIds, UNIT_FIELDS) : new Map();
    // Four independent reads, side by side: one after the other they took
    // about ten seconds a payout (measured 13-11-2026, mostly the scans of
    // Rompslomp's payments and expenses).
    const woovinOrders = async () => {
      const api = new Map();
      for (const ref of refs) {
        const data = await woovinOrder(ref);
        if (data) api.set(ref, data);
        if (text(woovinToken)) await pause(250);
      }
      return api;
    };
    const [invoices, api, expense, payments] = await Promise.all([
      rompslomp.invoicesOfContact(WOOVIN_CUSTOMER),
      woovinOrders(),
      feeExpenseOf(payout),
      paymentsOf(`Woovin payout #${payout.number}`, payout.date)
    ]);
    const plan = planPayout({ payout, orders, units, invoices, api, expense, payments, closedUntil, today: todayIn(now()) });
    if (!text(woovinToken)) plan.warnings.unshift("WOOVIN_API_TOKEN is not set on this service: the rows were not checked against the Woovin API.");
    return { payout, plan, invoices };
  }

  /*
   * What a preview read, kept for ten minutes so Book does not read it all
   * again. It is used once: a booking that stops halfway reads afresh when
   * the PDF comes back, so what it made is found.
   */
  const gathered = new Map();
  const keyOf = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

  async function preview(buffer) {
    const result = await gather(buffer);
    for (const [key, hit] of gathered) if (Date.now() - hit.at > 10 * 60_000) gathered.delete(key);
    gathered.set(keyOf(buffer), { at: Date.now(), result });
    return result.plan;
  }

  async function gatherForBooking(buffer) {
    const key = keyOf(buffer);
    const hit = gathered.get(key);
    gathered.delete(key);
    if (hit && Date.now() - hit.at <= 10 * 60_000) return hit.result;
    return gather(buffer);
  }

  /*
   * Every Woovin payout since the start, from Rompslomp itself, and how far
   * each one is: the bank lines Woovin paid ("Payout 7138" in their text),
   * the Kruisposten payments booked here for it, whether the bank line is
   * booked yet, and whether the invoices it pays are paid.
   *
   * Reading that is two scans of Rompslomp's payments (about 20 seconds from
   * September on), so the page never waits for it twice: it gets the last
   * list at once and a new one is read in the background when that list is
   * five minutes old. A payout that is done stays done, so a new read only
   * goes back to the oldest payout that is not.
   */
  let overviewCache = null;
  let overviewRun = null;
  // Payouts booked here lately: the list shows them as booked at once, also
  // when a read that began before the booking comes back without them.
  const bookedHere = new Map();

  function asBooked(row) {
    const plan = bookedHere.get(String(row.number))?.plan;
    if (!plan || row.payments) return row;
    const documents = plan.settle.filter((s) => s.kind !== "fees").length;
    return { ...row, payments: plan.settle.length, settled: plan.totals.settled, invoices: documents, open_invoices: documents, status: row.bank_booked ? "link" : "bank_line" };
  }

  function withBooked(data) {
    for (const [number, hit] of bookedHere) if (Date.now() - hit.at > 30 * 60_000) bookedHere.delete(number);
    const payouts = data.payouts.map(asBooked);
    return { ...data, payouts, next: payouts.find((r) => r.status === "to_upload")?.number || "" };
  }

  function markBooked(plan) {
    bookedHere.set(String(plan.number), { at: Date.now(), plan });
    if (overviewCache) overviewCache = { ...overviewCache, data: withBooked(overviewCache.data) };
  }

  async function readOverview() {
    const previous = overviewCache?.data?.payouts || [];
    const dates = (rows) => rows.map((r) => r.date).filter(Boolean).sort();
    const oldestOpen = dates(previous.filter((r) => r.status !== "done"))[0];
    const from = previous.length ? plusDays(oldestOpen || dates(previous).at(-1) || OVERVIEW_FROM, -7) : OVERVIEW_FROM;
    const since = from < OVERVIEW_FROM ? OVERVIEW_FROM : from;

    const scan = async (selection) => {
      const out = [];
      for (let page = 1; page <= 200; page++) {
        const rows = (await rompslomp.read(`/payments?selection=${selection}&page=${page}&per_page=100`))?.payments || [];
        out.push(...rows);
        if (rows.length < 100 || text(rows.at(-1)?.paid_at).slice(0, 10) < since) break;
      }
      return out;
    };

    const [all, unbookedRows, invoiceRows] = await Promise.all([scan("all"), scan("unbooked"), rompslomp.invoicesOfContact(WOOVIN_CUSTOMER)]);
    const unbooked = new Set(unbookedRows.map((p) => String(p.id)));
    const invoices = new Map(invoiceRows.map((i) => [text(i.invoice_number), i]));
    const payouts = new Map();
    const of = (number) => {
      if (!payouts.has(number)) payouts.set(number, { number, date: "", bank: null, bank_booked: false, payments: 0, settled: 0, open_invoices: 0, invoices: 0 });
      return payouts.get(number);
    };

    for (const p of all) {
      if (text(p.paid_at).slice(0, 10) < since) continue;
      const description = text(p.description);
      const ours = description.match(/^Woovin payout #(\d+):/);
      if (ours) {
        const row = of(ours[1]);
        row.payments += 1;
        row.settled = round2(row.settled + Number(p.amount));
        const number = description.match(/\b(KC\d{6}-\d+)\b/)?.[1];
        if (number && invoices.has(number)) {
          row.invoices += 1;
          if (Number(invoices.get(number).open_amount) > 0.005) row.open_invoices += 1;
        }
        if (!row.date) row.date = text(p.paid_at).slice(0, 10);
        continue;
      }
      const bank = /WOOVIN B\.V\./i.test(description) && /bank/i.test(text(p.account_path)) && description.match(/Payout (\d+)/i);
      if (bank) {
        const row = of(bank[1]);
        row.bank = round2(Number(p.amount));
        row.date = text(p.paid_at).slice(0, 10);
        row.bank_booked = !unbooked.has(String(p.id));
      }
    }

    const fresh = [...payouts.values()].map((row) => ({
      ...row,
      status: !row.payments ? "to_upload" : !row.bank_booked ? "bank_line" : row.open_invoices ? "link" : "done"
    }));
    // A payout that was done before the window of this read stays as it was.
    const kept = previous.filter((r) => r.status === "done" && !payouts.has(r.number));
    const list = [...kept, ...fresh].sort((x, y) => Number(x.number) - Number(y.number));
    const next = list.find((r) => r.status === "to_upload")?.number || "";
    const data = withBooked({ since: OVERVIEW_FROM, next, payouts: list, at: now().toISOString() });
    overviewCache = { at: Date.now(), data };
    return data;
  }

  function refreshOverview() {
    if (!overviewRun) overviewRun = readOverview().finally(() => { overviewRun = null; });
    return overviewRun;
  }

  async function overview({ fresh = false } = {}) {
    ready();
    if (fresh || !overviewCache) return refreshOverview();
    if (Date.now() - overviewCache.at > 5 * 60_000) refreshOverview().catch((err) => console.error("[woovin payouts] overview:", err.message));
    return { ...overviewCache.data, refreshing: Boolean(overviewRun) };
  }

  // Read the list once when the service starts, so the first visit is quick too.
  function warm() {
    if (!rompslomp?.configured || String(rompslomp.companyId) !== COMPANY_ID) return null;
    return refreshOverview().catch((err) => console.error("[woovin payouts] overview:", err.message));
  }

  /*
   * Book it. Runs as a job (a payout is a hundred calls or more, and
   * Rompslomp makes us wait a minute when it has had enough); the page asks
   * how far it is.
   */
  async function run(buffer, job) {
    const { plan, invoices } = await gatherForBooking(buffer);
    job.number = plan.number;
    const log = (line) => job.log.push(line);
    const todos = job.todos;

    if (!plan.bookable) throw new WoovinPayoutError(`Not booked: ${plan.problems.join(" ")}`);

    const documents = new Map(); // ref → document number to pay
    const journals = new Set((await rompslomp.recentJournals(3).catch(() => [])).map((j) => text(j.description)));

    for (const row of plan.rows) {
      job.step = `${row.order_id || row.ref}`;

      if (row.kind === "sale" && row.invoice) {
        documents.set(row.ref, row.invoice.number);
        if (row.airtable) {
          await airtable.update(ORDERS, row.record_id, row.airtable, { typecast: true });
          log(`${row.order_id}: Airtable now says ${row.invoice.number}, Invoiced.`);
        }
      } else if (row.kind === "sale") {
        let invoice = await rompslomp.findInvoice(row.record_id);
        if (!invoice) invoice = await rompslomp.createInvoice(salesInvoiceBody({ row }));
        if (invoice.status !== "published" || !invoice.invoice_number) invoice = await rompslomp.publishInvoice(invoice.id);
        if (Math.abs(Number(invoice.price_with_vat) - row.price) > 0.005) {
          throw new WoovinPayoutError(`${invoice.invoice_number} came out at ${euro(invoice.price_with_vat)}, Woovin paid ${euro(row.price)}. Stopped before paying it.`, 502);
        }
        documents.set(row.ref, invoice.invoice_number);
        const fields = {
          "Rompslomp Invoice ID": String(invoice.id),
          "Rompslomp Invoice Number": text(invoice.invoice_number),
          "Bookkeeping Status": "Invoiced",
          "Invoice Sent At": now().toISOString()
        };
        await airtable.update(ORDERS, row.record_id, fields, { typecast: true });
        log(`${row.order_id}: ${invoice.invoice_number}, ${euro(row.price)}, ${row.new_invoice.route}, dated ${invoice.date || row.new_invoice.date}.`);

        const description = `Voorraadcorrectie ${invoice.invoice_number}`;
        if (row.new_invoice.cost > 0 && !journals.has(description)) {
          const journal = await rompslomp.createJournal(stockJournalBody({ row, invoiceNumber: invoice.invoice_number }));
          journals.add(description);
          if (journal?.id) await airtable.update(ORDERS, row.record_id, { "Rompslomp Journal Entry ID": String(journal.id) });
          log(`${description}: ${euro(row.new_invoice.cost)}.`);
        } else if (!(row.new_invoice.cost > 0)) {
          todos.push(`Book the Voorraadcorrectie of ${invoice.invoice_number} (${row.order_id}) by hand: the unit has no purchase price.`);
        }
      } else if (row.kind === "correction") {
        let credit = row.credit ? invoices.find((i) => String(i.id) === String(row.credit.id)) : null;
        if (!credit) credit = await rompslomp.findInvoice(row.credit_reference);
        if (!credit) {
          const original = await rompslomp.getInvoice(row.original.id);
          credit = await rompslomp.createInvoice(creditInvoiceBody({ original, reference: row.credit_reference, now: now() }));
          todos.push(`${row.order_id}: credit made here, not by the Returns flow - check the pair's stock (Voorraadcorrectie back) on its return.`);
        }
        if (credit.status && credit.status !== "published") credit = await rompslomp.publishInvoice(credit.id);
        documents.set(row.ref, credit.invoice_number);
        await airtable.update(ORDERS, row.record_id, { "Rompslomp Credit Invoice Number": text(credit.invoice_number) });
        log(`${row.order_id}: credit ${credit.invoice_number} for ${row.original.number}.`);

        const flow = returnsFlow?.();
        if (flow) {
          const rets = (await flow.list({ view: "all", q: row.ref }).catch(() => [])).filter((r) => text(r.marketplace_order_id) === row.ref);
          for (const ret of rets) {
            for (const t of (ret.todo || []).filter((t) => t.kind === "marketplace_settle" && !t.done)) {
              await flow.tick(ret.id, t.id, true, `${plan.tag}`);
              log(`RET-${ret.return_number}: "settle with the marketplace" ticked.`);
            }
          }
        }
      } else if (row.airtable) {
        await airtable.update(ORDERS, row.record_id, row.airtable, { typecast: true });
        log(`${row.order_id}: Bookkeeping Status → Cancelled (${row.kind === "penalty" ? "penalty" : "refunded, never paid out"}).`);
      }
    }

    // Woovin's fee invoice.
    job.step = "fee expense";
    let expense = plan.expense;
    if (!expense) {
      const made = await rompslomp.createExpense(feeExpenseBody({ plan }));
      expense = { id: made.id, number: made.invoice_number, total: expenseTotal(made) };
      log(`Fee expense ${made.invoice_number || made.id}: ${euro(expenseTotal(made))} (VAT ${euro(expenseVat(made))}).`);
      if (Math.abs(expense.total - plan.totals.fees) > 0.005) {
        todos.push(`The fee expense ${made.invoice_number || made.id} came out at ${euro(expense.total)}, Woovin's invoice is ${euro(plan.totals.fees)}: correct it in Rompslomp, or its Kruisposten payment will not match.`);
      }
      todos.push(`Attach payout-invoice-${plan.number}.pdf to fee expense ${made.invoice_number || made.id} by hand; Rompslomp's API cannot add files to an expense.`);
    } else {
      log(`Fee expense ${expense.number || expense.id} was there already.`);
    }

    // Kruisposten: one payment per document.
    job.step = "Kruisposten";
    const done = new Set((await paymentsOf(plan.tag, plan.date)).map((p) => text(p.description)));
    const paidAt = plan.date || todayIn(now());
    let made = 0;
    for (const s of plan.settle) {
      const document = s.kind === "fees" ? `payout invoice #${plan.number}${expense.number ? ` (${expense.number})` : ""}` : documents.get(s.ref);
      const description = paymentText(plan, s, document);
      if (done.has(description)) continue;
      await rompslomp.createPayment({ amount: s.amount, description, accountId: KRUISPOSTEN.id, accountPath: KRUISPOSTEN.path, paidAt });
      done.add(description);
      made += 1;
    }
    log(`${made} Kruisposten payment${made === 1 ? "" : "s"} (${plan.settle.length} in all), together ${euro(plan.totals.settled)}.`);

    todos.unshift(
      `In Rompslomp, book the ING line of ${euro(plan.totals.bank)} from Woovin (around ${plan.date}) to Kruisposten.`,
      `Then link the ${plan.settle.length} Kruisposten payments "${plan.tag}: …" each to its invoice, credit or the fee expense.`
    );
    if (plan.totals.difference) todos.push(`Kruisposten keeps ${euro(-plan.totals.difference)} of rounding from this payout: book it as afrondingsverschil.`);

    return plan;
  }

  function book(buffer, { by = "" } = {}) {
    ready();
    const busy = [...jobs.values()].find((j) => j.state === "running");
    if (busy) throw new WoovinPayoutError(`Payout #${busy.number || "…"} is being booked; wait for it to finish.`);

    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const job = { id, by, state: "running", number: "", step: "reading the PDF", log: [], todos: [], error: "", started_at: now().toISOString() };
    jobs.set(id, job);
    for (const [key, old] of jobs) if (old.state !== "running" && Date.now() - Date.parse(old.started_at) > 6 * 3600_000) jobs.delete(key);

    job.promise = run(buffer, job)
      .then((plan) => { job.state = "done"; job.plan = plan; markBooked(plan); refreshOverview().catch(() => {}); })
      .catch((err) => { job.state = "failed"; job.error = err.message; console.error("[woovin payouts]", err.message); });

    return job;
  }

  function status(id) {
    const job = jobs.get(text(id));
    if (!job) throw new WoovinPayoutError("That booking is not known (the service may have restarted). Upload the PDF again: what is booked already is found back.", 404);
    const { promise, plan, ...rest } = job;
    return { ...rest, totals: plan?.totals || null };
  }

  return { preview, book, status, overview, warm, jobs };
}

/* ---------------- routes ---------------- */

export function mountWoovinPayouts(router, { store, audit, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";
  const pdf = express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "8mb" });

  const send = (res, err) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[admin woovin payouts]", err.message);
    res.status(status).json({ error: err instanceof WoovinPayoutError || status < 500 ? err.message : `Woovin payouts failed: ${err.message}` });
  };

  router.get(["/admin/woovin-payouts", "/admin/woovin-payouts/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.post("/api/admin/woovin-payouts/preview", pdf, async (req, res) => {
    try {
      res.json(await store.preview(req.body));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/woovin-payouts/book", pdf, async (req, res) => {
    try {
      const job = store.book(req.body, { by: req.admin?.name || req.admin?.email || "" });
      job.promise.then(() => audit?.record({
        actor: req.admin,
        action: job.state === "done" ? "woovin_payout_booked" : "woovin_payout_failed",
        source: "woovin_payouts",
        label: `Woovin payout #${job.number}`,
        details: { log: job.log, todos: job.todos, error: job.error }
      }).catch(() => {}));
      res.json(store.status(job.id));
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/woovin-payouts/overview", async (req, res) => {
    try {
      res.json(await store.overview({ fresh: req.query.fresh === "1" }));
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/woovin-payouts/status", (req, res) => {
    try {
      res.json(store.status(req.query.job));
    } catch (err) {
      send(res, err);
    }
  });
}

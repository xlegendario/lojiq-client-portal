// partner/saleDocumentPdf.js
//
// The partner's sale document as a PDF: a sales invoice and purchase
// declaration in his own name, for his buyer (partner/saleDocuments.js).
//
// Like admin/selfBillingPdf.js it needs no library - Helvetica is built into
// every PDF reader - but it runs over as many pages as the lines need, and it
// carries his drawn signature as an image. The signature arrives as a JPEG,
// which a PDF holds as it is, so nothing has to be decoded here.
//
// Lojiq is not on it anywhere: the document is his.

import { pdfString, textWidth, wrap } from "../admin/selfBillingPdf.js";
import { buyerName, documentNumber, formatIban, readSignature } from "./saleDocuments.js";

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const BOTTOM = 60;

const BLACK = [0, 0, 0];
const GREY = [0.38, 0.38, 0.38];
const LIGHT = [0.8, 0.8, 0.8];
const RED = [0.75, 0.1, 0.1];

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const euro = (value) => `€ ${Number(value || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const niceDay = (day) => {
  const [y, m, d] = text(day).split("-");
  return y && m && d ? `${d}-${m}-${y}` : "";
};

const signedStamp = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
};

class Page {
  constructor() {
    this.parts = [];
  }

  raw(value) {
    this.parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
    return this;
  }

  write(value, x, y, { size = 9, bold = false, color = BLACK, align = "left", width = 0 } = {}) {
    const clean = text(value);
    if (!clean) return this;
    const left = align === "right" ? x + width - textWidth(clean, size, bold) : x;
    this.raw(`${color.join(" ")} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td (`);
    this.raw(pdfString(clean));
    return this.raw(") Tj ET\n");
  }

  line(x1, y1, x2, y2, { color = LIGHT, width = 0.6 } = {}) {
    return this.raw(`${color.join(" ")} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`);
  }

  image(name, x, y, width, height) {
    return this.raw(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q\n`);
  }

  get content() {
    return Buffer.concat(this.parts);
  }
}

function buildPdf(pages, image) {
  // 1 catalog, 2 pages, 3-4 fonts, 5 the signature, then a page and its
  // content stream for every page.
  const first = 6;
  const objects = [];
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(" ");

  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  objects.push(image
    ? Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`),
        image.bytes,
        Buffer.from("\nendstream")
      ])
    : Buffer.from("null"));

  const xobject = image ? " /XObject << /Sig 5 0 R >>" : "";
  pages.forEach((page, i) => {
    const content = page.content;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${first + i * 2 + 1} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]));
  });

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let position = chunks[0].length;

  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    position += chunk.length;
  });

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));

  return Buffer.concat(chunks);
}

// "36 × 3, 37 × 3" for the sizes of a line.
export const sizesText = (line) => (line.sizes || []).map((s) => `${s.size} × ${s.qty}`).join(", ");

function addressLines(party = {}, { withName = true } = {}) {
  return [
    withName ? text(party.name) : "",
    text(party.address),
    text(party.address_line_2),
    [text(party.zipcode), text(party.city)].filter(Boolean).join(" "),
    text(party.country)
  ].filter(Boolean);
}

/*
 * row: a partner_sale_documents row (or the draft of one): seller, buyer,
 * lines, total, delivery_date, payment, vat_note, declaration, signature,
 * signed_at, doc_number, issue_date.
 */
export function saleDocumentPdf(row, { draft = false } = {}) {
  const pages = [];
  const right = A4.width - MARGIN;
  const width = right - MARGIN;
  let page;
  let y;

  const newPage = () => {
    page = new Page();
    pages.push(page);
    y = A4.height - MARGIN;
  };

  newPage();

  page.write("SALES INVOICE & PURCHASE DECLARATION", MARGIN, y, { size: 15, bold: true });
  y -= 16;
  if (draft) {
    page.write("DRAFT – not issued yet", MARGIN, y, { size: 10, bold: true, color: RED });
  }
  y -= 22;

  // Number and dates.
  const meta = [
    ["Document no.", documentNumber(row) || "assigned when issued"],
    ["Date", niceDay(row.issue_date) || (draft ? "date of issue" : "")],
    ["Delivery date", niceDay(row.delivery_date)]
  ];
  for (const [label, value] of meta) {
    page.write(label, MARGIN, y, { bold: true });
    page.write(value, MARGIN + 85, y);
    y -= 13;
  }
  y -= 14;

  // Who sells, who buys.
  const top = y;
  page.write("SUPPLIER / SELLER", MARGIN, y, { bold: true });
  page.write("BUYER", MARGIN + width / 2, y, { bold: true });
  y -= 5;
  page.line(MARGIN, y, right, y, { color: BLACK, width: 0.5 });
  y -= 13;

  const seller = addressLines(row.seller);
  const buyer = [buyerName(row.buyer), ...addressLines(row.buyer, { withName: false }), row.buyer?.vat_id ? `VAT: ${text(row.buyer.vat_id)}` : ""].filter(Boolean).flatMap((part) => wrap(part, 9, width / 2 - 6));
  const rows = Math.max(seller.length, buyer.length);
  for (let i = 0; i < rows; i += 1) {
    if (seller[i]) page.write(seller[i], MARGIN, y);
    if (buyer[i]) page.write(buyer[i], MARGIN + width / 2, y);
    y -= 12;
  }
  y = Math.min(y, top - 30) - 14;

  // The table.
  const cols = [
    { label: "Description", x: MARGIN, w: 170 },
    { label: "Sizes / variants", x: MARGIN + 172, w: 170 },
    { label: "Qty", x: MARGIN + 344, w: 34, align: "right" },
    { label: "Unit price", x: MARGIN + 380, w: 60, align: "right" },
    { label: "Amount", x: MARGIN + 442, w: width - 442, align: "right" }
  ];

  const header = () => {
    for (const c of cols) page.write(c.label, c.x, y, { bold: true, align: c.align || "left", width: c.w });
    y -= 5;
    page.line(MARGIN, y, right, y, { color: BLACK, width: 0.5 });
    y -= 12;
  };
  header();

  for (const line of row.lines || []) {
    const name = wrap(text(line.name) || text(line.sku), 9, cols[0].w);
    const sub = line.sku && text(line.name) ? [text(line.sku)] : [];
    const sizes = wrap(sizesText(line), 8, cols[1].w);
    const height = Math.max(name.length + sub.length, sizes.length, 1) * 11 + 6;

    if (y - height < BOTTOM) {
      newPage();
      header();
    }

    let ly = y;
    for (const part of name) { page.write(part, cols[0].x, ly); ly -= 11; }
    for (const part of sub) { page.write(part, cols[0].x, ly, { size: 8, color: GREY }); ly -= 11; }
    let sy = y;
    for (const part of sizes) { page.write(part, cols[1].x, sy, { size: 8, color: GREY }); sy -= 11; }
    page.write(String(line.qty), cols[2].x, y, { align: "right", width: cols[2].w });
    page.write(euro(line.unit_price), cols[3].x, y, { align: "right", width: cols[3].w });
    page.write(euro(line.total), cols[4].x, y, { align: "right", width: cols[4].w });

    y -= height;
    page.line(MARGIN, y + 8, right, y + 8);
  }

  // Everything after the table stays together: total, payment, declaration
  // and signature (about 260 points).
  if (y - 260 < BOTTOM) newPage();

  y -= 4;
  page.line(cols[3].x, y + 8, right, y + 8, { color: BLACK, width: 0.8 });
  page.write("Total", cols[3].x, y - 4, { bold: true, size: 10 });
  page.write(euro(row.total), cols[4].x, y - 4, { bold: true, size: 10, align: "right", width: cols[4].w });
  y -= 22;
  for (const part of wrap(text(row.vat_note), 8.5, width)) { page.write(part, MARGIN, y, { size: 8.5, color: GREY }); y -= 11; }
  y -= 16;

  page.write("PAYMENT", MARGIN, y, { bold: true, size: 10 });
  y -= 14;
  for (const part of [
    `Please transfer ${euro(row.total)} to:`,
    `IBAN: ${formatIban(row.payment?.iban)}`,
    `Account holder: ${text(row.payment?.holder)}`,
    `Reference: ${documentNumber(row) || "document no."}`
  ]) { page.write(part, MARGIN, y); y -= 12; }
  y -= 16;

  page.write("PURCHASE DECLARATION", MARGIN, y, { bold: true, size: 10 });
  y -= 14;
  for (const part of wrap(text(row.declaration), 9, width)) { page.write(part, MARGIN, y); y -= 12; }
  y -= 18;

  const sigX = MARGIN + 95;
  page.write("Name supplier:", MARGIN, y, { bold: true });
  page.write(text(row.seller?.name), sigX, y);
  y -= 16;
  page.write("Date:", MARGIN, y, { bold: true });
  page.write(row.signed_at ? signedStamp(row.signed_at).slice(0, 10) : "", sigX, y);
  y -= 16;
  page.write("Signature:", MARGIN, y, { bold: true });

  let image = null;
  if (row.signature) {
    try {
      image = readSignature(row.signature);
    } catch {
      image = null;
    }
  }

  const boxH = 56;
  const boxW = 200;
  if (image) {
    const scale = Math.min(boxW / image.width, boxH / image.height);
    page.image("Sig", sigX, y - boxH + 10, image.width * scale, image.height * scale);
  }
  y -= boxH - 4;
  page.line(sigX, y, sigX + boxW, y, { color: BLACK, width: 0.5 });
  y -= 11;
  if (row.signed_at) page.write(`Signed electronically by ${text(row.seller?.name)} · ${signedStamp(row.signed_at)} (Amsterdam time)`, sigX, y, { size: 7, color: GREY });

  // Page numbers, once there is more than one.
  if (pages.length > 1) {
    pages.forEach((p, i) => p.write(`Page ${i + 1} of ${pages.length}`, MARGIN, 30, { size: 8, color: GREY, align: "right", width }));
  }

  const name = documentNumber(row) || "draft";
  return { filename: `${name}.pdf`, pdf: buildPdf(pages, image) };
}

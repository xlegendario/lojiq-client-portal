// admin/selfBillingPdf.js
//
// The self-billing purchase invoice (block 10, 23-09-2026).
//
// When we buy a pair from a seller we write his invoice for him, under the
// self-billing agreement: one document per Inventory Unit, numbered by its
// Item ID. Until now Eledo made it and the file went to OneDrive by hand;
// this makes the same document from the same data, so it can be attached to
// the expense in Rompslomp the moment the purchase is booked.
//
// Three VAT routes, because what a purchase invoice must say about VAT is
// the one thing that differs:
//
//   Margin  no VAT at all, and it must say why (margin scheme)
//   VAT0    the seller charges nothing and we account for it (reverse charge)
//   VAT21   the VAT is shown apart, over a price excluding it
//
// No library: a PDF is a handful of objects and a stream of text-drawing
// operators, and this document is text in boxes. The base-14 Helvetica needs
// no font file, which is what keeps this dependency-free.

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;

const GOLD = [0.72, 0.56, 0.16];
const BLACK = [0, 0, 0];
const GREY = [0.35, 0.35, 0.35];

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

// What the document says about VAT, per route. The margin wording is the one
// Eledo has used all along; the other two are written to the same shape.
export const VAT_NOTES = {
  Margin: {
    label: "VAT Amount (0%) *",
    note: "* Margin Goods – Margin VAT Scheme applies. No VAT is charged and VAT may not be itemized.",
    rate: 0,
    priceIncludesVat: true,
    itemize: false
  },
  VAT0: {
    label: "VAT Amount (0%) *",
    note: "* VAT reverse-charged to the recipient under Article 196 of Council Directive 2006/112/EC.",
    rate: 0,
    priceIncludesVat: false,
    itemize: true
  },
  VAT21: {
    label: "VAT Amount (21%)",
    note: "",
    rate: 0.21,
    priceIncludesVat: false,
    itemize: true
  }
};

export const ISSUER = {
  name: "Payout by Kickz Caviar B.V.",
  lines: ["Havenstraat 74D", "1271AG Huizen", "The Netherlands", "KVK: 94370451", "VAT ID: NL866752845B01", "Email: info@kickzcaviar.nl"],
  footer: "This invoice is issued by Payout by Kickz Caviar B.V. on behalf of the seller under a self-billing agreement."
};

const euro = (value) => `€${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/*
 * What the three lines of the money block are, from the price as the seller
 * is paid it. A margin purchase has VAT inside the price and may not show
 * it; the other two have the VAT beside it.
 */
export function moneyLines(price, vatType) {
  const route = VAT_NOTES[vatType];
  if (!route) return null;

  const paid = Math.round(Number(price || 0) * 100) / 100;
  const net = route.priceIncludesVat || !route.rate ? paid : Math.round((paid / (1 + route.rate)) * 100) / 100;
  const vat = Math.round((paid - net) * 100) / 100;

  return {
    price: net,
    vat_label: route.label,
    // Margin VAT is never itemized; a zero reverse charge is shown as zero.
    vat: route.itemize ? vat : null,
    total: paid,
    note: route.note
  };
}

/* ---------------- the PDF itself ---------------- */

// A string as PDF bytes: WinAnsi, which is Latin-1 with the euro at 0x80.
function pdfString(value) {
  const bytes = [];
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    const byte = code === 0x20ac ? 0x80 : code === 0x2013 ? 0x96 : code <= 0xff ? code : 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

// Helvetica's own widths, near enough for wrapping and right-aligning.
const WIDTH_TABLE = { " ": 278, "0": 556, ".": 278, ",": 278, "€": 556 };

function textWidth(value, size, bold = false) {
  let units = 0;
  for (const char of String(value)) {
    const known = WIDTH_TABLE[char];
    if (known !== undefined) units += known;
    else if (/[A-Z]/.test(char)) units += bold ? 722 : 667;
    else if (/[a-z]/.test(char)) units += bold ? 556 : 500;
    else if (/[0-9]/.test(char)) units += 556;
    else units += 350;
  }
  return (units / 1000) * size;
}

function wrap(value, size, maxWidth, bold = false) {
  const words = String(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

class Page {
  constructor() {
    this.parts = [];
  }

  color(rgb, stroke = false) {
    this.parts.push(Buffer.from(`${rgb.join(" ")} ${stroke ? "RG" : "rg"}\n`));
    return this;
  }

  write(value, x, y, { size = 10, bold = false, color = BLACK, align = "left", width = 0 } = {}) {
    const clean = text(value);
    if (!clean) return this;

    const left = align === "right" ? x + width - textWidth(clean, size, bold) : x;
    this.color(color);
    this.parts.push(Buffer.from(`BT /${bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td (`));
    this.parts.push(pdfString(clean));
    this.parts.push(Buffer.from(") Tj ET\n"));
    return this;
  }

  box(x, y, width, height, { color = BLACK, lineWidth = 0.8 } = {}) {
    this.color(color, true);
    this.parts.push(Buffer.from(`${lineWidth} w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S\n`));
    return this;
  }

  get content() {
    return Buffer.concat(this.parts);
  }
}

function buildPdf(page) {
  const content = page.content;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    null, // the content stream
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  ];

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let position = chunks[0].length;

  objects.forEach((object, index) => {
    const number = index + 1;
    offsets.push(position);

    const body = object === null
      ? Buffer.concat([Buffer.from(`${number} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream\nendobj\n")])
      : Buffer.from(`${number} 0 obj\n${object}\nendobj\n`);

    chunks.push(body);
    position += body.length;
  });

  const xrefAt = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

/*
 * The document.
 *
 * input:
 *   document_number  the Inventory Unit's Item ID (OUT-007996, PCS-007999)
 *   order_number     what it was bought for (ORD-025689, EXTD-000078, MWTB-…)
 *   date             ISO date; today when left out
 *   vat_type         Margin | VAT0 | VAT21
 *   seller           { seller_id, name, address, zipcode, city, country, email, iban, vat_id }
 *   product          { name, size, sku, price }
 */
export function selfBillingPdf(input = {}) {
  const vatType = text(input.vat_type) || "Margin";
  const money = moneyLines(input.product?.price, vatType);

  if (!money) throw new Error(`No self-billing document for VAT type "${vatType}".`);

  const documentNumber = text(input.document_number);
  if (!documentNumber) throw new Error("The document needs the unit's Item ID as its number.");

  const page = new Page();
  const right = A4.width - MARGIN;
  let y = A4.height - MARGIN;

  page.write("SELF-BILLING PURCHASE INVOICE", MARGIN, y, { size: 15, bold: true, color: GOLD });
  y -= 34;

  // Who issues it, and the three numbers that identify it.
  const issuerTop = y;
  page.write(ISSUER.name, MARGIN, y, { size: 10, bold: true });
  y -= 14;
  for (const line of ISSUER.lines) {
    page.write(line, MARGIN, y, { size: 9, color: GREY });
    y -= 12;
  }

  const labelX = right - 190;
  const valueX = right - 90;
  let metaY = issuerTop;
  for (const [label, value] of [
    ["Invoice Number:", documentNumber],
    ["Date:", text(input.date) || new Date().toISOString().slice(0, 10)],
    ["Order Number:", text(input.order_number)]
  ]) {
    if (!value) continue;
    page.write(label, labelX, metaY, { size: 9, bold: true });
    page.write(value, valueX, metaY, { size: 9, align: "right", width: 90 });
    metaY -= 14;
  }

  y = Math.min(y, metaY) - 22;

  // Who is being paid.
  const seller = input.seller || {};
  page.write("Seller Details", MARGIN, y, { size: 11, bold: true, color: GOLD });
  y -= 16;

  const address = [text(seller.address), [text(seller.zipcode), text(seller.city)].filter(Boolean).join(" "), text(seller.country)]
    .filter(Boolean)
    .join(", ");

  for (const line of [
    text(seller.seller_id),
    text(seller.name),
    address,
    text(seller.vat_id) ? `VAT ID: ${text(seller.vat_id)}` : "",
    text(seller.email),
    text(seller.iban)
  ].filter(Boolean)) {
    page.write(line, MARGIN, y, { size: 9, color: GREY });
    y -= 12;
  }

  y -= 18;

  // What was bought.
  const columns = { name: MARGIN, size: MARGIN + 270, sku: MARGIN + 330, price: right - 90 };
  page.write("Product Name", columns.name, y, { size: 10, bold: true, color: GOLD });
  page.write("Size", columns.size, y, { size: 10, bold: true, color: GOLD });
  page.write("SKU", columns.sku, y, { size: 10, bold: true, color: GOLD });
  page.write("Price", columns.price, y, { size: 10, bold: true, color: GOLD, align: "right", width: 90 });
  y -= 18;

  const nameLines = wrap(text(input.product?.name), 9, 255);
  const rowHeight = Math.max(18, 12 * nameLines.length + 6);

  page.box(MARGIN - 4, y - rowHeight + 12, 258, rowHeight);
  page.box(columns.size - 4, y - rowHeight + 12, 56, rowHeight);
  page.box(columns.sku - 4, y - rowHeight + 12, 150, rowHeight);
  page.box(columns.price - 6, y - rowHeight + 12, 96, rowHeight);

  let nameY = y;
  for (const line of nameLines) {
    page.write(line, columns.name, nameY, { size: 9 });
    nameY -= 12;
  }

  page.write(text(input.product?.size), columns.size, y, { size: 9 });
  page.write(text(input.product?.sku), columns.sku, y, { size: 9 });
  page.write(euro(money.price), columns.price, y, { size: 9, align: "right", width: 90 });

  y -= rowHeight + 6;

  // The money block, two boxed rows under the table.
  for (const [label, value, bold] of [
    [money.vat_label, money.vat === null ? "-" : euro(money.vat), false],
    ["Total", euro(money.total), true]
  ]) {
    page.box(MARGIN - 4, y - 6, 140, 18);
    page.box(MARGIN + 140, y - 6, 158, 18);
    page.write(label, MARGIN, y, { size: 9, bold });
    page.write(value, MARGIN + 150, y, { size: 9, bold, align: "right", width: 138 });
    y -= 20;
  }

  y -= 16;

  if (money.note) {
    page.write(money.note, MARGIN, y, { size: 8.5, color: GREY });
    y -= 18;
  }

  page.write(ISSUER.footer, MARGIN, y, { size: 8.5, color: GREY });

  return { filename: `${documentNumber}.pdf`, pdf: buildPdf(page) };
}

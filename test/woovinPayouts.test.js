import test from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";

import {
  amount, createWoovinPayouts, feeExpenseBody, kindOf, parsePayoutLines, parsePayoutPdf, payoutDate, pdfLines,
  planPayout, salesInvoiceBody, WOOVIN_CUSTOMER, WOOVIN_SUPPLIER
} from "../admin/woovinPayouts.js";

/* ---------------- a payout PDF the way dompdf writes it ---------------- */

// Text as dompdf puts it: two-byte codes in a literal string, escaped.
const utf16 = (value) => {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    for (const byte of [code >> 8, code & 255]) {
      const c = String.fromCharCode(byte);
      out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
    }
  }
  return out;
};

function pdfOf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const root = add(null);
  const pageIds = [];

  for (const lines of pages) {
    let content = "";
    for (const [x, y, value] of lines) content += `BT ${x} ${y} Td /F1 9 Tf [(${utf16(value)})] TJ ET\n`;
    const data = zlib.deflateSync(Buffer.from(content, "latin1"));
    const stream = add(Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
    pageIds.push(add(`<< /Type /Page /Parent ${root} 0 R /Contents ${stream} 0 R >>`));
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${root} 0 R >>`;
  objects[root - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const parts = [Buffer.from("%PDF-1.7\n", "latin1")];
  objects.forEach((body, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"));
    parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    parts.push(Buffer.from("\nendobj\n", "latin1"));
  });
  parts.push(Buffer.from("trailer << /Root 1 0 R >>\n%%EOF", "latin1"));
  return Buffer.concat(parts);
}

const COLS = [39, 114, 189, 280, 362, 455, 524];

function row(y, ref, ...values) {
  return [[COLS[0], y, ref], ...values.map((v, i) => [COLS[i + 1], y, v])];
}

// Payout #7333's shape: the COMPENSATION column, two pages, a penalty.
function samplePdf() {
  const page1 = [
    [382, 784, "Payout invoice #7333"],
    [446, 765, "Date: Oct 28, 2026 16:57:30"],
    [39, 564, "ORDERS"],
    [39, 545, "REFERENCE"], [126, 545, "PRICE"], [169, 545, "PROCESSING"], [240, 545, "TRANSACTION FEE"], [330, 545, "COMPENSATION"], [413, 545, "VAT ON FEES (21%)"], [503, 545, "TOTAL PAYOUT"],
    ...row(519, "96674816", "€183,00", "€0,00", "€0,00", "€0,00", "€0,00", "€0,00"),
    ...row(491, "39675002", "€188,00", "€6,58", "€15,98", "€0,00", "€4,74", "€160,70"),
    ...row(463, "00699334", "€1.219,00", "€7,67", "€18,62", "€0,00", "€5,52", "€1.187,19")
  ];
  const page2 = [
    [39, 545, "REFERENCE"], [126, 545, "PRICE"], [169, 545, "PROCESSING"], [240, 545, "TRANSACTION FEE"], [330, 545, "COMPENSATION"], [413, 545, "VAT ON FEES (21%)"], [503, 545, "TOTAL PAYOUT"],
    ...row(435, "32513914", "€188,00", "€0,00", "€0,00", "€20,00", "€4,20", "-€24,20"),
    [39, 387, "CORRECTIONS"],
    [39, 368, "REFERENCE"], [106, 368, "PRICE"], [149, 368, "PROCESSING"], [220, 368, "TRANSACTION FEE"], [310, 368, "COMPENSATION"], [393, 368, "VAT ON FEES (21%)"], [487, 368, "TOTAL CORRECTION"],
    [297, 302, "Total transaction fee (orders - corrections)"], [525, 302, "€34,60"],
    [297, 283, "Total payment processing (orders - corrections)"], [525, 283, "€14,25"],
    [297, 263, "Total compensation (orders - corrections)"], [526, 263, "€20,00"],
    [297, 243, "Taxable amount (excl. VAT)"], [521, 243, "€68,85"],
    [297, 223, "VAT on fees (21%)"], [528, 223, "€14,46"]
  ];
  return pdfOf([page1, page2]);
}

test("amounts as Woovin prints them", () => {
  assert.equal(amount("€183,00"), 183);
  assert.equal(amount("€1.219,00"), 1219);
  assert.equal(amount("-€24,20"), -24.2);
  assert.equal(amount("€-60,00"), -60);
  assert.equal(amount("TOTAL"), null);
  assert.equal(payoutDate("Oct 28, 2026 16:57:30"), "2026-10-28");
  assert.equal(payoutDate("Sep 1, 2026 10:20:02"), "2026-09-01");
});

test("reads the rows, sections and totals off a dompdf payout PDF", () => {
  const lines = pdfLines(samplePdf());
  assert.deepEqual(lines[0], ["Payout invoice #7333"]);

  const payout = parsePayoutPdf(samplePdf());
  assert.equal(payout.number, "7333");
  assert.equal(payout.date, "2026-10-28");
  assert.equal(payout.rows.length, 4);
  assert.deepEqual(payout.rows[1], { section: "order", ref: "39675002", price: 188, processing: 6.58, fee: 15.98, compensation: 0, vat: 4.74, total: 160.7 });
  assert.equal(payout.rows[2].price, 1219);
  assert.deepEqual(payout.rows[3], { section: "order", ref: "32513914", price: 188, processing: 0, fee: 0, compensation: 20, vat: 4.2, total: -24.2 });
  assert.deepEqual(payout.footer, { fee: 34.6, processing: 14.25, compensation: 20, taxable: 68.85, vat: 14.46 });
});

test("older payouts without the COMPENSATION column, and a correction", () => {
  const payout = parsePayoutLines([
    ["Payout invoice #7289"], ["Date: Oct 21, 2026 18:54:32"], ["ORDERS"],
    ["REFERENCE", "PRICE", "PROCESSING", "TRANSACTION FEE", "VAT ON FEES (21%)", "TOTAL PAYOUT"],
    ["28790490", "€309,00", "€10,82", "€26,27", "€7,79", "€264,12"],
    ["CORRECTIONS"],
    ["REFERENCE", "PRICE", "PROCESSING", "TRANSACTION FEE", "VAT ON FEES (21%)", "TOTAL CORRECTION"],
    ["47981790", "€159,00", "€5,57", "€13,52", "€4,01", "€135,90"],
    ["Total transaction fee (orders - corrections)", "€12,75"],
    ["Total payment processing (orders - corrections)", "€5,25"],
    ["Taxable amount (excl. VAT)", "€18,00"],
    ["VAT on fees (21%)", "€3,78"]
  ]);
  assert.equal(payout.rows.length, 2);
  assert.equal(payout.rows[0].compensation, 0);
  assert.equal(payout.rows[1].section, "correction");
  assert.equal(kindOf(payout.rows[1]), "correction");
  assert.equal(payout.footer.compensation, 0);
});

test("a file that is not a payout is refused, not guessed at", () => {
  assert.throws(() => parsePayoutPdf(Buffer.from("hello")), /not a PDF/);
  assert.throws(() => parsePayoutLines([["Invoice #1"]]), /not a Woovin payout invoice/);
  assert.throws(() => parsePayoutLines([["Payout invoice #1"], ["ORDERS"], ["REFERENCE", "PRICE", "PROCESSING", "TRANSACTION FEE", "VAT ON FEES (21%)", "TOTAL PAYOUT"], ["123456", "€1,00", "€0,00"]]), /could not be read/);
});

/* ---------------- the plan ---------------- */

const order = (id, ref, fields = {}) => ({ id, fields: { "Order ID": `ORD-${id.slice(-4)}`, "Marketplace Sale ID": ref, Marketplace: "Woovin", "Bookkeeping Status": "To book – marketplace", "Linked Inventory Unit": [`unit${id.slice(3)}`], "Product Name": "Shoe", Size: "42", "Order Date": "2026-10-07T10:00:00.000Z", ...fields } });
const unit = (vat = "Margin", price = 120) => ({ "Item ID": "KC-1", "VAT Type": vat, "Final Purchase Price": price, "Final Purchase Price (ex. VAT)": round(price / 1.21) });
const round = (n) => Math.round(n * 100) / 100;

function world() {
  const payout = parsePayoutPdf(samplePdf());
  const orders = new Map([
    ["96674816", order("recAAAAAAAAAAAA0001", "96674816")],
    ["39675002", order("recAAAAAAAAAAAA0002", "39675002")],
    ["00699334", order("recAAAAAAAAAAAA0003", "00699334", { "Order Date": "2026-09-20T10:00:00.000Z" })],
    ["32513914", order("recAAAAAAAAAAAA0004", "32513914", { "Bookkeeping Status": "Cancelled" })]
  ]);
  const units = new Map([
    ["unitAAAAAAAAAAAA0002", unit("Margin", 150)],
    ["unitAAAAAAAAAAAA0003", unit("VAT21", 900)]
  ]);
  return { payout, orders, units };
}

test("the plan: sales, a refund, a penalty, and it adds up to the payout", () => {
  const { payout, orders, units } = world();
  const plan = planPayout({ payout, orders, units, today: "2026-11-12", closedUntil: "2026-09-30" });

  assert.equal(plan.bookable, true, plan.problems.join(" "));
  assert.deepEqual(plan.rows.map((r) => r.kind), ["refunded", "sale", "sale", "penalty"]);
  assert.equal(plan.totals.sales, 1407);
  assert.equal(plan.totals.fees, 83.31);
  assert.equal(plan.totals.bank, 1323.69);
  assert.equal(plan.totals.difference, 0);
  assert.equal(plan.totals.settled, plan.totals.bank);

  // Refunded and still "to book": Cancelled. The penalty is Cancelled already.
  assert.deepEqual(plan.rows[0].airtable, { "Bookkeeping Status": "Cancelled" });
  assert.equal(plan.rows[3].airtable, null);

  // Margin on the sale date; a sale in a filed period is dated today.
  assert.equal(plan.rows[1].new_invoice.route, "Margin");
  assert.equal(plan.rows[1].new_invoice.date, "2026-10-07");
  assert.equal(plan.rows[1].new_invoice.cost, 150);
  assert.equal(plan.rows[2].new_invoice.route, "VAT21");
  assert.equal(plan.rows[2].new_invoice.date, "2026-11-12");
  assert.equal(plan.rows[2].new_invoice.cost, round(900 / 1.21));
});

test("nothing is bookable when the PDF does not add up, or a sale has no order", () => {
  const { payout, orders, units } = world();
  const broken = { ...payout, footer: { ...payout.footer, taxable: 70 } };
  assert.equal(planPayout({ payout: broken, orders, units }).bookable, false);

  const missing = new Map(orders);
  missing.delete("39675002");
  const plan = planPayout({ payout, orders: missing, units });
  assert.equal(plan.bookable, false);
  assert.match(plan.problems.join(" "), /39675002: No order in Airtable/);
});

test("an invoice made by hand is paid, not made again - unless it is paid already", () => {
  const { payout, orders, units } = world();
  const invoices = [{ id: 1, invoice_number: "KC202610-0001", description: "ORD-0002 (Woovin 39675002)", price_with_vat: "188.0", open_amount: "188.0" }];
  const plan = planPayout({ payout, orders, units, invoices });
  assert.equal(plan.rows[1].invoice.number, "KC202610-0001");
  assert.equal(plan.rows[1].new_invoice, undefined);
  assert.deepEqual(plan.rows[1].airtable, { "Rompslomp Invoice ID": "1", "Rompslomp Invoice Number": "KC202610-0001", "Bookkeeping Status": "Invoiced" });

  const paid = planPayout({ payout, orders, units, invoices: [{ ...invoices[0], open_amount: "0.0" }] });
  assert.equal(paid.bookable, false);
  assert.match(paid.problems.join(" "), /paid already/);

  // Its own Kruisposten payment is what paid it: a second run is fine.
  const again = planPayout({ payout, orders, units, invoices: [{ ...invoices[0], open_amount: "0.0" }], payments: [{ description: "Woovin payout #7333: KC202610-0001 (ORD-0002)" }] });
  assert.equal(again.bookable, true, again.problems.join(" "));
});

test("a fee expense booked by hand a cent off (Woovin recalculated the PDF) is paid for its own amount", () => {
  const { payout, orders, units } = world();
  const plan = planPayout({ payout, orders, units, expense: { id: 5, invoice_number: "2026090413", total: 83.32 } });
  assert.equal(plan.bookable, true, plan.problems.join(" "));
  assert.equal(plan.settle.at(-1).amount, -83.32);
  assert.equal(plan.totals.difference, -0.01);
  assert.match(plan.warnings.join(" "), /recalculated/);
  assert.match(plan.warnings.join(" "), /€ 0,01 left on Kruisposten/);

  const far = planPayout({ payout, orders, units, expense: { id: 5, invoice_number: "2026090413", total: 90 } });
  assert.equal(far.bookable, false);
});

test("an invoice for a refunded order has to be credited first", () => {
  const { payout, orders, units } = world();
  const invoices = [{ id: 9, invoice_number: "KC202610-0009", api_reference: "recAAAAAAAAAAAA0001", price_with_vat: "183.0", open_amount: "183.0" }];
  const plan = planPayout({ payout, orders, units, invoices });
  assert.equal(plan.bookable, false);
  assert.match(plan.problems.join(" "), /never paid it out: credit it first/);
});

test("the fee expense: a line per order at 21%, the rounding apart, Woovin's total to the cent", () => {
  const { payout, orders, units } = world();
  const plan = planPayout({ payout, orders, units });
  const body = feeExpenseBody({ plan }).expense;

  assert.equal(body.contact_id, WOOVIN_SUPPLIER);
  const vatLines = body.invoice_lines.filter((l) => l.vat_type_id === 701184043);
  assert.equal(vatLines.length, 3);
  assert.ok(vatLines.every((l) => l.description.startsWith("Woovin payout invoice #7333")));
  const excl = vatLines.reduce((s, l) => s + Number(l.price_per_unit), 0);
  const vat = vatLines.reduce((s, l) => s + Math.round(Number(l.price_per_unit) * 21) / 100, 0);
  const rounding = body.invoice_lines.filter((l) => l.vat_type_id !== 701184043).reduce((s, l) => s + Number(l.price_per_unit), 0);
  assert.equal(round(excl), 68.85);
  assert.equal(round(excl + vat + rounding), plan.totals.fees);
});

test("the sales invoice looks like September's: to Woovin, order and reference, margin template", () => {
  const { payout, orders, units } = world();
  const plan = planPayout({ payout, orders, units, today: "2026-11-12" });
  const margin = salesInvoiceBody({ row: plan.rows[1] }).sales_invoice;
  assert.equal(margin.contact_id, WOOVIN_CUSTOMER);
  assert.equal(margin.description, "ORD-0002 (Woovin 39675002)");
  assert.equal(margin.api_reference, "recAAAAAAAAAAAA0002");
  assert.equal(margin.template_id, 322464949);
  assert.equal(margin.invoice_lines[0].price_per_unit, "188.00");
  assert.equal(margin.due_date, "2026-10-14");

  const vat = salesInvoiceBody({ row: plan.rows[2] }).sales_invoice;
  assert.equal(vat.template_id, null);
  assert.equal(vat.invoice_lines[0].vat_type_id, 701184043);
  assert.equal(vat.invoice_lines[0].price_per_unit, (1219 / 1.21).toFixed(5));
});

/* ---------------- booking ---------------- */

function services() {
  const { orders, units } = world();
  const records = [...orders.values()];
  const writes = [];
  const airtable = {
    async select(table, { formula }) {
      return { records: records.filter((r) => formula.includes(`'${r.fields["Marketplace Sale ID"]}'`)), offset: "" };
    },
    async byIds(table, ids) {
      return new Map(ids.filter((id) => units.has(id)).map((id) => [id, units.get(id)]));
    },
    async update(table, id, fields) {
      writes.push({ table, id, fields });
      Object.assign(records.find((r) => r.id === id).fields, fields);
    }
  };

  const invoices = [];
  const journals = [];
  const expenses = [];
  const payments = [];
  let next = 100;
  const rompslomp = {
    configured: true,
    companyId: "1296508534",
    async invoicesOfContact() { return invoices; },
    async findInvoice(reference) { return invoices.find((i) => i.api_reference === reference) || null; },
    async getInvoice(id) { return invoices.find((i) => i.id === id); },
    async createInvoice(body) {
      const b = body.sales_invoice;
      const total = b.invoice_lines.reduce((s, l) => s + Number(l.price_per_unit) * (l.vat_type_id === 701184043 ? 1.21 : 1), 0);
      const inv = { id: ++next, status: "concept", invoice_number: null, api_reference: b.api_reference, description: b.description, date: b.date, price_with_vat: round(total).toFixed(2), open_amount: round(total).toFixed(2), body };
      invoices.push(inv);
      return inv;
    },
    async publishInvoice(id) {
      const inv = invoices.find((i) => i.id === id);
      inv.status = "published";
      inv.invoice_number = `KC202610-${inv.id}`;
      return inv;
    },
    async createJournal(body) { journals.push(body); return { id: ++next, ...body.journal_entry }; },
    async recentJournals() { return journals.map((j) => j.journal_entry); },
    async listExpenses() { return expenses; },
    async createExpense(body) {
      const lines = body.expense.invoice_lines.map((l) => ({ ...l, price_without_vat: l.price_per_unit, vat_amount: (Math.round(Number(l.price_per_unit) * Number(l.vat_rate) * 100) / 100).toFixed(2) }));
      const exp = { id: ++next, invoice_number: "2026100001", date: body.expense.date, contact_id: body.expense.contact_id, invoice_lines: lines };
      expenses.push(exp);
      return exp;
    },
    async read(path) { return /^\/payments/.test(path) ? { payments } : null; },
    async createPayment(p) { payments.push({ ...p, amount: Number(p.amount).toFixed(2) }); }
  };

  return { airtable, rompslomp, writes, invoices, journals, expenses, payments, records };
}

test("booking makes every document once, settles them on Kruisposten, and a second run adds nothing", async () => {
  const s = services();
  const store = createWoovinPayouts({ airtable: s.airtable, rompslomp: s.rompslomp, now: () => new Date("2026-11-12T10:00:00Z"), pause: async () => {} });

  const job = store.book(samplePdf(), { by: "test" });
  await job.promise;
  assert.equal(job.state, "done", job.error);

  assert.equal(s.invoices.length, 2);
  assert.deepEqual(s.invoices.map((i) => i.api_reference).sort(), ["recAAAAAAAAAAAA0002", "recAAAAAAAAAAAA0003"]);
  assert.equal(s.journals.length, 2);
  assert.equal(s.expenses.length, 1);
  assert.equal(s.expenses[0].attachment, undefined);

  const sum = round(s.payments.reduce((t, p) => t + Number(p.amount), 0));
  assert.equal(sum, 1323.69);
  assert.equal(s.payments.length, 3);
  assert.ok(s.payments.every((p) => p.accountId === 950141831 && p.description.startsWith("Woovin payout #7333:")));

  const order2 = s.records.find((r) => r.id === "recAAAAAAAAAAAA0002").fields;
  assert.equal(order2["Bookkeeping Status"], "Invoiced");
  assert.ok(order2["Rompslomp Invoice Number"]);
  assert.ok(order2["Rompslomp Journal Entry ID"]);
  assert.equal(s.records.find((r) => r.id === "recAAAAAAAAAAAA0001").fields["Bookkeeping Status"], "Cancelled");
  assert.match(job.todos[0], /ING line of € 1323,69/);

  // Again, as after a crash or a second upload: found back, nothing new.
  const again = store.book(samplePdf(), { by: "test" });
  await again.promise;
  assert.equal(again.state, "done", again.error);
  assert.equal(s.invoices.length, 2);
  assert.equal(s.journals.length, 2);
  assert.equal(s.expenses.length, 1);
  assert.equal(s.payments.length, 3);
});

test("a payout with a problem is not booked at all", async () => {
  const s = services();
  s.records.splice(s.records.findIndex((r) => r.id === "recAAAAAAAAAAAA0002"), 1);
  const store = createWoovinPayouts({ airtable: s.airtable, rompslomp: s.rompslomp, pause: async () => {} });

  const job = store.book(samplePdf());
  await job.promise;
  assert.equal(job.state, "failed");
  assert.match(job.error, /Not booked/);
  assert.equal(s.invoices.length + s.expenses.length + s.payments.length, 0);
});

test("the overview: every Woovin bank line, and how far each payout is", async () => {
  const s = services();
  const bank = (id, amount, date, n) => ({ id, amount: String(amount), paid_at: `${date}T00:00:00.000+02:00`, account_path: "activa.liquid_assets.bank_zakelijk_ing_custom", description: `Naam: WOOVIN B.V.Omschrijving: Payout ${n} - UNIONAmsterdam` });
  const lines = [bank(3, 1038.49, "2026-10-01", "7166"), bank(2, 1404.46, "2026-09-28", "7138"), bank(1, 999, "2026-09-20", "7100")];
  s.invoices.push({ id: 7, invoice_number: "KC202609-2432", price_with_vat: "82.0", open_amount: "0.0" });
  s.invoices.push({ id: 8, invoice_number: "KC202609-2433", price_with_vat: "120.0", open_amount: "120.0" });
  const ours = [
    { id: 10, amount: "82.0", paid_at: "2026-09-28T00:00:00.000+02:00", description: "Woovin payout #7138: KC202609-2432 (ORD-023783)" },
    { id: 11, amount: "120.0", paid_at: "2026-09-28T00:00:00.000+02:00", description: "Woovin payout #7138: KC202609-2433 (ORD-023805)" },
    { id: 12, amount: "-1.0", paid_at: "2026-09-20T00:00:00.000+02:00", description: "Woovin payout #7100: kosten payout invoice #7100" }
  ];
  s.rompslomp.read = async (path) => {
    if (/selection=unbooked/.test(path)) return { payments: path.includes("page=1&") ? [lines[0], lines[1]] : [] };
    return { payments: path.includes("page=1&") ? [lines[0], ...ours.slice(0, 2), lines[1], lines[2], ours[2]] : [] };
  };
  const store = createWoovinPayouts({ airtable: s.airtable, rompslomp: s.rompslomp });

  const o = await store.overview();
  assert.deepEqual(o.payouts.map((p) => [p.number, p.status]), [["7100", "done"], ["7138", "bank_line"], ["7166", "to_upload"]]);
  assert.equal(o.next, "7166");
  const p7138 = o.payouts.find((p) => p.number === "7138");
  assert.equal(p7138.bank, 1404.46);
  assert.equal(p7138.settled, 202);
  assert.equal(p7138.open_invoices, 1);
});

test("only Kickz Caviar's company is booked into", () => {
  const s = services();
  const store = createWoovinPayouts({ airtable: s.airtable, rompslomp: { ...s.rompslomp, companyId: "42" } });
  assert.throws(() => store.book(samplePdf()), /company 1296508534 only/);
});

test("the payout PDF is kept under its number, and the overview links it", async () => {
  const s = services();
  const kept = new Map([["7166", Buffer.from("old")]]);
  const files = {
    configured: true,
    async save(number, buffer) { kept.set(String(number), buffer); return `woovin-payouts/payout-invoice-${number}.pdf`; },
    async numbers() { return new Set(kept.keys()); },
    async download(number) { if (!kept.has(String(number))) throw new Error("404"); return kept.get(String(number)); }
  };
  const store = createWoovinPayouts({ airtable: s.airtable, rompslomp: s.rompslomp, files, pause: async () => {} });

  const plan = await store.preview(samplePdf());
  assert.equal(plan.number, "7333");
  assert.ok(kept.has("7333"));
  assert.ok(!plan.warnings.some((w) => /could not be kept/.test(w)));

  const { filename, pdf } = await store.pdf("7333");
  assert.equal(filename, "payout-invoice-7333.pdf");
  assert.deepEqual(pdf, samplePdf());
  await assert.rejects(store.pdf("7400"), /not here/);

  // Booking after the preview no longer asks for the PDF to be attached by hand.
  const job = store.book(samplePdf());
  await job.promise;
  assert.equal(job.state, "done", job.error);
  assert.ok(!job.todos.some((t) => /Attach/.test(t)));

  // A PDF that cannot be kept does not stop the payout.
  const broken = createWoovinPayouts({ airtable: s.airtable, rompslomp: s.rompslomp, files: { ...files, async save() { throw new Error("down"); } }, pause: async () => {} });
  const plan2 = await broken.preview(samplePdf());
  assert.ok(plan2.warnings.some((w) => /could not be kept here \(down\)/.test(w)));
  assert.equal(plan2.bookable, true);
});

import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import {
  contactBody,
  createExternalSalesInvoicing,
  creditInvoiceBody,
  invoicePlanFor,
  journalBody,
  matchContact,
  mentionsDeal,
  pairLines,
  salesInvoiceBody
} from "../admin/externalSalesInvoicing.js";

const sale = (extra = {}) => ({
  id: "s1",
  deal_number: 76,
  buyer_record_id: "recBUYER",
  buyer_uuid: "b1",
  buyer_email: "buyer@example.com",
  buyer_vat_id: "PL7011035218",
  buyer_country_code: "PL",
  payment_status: "pending",
  bookkeeping_status: "to_invoice",
  total_selling_price: "175.00",
  ...extra
});

const pair = (extra = {}) => ({
  id: `p${Math.random()}`,
  item_id: "PCS-006155",
  sku: "JR9632",
  size: "43 1/3",
  purchase_vat_type: "Margin",
  purchase_price_ex_vat: "150.00",
  selling_vat_type: "Margin",
  selling_price: null,
  ...extra
});

/* ---------------- plan ---------------- */

test("one VAT type: one invoice for the deal total", () => {
  const plan = invoicePlanFor(sale(), [pair()]);
  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.deepEqual(plan.invoices.map((i) => [i.route, i.amount, i.purchase]), [["Margin", 175, 150]]);
});

test("margin and VAT on one deal: two invoices, and only with a price per pair", () => {
  const pairs = [pair(), pair({ sku: "IF1787-100", purchase_vat_type: "VAT21", purchase_price_ex_vat: "100.00", selling_vat_type: "VAT0" })];

  const unpriced = invoicePlanFor(sale({ total_selling_price: "300.00" }), pairs);
  assert.equal(unpriced.ok, false);
  assert.match(unpriced.problems.join(" "), /selling price of every pair/);

  pairs[0].selling_price = "170.00";
  pairs[1].selling_price = "130.00";
  const priced = invoicePlanFor(sale({ total_selling_price: "300.00" }), pairs);
  assert.equal(priced.ok, true, priced.problems.join(" "));
  assert.deepEqual(priced.invoices.map((i) => [i.route, i.amount, i.purchase]), [["Margin", 170, 150], ["VAT0", 130, 100]]);

  pairs[1].selling_price = "120.00";
  assert.match(invoicePlanFor(sale({ total_selling_price: "300.00" }), pairs).problems.join(" "), /add up to €290.00/);
});

test("everything that blocks an invoice is said at once", () => {
  const plan = invoicePlanFor(
    sale({ bookkeeping_status: "invoiced", buyer_record_id: null, buyer_vat_id: "" }),
    [pair({ purchase_vat_type: null, purchase_price_ex_vat: 0, selling_vat_type: "VAT0" })]
  );
  const all = plan.problems.join(" | ");
  assert.match(all, /"invoiced", not "to invoice"/);
  assert.match(all, /no buyer/);
  assert.match(all, /no purchase VAT type/);
  assert.match(all, /no purchase price/);
  assert.match(all, /reverse-charge.*VAT ID/);
});

/* ---------------- bodies ---------------- */

test("the invoice looks like the ones made by hand", () => {
  const [inv] = invoicePlanFor(sale(), [pair()]).invoices;
  const body = salesInvoiceBody({ sale: sale(), invoice: inv, contactId: "474787066" }).sales_invoice;

  assert.equal(body.template_id, 322464949, "the margin template");
  assert.equal(body.api_reference, "EXTD-000076-Margin");
  assert.equal(body.vat_number, "PL7011035218");
  assert.equal(body.contact_id, 474787066);
  assert.deepEqual(
    { d: body.invoice_lines[0].description, e: body.invoice_lines[0].extended_description, p: body.invoice_lines[0].price_per_unit, vt: body.invoice_lines[0].vat_type_id },
    { d: "EXTD-000076", e: "JR9632 — Size 43 1/3", p: "175.00", vt: 688369464 }
  );
  assert.equal(body.invoice_lines[0].account_id, undefined, "margin lines take the template's account");
});

test("a 21% invoice sends its price excl. VAT, on the cent", () => {
  const [inv] = invoicePlanFor(sale({ total_selling_price: "230.00" }), [pair({ purchase_vat_type: "VAT21", selling_vat_type: "VAT21" })]).invoices;
  const line = salesInvoiceBody({ sale: sale(), invoice: inv, contactId: 1 }).sales_invoice.invoice_lines[0];
  assert.equal(line.price_per_unit, "190.08264");
  assert.equal(Math.round(Number(line.price_per_unit) * 1.21 * 100) / 100, 230);
  assert.equal(line.account_id, 589136361);
  assert.equal(line.vat_type_id, 701184043);
});

test("pairs are listed per SKU, with their prices when known", () => {
  const pairs = [
    pair({ sku: "FD0884-025", size: "38", selling_price: "88" }),
    pair({ sku: "FD0884-025", size: "38.5", selling_price: "88" }),
    pair({ sku: "IF3219", size: "42 2/3", selling_price: "160" })
  ];
  assert.equal(pairLines(pairs, true), "FD0884-025 — Sizes 38, 38.5 — 2 pairs × €88 = €176\nIF3219 — Size 42 2/3 — 1 pair × €160 = €160");
  assert.equal(pairLines(pairs, false), "FD0884-025 — Sizes 38, 38.5\nIF3219 — Size 42 2/3");
});

test("the journal moves the purchase from stock to cost, and a credit moves it back", () => {
  const margin = journalBody({ route: "Margin", invoiceNumber: "KC202609-2200", date: "2026-09-22", amount: 150 }).journal_entry;
  assert.equal(margin.description, "Voorraadcorrectie KC202609-2200");
  assert.deepEqual(margin.lines.map((l) => [l.account_id, l.debit_amount, l.credit_amount]), [[1537847149, "150.00", null], [1981496874, null, "150.00"]]);

  const vat = journalBody({ route: "VAT21", invoiceNumber: "KC1", date: "2026-09-22", amount: 100, reverse: true }).journal_entry;
  assert.deepEqual(vat.lines.map((l) => [l.account_id, l.debit_amount, l.credit_amount]), [[1981496874, "100.00", null], [306471935, null, "100.00"]]);
});

test("a credit invoice is the same invoice, negative", () => {
  const body = creditInvoiceBody({
    original: { invoice_number: "KC202609-2200", contact_id: 5, template_id: 322464949, vat_number: "PL1", invoice_lines: [{ description: "EXTD-000076", extended_description: "JR9632 — Size 43", price_per_unit: "175.0", quantity: "1.0", vat_type_id: 688369464 }] },
    reference: "credit-99"
  }).sales_invoice;
  assert.equal(body.description, "Creditfactuur voor factuur: KC202609-2200");
  assert.equal(body.invoice_lines[0].price_per_unit, "-175.00000");
  assert.equal(body.invoice_lines[0].description, "Credit: EXTD-000076");
  assert.equal(body.api_reference, "credit-99");
});

test("a contact is matched on VAT number or exact name, never on part of a name", () => {
  const contacts = [{ id: 1, company_name: "F1rst Kicks Amsterdam", vat_number: "" }, { id: 2, company_name: "Other", vat_number: "NL 8617 94461B01" }];
  assert.equal(matchContact(contacts, { vat_id: "NL861794461B01", company_name: "F1rst Kicks" })?.id, 2);
  assert.equal(matchContact(contacts, { company_name: "F1rst Kicks" }), null);
  assert.equal(matchContact(contacts, { company_name: "f1rst kicks amsterdam" })?.id, 1);
});

test("a private buyer becomes an individual contact", () => {
  const body = contactBody({ buyer_number: 23, full_name: "Lian Gietermans", address: "Straat 1", address_line2: "bus 2", zipcode: "1234AB", city: "Utrecht", country_code: "nl", email: "l@x.nl" }).contact;
  assert.equal(body.contact_number, "BU-00023", "the Buyer ID is the customer number");
  assert.equal(body.is_individual, true);
  assert.equal(body.contact_person_name, "Lian Gietermans");
  assert.equal(body.address, "Straat 1, bus 2");
  assert.equal(body.country_code, "NL");
});

/* ---------------- the whole run ---------------- */

function fakeRompslomp({ totalOverride = null } = {}) {
  const invoices = new Map();
  const calls = { created: 0, journals: [], contacts: 0 };
  let n = 2200;

  return {
    calls,
    invoices,
    configured: true,
    async searchContacts() { return []; },
    async getContact(id) { return id === "474787066" ? { id: 474787066 } : null; },
    async createContact(body) { calls.contacts += 1; return { id: 999, ...body.contact }; },
    async findInvoice(reference) { return [...invoices.values()].find((i) => i.api_reference === reference) || null; },
    async getInvoice(id) { return invoices.get(String(id)); },
    async createInvoice(body) {
      calls.created += 1;
      const b = body.sales_invoice;
      const line = b.invoice_lines[0];
      const incl = line.vat_type_id === 701184043 ? Number(line.price_per_unit) * 1.21 : Number(line.price_per_unit);
      const inv = { ...b, id: 5000 + calls.created, status: "concept", invoice_number: null, date: "2026-09-22", price_with_vat: String(totalOverride ?? Math.round(incl * 100) / 100) };
      invoices.set(String(inv.id), inv);
      return inv;
    },
    async publishInvoice(id) {
      const inv = invoices.get(String(id));
      Object.assign(inv, { status: "published", invoice_number: `KC202609-${n++}` });
      return inv;
    },
    async createJournal(body) { calls.journals.push(body.journal_entry); return { id: 7000 + calls.journals.length, description: body.journal_entry.description }; },
    async invoicesOfContact(contactId) { return [...invoices.values()].filter((i) => String(i.contact_id) === String(contactId)); },
    async recentJournals() { return calls.journals.map((j, i) => ({ id: 7001 + i, description: j.description })); },
    async pdf() { return Buffer.from("%PDF-1.4"); }
  };
}

const fakeAirtableBuyers = (buyer) => {
  const updates = [];
  return {
    updates,
    async byIds() { return new Map([["recBUYER", buyer]]); },
    async update(table, id, fields) { updates.push(fields); Object.assign(buyer, fields); return { fields: buyer }; }
  };
};

test("invoicing a deal: invoice, journal, contact remembered, mail - and never twice", async () => {
  const db = fakeDb({
    external_sales: [sale()],
    external_sale_pairs: [pair({ sale_id: "s1" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 84, company_name: "Grail Point sp. z o.o.", vat_id: "PL7011035218", address: "ul. 1", zipcode: "00-001", city: "Warsaw", country_code: "PL", rompslomp_contact_id: null }]
  });
  const rompslomp = fakeRompslomp();
  const airtable = fakeAirtableBuyers({});
  const mails = [];
  const invoicing = createExternalSalesInvoicing({ db, airtable, rompslomp, sendMail: async (m) => mails.push(m) });

  const out = await invoicing.invoice("s1");

  assert.equal(rompslomp.calls.created, 1);
  assert.equal(rompslomp.calls.contacts, 1, "no contact found: a new one");
  assert.equal(db.tables.buyers[0].rompslomp_contact_id, "999", "remembered on the buyer");
  assert.deepEqual(airtable.updates, [], "Airtable is not written");
  assert.equal(rompslomp.calls.journals.length, 1);
  assert.equal(rompslomp.calls.journals[0].description, "Voorraadcorrectie KC202609-2200");
  assert.equal(rompslomp.calls.journals[0].lines[0].debit_amount, "150.00");
  assert.equal(db.tables.external_sales[0].bookkeeping_status, "invoiced");
  assert.equal(db.tables.external_sale_invoices[0].journal_entry_id, "7001");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "buyer@example.com");
  assert.equal(mails[0].attachments[0].filename, "Invoice KC202609-2200.pdf");
  assert.ok(db.tables.external_sale_invoices[0].sent_at);
  assert.ok(out.log.some((l) => l.startsWith("Invoice KC202609-2200")));

  // Invoiced now: a second click is refused, nothing new in Rompslomp.
  await assert.rejects(invoicing.invoice("s1"), /not "to invoice"/);
  assert.equal(rompslomp.calls.created, 1);
});

test("a run that stopped half-way carries on without a second invoice", async () => {
  const db = fakeDb({
    external_sales: [sale()],
    external_sale_pairs: [pair({ sale_id: "s1" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });
  const rompslomp = fakeRompslomp();
  // Made in Rompslomp by an earlier run that died before saving anything.
  await rompslomp.createInvoice({ sales_invoice: { api_reference: "EXTD-000076-Margin", invoice_lines: [{ price_per_unit: "175.00", vat_type_id: 688369464 }] } });

  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => {} });
  await invoicing.invoice("s1", { mail: false });

  assert.equal(rompslomp.calls.created, 1, "found back by its api_reference");
  assert.equal(db.tables.external_sale_invoices.length, 1);
  assert.equal(rompslomp.calls.journals.length, 1);
});

test("a total that comes out different stops before the journal", async () => {
  const db = fakeDb({
    external_sales: [sale()],
    external_sale_pairs: [pair({ sale_id: "s1" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });
  const rompslomp = fakeRompslomp({ totalOverride: 174.99 + 0.5 });
  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => {} });

  await assert.rejects(invoicing.invoice("s1"), /came out at/);
  assert.equal(db.tables.external_sale_invoices.length, 1, "the invoice is on the deal, so Checks shows it");
  assert.equal(rompslomp.calls.journals.length, 0);
  assert.equal(db.tables.external_sales[0].bookkeeping_status, "to_invoice");
});

test("crediting books a negative invoice and the purchase back into stock", async () => {
  const db = fakeDb({
    external_sales: [sale()],
    external_sale_pairs: [pair({ sale_id: "s1" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });
  const rompslomp = fakeRompslomp();
  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => {} });
  await invoicing.invoice("s1", { mail: false });

  const original = db.tables.external_sale_invoices[0];
  const out = await invoicing.credit("s1", original.id);

  const creditRow = db.tables.external_sale_invoices.find((i) => i.kind === "credit");
  assert.equal(creditRow.credits_invoice_id, original.id);
  assert.equal(out.of, original.invoice_number);
  assert.equal(rompslomp.calls.journals.at(-1).lines[0].account_id, 1981496874, "stock debited again");
  assert.equal(db.tables.external_sales[0].bookkeeping_status, "credited");

  // A second credit of the same invoice makes nothing new.
  await invoicing.credit("s1", original.id);
  assert.equal(db.tables.external_sale_invoices.filter((i) => i.kind === "credit").length, 1);
  assert.equal(rompslomp.calls.created, 2);
});

test("a credit puts back only what its own invoice took out", async () => {
  const db = fakeDb({
    external_sales: [sale({ total_selling_price: "300.00" })],
    external_sale_pairs: [
      // One pair was cancelled earlier and credited with its own invoice.
      pair({ id: "p1", sale_id: "s1", purchase_price_ex_vat: "200.00", cancelled_at: "2026-09-23T10:00:00Z" }),
      pair({ id: "p2", sale_id: "s1", purchase_price_ex_vat: "100.00", cancelled_at: null })
    ],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });

  const rompslomp = fakeRompslomp();
  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => {} });
  await invoicing.invoice("s1", { mail: false });
  await invoicing.credit("s1", db.tables.external_sale_invoices[0].id);

  const reversal = rompslomp.calls.journals.at(-1);
  assert.equal(reversal.lines[0].debit_amount, "100.00", "the cancelled pair is not put back a second time");
});

test("an invoice made by hand is found, not made again, and can be linked", async () => {
  const db = fakeDb({
    external_sales: [sale({ deal_number: 66, total_selling_price: "150.00" })],
    external_sale_pairs: [pair({ sale_id: "s1", purchase_price_ex_vat: "134.00" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });
  const rompslomp = fakeRompslomp();
  const hand = await rompslomp.createInvoice({ sales_invoice: { contact_id: 474787066, api_reference: null, invoice_lines: [{ description: "EXTD-000066", extended_description: "1203A537-106 - 39", price_per_unit: "150.0", vat_type_id: 688369464 }] } });
  await rompslomp.publishInvoice(hand.id);
  hand.published_at = "2026-09-21T10:00:00+02:00";

  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => assert.fail("no mail") });

  const preview = await invoicing.preview("s1");
  assert.equal(preview.ok, false);
  assert.deepEqual(preview.hand_made.map((h) => h.invoice_number), ["KC202609-2200"]);

  await assert.rejects(invoicing.invoice("s1"), /already on KC202609-2200/);
  assert.equal(rompslomp.calls.created, 1, "nothing new made");

  const out = await invoicing.link("s1", String(hand.id));
  assert.match(out.log[0], /Linked KC202609-2200 \(Margin, €150.00\)/);
  assert.equal(db.tables.external_sales[0].bookkeeping_status, "invoiced");
  assert.equal(rompslomp.calls.journals[0].description, "Voorraadcorrectie KC202609-2200");
  assert.equal(rompslomp.calls.journals[0].lines[0].debit_amount, "134.00");
  assert.equal(db.tables.external_sale_invoices[0].sent_at, "2026-09-21T10:00:00+02:00");

  await assert.rejects(invoicing.link("s1", String(hand.id)), /already on this deal/);
});

test("a journal that already exists is taken over, not made twice", async () => {
  const db = fakeDb({
    external_sales: [sale()],
    external_sale_pairs: [pair({ sale_id: "s1" })],
    external_sale_invoices: [],
    external_sale_invoice_deals: [],
    buyers: [{ id: "b1", buyer_number: 22, company_name: "DPX Capital s.r.o.", rompslomp_contact_id: "474787066" }]
  });
  const rompslomp = fakeRompslomp();
  rompslomp.calls.journals.push({ description: "Voorraadcorrectie KC202609-2200", lines: [] });
  const invoicing = createExternalSalesInvoicing({ db, airtable: fakeAirtableBuyers({ "Rompslomp Contact ID": "474787066" }), rompslomp, sendMail: async () => {} });

  const out = await invoicing.invoice("s1", { mail: false });
  assert.equal(rompslomp.calls.journals.length, 1);
  assert.ok(out.log.some((l) => /already there, taken over/.test(l)));
});

test("the deal number is found as a whole word only", () => {
  assert.equal(mentionsDeal({ invoice_lines: [{ description: "EXTD-000066" }] }, "EXTD-000066"), true);
  assert.equal(mentionsDeal({ description: "", invoice_lines: [{ extended_description: "EXTD-0000661" }] }, "EXTD-000066"), false);
});

test("the mail comes from noreply and points questions to info@", async () => {
  const { invoiceMail } = await import("../admin/externalSalesInvoicing.js");
  const m = invoiceMail({ sale: sale({ buyer_company: "Grail Point" }), invoices: [{ invoice_number: "KC1" }], to: "b@x.pl", from: "noreply@kickzcaviar.nl", replyTo: "info@kickzcaviar.nl", pdfs: ["x"] });
  assert.equal(m.from.email, "noreply@kickzcaviar.nl");
  assert.equal(m.replyTo, "info@kickzcaviar.nl");
  assert.match(m.text, /email us at info@kickzcaviar.nl/);
});

test("every invoice is due in 7 days, dated in Dutch time", async () => {
  const { invoiceDates } = await import("../admin/externalSalesInvoicing.js");
  assert.deepEqual(invoiceDates(new Date("2026-09-22T10:00:00Z")), { date: "2026-09-22", due_date: "2026-09-29" });
  // 23:30 UTC on the 30th is already 1 October in Amsterdam.
  assert.deepEqual(invoiceDates(new Date("2026-09-30T23:30:00Z")), { date: "2026-10-01", due_date: "2026-10-08" });
  const [inv] = invoicePlanFor(sale(), [pair()]).invoices;
  const body = salesInvoiceBody({ sale: sale(), invoice: inv, contactId: 1, now: new Date("2026-12-28T09:00:00Z") }).sales_invoice;
  assert.equal(body.date, "2026-12-28");
  assert.equal(body.due_date, "2027-01-04");
});

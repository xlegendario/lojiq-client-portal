import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import {
  createForwardInvoicing,
  forwardInvoiceBody,
  forwardInvoiceLine,
  forwardInvoiceMoney,
  invoiceReference
} from "../partner/forwardInvoicing.js";

const forward = { id: "fw1", forwarding_number: 40, unit_forwarding_fee: 2, shipping_costs: 0 };
const pair = (size, fee = null) => ({ id: `p${size}${Math.random()}`, sku: "U9060ECA", size, product_name: "New Balance 9060", forwarding_fee: fee, forwarding_log_id: "fw1" });

test("the partner gets the total minus the forwarding fee of every pair", () => {
  assert.deepEqual(forwardInvoiceMoney({ forward, pairs: [pair("40"), pair("41", 5)], pricePerPair: 120 }), { total: 240, fee: 7, purchase: 233 });
});

test("the invoice is a margin invoice with the forward number and the sizes counted", () => {
  const body = forwardInvoiceBody({ forward, pairs: [pair("40"), pair("40"), pair("38.5")], pricePerPair: 120, contactId: "61", now: new Date("2026-10-11T10:00:00Z") });
  const invoice = body.sales_invoice;

  assert.equal(invoice.api_reference, "FWD-000040-Margin");
  assert.equal(invoice.template_id, 322464949);
  assert.equal(invoice.contact_id, 61);
  assert.equal(invoice.invoice_lines[0].description, "FWD-000040");
  assert.equal(invoice.invoice_lines[0].price_per_unit, "360.00");
  assert.equal(invoice.invoice_lines[0].vat_type_id, 688369464);
  assert.equal(invoice.due_date, "2026-10-18");
  assert.equal(forwardInvoiceLine([pair("40"), pair("40"), pair("38.5")], 120), "U9060ECA New Balance 9060 — Sizes 38.5, 40 ×2 — 3 pairs × €120.00 = €360.00");
  assert.equal(invoiceReference(forward), "FWD-000040-Margin");
});

function setup({ failAt = null } = {}) {
  const db = fakeDb({
    forwarding_log: [{ ...forward, payment_status: "pending" }],
    partner_stock: [pair("40"), pair("40")],
    buyers: [{ id: "b1", buyer_number: 102, company_name: "Kicks Berlin GmbH", email: "lena@kb.test", address: "Torstr 5", zipcode: "10119", city: "Berlin", country_code: "DE" }],
    forward_invoices: []
  });
  const calls = [];
  const fail = (step) => {
    if (failAt === step) {
      failAt = null;
      throw new Error(`${step} is down`);
    }
  };

  const rompslomp = {
    configured: true,
    async getContact() { return null; },
    async searchContacts() { return []; },
    async createContact(body) { calls.push(["contact", body.contact.contact_number]); return { id: 61 }; },
    async findInvoice() { return null; },
    async createInvoice(body) { fail("invoice"); calls.push(["invoice", body.sales_invoice.invoice_lines[0].price_per_unit]); return { id: 70, status: "concept" }; },
    async publishInvoice(id) { return { id, status: "published", invoice_number: "KC202610-2301", date: "2026-10-11", price_with_vat: "240.0" }; },
    async recentJournals() { return []; },
    async createJournal(body) { calls.push(["journal", body.journal_entry.lines[0].debit_amount]); return { id: 80 }; },
    async getInvoice() { return { payment_status: "paid" }; },
    async pdf() { return Buffer.from("%PDF"); }
  };
  const purchases = {
    async book({ unit, deal }) { fail("purchase"); calls.push(["expense", unit.price, deal]); return { expense_id: "90", expense_number: "UITG-1", company_id: "2" }; }
  };
  const mails = [];

  const invoicing = createForwardInvoicing({
    db,
    rompslomp,
    purchases,
    sellerOf: async () => ({ seller_id: "SE-00781" }),
    sendMail: async (message) => mails.push(message)
  });

  return { db, calls, mails, invoicing };
}

const partner = { sellerRecordId: "recJIMMY", sellerId: "SE-00781" };

test("an invoiced forward: contact, invoice, stock correction, purchase, fee settled, mail", async () => {
  const { db, calls, mails, invoicing } = setup();
  const pairs = db.tables.partner_stock;

  const row = await invoicing.open({ forward, pairs, partner, buyerId: "b1", pricePerPair: 120 });
  assert.equal(row.status, "to_invoice");
  assert.equal(Number(row.purchase_total), 236);

  const done = await invoicing.run(row.id);

  assert.equal(done.status, "invoiced");
  assert.deepEqual(calls, [["contact", "BU-00102"], ["invoice", "240.00"], ["journal", "236.00"], ["expense", 236, "FWD-000040"]]);
  assert.equal(db.tables.forwarding_log[0].payment_status, "paid");
  assert.match(db.tables.forwarding_log[0].payment_note, /KC202610-2301/);
  assert.equal(db.tables.buyers[0].rompslomp_contact_id, "61");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "lena@kb.test");
});

test("a run that fails halfway carries on from there, nothing twice", async () => {
  const { db, calls, invoicing } = setup({ failAt: "purchase" });
  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b1", pricePerPair: 120 });

  await assert.rejects(invoicing.run(row.id));
  const failed = db.tables.forward_invoices[0];
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /^purchase:/);
  assert.equal(failed.invoice_number, "KC202610-2301");

  await invoicing.run(row.id);
  assert.equal(db.tables.forward_invoices[0].status, "invoiced");
  assert.equal(calls.filter(([what]) => what === "invoice").length, 1);
  assert.equal(calls.filter(([what]) => what === "journal").length, 1);
  assert.equal(calls.filter(([what]) => what === "expense").length, 1);
});

test("an invoice on hold is not run", async () => {
  const { db, calls, invoicing } = setup();
  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b1", pricePerPair: 120, hold: { id: "b0" } });

  assert.equal(row.status, "on_hold");
  assert.equal(row.possible_duplicate_of, "b0");
  await invoicing.run(row.id);
  assert.equal(calls.length, 0);
});

test("once the buyer paid, the partner's money becomes payable", async () => {
  const { db, invoicing } = setup();
  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b1", pricePerPair: 120 });
  await invoicing.run(row.id);

  // The fake only understands eq/in filters; the sweep's other filters are
  // dropped, which is enough to see what it does with a paid invoice.
  await invoicing.sweep();

  const after = db.tables.forward_invoices[0];
  assert.equal(after.buyer_payment_status, "paid");
  assert.equal(after.partner_payout_status, "to_pay");
});

function fakeBuyers(db) {
  const done = [];
  return {
    done,
    async link(seller, id) { done.push(["link", id]); db.tables.partner_buyers.push({ seller_record_id: seller, buyer_id: id }); },
    async markChecked(seller, id) { done.push(["checked", id]); }
  };
}

test("same buyer: the invoice goes to the buyer we had, the look-alike is dropped", async () => {
  const { db, calls, invoicing } = setup();
  db.tables.buyers.push({ id: "b-look", company_name: "Kicks-Berlin", email: "x@kb.test", rompslomp_contact_id: null });
  db.tables.partner_buyers = [{ seller_record_id: "recJIMMY", buyer_id: "b-look" }];
  const buyers = fakeBuyers(db);

  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b-look", pricePerPair: 120, hold: { id: "b1" } });
  const done = await invoicing.resolveHold(row.id, true, { buyers });

  assert.equal(done.status, "invoiced");
  assert.equal(done.buyer_id, "b1");
  assert.deepEqual(buyers.done, [["link", "b1"], ["checked", "b1"]]);
  assert.equal(db.tables.buyers.some((b) => b.id === "b-look"), false);
  assert.equal(db.tables.forwarding_log[0].buyer_id, "BU-00102");
  assert.equal(calls[0][1], "BU-00102", "the contact is the kept buyer's");
});

test("different buyer: the new buyer stays and is never asked about again", async () => {
  const { db, invoicing } = setup();
  const buyers = fakeBuyers(db);

  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b1", pricePerPair: 120, hold: { id: "b0" } });
  const done = await invoicing.resolveHold(row.id, false, { buyers });

  assert.equal(done.status, "invoiced");
  assert.equal(done.buyer_id, "b1");
  assert.deepEqual(buyers.done, [["checked", "b1"]]);
});

test("the partner can only be marked paid once the buyer paid", async () => {
  const { db, invoicing } = setup();
  const row = await invoicing.open({ forward, pairs: db.tables.partner_stock, partner, buyerId: "b1", pricePerPair: 120 });
  await invoicing.run(row.id);

  await assert.rejects(invoicing.setPartnerPaid(row.id, true), /not paid yet/);

  await invoicing.sweep();
  const paid = await invoicing.setPartnerPaid(row.id, true, "ING 11-10");
  assert.equal(paid.partner_payout_status, "paid");
  assert.equal(paid.partner_paid_note, "ING 11-10");

  const back = await invoicing.setPartnerPaid(row.id, false);
  assert.equal(back.partner_payout_status, "to_pay");
});

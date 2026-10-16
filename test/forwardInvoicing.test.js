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

function setup({ failAt = null, priceWithVat = "240.0" } = {}) {
  const db = fakeDb({
    forwarding_log: [{ ...forward, payment_status: "pending" }],
    partner_stock: [pair("40"), pair("40")],
    buyers: [{ id: "b1", buyer_number: 102, company_name: "Kicks Berlin GmbH", email: "lena@kb.test", address: "Torstr 5", zipcode: "10119", city: "Berlin", country_code: "DE" }],
    forward_invoices: []
  });
  const calls = [];
  const bodies = [];
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
    async createInvoice(body) { fail("invoice"); calls.push(["invoice", body.sales_invoice.invoice_lines[0].price_per_unit]); bodies.push(body); return { id: 70, status: "concept" }; },
    async publishInvoice(id) { return { id, status: "published", invoice_number: "KC202610-2301", date: "2026-10-11", price_with_vat: priceWithVat }; },
    async recentJournals() { return []; },
    async createJournal(body) { calls.push(["journal", body.journal_entry.lines[0].debit_amount]); return { id: 80 }; },
    async getInvoice() { return { payment_status: "paid" }; },
    async invoiceByNumber(number) {
      return number === "KC202610-2234"
        ? { id: 714238889, invoice_number: "KC202610-2234", date: "2026-10-13", published_at: "2026-10-13T09:00:00Z", price_with_vat: "1675.0", contact_id: 1802742576, invoice_lines: [{ description: "JXT-00002", extended_description: "U9060PB 1x 36", price_per_unit: "1675.0", quantity: "1.0" }] }
        : null;
    },
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

  return { db, calls, bodies, mails, invoicing };
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


/* ---------------- external invoices (JXT) ---------------- */

function externalSetup(options = {}) {
  const made = setup({ priceWithVat: "300.0", ...options });
  const { db } = made;
  Object.assign(db.tables.forwarding_log[0], { seller_record_id: "recJIMMY", shipping_status: "shipped", forwarding_date: "2026-10-01" });
  db.tables.partner_labels = [
    { id: "l1", label_number: 2, carrier: "DPD", price: "7.50", payment_status: "pending", status: "created", seller_record_id: "recJIMMY", created_at: "2026-10-15T10:00:00Z" },
    { id: "l2", label_number: 3, carrier: "UPS", price: null, payment_status: "pending", status: "created", seller_record_id: "recJIMMY", created_at: "2026-10-15T10:00:00Z" }
  ];
  return made;
}

const jxtLines = [{ sku: "dd1391-100", name: "Nike Dunk Low Panda", sizes: "40, 41", qty: 2, price_per_pair: "150" }];

test("open fees: his unpaid forwards at what Finance asks, and his priced labels", async () => {
  const { invoicing } = externalSetup();
  const fees = await invoicing.openFees("recJIMMY");

  assert.deepEqual(fees.forwards.map((f) => [f.name, f.amount]), [["FWD-000040", 4]]);
  assert.deepEqual(fees.labels.map((l) => [l.name, l.amount]), [["LBL-000002", 7.5]], "a label without a price is not owed yet");
});

test("a JXT invoice: own lines, the ticked fees settled, the partner gets the rest", async () => {
  const { db, calls, bodies, mails, invoicing } = externalSetup();

  const row = await invoicing.openExternal({ partner, buyerId: "b1", lines: jxtLines, settleForwardIds: ["fw1"], settleLabelIds: ["l1"] });
  assert.equal(row.kind, "external");
  assert.equal(row.jxt_number, 4, "the numbers made by hand end at JXT-00003");
  assert.equal(row.forwarding_log_id, null);
  assert.equal(Number(row.total), 300);
  assert.equal(Number(row.fee_total), 11.5);
  assert.equal(Number(row.purchase_total), 288.5);
  assert.deepEqual(row.settled_items.map((item) => [item.name, item.amount]), [["FWD-000040", 4], ["LBL-000002", 7.5]]);

  const done = await invoicing.run(row.id);
  assert.equal(done.status, "invoiced");

  const invoice = bodies[0].sales_invoice;
  assert.equal(invoice.api_reference, "JXT-00004-Margin");
  assert.equal(invoice.invoice_lines[0].description, "JXT-00004");
  assert.equal(invoice.invoice_lines[0].extended_description, "DD1391-100 Nike Dunk Low Panda — Sizes 40, 41 — 2 pairs × €150.00 = €300.00");
  assert.deepEqual(calls.filter(([what]) => what === "journal" || what === "expense"), [["journal", "288.50"], ["expense", 288.5, "JXT-00004"]]);

  assert.equal(db.tables.forwarding_log[0].payment_status, "paid");
  assert.match(db.tables.forwarding_log[0].payment_note, /Settled in JXT-00004/);
  assert.equal(db.tables.partner_labels.find((l) => l.id === "l1").payment_status, "paid");
  assert.equal(db.tables.partner_labels.find((l) => l.id === "l2").payment_status, "pending");
  assert.match(mails[0].subject, /for JXT-00004$/);
});

test("JXT numbers go on from the last one", async () => {
  const { db, invoicing } = externalSetup();
  db.tables.forward_invoices.push({ id: "old", kind: "external", jxt_number: 7, status: "invoiced", seller_record_id: "recJIMMY", settled_forward_ids: [], settled_label_ids: [] });

  const row = await invoicing.openExternal({ partner, buyerId: "b1", lines: jxtLines });
  assert.equal(row.jxt_number, 8);
  assert.equal(Number(row.fee_total), 0);
});

test("a JXT invoice refuses fees that are not open, or that eat the whole invoice", async () => {
  const { invoicing } = externalSetup();

  await assert.rejects(invoicing.openExternal({ partner, buyerId: "b1", lines: jxtLines, settleLabelIds: ["l2"] }), /not open any more/);
  await assert.rejects(
    invoicing.openExternal({ partner, buyerId: "b1", lines: [{ sku: "X", qty: 1, price_per_pair: 10 }], settleForwardIds: ["fw1"], settleLabelIds: ["l1"] }),
    /not less than the invoice/
  );
  await assert.rejects(invoicing.openExternal({ partner, buyerId: "b1", lines: [{ sku: "X", qty: 0, price_per_pair: 10 }] }), /number of pairs/);
});

test("a fee ticked on a JXT invoice still being made is not offered twice", async () => {
  const { invoicing } = externalSetup({ failAt: "invoice" });
  const row = await invoicing.openExternal({ partner, buyerId: "b1", lines: jxtLines, settleForwardIds: ["fw1"] });
  await assert.rejects(invoicing.run(row.id));

  const fees = await invoicing.openFees("recJIMMY");
  assert.deepEqual(fees.forwards, [], "FWD-000040 waits for the failed JXT invoice to be retried");
});

test("a JXT invoice already in Rompslomp: read in, not made or mailed again; purchase, correction and fees booked", async () => {
  const { db, calls, mails, invoicing } = externalSetup();

  await assert.rejects(invoicing.importExternal({ partner, jxtNumber: 2, invoiceNumber: "KC202610-9999" }), /no invoice KC202610-9999/);

  const row = await invoicing.importExternal({ partner, jxtNumber: 2, invoiceNumber: "KC202610-2234", settleForwardIds: ["fw1"] });
  assert.equal(row.jxt_number, 2);
  assert.equal(row.invoice_number, "KC202610-2234");
  assert.equal(Number(row.total), 1675);
  assert.equal(Number(row.purchase_total), 1671);
  assert.equal(row.buyer_id, null, "no buyer of ours has that Rompslomp contact");

  const done = await invoicing.run(row.id);
  assert.equal(done.status, "invoiced");
  assert.deepEqual(calls.map(([what]) => what), ["journal", "expense"], "no contact, no invoice");
  assert.deepEqual(calls.at(-1), ["expense", 1671, "JXT-00002"]);
  assert.equal(mails.length, 0, "Dario sent it himself");
  assert.match(db.tables.forwarding_log[0].payment_note, /Settled in JXT-00002 \(invoice KC202610-2234\)/);

  await assert.rejects(invoicing.importExternal({ partner, jxtNumber: 2, invoiceNumber: "KC202610-2234" }), /JXT-00002 is already here/);
  await assert.rejects(invoicing.importExternal({ partner, jxtNumber: 3, invoiceNumber: "KC202610-2234" }), /already booked here/);
});

test("a forward already marked paid by hand can be settled in a JXT invoice: it stays paid and learns where", async () => {
  const { db, invoicing } = externalSetup();
  db.tables.forwarding_log.push({ id: "fw9", forwarding_number: 36, unit_forwarding_fee: 1, shipping_costs: 0, pair_count: 94, seller_record_id: "recJIMMY", payment_status: "paid", paid_at: "2026-10-16T06:57:12Z", payment_note: null, shipping_status: "shipped" });

  const fees = await invoicing.openFees("recJIMMY");
  assert.deepEqual(fees.paid_by_hand.map((f) => [f.name, f.amount]), [["FWD-000036", 94]]);
  assert.ok(!fees.forwards.some((f) => f.id === "fw9"), "not among the open ones");

  const row = await invoicing.importExternal({ partner, jxtNumber: 2, invoiceNumber: "KC202610-2234", settleForwardIds: ["fw9"] });
  assert.equal(Number(row.fee_total), 94);
  await invoicing.run(row.id);

  const fw = db.tables.forwarding_log.find((f) => f.id === "fw9");
  assert.equal(fw.paid_at, "2026-10-16T06:57:12Z", "its own paid date stays");
  assert.match(fw.payment_note, /Settled in JXT-00002/);
  assert.equal((await invoicing.openFees("recJIMMY")).paid_by_hand.length, 0, "not offered again");
});

test("a label already marked paid by hand can be settled too, and keeps its paid date", async () => {
  const { db, invoicing } = externalSetup();
  Object.assign(db.tables.partner_labels[0], { payment_status: "paid", paid_at: "2026-10-16T06:57:12Z" });

  const fees = await invoicing.openFees("recJIMMY");
  assert.deepEqual(fees.labels_paid_by_hand.map((l) => [l.name, l.amount]), [["LBL-000002", 7.5]]);

  const row = await invoicing.importExternal({ partner, jxtNumber: 2, invoiceNumber: "KC202610-2234", settleLabelIds: ["l1"] });
  assert.equal(Number(row.fee_total), 7.5);
  await invoicing.run(row.id);
  assert.equal(db.tables.partner_labels[0].paid_at, "2026-10-16T06:57:12Z");
  assert.equal((await invoicing.openFees("recJIMMY")).labels_paid_by_hand.length, 0);
});

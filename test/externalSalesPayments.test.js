import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { createExternalSalesPayments, paymentAfter, paymentFromInvoices } from "../admin/externalSalesPayments.js";

const SALE = "11111111-2222-4333-8444-555555555555";
const sale = (extra = {}) => ({ id: SALE, deal_number: 78, total_selling_price: "400.00", payment_status: "pending", bookkeeping_status: "invoiced", paid_amount: null, payment_note: null, ...extra });

test("a manual payment: all of it is paid, less is partly paid, and parts add up", () => {
  assert.deepEqual(paymentAfter(sale(), 400), { payment_status: "paid", paid_amount: 400 });
  assert.deepEqual(paymentAfter(sale(), 150), { payment_status: "partially_paid", paid_amount: 150 });
  assert.deepEqual(paymentAfter(sale({ payment_status: "partially_paid", paid_amount: "150.00" }), 250), { payment_status: "paid", paid_amount: 400 });
  assert.throws(() => paymentAfter(sale(), 0), /amount that came in/);
});

test("Rompslomp decides: paid when every invoice is, partly when money came in", () => {
  assert.deepEqual(paymentFromInvoices(sale(), [{ payment_status: "paid" }, { payment_status: "paid" }]), { payment_status: "paid" });
  assert.deepEqual(paymentFromInvoices(sale(), [{ payment_status: "unpaid", price_with_vat: "400.0", open_amount: "100.0" }]), { payment_status: "partially_paid", paid_amount: 300 });
  assert.equal(paymentFromInvoices(sale(), [{ payment_status: "unpaid", price_with_vat: "400.0", open_amount: "400.0" }]), null);
});

function setup(extra = {}, rompslompInvoices = {}) {
  const db = fakeDb({
    external_sales: [sale(extra)],
    external_sale_invoice_deals: [{ invoice_id: "inv1", sale_id: SALE }],
    external_sale_invoices: [{ id: "inv1", kind: "sale", rompslomp_invoice_id: "R1", invoice_number: "KC1" }]
  });
  const batches = [];
  const airtable = {
    async create(table, fields) { const rec = { id: `recBATCH${batches.length}`, fields: { ...fields, "Batch ID": `PAYB-00012${batches.length}` } }; batches.push(rec); return rec; },
    async update(table, id, fields) { Object.assign(batches.find((b) => b.id === id).fields, fields); return {}; }
  };
  const mollieCalls = [];
  const mollie = async (path, { method = "GET", body } = {}) => {
    mollieCalls.push({ path, method, body });
    if (path === "/payment-links" && method === "POST") return { id: `pl_${mollieCalls.length}`, _links: { paymentLink: { href: `https://paymentlink.mollie.com/${mollieCalls.length}` } } };
    return {};
  };
  const rompslomp = { async getInvoice(id) { return rompslompInvoices[id] || { payment_status: "unpaid", price_with_vat: "400.0", open_amount: "400.0" }; } };
  const payments = createExternalSalesPayments({ db, airtable, rompslomp, mollie, links: { redirectUrl: "https://kickzcaviar.com", webhookUrl: "https://portal/api/mollie/webhook" } });
  return { db, batches, mollieCalls, payments };
}

test("the Rompslomp check marks a paid invoice's deal paid, and leaves the rest", async () => {
  const paid = setup({}, { R1: { payment_status: "paid" } });
  const out = await paid.payments.checkRompslomp();
  assert.deepEqual(out.changed, [{ deal: "EXTD-000078", to: "paid" }]);
  assert.equal(paid.db.tables.external_sales[0].payment_status, "paid");

  const unpaid = setup();
  await unpaid.payments.checkRompslomp();
  assert.equal(unpaid.db.tables.external_sales[0].payment_status, "pending");
  assert.ok(unpaid.db.tables.external_sales[0].payment_checked_at);
});

test("a payment link goes through a Payment Batch, once", async () => {
  const { db, batches, mollieCalls, payments } = setup();
  const first = await payments.paymentLink(SALE);
  assert.equal(first.url, "https://paymentlink.mollie.com/1");
  assert.equal(batches[0].fields["External Deal IDs"], "EXTD-000078");
  assert.equal(batches[0].fields.Amount, 400);
  assert.equal(batches[0].fields["Payment Status"], "Awaiting Payment");
  assert.match(mollieCalls[0].body.description, /EXTD-000078 PAYB-000120/);
  assert.equal(db.tables.external_sales[0].payment_method, "payment_link");

  const again = await payments.paymentLink(SALE);
  assert.equal(again.reused, true, "the same link, not a second one");
  assert.equal(batches.length, 1);

  await payments.paymentLink(SALE, { fresh: true });
  assert.deepEqual(mollieCalls[1], { path: "/payment-links/pl_1", method: "PATCH", body: { archived: true } }, "the old link is switched off");
  assert.equal(batches[0].fields["Payment Status"], "Cancelled");
  assert.equal(batches.length, 2);
});

test("a paid batch marks its deals paid, once", async () => {
  const { db, payments } = setup();
  assert.deepEqual(await payments.settleFromBatch(["EXTD-000078"], { molliePaymentId: "tr_1" }), ["EXTD-000078"]);
  assert.equal(db.tables.external_sales[0].payment_status, "paid");
  assert.match(db.tables.external_sales[0].payment_note, /tr_1/);
  assert.deepEqual(await payments.settleFromBatch(["EXTD-000078"]), [], "already paid: nothing twice");
});

test("mark as paid by hand, with its date and a note", async () => {
  const { db, payments } = setup();
  await payments.markPaid(SALE, { date: "2026-09-20", amount: "150", note: "Cash" });
  assert.equal(db.tables.external_sales[0].payment_status, "partially_paid");
  await payments.markPaid(SALE, { date: "2026-09-21" });
  const row = db.tables.external_sales[0];
  assert.equal(row.payment_status, "paid");
  assert.equal(row.paid_at, "2026-09-21T12:00:00Z");
  assert.match(row.payment_note, /Cash - Part paid: €150.00 on 2026-09-20\nPaid: €250.00 on 2026-09-21/);
});

test("hand-made Mollie links are suggested by open amount, the named deal first", async () => {
  const { matchMolliePayments } = await import("../admin/externalSalesPayments.js");
  const deals = [{ id: "d1", deal_number: 49, total_selling_price: "360.00", payment_status: "pending", sale_date: "2026-07-06", buyer_company: "CONQUER SHOP S.R.L." }];
  const payments = [
    { id: "tr_a", amount: 360, paid_at: "2026-07-01T10:00:00Z", description: "early" },
    { id: "tr_b", amount: 360, paid_at: "2026-07-08T10:00:00Z", description: "Betaling" },
    { id: "tr_c", amount: 360, paid_at: "2026-07-09T10:00:00Z", description: "Conquer shop 2 pairs" },
    { id: "tr_d", amount: 350, paid_at: "2026-07-09T10:00:00Z", description: "Conquer" }
  ];
  const [m] = matchMolliePayments(deals, payments);
  assert.deepEqual(m.candidates.map((c) => [c.id, c.strong]), [["tr_c", true], ["tr_b", false]], "before the sale and other amounts left out");
});

test("linking a Mollie payment makes a paid batch with its payment id, and pays the deal", async () => {
  const { db, batches, payments } = setup();
  const created = [];
  const airtable = {
    async select() { return { records: [], offset: "" }; },
    async create(table, fields) { const rec = { id: "recB", fields: { ...fields, "Batch ID": "PAYB-000130" } }; created.push(rec); return rec; }
  };
  const mollie = async (path) => ({ id: "tr_c", status: "paid", paidAt: "2026-07-09T10:00:00Z", amount: { value: "400.00" }, paymentLinkId: "pl_x" });
  const { createExternalSalesPayments } = await import("../admin/externalSalesPayments.js");
  const p = createExternalSalesPayments({ db, airtable, rompslomp: {}, mollie });
  const out = await p.linkMolliePayment(SALE, "tr_c");
  assert.equal(out.batch, "PAYB-000130");
  assert.deepEqual([created[0].fields["Payment Status"], created[0].fields["Mollie Payment ID"], created[0].fields["External Deal IDs"]], ["Paid", "tr_c", "EXTD-000078"]);
  const row = db.tables.external_sales[0];
  assert.equal(row.payment_status, "paid");
  assert.equal(row.paid_at, "2026-07-09T10:00:00Z");
  assert.equal(row.payment_method, "payment_link");
});

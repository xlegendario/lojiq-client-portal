import test from "node:test";
import assert from "node:assert/strict";

import { cancelPlan, conditionNote, conditionWith, createExternalSalesCancel } from "../admin/externalSalesCancel.js";
import { fakeDb } from "./fakeSupabase.js";

// Rows in Supabase, so ids that look like it.
const S1 = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const SALE = {
  id: S1,
  deal_number: 81,
  buyer_company: "Conquer Shop S.R.L.",
  buyer_name: "Delia Stepan",
  total_selling_price: 600,
  paid_amount: 0,
  refunded_amount: 0,
  payment_status: "pending",
  shipping_status: "shipped",
  bookkeeping_status: "invoiced",
  notes: ""
};

const PAIRS = [
  { id: P1, sale_id: S1, inventory_unit_record_id: "recA", selling_price: 250, purchase_price_ex_vat: 200, selling_vat_type: "Margin", created_at: "2026-09-20T10:00:00Z" },
  { id: P2, sale_id: S1, inventory_unit_record_id: "recB", selling_price: 350, purchase_price_ex_vat: 300, selling_vat_type: "Margin", created_at: "2026-09-20T10:01:00Z" }
];

const INVOICES = [{ id: "i1", kind: "sale", invoice_number: "KC202609-2100", rompslomp_invoice_id: "900", vat_route: "Margin", journal_entry_id: "j1" }];

test("the note says where the pair is, in the buyer's name", () => {
  assert.equal(conditionNote(SALE, "return_expected"), "Need return from Conquer Shop S.R.L.");
  assert.equal(conditionNote(SALE, "stays_with_buyer"), "At Conquer Shop S.R.L.");
  assert.equal(conditionNote(SALE, "never_shipped"), "");
  assert.equal(conditionNote({ buyer_name: "Jan" }, "stays_with_buyer"), "At Jan");
});

test("the note goes in front of what the unit already said, and never twice", () => {
  assert.equal(conditionWith("At Jan", "Small scuff on the toe"), "At Jan - Small scuff on the toe");
  assert.equal(conditionWith("At Jan", ""), "At Jan");
  assert.equal(conditionWith("", "Small scuff"), "Small scuff");
  assert.equal(conditionWith("At Jan", "At Jan - Small scuff"), "At Jan - Small scuff");
});

test("the plan says what is left, what is credited and what has to go back", () => {
  const plan = cancelPlan({ sale: SALE, pairs: PAIRS, pairIds: [P1], invoices: INVOICES });

  assert.equal(plan.ok, true);
  assert.equal(plan.cancelled_value, 250);
  assert.equal(plan.new_total, 350);
  assert.deepEqual(plan.credits, ["KC202609-2100"]);
  assert.equal(plan.reinvoice, true);
  assert.equal(plan.ends_deal, false);
  assert.equal(plan.refund, 0);

  // Paid in full: the difference has to go back.
  const paid = cancelPlan({ sale: { ...SALE, payment_status: "paid" }, pairs: PAIRS, pairIds: [P1], invoices: INVOICES });
  assert.equal(paid.refund, 250);

  // Everything off the deal ends it, and there is nothing left to invoice.
  const all = cancelPlan({ sale: SALE, pairs: PAIRS, pairIds: [P1, P2], invoices: INVOICES });
  assert.equal(all.ends_deal, true);
  assert.equal(all.new_total, 0);
  assert.equal(all.reinvoice, false);
});

test("a deal without a price per pair cannot lose one pair", () => {
  const unpriced = PAIRS.map((pair) => ({ ...pair, selling_price: null }));
  const plan = cancelPlan({ sale: SALE, pairs: unpriced, pairIds: [P1], invoices: [] });

  assert.equal(plan.ok, false);
  assert.match(plan.problems.join(" "), /price per pair/);

  assert.equal(cancelPlan({ sale: SALE, pairs: PAIRS, pairIds: [], invoices: [] }).ok, false);
});

function fakes({ sale = SALE, pairs = PAIRS, invoices = INVOICES } = {}) {
  const db = fakeDb({
    external_sales: [{ ...sale }],
    external_sale_pairs: pairs.map((pair) => ({ ...pair })),
    external_sale_invoices: invoices.map((invoice) => ({ ...invoice })),
    external_sale_invoice_deals: invoices.map((invoice) => ({ invoice_id: invoice.id, sale_id: sale.id }))
  });

  const units = new Map([["recA", { "Item Condition": "Box damaged" }], ["recB", {}]]);
  const written = [];

  const airtable = {
    byIds: async (_table, ids) => new Map(ids.map((id) => [id, units.get(id) || {}])),
    update: async (_table, id, fields) => { written.push({ id, fields }); return { id, fields }; }
  };

  const calls = [];
  const invoicing = {
    credit: async (saleId, invoiceId) => { calls.push(["credit", invoiceId]); return { credit: "KC202609-2101", of: "KC202609-2100" }; },
    invoice: async (saleId) => { calls.push(["invoice", saleId]); return { invoices: [{ invoice_number: "KC202609-2102" }] }; }
  };

  return { db, written, calls, cancel: createExternalSalesCancel({ db, airtable, invoicing }) };
}

test("cancelling one pair credits, re-invoices, frees the unit and asks for the refund", async () => {
  const { db, written, calls, cancel } = fakes({ sale: { ...SALE, payment_status: "paid", paid_amount: 600 } });

  const out = await cancel.cancelPairs(S1, { pair_ids: [P1], reason: "Wrong size sent", outcome: "return_expected", by: "Dario" });

  assert.equal(out.cancelled, 1);
  assert.equal(out.refund, 250);
  assert.deepEqual(calls, [["credit", "i1"], ["invoice", S1]]);

  const pair = db.tables.external_sale_pairs.find((p) => p.id === P1);
  assert.ok(pair.cancelled_at);
  assert.equal(pair.cancel_outcome, "return_expected");
  assert.equal(pair.cancel_reason, "Wrong size sent");

  const deal = db.tables.external_sales[0];
  assert.equal(deal.total_selling_price, 350);
  assert.equal(deal.bookkeeping_status, "to_invoice");
  // Paid more than the deal is now worth: open again until the money is back.
  assert.equal(deal.payment_status, "partially_paid");
  assert.match(deal.notes, /1 pair cancelled by Dario: Wrong size sent \(return expected\)/);

  // The unit goes back to stock with the note in front of what it said.
  assert.deepEqual(written, [{
    id: "recA",
    fields: { "Availability Status": "Available", "External Deal ID": "", "Item Condition": "Need return from Conquer Shop S.R.L. - Box damaged" }
  }]);
});

test("a pair the buyer keeps is Sold, and the last pair ends the deal", async () => {
  const { db, written, calls, cancel } = fakes();

  const out = await cancel.cancelPairs(S1, { pair_ids: [P1, P2], outcome: "stays_with_buyer" });

  assert.equal(out.cancelled, 2);
  // Nothing is left to invoice, so only the credit runs.
  assert.deepEqual(calls, [["credit", "i1"]]);
  assert.equal(written.every((w) => w.fields["Availability Status"] === "Sold"), true);

  const deal = db.tables.external_sales[0];
  assert.equal(deal.shipping_status, "cancelled");
  assert.equal(deal.payment_status, "cancelled");
  assert.equal(deal.bookkeeping_status, "credited");
  assert.equal(deal.total_selling_price, 0);
  assert.ok(deal.cancelled_at);
});

test("a refund is written down, never more than came in", async () => {
  const { db, cancel } = fakes({ sale: { ...SALE, payment_status: "partially_paid", paid_amount: 600, total_selling_price: 350 } });

  const saved = await cancel.registerRefund(S1, { amount: 250, date: "2026-09-23", note: "IBAN NL12", by: "Dario" });

  assert.equal(saved.refunded_amount, 250);
  assert.equal(saved.paid_amount, 350);
  assert.equal(saved.payment_status, "paid");
  assert.match(saved.payment_note, /refunded 250.00 by bank by Dario: IBAN NL12/);

  await assert.rejects(() => cancel.registerRefund(S1, { amount: 500 }), /more than came in/);
  await assert.rejects(() => cancel.registerRefund(S1, { amount: 0 }), /amount that went back/);
});

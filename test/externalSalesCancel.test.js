import test from "node:test";
import assert from "node:assert/strict";

import { CANCEL_OUTCOMES, cancelPlan, conditionNote, conditionWith, createExternalSalesCancel, discountPlan } from "../admin/externalSalesCancel.js";
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
  { id: P1, sale_id: S1, item_id: "PCS-007999", sku: "A01FW702-BLK", size: "42", inventory_unit_record_id: "recA", selling_price: 250, purchase_price_ex_vat: 200, selling_vat_type: "Margin", created_at: "2026-09-20T10:00:00Z" },
  { id: P2, sale_id: S1, inventory_unit_record_id: "recB", selling_price: 350, purchase_price_ex_vat: 300, selling_vat_type: "Margin", created_at: "2026-09-20T10:01:00Z" }
];

const INVOICES = [{ id: "i1", kind: "sale", invoice_number: "KC202609-2100", rompslomp_invoice_id: "900", vat_route: "Margin", journal_entry_id: "j1" }];

test("the unit says where the pair went, off which deal and when", () => {
  const when = new Date("2026-09-24T10:00:00Z");

  assert.equal(conditionNote(SALE, "return", when), "Return from Conquer Shop S.R.L. (EXTD-000081, 24-09-2026)");
  assert.equal(conditionNote(SALE, "store_consign", when), "At Conquer Shop S.R.L. (EXTD-000081, 24-09-2026)");
  assert.equal(conditionNote(SALE, "lost", when), "Lost on the way to Conquer Shop S.R.L. (EXTD-000081, 24-09-2026)");
  assert.equal(conditionNote(SALE, "written_off", when), "Written off, kept by Conquer Shop S.R.L. (EXTD-000081, 24-09-2026)");
  assert.equal(conditionNote(SALE, "nonsense", when), "");
});

test("only a pair that comes back to us is sellable again and puts its stock back", () => {
  assert.deepEqual(
    Object.entries(CANCEL_OUTCOMES).map(([key, rule]) => [key, rule.available, rule.stockBack, rule.toPartner]),
    [
      ["return", true, true, true],
      ["store_consign", true, true, false],
      ["lost", false, false, false],
      ["written_off", false, false, false]
    ]
  );
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

function fakes({ sale = SALE, pairs = PAIRS, invoices = INVOICES, partnerStock = [], unitFields = {} } = {}) {
  const db = fakeDb({
    external_sales: [{ ...sale }],
    external_sale_pairs: pairs.map((pair) => ({ ...pair })),
    external_sale_invoices: invoices.map((invoice) => ({ ...invoice })),
    external_sale_invoice_deals: invoices.map((invoice) => ({ invoice_id: invoice.id, sale_id: sale.id })),
    partner_stock: partnerStock.map((row) => ({ ...row }))
  });

  const units = new Map([
    ["recA", { "Item Condition": "Box damaged", ...(unitFields.recA || {}) }],
    ["recB", { ...(unitFields.recB || {}) }]
  ]);
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

  const out = await cancel.cancelPairs(S1, { pair_ids: [P1], reason: "Wrong size sent", outcome: "return", by: "Dario" });

  assert.equal(out.cancelled, 1);
  assert.equal(out.refund, 250);
  assert.deepEqual(calls, [["credit", "i1"], ["invoice", S1]]);

  const pair = db.tables.external_sale_pairs.find((p) => p.id === P1);
  assert.ok(pair.cancelled_at);
  assert.equal(pair.cancel_outcome, "return");
  assert.equal(pair.cancel_reason, "Wrong size sent");

  const deal = db.tables.external_sales[0];
  assert.equal(deal.total_selling_price, 350);
  assert.equal(deal.bookkeeping_status, "to_invoice");
  // Paid more than the deal is now worth: open again until the money is back.
  assert.equal(deal.payment_status, "partially_paid");

  // What happened is one note on the deal, in the words of the outcome.
  const note = db.tables.external_sale_notes[0];
  assert.equal(note.written_by, "Dario");
  assert.match(note.body, /Cancelled 1 pair: PCS-007999 \(Return\) - Wrong size sent/);

  // The unit goes back to stock, marked, with the story in front of what it said.
  assert.equal(written.length, 1);
  assert.equal(written[0].id, "recA");
  assert.equal(written[0].fields["Availability Status"], "Available");
  assert.equal(written[0].fields["Cancel Status"], "Return");
  assert.match(written[0].fields["Item Condition"], /^Return from Conquer Shop S\.R\.L\. \(EXTD-000081, \d\d-\d\d-\d{4}\) - Box damaged$/);
});

test("the last pair off the deal ends it", async () => {
  const { db, written, calls, cancel } = fakes();

  const out = await cancel.cancelPairs(S1, { pair_ids: [P1, P2], outcome: "return" });

  assert.equal(out.cancelled, 2);
  // Nothing is left to invoice, so only the credit runs.
  assert.deepEqual(calls, [["credit", "i1"]]);
  assert.equal(written.every((w) => w.fields["Availability Status"] === "Available"), true);

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

/* ---------------- a partner's pair ---------------- */

const SHELF = { id: "cccccccc-3333-4333-8333-cccccccccccc", sku: "A01FW702-BLK", size: "42", status: "sold", sold_ref: "EXTD-000081", inventory_unit_id: "PCS-006200" };
const partnerPairs = () => [{ ...PAIRS[0], partner_stock_id: SHELF.id }, PAIRS[1]];

test("an unpaid partner pair that comes back goes on the partner's shelf again", async () => {
  const { db, written, cancel } = fakes({ pairs: partnerPairs(), partnerStock: [SHELF], unitFields: { recA: { "Payment Status": "To Pay" } } });

  await cancel.cancelPairs(S1, { pair_ids: [P1], outcome: "return" });

  const shelf = db.tables.partner_stock[0];
  assert.equal(shelf.status, "in_stock");
  assert.equal(shelf.sold_ref, null);

  // The unit made for the sale is switched off: we do not owe for it.
  assert.equal(written[0].id, "recA");
  assert.equal(written[0].fields["Availability Status"], "Inactive");
});

test("a partner pair we already paid for stays ours", async () => {
  const { db, written, cancel } = fakes({ pairs: partnerPairs(), partnerStock: [SHELF], unitFields: { recA: { "Payment Status": "Paid", "Item Condition": "Box damaged" } } });

  await cancel.cancelPairs(S1, { pair_ids: [P1], outcome: "return" });

  // Paid is bought: the shelf keeps it as sold and the unit joins our stock.
  assert.equal(db.tables.partner_stock[0].status, "sold");
  assert.equal(written.length, 1);
  assert.equal(written[0].id, "recA");
  assert.equal(written[0].fields["Availability Status"], "Available");
  assert.equal(written[0].fields["Cancel Status"], "Return");
  assert.match(written[0].fields["Item Condition"], /^Return from Conquer Shop S\.R\.L\. \(EXTD-000081, \d\d-\d\d-\d{4}\) - Box damaged$/);
});

/* ---------------- a discount, with the shoes gone ---------------- */

test("a discount says what each pair becomes and what the deal is worth", () => {
  const plan = discountPlan({ sale: SALE, pairs: PAIRS, wanted: [{ id: P1, amount: 50, reason: "Small mark" }], invoices: INVOICES });

  assert.equal(plan.ok, true);
  assert.equal(plan.given, 50);
  assert.deepEqual(plan.lines[0], { id: P1, pair: "PCS-007999", amount: 50, reason: "Small mark", was: 250, becomes: 200, discount_so_far: 50 });
  assert.equal(plan.new_total, 550, "the other pair keeps its price");
  assert.equal(plan.reinvoice, true);
});

test("a discount is never the whole price, and never on a pair that is gone", () => {
  const whole = discountPlan({ sale: SALE, pairs: PAIRS, wanted: [{ id: P1, amount: 250 }] });
  assert.match(whole.problems[0], /whole price of 250.00: cancel the pair instead/);

  const none = discountPlan({ sale: SALE, pairs: PAIRS, wanted: [{ id: P1, amount: 0 }] });
  assert.match(none.problems[0], /Enter what comes off PCS-007999/);

  const cancelled = discountPlan({ sale: SALE, pairs: [{ ...PAIRS[0], cancelled_at: "2026-09-24" }], wanted: [{ id: P1, amount: 50 }] });
  assert.match(cancelled.problems[0], /no longer on this deal/);
});

test("discounting credits, writes the pair cheaper and invoices again", async () => {
  const { db, written, calls, cancel } = fakes();

  const out = await cancel.discountPairs(S1, { pairs: [{ id: P1, amount: 50 }], reason: "Small mark", by: "Dario" });

  assert.equal(out.given, 50);
  assert.equal(out.new_total, 550);
  assert.deepEqual(calls, [["credit", "i1"], ["invoice", S1]]);

  const pair = db.tables.external_sale_pairs.find((p) => p.id === P1);
  assert.equal(pair.selling_price, 200);
  assert.equal(pair.discount, 50);
  assert.equal(pair.discount_reason, "Small mark");
  assert.ok(pair.discounted_at);
  assert.equal(pair.cancelled_at, undefined, "the pair stays sold");

  // Nothing moves in stock: the buyer keeps the shoes.
  assert.deepEqual(written, []);

  const deal = db.tables.external_sales[0];
  assert.equal(deal.total_selling_price, 550);
  assert.equal(deal.bookkeeping_status, "to_invoice");
  assert.match(db.tables.external_sale_notes[0].body, /Discount 50.00: PCS-007999 250.00 -> 200.00 - Small mark/);
});

test("a second discount is added to the first, and a paid deal owes the difference", async () => {
  const { db, cancel } = fakes({ sale: { ...SALE, payment_status: "paid", paid_amount: 600 }, pairs: [{ ...PAIRS[0], discount: 50, selling_price: 200 }, PAIRS[1]] });

  const out = await cancel.discountPairs(S1, { pairs: [{ id: P1, amount: 25 }] });

  assert.equal(out.new_total, 525);
  assert.equal(out.refund, 75, "600 came in, 525 is owed");
  assert.match(out.log.join(" "), /Refund the buyer 75.00 by bank/);

  assert.equal(db.tables.external_sale_pairs.find((p) => p.id === P1).discount, 75);
  assert.equal(db.tables.external_sales[0].payment_status, "partially_paid");
});

test("on a one-pair deal the deal's own price is the pair's price", () => {
  const lone = [{ ...PAIRS[0], selling_price: null }];
  const plan = discountPlan({ sale: { ...SALE, total_selling_price: 250 }, pairs: lone, wanted: [{ id: P1, amount: 50 }] });

  assert.equal(plan.ok, true);
  assert.equal(plan.lines[0].was, 250);
  assert.equal(plan.new_total, 200);

  // With more pairs on it there is nothing to divide the total over.
  const two = discountPlan({ sale: SALE, pairs: [lone[0], { ...PAIRS[1], selling_price: null }], wanted: [{ id: P1, amount: 50 }] });
  assert.match(two.problems[0], /Enter the selling price of PCS-007999 first/);
});

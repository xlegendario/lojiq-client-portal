import test from "node:test";
import assert from "node:assert/strict";

import { externalSalesChecks } from "../admin/adminExternalSales.js";
import { fakeDb } from "./fakeSupabase.js";
import { labelKey, saleMoney, sellingVatType, shippingStatusFor } from "../admin/externalSalesSync.js";

/* ---------------- rules ---------------- */

test("the selling VAT follows the purchase and the buyer", () => {
  assert.equal(sellingVatType("Margin", { buyer_country_code: "DE", buyer_vat_id: "DE123" }), "Margin");
  assert.equal(sellingVatType("VAT21", { buyer_country_code: "NL", buyer_vat_id: "NL123B01" }), "VAT21");
  assert.equal(sellingVatType("VAT21", { buyer_country_code: "DE", buyer_vat_id: "DE123" }), "VAT0");
  assert.equal(sellingVatType("VAT0", { buyer_country_code: "DE", buyer_vat_id: "" }), "VAT21", "a private buyer abroad pays 21%");
  assert.equal(sellingVatType(null, {}), null);
});

test("profit takes the VAT off the margin, not the whole price", () => {
  // Margin: 200 sold, 100 bought -> VAT 100 x 21/121 = 17.36.
  const margin = saleMoney({ total_selling_price: 200, shipping_costs: 10, legacy_selling_vat_type: "Margin" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(margin.selling_ex_vat, 182.64);
  assert.equal(margin.profit, 72.64);

  const vat21 = saleMoney({ total_selling_price: 242, shipping_costs: 0, legacy_selling_vat_type: "VAT21" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(vat21.profit, 100);

  const vat0 = saleMoney({ total_selling_price: 150, shipping_costs: 5, legacy_selling_vat_type: "VAT0" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(vat0.profit, 45);
});

test("a mixed deal has no profit until every pair has its price", () => {
  const pairs = [
    { purchase_price_ex_vat: 100, selling_vat_type: "Margin", selling_price: null },
    { purchase_price_ex_vat: 100, selling_vat_type: "VAT21", selling_price: null }
  ];
  const unknown = saleMoney({ total_selling_price: 400, shipping_costs: 0, legacy_selling_vat_type: null }, pairs);
  assert.equal(unknown.profit, null);

  pairs[0].selling_price = 200;
  pairs[1].selling_price = 242;
  const known = saleMoney({ total_selling_price: 442, shipping_costs: 0, legacy_selling_vat_type: null }, pairs);
  assert.equal(known.selling_ex_vat, 382.64);
  assert.equal(known.profit, 182.64);
});

test("a label keeps its key through the copy to R2", () => {
  assert.equal(labelKey("label_astro (5).pdf"), labelKey("EXTD-000069-label_astro__5_.pdf"));
  assert.equal(labelKey("image.jpeg"), labelKey("EXTD-000063-image.pdf"));
  assert.equal(labelKey("EXTD-000076.pdf"), labelKey("EXTD-000076-EXTD-000076.pdf"));
  assert.notEqual(labelKey("a.pdf"), labelKey("b.pdf"));
});

test("shipping status: parcels make it ready, shipped and cancelled stay", () => {
  assert.equal(shippingStatusFor({ current: "pending", cancelled: false, parcels: 1 }), "ready_to_ship");
  assert.equal(shippingStatusFor({ current: "ready_to_ship", cancelled: false, parcels: 0 }), "pending");
  assert.equal(shippingStatusFor({ current: "shipped", cancelled: false, parcels: 0 }), "shipped");
  assert.equal(shippingStatusFor({ current: "delivered", cancelled: false, parcels: 0 }), "delivered");
  assert.equal(shippingStatusFor({ current: "shipped", cancelled: true, parcels: 2 }), "cancelled");
});

/* ---------------- checks ---------------- */

test("checks find what is missing or wrong, each on its deal", () => {
  const sale = (n, extra) => ({ id: `s${n}`, deal_number: n, buyer_record_id: "recB", buyer_name: "B", payment_status: "paid", shipping_status: "shipped", bookkeeping_status: "invoiced", total_selling_price: 200, shipping_costs: 0, legacy_selling_vat_type: "VAT0", labels_needed: 0, sale_date: "2026-09-01", ...extra });
  const sales = [
    sale(1, {}),
    sale(2, { payment_status: "cancelled", shipping_status: "cancelled" }),
    sale(3, { bookkeeping_status: "to_invoice", legacy_selling_vat_type: null }),
    sale(4, { shipping_status: "ready_to_ship", labels_needed: 2 })
  ];
  const pairsBySale = new Map([
    ["s1", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 250 }]],
    ["s2", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 100 }]],
    ["s3", [{ purchase_vat_type: "Margin", purchase_price_ex_vat: 50, selling_vat_type: "Margin", selling_price: null }, { purchase_vat_type: null, purchase_price_ex_vat: 0, selling_vat_type: null, selling_price: null }]],
    ["s4", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 100 }]]
  ]);
  const parcelsBySale = new Map([["s1", [{ tracking_number: "1ZAAA1111111111111" }]], ["s4", [{ label_url: "x", tracking_number: "1ZDDD4444444444444" }]]]);
  const invoicesBySale = new Map([["s1", [{ kind: "sale", invoice_number: "KC1", journal_entry_id: null }]], ["s2", [{ kind: "sale", invoice_number: "KC2", journal_entry_id: "j" }]]]);

  const checks = externalSalesChecks({ sales, pairsBySale, parcelsBySale, invoicesBySale, now: Date.parse("2026-09-22") });
  const by = Object.fromEntries(checks.map((c) => [c.key, c.items.map((i) => i.deal)]));

  assert.equal(by.loss, undefined, "selling at a loss happens on purpose; it is no check");
  assert.deepEqual(by.invoice_without_journal, ["EXTD-000001"]);
  assert.deepEqual(by.cancelled_invoiced, ["EXTD-000002"]);
  assert.deepEqual(by.purchase_missing, ["EXTD-000003"]);
  assert.deepEqual(by.mixed_vat, ["EXTD-000003"]);
  assert.deepEqual(by.labels_short, ["EXTD-000004"]);
  assert.deepEqual(by.shipped_no_tracking, ["EXTD-000003"], "EXTD-000001 has its tracking");
  assert.deepEqual(by.to_invoice, ["EXTD-000003"]);
});

/* ---------------- one edit at a time ---------------- */

test("an edit works out the deal's shipping status again from its parcels", async () => {
  const { createExternalSalesEdits } = await import("../admin/externalSalesSync.js");

  const db = fakeDb({
    external_sales: [{ id: "s80", deal_number: 80, payment_status: "pending", shipping_status: "pending", shipped_at: null }],
    shipments: []
  });

  const edits = createExternalSalesEdits({ db });

  // A first parcel makes it Ready to Ship.
  await edits.edit(db.tables.external_sales[0], async (sale) => {
    await db.insert("shipments", [{ external_sale_id: sale.id, tracking_number: "1ZBBB222", label_url: "https://r2/b", label_filename: "b.pdf", airtable_attachment_id: null }]);
  });
  assert.equal(db.tables.external_sales[0].shipping_status, "ready_to_ship");

  // Removing the last one puts it back on Pending.
  await edits.edit(db.tables.external_sales[0], async () => {
    db.tables.shipments = [];
  });
  assert.equal(db.tables.external_sales[0].shipping_status, "pending");

  // A deal that has left is never made unshipped by an edit.
  db.tables.external_sales[0].shipping_status = "shipped";
  await edits.edit(db.tables.external_sales[0], async () => {});
  assert.equal(db.tables.external_sales[0].shipping_status, "shipped");
});


test("the next step follows the work: invoice, label, Pack & Ship, money", async () => {
  const { nextStep } = await import("../admin/adminExternalSales.js");
  const base = { payment_status: "pending", shipping_status: "pending", bookkeeping_status: "invoiced", total_selling_price: 1690.5, sale_date: "2026-09-18" };
  const now = Date.parse("2026-09-22T12:00:00Z");

  assert.equal(nextStep({ sale: { ...base, bookkeeping_status: "to_invoice" }, now }).key, "invoice");
  assert.equal(nextStep({ sale: base, now }).key, "label");
  assert.equal(nextStep({ sale: { ...base, shipping_status: "ready_to_ship" }, now }).key, "pack");

  const shipped = { ...base, shipping_status: "shipped" };
  const invoices = [{ kind: "sale", sent_at: "2026-09-18T10:00:00Z", created_at: "2026-09-22T08:00:00Z" }];
  const waiting = nextStep({ sale: shipped, invoices, now });
  assert.equal(waiting.key, "payment");
  // Short on purpose: the date is the message, the amount stands in the deal.
  assert.equal(waiting.text, "Payment due 25-09-2026");

  const late = nextStep({ sale: shipped, invoices: [{ kind: "sale", sent_at: "2026-09-07T10:00:00Z" }], now });
  assert.equal(late.key, "overdue");
  assert.equal(late.tone, "bad");
  assert.equal(late.text, "Overdue 14-09-2026");
  assert.equal(nextStep({ sale: { ...shipped, payment_status: "paid" }, now }).key, "done");
  assert.equal(nextStep({ sale: { ...shipped, payment_status: "cancelled" }, now }).key, "cancelled");
});

test("an invoice published months later is due from the sale", async () => {
  const { dueDate } = await import("../admin/adminExternalSales.js");
  const due = dueDate({ sale_date: "2026-04-08" }, [{ kind: "sale", sent_at: "2026-09-21T10:00:00Z" }]);
  assert.equal(due.toISOString().slice(0, 10), "2026-04-15");
});

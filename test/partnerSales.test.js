import test from "node:test";
import assert from "node:assert/strict";

import { assignShipments, readPaymentNote, saleKind, summarizeSales } from "../partner/partnerSales.js";

const unit = (id, fields, createdTime = "2026-10-01T10:00:00.000Z") => ({
  id,
  createdTime,
  fields: { SKU: "A05FW702", "Product Name": "Hank", "Purchase Price": 100, "Availability Status": "Sold", ...fields }
});

test("a payment note: amount, bank code and the date the code carries (yyyy dd mm)", () => {
  assert.deepEqual(readPaymentNote("4380 (MON20260211)"), { note: "4380 (MON20260211)", total: 4380, code: "MON20260211", date: "2026-11-02" });
  assert.deepEqual(readPaymentNote("1560 (MO20260710)").date, "2026-10-07");
  assert.equal(readPaymentNote("1200 (Myy80-12)").date, null);
  assert.deepEqual(readPaymentNote("100"), { note: "100", total: 100, code: "", date: null });
});

test("what a unit is for him: a sale, a cancelled sale, or nothing", () => {
  assert.equal(saleKind({ "Availability Status": "Sold" }), "sale");
  assert.equal(saleKind({ "Availability Status": "Returning" }), "sale", "a pair on its way back is only shown once it is back");
  assert.equal(saleKind({ "Availability Status": "Void", "Sales Date": "2026-10-16" }), "cancelled");
  assert.equal(saleKind({ "Availability Status": "Available", "Payment Status": "Paid", "Cancel Status": ["Return"] }), "sale", "came back paid and became ours: still his paid sale");
  assert.equal(saleKind({ "Availability Status": "Reserved" }), "sale", "sold, not shipped yet");
  assert.equal(saleKind({ "Availability Status": "Available" }), null);
  assert.equal(saleKind({ "Availability Status": "Inactive" }), null);
});

test("per model Sold · Paid · To pay, and per payment the pairs and amount, never which pair", () => {
  const s = summarizeSales([
    unit("a", { Size: "40", "Sales Date": "2026-10-01", "Payment Status": "Paid", "Payment Note": "1560 (MO20260710)" }),
    unit("b", { Size: "41", "Sales Date": "2026-10-02", "Payment Status": "Paid", "Payment Note": "1560 (MO20260710)" }),
    unit("c", { Size: "42", "Sales Date": "2026-11-02", "Payment Status": "To Pay" }),
    unit("d", { SKU: "PETERSON", "Product Name": "Peterson", Size: "43", "Sales Date": "2026-10-03", "Payment Status": "Paid", "Payment Note": "1560 (MO20260710)" })
  ]);

  const hank = s.models.find((m) => m.sku === "A05FW702");
  assert.deepEqual([hank.sold, hank.paid, hank.to_pay, hank.to_pay_amount], [3, 2, 1, 100]);
  assert.equal(s.to_pay_amount, 100);
  assert.equal(s.payments.length, 1);
  assert.deepEqual(s.payments[0].models.map((m) => [m.name, m.pairs, m.amount]), [["Hank", 2, 200], ["Peterson", 1, 100]]);
  assert.ok(!JSON.stringify(s.payments).includes('"size"'), "a payment never says which size");
});

test("a paid pair that comes back and is swapped: his numbers per model and per payment do not move", () => {
  const before = summarizeSales([
    unit("p38", { Size: "38", "Sales Date": "2026-10-16", "Payment Status": "Paid", "Payment Note": "2100 (MO20261910)" }),
    unit("p43", { Size: "43", "Sales Date": "2026-11-02", "Payment Status": "To Pay" })
  ]);
  // The swap: 38 is Void without its payment; 43 carries the payment now.
  const after = summarizeSales([
    unit("p38", { Size: "38", "Sales Date": "2026-10-16", "Availability Status": "Void" }),
    unit("p43", { Size: "43", "Sales Date": "2026-11-02", "Payment Status": "Paid", "Payment Note": "2100 (MO20261910)" })
  ]);

  assert.deepEqual([before.models[0].paid, before.payments[0].pairs, before.payments[0].amount], [1, 1, 100]);
  assert.deepEqual([after.models[0].paid, after.payments[0].pairs, after.payments[0].amount], [1, 1, 100], "the payment did not change");
  assert.equal(after.models[0].sold, 1);
  assert.equal(after.models[0].to_pay, 0);
  assert.deepEqual(after.models[0].cancelled, [{ date: "2026-10-16", size: "38", shipment: "" }], "only a cancelled line appears");
});

test("units from before the partner consignment (the old deals) never show", () => {
  const s = summarizeSales([
    unit("old", { Size: "40", "Sales Date": "2026-09-05", "Payment Status": "To Pay" }, "2026-04-21T10:00:00.000Z"),
    unit("new", { Size: "41", "Sales Date": "2026-10-05", "Payment Status": "To Pay" }, "2026-09-20T10:00:00.000Z")
  ]);
  assert.equal(s.sold, 1);
  assert.equal(s.to_pay_amount, 100);
});

test("a note without a bank code is each pair's own payment, not one big one", () => {
  const s = summarizeSales([
    unit("x", { "Sales Date": "2026-09-15", "Payment Status": "Paid", "Payment Note": "100" }),
    unit("y", { "Sales Date": "2026-09-16", "Payment Status": "Paid", "Payment Note": "100" })
  ]);
  assert.equal(s.payments.length, 2);
  assert.deepEqual(s.payments.map((p) => [p.total, p.pairs]), [[100, 1], [100, 1]]);
});

test("each sale gets the shipment it came from, and payments count pairs per shipment", () => {
  const stock = [
    { sku: "A05FW702", size: "40", status: "sold", received_at: "2026-09-17T10:00:00Z", sold_at: "2026-09-19T10:00:00Z" },
    { sku: "A05FW702", size: "41", status: "in_stock", received_at: "2026-09-17T10:00:00Z", sold_at: null },
    { sku: "A05FW702", size: "42", status: "sold", received_at: "2026-10-28T10:00:00Z", sold_at: "2026-10-29T22:30:00Z" }
  ];
  const units = [
    unit("early", { Size: "39", "Sales Date": "2026-09-16", "Payment Status": "Paid", "Payment Note": "100" }),
    unit("a", { Size: "40", "Sales Date": "2026-09-19", "Payment Status": "Paid", "Payment Note": "4380 (MON20260211)" }),
    unit("b", { Size: "42", "Sales Date": "2026-10-29", "Payment Status": "Paid", "Payment Note": "4380 (MON20260211)" }),
    unit("c", { Size: "43", "Sales Date": "2026-11-02", "Payment Status": "To Pay" })
  ];
  const map = assignShipments(units, stock);
  assert.equal(map.get("early"), "2026-09-17", "sold before the intake was booked: the first shipment");
  assert.equal(map.get("a"), "2026-09-17", "same size and day as a sold row");
  assert.equal(map.get("b"), "2026-10-28", "the day is Amsterdam's, not UTC's");
  assert.equal(map.get("c"), "2026-09-17", "no row to match: the oldest shipment already in");

  const s = summarizeSales(units, new Map(), { shipments: map });
  assert.deepEqual(s.models[0].shipments.map((x) => [x.date, x.sold, x.paid, x.to_pay]), [["2026-09-17", 3, 2, 1], ["2026-10-28", 1, 1, 0]]);
  const big = s.payments.find((p) => p.code === "MON20260211");
  assert.deepEqual(big.models[0].shipments, [{ date: "2026-09-17", pairs: 1 }, { date: "2026-10-28", pairs: 1 }]);
});

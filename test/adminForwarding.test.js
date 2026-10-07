import test from "node:test";
import assert from "node:assert/strict";

import { displayId, feeLines, forwardMoney, nextShippingStatus, pairFee, trackingList } from "../admin/adminForwarding.js";

test("a forward is shown as FWD- and six digits", () => {
  assert.equal(displayId({ forwarding_number: 42 }), "FWD-000042");
});

test("the partner pays fee plus shipping, the profit is the fee", () => {
  assert.deepEqual(forwardMoney({ pair_count: 39, unit_forwarding_fee: 2, shipping_costs: 18.5 }), {
    fee: 78,
    shipping: 18.5,
    payable: 96.5,
    profit: 78,
    profit_ex_vat: 64.46
  });
});

test("a pair without its own fee costs the forward's standard fee", () => {
  assert.equal(pairFee({ forwarding_fee: 1 }, 2), 1);
  assert.equal(pairFee({ forwarding_fee: 0 }, 2), 0);
  assert.equal(pairFee({ forwarding_fee: null }, 2), 2);
  assert.equal(pairFee({}, 2), 2);
});

test("a mixed parcel is counted off its own pairs, not the standard fee", () => {
  const row = { pair_count: 4, unit_forwarding_fee: 2, shipping_costs: 0 };
  const pairs = [
    { sku: "TEE", forwarding_fee: 1 },
    { sku: "TEE", forwarding_fee: 1 },
    { sku: "SHOE", forwarding_fee: 3 },
    { sku: "SHOE", forwarding_fee: null }
  ];

  // 1 + 1 + 3 + 2 (the last one falls back to the standard)
  assert.equal(forwardMoney(row, pairs).fee, 7);
  assert.equal(forwardMoney(row, pairs).payable, 7);
});

test("without pairs - a cancelled forward - the old sum is all there is", () => {
  assert.equal(forwardMoney({ pair_count: 39, unit_forwarding_fee: 2 }, []).fee, 78);
  assert.equal(forwardMoney({ pair_count: 39, unit_forwarding_fee: 2 }, null).fee, 78);
});

test("the fee is listed per SKU, with the dearest line first", () => {
  const pairs = [
    { sku: "TEE", product_name: "Tee", forwarding_fee: 1 },
    { sku: "TEE", product_name: "Tee", forwarding_fee: 1 },
    { sku: "TEE", product_name: "Tee", forwarding_fee: 1 },
    { sku: "SHOE", product_name: "Shoe", forwarding_fee: null }
  ];

  assert.deepEqual(feeLines(pairs, 2), [
    { sku: "TEE", product_name: "Tee", count: 3, fee: 1, amount: 3, mixed: false },
    { sku: "SHOE", product_name: "Shoe", count: 1, fee: 2, amount: 2, mixed: false }
  ]);
});

test("a SKU whose own pairs disagree is marked mixed", () => {
  const [line] = feeLines([{ sku: "TEE", forwarding_fee: 1 }, { sku: "TEE", forwarding_fee: 3 }], 2);

  assert.equal(line.mixed, true);
  assert.equal(line.amount, 4);
});

test("tracking numbers can be typed in any separated form", () => {
  assert.deepEqual(trackingList("1Z999, 1Z888\n1Z777;1Z999"), ["1Z999", "1Z888", "1Z777"]);
  assert.deepEqual(trackingList(["A1", " ", "B2"]), ["A1", "B2"]);
  assert.deepEqual(trackingList(""), []);
});

test("labels or tracking make a forward Ready to Ship, none puts it back", () => {
  assert.equal(nextShippingStatus("awaiting_label", ["1Z"], []), "ready_to_ship");
  assert.equal(nextShippingStatus("awaiting_label", [], [{ url: "x" }]), "ready_to_ship");
  assert.equal(nextShippingStatus("ready_to_ship", [], []), "awaiting_label");
});

test("an edit never undoes shipped or cancelled", () => {
  assert.equal(nextShippingStatus("shipped", [], []), "shipped");
  assert.equal(nextShippingStatus("cancelled", ["1Z"], []), "cancelled");
});

test("a label upload is recognised as PDF, JPEG or PNG by its first bytes", async () => {
  const { labelUpload } = await import("../admin/adminForwarding.js");
  const pad = (head) => Buffer.concat([head, Buffer.alloc(200)]);

  assert.deepEqual(labelUpload(pad(Buffer.from("%PDF-1.4"))), { mime: "application/pdf", ext: "pdf" });
  assert.deepEqual(labelUpload(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(labelUpload(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47]))), { mime: "image/png", ext: "png" });
  assert.equal(labelUpload(pad(Buffer.from("GIF89a"))), null);
  assert.equal(labelUpload(Buffer.from("%PDF-")), null);
});

test("a tracking number typed with spaces stays one number", () => {
  assert.deepEqual(trackingList("1Z FV6 483 68 2567 1031"), ["1ZFV648368 25671031".replace(" ", "")]);
  assert.deepEqual(trackingList("JD00 003 0031993 000006106826, 1Z999"), ["JD000030031993000006106826", "1Z999"]);
});

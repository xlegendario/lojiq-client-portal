import test from "node:test";
import assert from "node:assert/strict";

import { displayId, forwardMoney, nextShippingStatus, trackingList } from "../admin/adminForwarding.js";

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

import test from "node:test";
import assert from "node:assert/strict";

import { nextSaleStatus, saleRow } from "../admin/adminExternalSales.js";

test("a tracking number or a label makes a sale Ready to Ship", () => {
  assert.equal(nextSaleStatus("Pending", ["1Z999"], []), "Ready to Ship");
  assert.equal(nextSaleStatus("Pending", [], [{ url: "x" }]), "Ready to Ship");
  assert.equal(nextSaleStatus("Label(s) Generated", ["1Z999"], []), "Ready to Ship");
});

test("taking everything off puts it back, but keeps a hand-set Label(s) Generated", () => {
  assert.equal(nextSaleStatus("Ready to Ship", [], []), "Pending");
  assert.equal(nextSaleStatus("Label(s) Generated", [], []), "Label(s) Generated");
});

test("Shipped is never undone by an edit", () => {
  assert.equal(nextSaleStatus("Shipped", [], []), "Shipped");
  assert.equal(nextSaleStatus("Shipped", ["1Z"], []), "Shipped");
});

test("a row reads the sale the way the WMS wrote it", () => {
  const row = saleRow({
    id: "recAAAAAAAAAAAAAA",
    fields: {
      "External Deal ID": "EXT-000123",
      "Buyer Name": ["Some Buyer"],
      "Tracking Numbers": "1Z111, 1Z222",
      "Shipping Labels": [{ id: "att1", url: "https://x/label.pdf", filename: "label.pdf" }],
      "Total Selling Price": 450,
      "Linked Inventory Units": ["recU1", "recU2"]
    }
  });

  assert.equal(row.display_id, "EXT-000123");
  assert.equal(row.buyer_name, "Some Buyer");
  assert.deepEqual(row.tracking_numbers, ["1Z111", "1Z222"]);
  assert.equal(row.labels[0].id, "att1");
  assert.equal(row.shipping_status, "Pending");
  assert.equal(row.quantity, 2);
});

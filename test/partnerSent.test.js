import test from "node:test";
import assert from "node:assert/strict";

import { loadForwards, summarizeForwards } from "../partner/partnerSent.js";

const forward = (fields) => ({
  id: "f1",
  forwarding_number: 37,
  pair_count: 3,
  unit_forwarding_fee: 2,
  shipping_costs: 0,
  tracking_numbers: ["1ZR0082Y6898283021"],
  shipping_status: "shipped",
  payment_status: "pending",
  shipped_at: "2026-10-09T10:00:00Z",
  created_at: "2026-10-08T13:00:00Z",
  ...fields
});

const pair = (fields) => ({ forwarding_log_id: "f1", sku: "U9060ECA", size: "38", product_name: "9060", image_url: "", forwarding_fee: null, ...fields });

test("a forward shows its pairs per product and size, and the fee as the admin counts it", () => {
  const [row] = summarizeForwards(
    [forward({})],
    [pair({ size: "38.5" }), pair({}), pair({ forwarding_fee: 5 })]
  );

  assert.equal(row.display_id, "FWD-000037");
  assert.equal(row.pairs, 3);
  assert.equal(row.fee, 9);
  assert.equal(row.fee_paid, false);
  assert.deepEqual(row.products[0].sizes, [{ size: "38", count: 2 }, { size: "38.5", count: 1 }]);
});

test("shipping costs count in the fee, like Finance's payable", () => {
  const [row] = summarizeForwards([forward({ shipping_costs: 7.5 })], [pair({})]);
  assert.equal(row.fee, 9.5);
});

test("forwards still with us come first, then newest first", () => {
  const rows = summarizeForwards(
    [
      forward({ id: "old-shipped", created_at: "2026-09-01T10:00:00Z" }),
      forward({ id: "new-shipped", created_at: "2026-10-08T10:00:00Z" }),
      forward({ id: "waiting", shipping_status: "awaiting_label", created_at: "2026-09-24T10:00:00Z" })
    ],
    []
  );

  assert.deepEqual(rows.map((r) => r.id), ["waiting", "new-shipped", "old-shipped"]);
});

test("no label address, buyer or price leaves the server", () => {
  const out = JSON.stringify(
    summarizeForwards([forward({ labels: [{ url: "https://r2/label.pdf" }], buyer_name: "Paul" })], [pair({ partner_price: 140 })])
  );

  assert.equal(out.includes("r2/label"), false);
  assert.equal(out.includes("Paul"), false);
  assert.equal(out.includes("140"), false);
});

test("forwards and their pairs are read for this partner only", async () => {
  const paths = [];
  const db = {
    async get(path) {
      paths.push(path);
      if (path.startsWith("forward_invoices")) return [];
      return path.startsWith("forwarding_log") ? [forward({})] : [pair({})];
    }
  };

  const rows = await loadForwards(db, "recJIMMY00000001");

  assert.equal(rows.length, 1);
  assert.ok(paths.every((p) => p.includes("seller_record_id=eq.recJIMMY00000001")));
  assert.ok(paths[1].includes('forwarding_log_id=in.("f1")'));
});

test("the buyer and whether he paid: ticked off by the partner without an invoice, ours to follow with one", async () => {
  const { buyerView } = await import("../partner/partnerSent.js");
  const buyers = new Map([["b1", { id: "b1", company_name: "", full_name: "Wang Lei" }]]);

  assert.deepEqual(buyerView(forward({}), null, { buyer_id: "b1", buyer_paid_at: null }, buyers), { name: "Wang Lei", paid: false, editable: true });
  assert.deepEqual(buyerView(forward({}), null, { buyer_id: "b1", buyer_paid_at: "2026-10-16T10:00:00Z" }, buyers).paid, true);
  assert.deepEqual(buyerView(forward({ buyer_name: "Paul" }), null, null, buyers), { name: "", paid: false, editable: true }, "our own buyer on an old forward stays hidden");
  assert.deepEqual(buyerView(forward({}), { buyer: "Kicks BV", stage: "to_pay" }, null, buyers), { name: "Kicks BV", paid: true, editable: false });
  assert.equal(buyerView(forward({ shipping_status: "cancelled" }), null, null, buyers).editable, false);
});

test("buyer paid: only his own forward, never an invoiced or cancelled one", async () => {
  const { setBuyerPaid } = await import("../partner/partnerSent.js");
  const id = "aaaaaaaa-2222-3333-4444-555555555555";
  const writes = [];
  const db = (invoiced, status = "shipped", sale = []) => ({
    async get(path) {
      if (path.startsWith("forwarding_log")) return path.includes("recJIMMY") ? [{ id, shipping_status: status }] : [];
      if (path.startsWith("forward_invoices")) return invoiced ? [{ id: "i1" }] : [];
      return sale;
    },
    async insert(table, rows) { writes.push(["insert", table, rows[0]]); return rows; },
    async patch(path, fields) { writes.push(["patch", path, fields]); return [fields]; }
  });
  const now = () => new Date("2026-10-16T12:00:00Z");

  assert.deepEqual(await setBuyerPaid(db(false), "recOTHER", id, true, now), { error: "not_found" });
  assert.deepEqual(await setBuyerPaid(db(true), "recJIMMY", id, true, now), { error: "invoiced" });
  assert.deepEqual(await setBuyerPaid(db(false, "cancelled"), "recJIMMY", id, true, now), { error: "not_found" });

  assert.deepEqual(await setBuyerPaid(db(false), "recJIMMY", id, true, now), { paid: true });
  assert.deepEqual(writes.pop(), ["insert", "partner_forward_sales", { forwarding_log_id: id, seller_record_id: "recJIMMY", buyer_paid_at: "2026-10-16T12:00:00.000Z" }]);

  assert.deepEqual(await setBuyerPaid(db(false, "shipped", [{ forwarding_log_id: id }]), "recJIMMY", id, false, now), { paid: false });
  const [kind, path, fields] = writes.pop();
  assert.equal(kind, "patch");
  assert.ok(path.startsWith("partner_forward_sales?forwarding_log_id=eq."));
  assert.equal(fields.buyer_paid_at, null, "taken back");
});

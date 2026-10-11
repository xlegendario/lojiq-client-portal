import test from "node:test";
import assert from "node:assert/strict";

import { loadPartnerPairs, summarizeStock } from "../partner/partnerStock.js";

const pair = (fields) => ({
  sku: "A05FW702",
  size: "44",
  product_name: "Hank OG",
  brand: "Maison Mihara",
  image_url: "https://img/hank.png",
  status: "in_stock",
  received_at: "2026-10-02T09:00:00Z",
  warehouse: "lojiq",
  ...fields
});

test("by product: only what is on the shelf, sizes in size order, arrivals per size", () => {
  const { totals, products } = summarizeStock([
    pair({ size: "44" }),
    pair({ size: "44", received_at: "2026-09-17T08:00:00Z" }),
    pair({ size: "42-43" }),
    pair({ size: "36" }),
    pair({ size: "44", status: "sold" }),
    pair({ size: "44", status: "forwarded" }),
    pair({ size: "44", status: "removed" }),
    pair({ size: "44", status: "reserved" })
  ]);

  assert.equal(totals.on_shelf, 5);
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].sizes.map((s) => [s.size, s.count]), [["36", 1], ["42-43", 1], ["44", 3]]);

  const size44 = products[0].sizes.find((s) => s.size === "44");
  assert.equal(size44.onHold, 1);
  assert.deepEqual(size44.arrivals.map((a) => [a.date, a.count]), [["2026-09-17", 1], ["2026-10-02", 2]]);
});

test("by arrival: every pair that came in, newest day first, with what became of it", () => {
  const { arrivals } = summarizeStock([
    pair({}),
    pair({ status: "sold" }),
    pair({ status: "forwarded" }),
    pair({ sku: "U9060ECA", product_name: "9060", status: "forwarded" }),
    pair({ received_at: "2026-08-25T10:00:00Z", status: "forwarded" }),
    pair({ status: "removed" })
  ]);

  assert.deepEqual(arrivals.map((a) => a.date), ["2026-10-02", "2026-08-25"]);
  assert.deepEqual(
    { received: arrivals[0].received, left: arrivals[0].left, sold: arrivals[0].sold, forwarded: arrivals[0].forwarded },
    { received: 4, left: 1, sold: 1, forwarded: 2 }
  );
  assert.deepEqual(
    arrivals[0].products.map((p) => [p.sku, p.received, p.left, p.sold, p.forwarded]),
    [["A05FW702", 3, 1, 1, 1], ["U9060ECA", 1, 0, 0, 1]]
  );
  assert.deepEqual(arrivals[0].products[0].sizes, [{ size: "44", received: 3, left: 1 }]);
  assert.equal(arrivals[1].left, 0);
});

test("the day is the warehouse's day, not UTC", () => {
  // 23:30 UTC on 1 October is already 2 October in Amsterdam.
  const { arrivals } = summarizeStock([pair({ received_at: "2026-10-01T23:30:00Z" })]);
  assert.equal(arrivals[0].date, "2026-10-02");
});

test("a second warehouse is counted apart", () => {
  const { totals, arrivals } = summarizeStock([pair({}), pair({}), pair({ warehouse: "h23" })]);

  assert.deepEqual(totals.warehouses, [{ warehouse: "lojiq", count: 2 }, { warehouse: "h23", count: 1 }]);
  assert.equal(arrivals.length, 2);
});

test("no prices, buyers or references leave the server", () => {
  const out = JSON.stringify(summarizeStock([pair({ partner_price: 120, sold_ref: "ORD-1", notes: "secret" })]));

  assert.equal(out.includes("120"), false);
  assert.equal(out.includes("ORD-1"), false);
  assert.equal(out.includes("secret"), false);
});

test("pairs are read a page at a time, filtered on the partner", async () => {
  const paths = [];
  const db = {
    async get(path) {
      paths.push(path);
      return path.includes("offset=0") ? Array.from({ length: 1000 }, () => pair({})) : [pair({})];
    }
  };

  const rows = await loadPartnerPairs(db, "recJIMMY00000001");

  assert.equal(rows.length, 1001);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((p) => p.includes("seller_record_id=eq.recJIMMY00000001")));
});

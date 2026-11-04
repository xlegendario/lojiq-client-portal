import test from "node:test";
import assert from "node:assert/strict";

import { createNewOrder, newOrderFields, nextPrivateNumber } from "../admin/adminNewOrder.js";

const MERCHANT = "rec12euDYQPxBBGMJ";
const NOW = new Date("2026-11-04T10:00:00.000Z");

function fakeDeps({ privates = [], lookup = { found: true, source: "sku_master", product_name: "Maison Mihara Yasuhiro Hank", brand: "Maison Mihara Yasuhiro", image: "https://img.test/a.png" } } = {}) {
  const calls = [];

  return {
    calls,
    callKc: async (path, body) => {
      calls.push({ kind: "kc", path, body });
      return lookup;
    },
    airtable: {
      byIds: async (table, ids) => {
        calls.push({ kind: "byIds", table, ids });
        if (table === "Merchants") return new Map([[MERCHANT, { id: MERCHANT, fields: { "Store Name": "Tienne Milano" } }]]);
        return new Map(ids.map((id) => [id, { id, fields: { "Order ID": "ORD-031000", "Fulfillment Status": "Pending" } }]));
      },
      select: async (table, options) => {
        calls.push({ kind: "select", table, options });
        if (table === "Sellers Database") return { records: [{ id: "recSELLER", fields: { "Seller ID": "SE-00781", "Full Name": "Jimmy" } }] };
        return { records: privates.map((n, i) => ({ id: `rec${i}`, fields: { "Shopify Order Number": n } })), offset: "" };
      },
      create: async (table, fields) => {
        calls.push({ kind: "create", table, fields });
        return { id: table === "Order Processing Form" ? "recFORM" : "recNEWORDER00000a", fields };
      },
      update: async (table, id, fields) => calls.push({ kind: "update", table, id, fields })
    }
  };
}

const input = { store_id: MERCHANT, sku: "a05fw702", size: "42", selling_price: "229,90", store_price: "145" };

test("the next Private number counts on from the highest, by number", () => {
  assert.equal(nextPrivateNumber(["Private 9", "Private 10", "Private 2"]), "Private 11");
  assert.equal(nextPrivateNumber(["#1001", "private 3"]), "Private 4");
  assert.equal(nextPrivateNumber([]), "Private 1");
});

test("a new order carries what the engine needs and nothing of another order", () => {
  const fields = newOrderFields({
    merchantId: MERCHANT,
    orderNumber: "Private 11",
    sku: "a05fw702",
    size: "42",
    product: { product_name: "Hank", brand: "Maison Mihara Yasuhiro", image: "" },
    sellingPrice: 229.9,
    storePrice: 145,
    now: NOW
  });

  assert.equal(fields["SKU (Soft)"], "A05FW702");
  assert.equal(fields["Shopify Product Name"], "Hank");
  assert.equal(fields["Fulfillment Status"], "Pending");
  assert.equal(fields["Match Risk Level"], "Low");
  assert.equal(fields["Custom Offer"], 145);
  assert.equal(fields["Offer Accepted?"], true);
  assert.equal(fields.Picture, undefined);

  for (const copied of ["Fulfillment Sent?", "Rompslomp Invoice ID", "Invoice Sent At", "Bookkeeping Status", "Linked Inventory Unit", "auto_allocate_attempted_at"]) {
    assert.equal(copied in fields, false, copied);
  }
});

test("New Order makes the next Private for the store and leaves the pair to the engine", async () => {
  const deps = fakeDeps({ privates: ["Private 9", "Private 10"] });
  const result = await createNewOrder({ input, deps, now: NOW });

  const created = deps.calls.find((call) => call.kind === "create");
  assert.equal(created.table, "Unfulfilled Orders Log");
  assert.equal(created.fields["Shopify Order Number"], "Private 11");
  assert.equal(created.fields["Product Name"], "Maison Mihara Yasuhiro Hank");
  assert.deepEqual(created.fields.Picture, [{ url: "https://img.test/a.png" }]);
  assert.equal(created.fields["Selling Price"], 229.9);
  assert.equal("auto_allocate_attempted_at" in created.fields, false);
  assert.match(result.message, /ORD-031000 made for Tienne Milano: Private 11/);
  assert.equal(deps.calls.filter((call) => call.kind === "create").length, 1);
});

test("with a seller and payout the deal is made and the engine is kept off the order", async () => {
  const deps = fakeDeps();
  await createNewOrder({ input: { ...input, seller: "se-00781", payout: "110", vat: "Margin" }, deps, now: NOW });

  const [order, form] = deps.calls.filter((call) => call.kind === "create");
  assert.equal(order.fields["Shopify Order Number"], "Private 1");
  assert.equal(order.fields.auto_allocate_attempted_at, NOW.toISOString());
  assert.equal(form.table, "Order Processing Form");
  assert.deepEqual(form.fields["Linked Order ID"], ["recNEWORDER00000a"]);
  assert.equal(form.fields["Payout (€)"], 110);
});

test("an unknown SKU asks for the name instead of making a nameless order", async () => {
  const deps = fakeDeps({ lookup: { found: false } });
  await assert.rejects(createNewOrder({ input, deps, now: NOW }), /Type the product name/);
  assert.equal(deps.calls.some((call) => call.kind === "create"), false);

  await createNewOrder({ input: { ...input, product_name: "Hank OG", brand: "Mihara" }, deps, now: NOW });
  assert.equal(deps.calls.find((call) => call.kind === "create").fields["Product Name"], "Hank OG");
});

test("the prices and the store are required", async () => {
  const deps = fakeDeps();
  await assert.rejects(createNewOrder({ input: { ...input, selling_price: "" }, deps }), /selling price/);
  await assert.rejects(createNewOrder({ input: { ...input, store_price: "0" }, deps }), /store pays/);
  await assert.rejects(createNewOrder({ input: { ...input, store_id: "x" }, deps }), /Choose the store/);
});

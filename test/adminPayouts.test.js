import test from "node:test";
import assert from "node:assert/strict";

import { loadPayouts, markUnitsPaid } from "../admin/adminPayouts.js";

function fakeBase(tables) {
  const writes = [];

  return {
    writes,
    airtable: {
      async select(table, { formula } = {}) {
        let records = tables[table] || [];
        if (table === "Inventory Units" && /To Pay/.test(formula || "")) records = records.filter((r) => r.fields["Payment Status"] === "To Pay");
        return { records, offset: "" };
      },
      async byIds(table, ids) {
        return new Map((tables[table] || []).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.fields]));
      },
      async update(table, id, fields) {
        writes.push({ table, id, fields });
        return { id };
      }
    }
  };
}

const unit = (id, fields) => ({
  id,
  fields: { "Item ID": id.slice(-4), "Payment Status": "To Pay", Type: "Consignment", "Final Purchase Price": 100, "Seller ID": ["recSELLER00000001"], "Purchase Date": "2026-09-01", ...fields }
});

const sellers = [
  { id: "recSELLER00000001", fields: { "Seller ID": "SE-00001", "Full Name": "Jan Jansen", "Company Name": "Jansen Kicks", "Payout Info": "NL91 ABNA 0417 1643 00" } },
  { id: "recSELLER00000002", fields: { "Seller ID": "SE-00002", "Full Name": "Piet", "Payout Info": "" } }
];

test("payouts: To Pay units per seller with their Payout Info, the seller owed most on top", async () => {
  const { airtable } = fakeBase({
    "Sellers Database": sellers,
    "Unfulfilled Orders Log": [{ id: "recORDER000000007", fields: { "Order ID": "ORD-007001" } }],
    "Inventory Units": [
      unit("recUNIT0000000001", { "Unfulfilled Orders Log": ["recORDER000000007"], "Shipping Status": ["Delivered"], "Store Name": ["Genky"], "Shopify Order Number": ["7001"] }),
      unit("recUNIT0000000002", { "Member WTBs": ["recW"], "Member WTB ID": ["MWTB-9"], "Shipping Status (MWTB)": ["Shipped"], "Final Purchase Price": 50 }),
      unit("recUNIT0000000003", { "Seller ID": ["recSELLER00000002"], "Final Purchase Price": 400, Type: "Custom" }),
      unit("recUNIT0000000004", { "Payment Status": "Paid" })
    ]
  });

  const all = await loadPayouts(airtable, {});
  assert.equal(all.count, 3);
  assert.equal(all.total, 550);
  assert.deepEqual(all.groups.map((g) => [g.seller.name, g.total]), [["Piet", 400], ["Jansen Kicks", 150]]);
  assert.equal(all.groups[1].seller.payout_info, "NL91 ABNA 0417 1643 00");
  assert.equal(all.groups[1].rows[0].reference, "ORD-007001 · Genky · 7001");
  assert.equal(all.groups[1].rows[1].reference, "MWTB-9");

  assert.equal((await loadPayouts(airtable, { shipping: "delivered" })).count, 1);
  assert.equal((await loadPayouts(airtable, { shipping: "shipped_or_delivered" })).count, 2);
  assert.equal((await loadPayouts(airtable, { shipping: "not_shipped" })).count, 1);
  assert.equal((await loadPayouts(airtable, { type: "Custom" })).count, 1);
  assert.equal((await loadPayouts(airtable, { search: "se-00001" })).count, 2);
  assert.equal((await loadPayouts(airtable, { search: "ORD-007001" })).count, 1);
  assert.equal((await loadPayouts(airtable, { search: "mwtb-9" })).count, 1);
});

test("mark paid: only To Pay units of one seller, and only Payment Status is written", async () => {
  const base = fakeBase({
    "Inventory Units": [
      unit("recUNIT0000000001", {}),
      unit("recUNIT0000000002", { "Final Purchase Price": 77.5 }),
      unit("recUNIT0000000003", { "Seller ID": ["recSELLER00000002"] }),
      unit("recUNIT0000000004", { "Payment Status": "Paid" })
    ]
  });

  await assert.rejects(markUnitsPaid({ ids: [], airtable: base.airtable }), /at least one/);
  await assert.rejects(markUnitsPaid({ ids: ["recUNIT0000000004"], airtable: base.airtable }), /not on To Pay/);
  await assert.rejects(markUnitsPaid({ ids: ["recUNIT0000000001", "recUNIT0000000003"], airtable: base.airtable }), /one seller at a time/);
  assert.equal(base.writes.length, 0);

  const result = await markUnitsPaid({ ids: ["recUNIT0000000001", "recUNIT0000000002"], airtable: base.airtable });

  assert.equal(result.total, 177.5);
  assert.deepEqual(base.writes.map((w) => w.fields), [{ "Payment Status": "Paid" }, { "Payment Status": "Paid" }]);
});

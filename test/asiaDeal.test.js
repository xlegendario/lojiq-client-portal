import test from "node:test";
import assert from "node:assert/strict";
import { makeAsiaDeal } from "../admin/asiaDeal.js";

function fakeDeps(order) {
  const calls = [];
  return {
    calls,
    airtable: {
      byIds: async (table, ids) => {
        if (table === "Unfulfilled Orders Log" && ids[0] === "recORDER000000001") return new Map([[ids[0], { "Order ID": "ORD-1", SKU: "X", Size: "42", ...order }]]);
        return new Map();
      },
      select: async (table, { formula }) => {
        calls.push({ kind: "select", table, formula });
        return { records: [{ id: "recDEWU0000000001", fields: { "Seller ID": "SE-00455", Email: "p@example.com", "Full Name": "Panyao" } }] };
      },
      update: async (table, id, fields) => calls.push({ kind: "update", table, id, fields }),
      create: async (table, fields) => {
        calls.push({ kind: "create", table, fields });
        return { id: table === "Order Processing Form" ? "recFORM" : "recUNIT" };
      }
    },
    purchases: { book: async () => ({ expense_id: "9", expense_number: "IN-9" }) },
    sendMail: async (m) => calls.push({ kind: "mail", m }),
    mailFrom: "noreply@kickzcaviar.nl",
    postJson: async () => calls.push({ kind: "post" }),
    discordUpdatesUrl: "https://updates.test/"
  };
}

test("Asia deal: accepted Custom Offer, form, unit on the Dewu supplier, Margin, mail, no label request", async () => {
  const deps = fakeDeps({ "Fulfillment Status": "Dewu Processing" });
  const out = await makeAsiaDeal({ input: { order_record_id: "recORDER000000001", payout: "110", store_price: 125 }, deps });

  assert.equal(out.unit_id, "recUNIT");
  assert.equal(out.seller_id, "SE-00455");
  assert.match(deps.calls[0].formula, /Dewu Supplier\?/);
  assert.deepEqual(deps.calls.find((c) => c.kind === "update").fields, { "Custom Offer": 125, "Offer Accepted?": true, "Offer Denied?": false });
  const [form, unit] = deps.calls.filter((c) => c.kind === "create");
  assert.deepEqual(form.fields, { "Linked Order ID": ["recORDER000000001"], "Linked Seller ID": ["recDEWU0000000001"], "Payout (€)": 110, "VAT Type": "Margin", Agreement: true, "Approved?": true });
  assert.equal(unit.fields["Purchase Price"], 110);
  assert.equal(unit.fields["VAT Type"], "Margin");
  assert.equal(deps.calls.filter((c) => c.kind === "mail").length, 1);
  assert.equal(deps.calls.filter((c) => c.kind === "post").length, 0);
});

test("Asia deal refuses a second pair, a closed order and bad prices", async () => {
  await assert.rejects(makeAsiaDeal({ input: { order_record_id: "recORDER000000001", payout: 110, store_price: 125 }, deps: fakeDeps({ "Fulfillment Status": "Allocated", "Linked Inventory Unit": ["recU"] }) }), (e) => e.status === 409 && e.extra.unit_id === "recU");
  await assert.rejects(makeAsiaDeal({ input: { order_record_id: "recORDER000000001", payout: 110, store_price: 125 }, deps: fakeDeps({ "Fulfillment Status": "Store Fulfilled" }) }), /Store Fulfilled/);
  await assert.rejects(makeAsiaDeal({ input: { order_record_id: "recORDER000000001", payout: 130, store_price: 125 }, deps: fakeDeps({ "Fulfillment Status": "Confirmed" }) }), /less than we pay/);
  await assert.rejects(makeAsiaDeal({ input: { order_record_id: "nope", payout: 1, store_price: 2 }, deps: fakeDeps({}) }), /record id/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { loadOpenPayments, markPaidByBankTransfer, openPaymentFormula } from "../admin/adminPayments.js";

// A tiny in-memory Airtable: tables of { id, fields }, and every write recorded.
function fakeBase(tables) {
  const writes = [];

  return {
    writes,
    airtable: {
      async select(table) {
        return { records: (tables[table] || []).map((r) => ({ id: r.id, fields: r.fields })), offset: "" };
      },
      async byIds(table, ids) {
        return new Map((tables[table] || []).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.fields]));
      },
      async update(table, id, fields) {
        writes.push({ op: "update", table, id, fields });
        return { id };
      },
      async create(table, fields) {
        writes.push({ op: "create", table, fields });
        return { id: "recNEWBATCH000001" };
      }
    }
  };
}

const merchants = [
  { id: "recMERCHANT000001", fields: { "Store Name": "Genky", "Seller ID": ["recSELLER00000001"] } },
  { id: "recMERCHANT000002", fields: { "Store Name": "LetzKick" } }
];

const order = (id, fields) => ({
  id,
  fields: { "Order ID": id.slice(-6), "Store Name": ["Genky"], Client: ["recMERCHANT000001"], "Fulfillment Status": "Ready to Ship", "Invoice Status": "Pending", "Invoice Price (VAT Included)": 100, "Order Date": "2026-09-01T10:00:00.000Z", ...fields }
});

test("the open rule is the client portal's", () => {
  const f = openPaymentFormula("mwtb");
  assert.match(f, /\{Fulfillment Status\} = 'Requested Label'/);
  assert.match(f, /\{Payment Status\} = 'Expired'/);
  assert.doesNotMatch(f, /Trusted/);
  assert.match(openPaymentFormula("store"), /\{Invoice Status\} = 'Failed'/);
});

test("open amounts are grouped per store, a store's member WTBs under its own name", async () => {
  const { airtable } = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [
      order("recORDER000000001", {}),
      order("recORDER000000002", { "Store Name": ["LetzKick"], Client: ["recMERCHANT000002"], "Order Date": "2026-08-01T10:00:00.000Z", "Invoice Price (VAT Included)": 50.5 })
    ],
    "Member WTBs": [
      { id: "recWTB00000000001", fields: { "Member WTB ID": "MWTB-1", "Buyer Seller ID": ["recSELLER00000001"], "Fulfillment Status": "Fulfilled", "Payment Status": "Expired", "Invoice Price": 25, Date: "2026-09-02T10:00:00.000Z" } }
    ]
  });

  const data = await loadOpenPayments(airtable, {});

  assert.equal(data.count, 3);
  assert.equal(data.total, 175.5);
  assert.deepEqual(data.groups.map((g) => [g.store, g.rows.length, g.total]), [["LetzKick", 1, 50.5], ["Genky", 2, 125]]);

  const excluded = await loadOpenPayments(airtable, { stores: ["Genky"], storeMode: "exclude" });
  assert.deepEqual(excluded.groups.map((g) => g.store), ["LetzKick"]);
});

test("mark paid: one Bank Transfer batch, records Paid, link cleared", async () => {
  const base = fakeBase({ Merchants: merchants, "Unfulfilled Orders Log": [order("recORDER000000001", { "Payment Link": "https://pay.test/x" })] });

  const result = await markPaidByBankTransfer({
    targets: [{ source: "store", id: "recORDER000000001" }],
    deps: { airtable: base.airtable, tellKickzPaid: async () => "", archiveMollieLink: async () => "" }
  });

  const batch = base.writes.find((w) => w.op === "create");
  assert.equal(batch.fields["Payment Provider"], "Bank Transfer");
  assert.equal(batch.fields["Payment Status"], "Paid");
  assert.equal(batch.fields.Amount, 100);
  assert.deepEqual(batch.fields.Store, ["recMERCHANT000001"]);
  assert.deepEqual(batch.fields["Linked Orders"], ["recORDER000000001"]);

  const update = base.writes.find((w) => w.op === "update");
  assert.equal(update.fields["Invoice Status"], "Paid");
  assert.equal(update.fields["Payment Link"], "");
  assert.deepEqual(update.fields["Payment Batches"], ["recNEWBATCH000001"]);
  assert.equal(result.total, 100);
});

test("mark paid refuses what is not open, several stores, and half a payment link", async () => {
  const deps = (base) => ({ airtable: base.airtable, tellKickzPaid: async () => "", archiveMollieLink: async () => "" });

  const paid = fakeBase({ Merchants: merchants, "Unfulfilled Orders Log": [order("recORDER000000001", { "Invoice Status": "Paid" })] });
  await assert.rejects(markPaidByBankTransfer({ targets: [{ source: "store", id: "recORDER000000001" }], deps: deps(paid) }), /not open anymore/);

  const early = fakeBase({ Merchants: merchants, "Unfulfilled Orders Log": [order("recORDER000000001", { "Fulfillment Status": "Allocated" })] });
  await assert.rejects(markPaidByBankTransfer({ targets: [{ source: "store", id: "recORDER000000001" }], deps: deps(early) }), /not payable yet/);

  const two = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [order("recORDER000000001", {}), order("recORDER000000002", { "Store Name": ["LetzKick"] })]
  });
  await assert.rejects(
    markPaidByBankTransfer({ targets: [{ source: "store", id: "recORDER000000001" }, { source: "store", id: "recORDER000000002" }], deps: deps(two) }),
    /one store at a time/
  );

  const linked = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [
      order("recORDER000000001", { "Invoice Status": "Awaiting Payment", "Payment Batches": ["recBATCH000000001"] }),
      order("recORDER000000002", { "Invoice Status": "Awaiting Payment", "Payment Batches": ["recBATCH000000001"] })
    ],
    "Payment Batches": [{ id: "recBATCH000000001", fields: { "Batch ID": "PAYB-1", "Payment Status": "Awaiting Payment", "Linked Orders": ["recORDER000000001", "recORDER000000002"], "Mollie Payment Link ID": "pl_1" } }]
  });
  await assert.rejects(markPaidByBankTransfer({ targets: [{ source: "store", id: "recORDER000000001" }], deps: deps(linked) }), /Select all 2/);
  assert.equal(linked.writes.length, 0);

  const inProgress = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [order("recORDER000000001", { "Invoice Status": "Pending Payment", "Payment Batches": ["recBATCH000000001"] })],
    "Payment Batches": [{ id: "recBATCH000000001", fields: { "Batch ID": "PAYB-1", "Payment Status": "Pending Payment", "Linked Orders": ["recORDER000000001"] } }]
  });
  await assert.rejects(markPaidByBankTransfer({ targets: [{ source: "store", id: "recORDER000000001" }], deps: deps(inProgress) }), /in progress at Mollie/);
});

test("mark paid covering a whole link cancels it, switches the link off and tells Kickz Caviar about WTBs", async () => {
  const told = [];
  const archived = [];

  const base = fakeBase({
    Merchants: merchants,
    "Member WTBs": [{ id: "recWTB00000000001", fields: { "Member WTB ID": "MWTB-1", "Buyer Seller ID": ["recSELLER00000001"], "Fulfillment Status": "Requested Label", "Payment Status": "Awaiting Payment", "Invoice Price": 80, "Payment Batches": ["recBATCH000000001"] } }],
    "Payment Batches": [{ id: "recBATCH000000001", fields: { "Batch ID": "PAYB-9", "Payment Status": "Awaiting Payment", "Linked Member WTBs": ["recWTB00000000001"], "Mollie Payment Link ID": "pl_9" } }]
  });

  const result = await markPaidByBankTransfer({
    targets: [{ source: "mwtb", id: "recWTB00000000001" }],
    deps: {
      airtable: base.airtable,
      tellKickzPaid: async (ids) => { told.push(...ids); return ""; },
      archiveMollieLink: async (id) => { archived.push(id); return ""; }
    }
  });

  assert.deepEqual(result.cancelled, ["PAYB-9"]);
  assert.deepEqual(archived, ["pl_9"]);
  assert.deepEqual(told, ["recWTB00000000001"]);
  assert.ok(base.writes.some((w) => w.table === "Payment Batches" && w.id === "recBATCH000000001" && w.fields["Payment Status"] === "Cancelled"));

  const wtb = base.writes.find((w) => w.table === "Member WTBs");
  assert.equal(wtb.fields["Payment Status"], "Paid");
  assert.deepEqual(wtb.fields["Payment Batches"], ["recBATCH000000001", "recNEWBATCH000001"]);
});

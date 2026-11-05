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

/* ----- following Rompslomp ----- */

import { creditedNumbers, followRompslompPayments, mentionsInvoice, paymentDateFor } from "../admin/adminPayments.js";

test("a bank line names an invoice only as a whole number", () => {
  assert.equal(mentionsInvoice("Omschrijving: Factuur:KC202611-2539IBAN: ES09", "KC202611-2539"), true);
  assert.equal(mentionsInvoice("Saldo fattura invoiceKC2026 11 2505 IBAN", "KC202611-2505"), true);
  assert.equal(mentionsInvoice("Factuur KC202609-2089", "KC202609-208"), false);
  assert.equal(mentionsInvoice("anything", ""), false);
});

test("the paid day: invoice number first, then exact amount from the customer's name", () => {
  const invoice = { date: "2026-10-01", invoice_number: "KC202610-2000", price_with_vat: "145.0", cached_contact: { name: "Tienne Milano" } };
  const payments = [
    { paid_at: "2026-10-20T00:00:00.000+02:00", amount: "300.0", description: "TIENNE MILANO SRL Factuur KC202610-2000 KC202610-2001" },
    { paid_at: "2026-10-05T00:00:00.000+02:00", amount: "145.0", description: "Naam: TIENNE MILANO SRL" },
    { paid_at: "2026-09-01T00:00:00.000+02:00", amount: "145.0", description: "Factuur KC202610-2000" }
  ];

  assert.deepEqual(paymentDateFor(invoice, payments), { date: "2026-10-20", how: "invoice number" });
  assert.deepEqual(paymentDateFor(invoice, payments.slice(1)), { date: "2026-10-05", how: "amount and name" });
  assert.equal(paymentDateFor(invoice, payments.slice(2)), null, "a line from before the invoice is not its payment");
});

test("credit notes name the invoice they credit", () => {
  const numbers = creditedNumbers([{ description: "Creditfactuur voor factuur: KC202602-555" }, { description: "" }]);
  assert.deepEqual([...numbers], ["KC202602555"]);
});

function fakeRompslomp({ unpaid = [], invoices = {}, credits = [], payments = [] }) {
  const reads = [];
  return {
    reads,
    async read(path) {
      reads.push(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] || 1);
      if (page > 1) return path.startsWith("/payments") ? { payments: [] } : { sales_invoices: [] };
      if (path.includes("selection=unpaid")) return { sales_invoices: unpaid.map((id) => ({ id })) };
      if (path.includes("selection=credit_invoices")) return { sales_invoices: credits };
      if (path.startsWith("/payments")) return { payments };
      throw new Error(`unexpected ${path}`);
    },
    async getInvoice(id) {
      reads.push(`get ${id}`);
      return invoices[id] || null;
    }
  };
}

const invoiced = (id, invoiceId, fields = {}) => order(id, { "Order ID": `ORD-${id.slice(-3)}`, "Rompslomp Invoice ID": invoiceId, "Rompslomp Invoice Number": `KC2026-${invoiceId}`, ...fields });
const rsInvoice = (id, fields = {}) => ({ id: Number(id), invoice_number: `KC2026-${id}`, date: "2026-10-01", status: "published", payment_status: "paid", price_with_vat: "100.0", cached_contact: { name: "Genky Sneakers" }, ...fields });

test("Rompslomp: paid invoices are marked paid on the bank day, one batch per store and day", async () => {
  const base = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [invoiced("recORDER000000001", "11"), invoiced("recORDER000000002", "22"), invoiced("recORDER000000003", "33"), invoiced("recORDER000000004", "44")]
  });
  const rompslomp = fakeRompslomp({
    unpaid: ["33"],
    invoices: { 11: rsInvoice("11"), 22: rsInvoice("22"), 44: rsInvoice("44", { payment_status: "unpaid" }) },
    payments: [{ paid_at: "2026-10-12T00:00:00.000+02:00", amount: "200.0", description: "GENKY Factuur KC2026-11 KC2026-22" }]
  });

  const calls = [];
  const result = await followRompslompPayments({
    now: new Date("2026-11-05T10:00:00Z"),
    deps: {
      airtable: base.airtable,
      rompslomp,
      markPaid: async (targets, paidAt) => {
        calls.push({ targets, paidAt });
        return markPaidByBankTransfer({ targets, paidAt, deps: { airtable: base.airtable, tellKickzPaid: async () => "", archiveMollieLink: async () => "" } });
      }
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targets.map((t) => t.id), ["recORDER000000001", "recORDER000000002"]);
  assert.equal(calls[0].paidAt, "2026-10-12T12:00:00.000Z");
  assert.deepEqual(result.marked.map((m) => [m.label, m.date, m.how]), [["ORD-001", "2026-10-12", "invoice number"], ["ORD-002", "2026-10-12", "invoice number"]]);

  const batch = base.writes.find((w) => w.op === "create");
  assert.equal(batch.fields["Paid At"], "2026-10-12T12:00:00.000Z");
  assert.equal(batch.fields["Payment Provider"], "Bank Transfer");
  const order1 = base.writes.find((w) => w.op === "update" && w.id === "recORDER000000001");
  assert.equal(order1.fields["Invoice Status"], "Paid");
  assert.equal(order1.fields["Paid At"], "2026-10-12T12:00:00.000Z");

  // Only the invoices missing from the unpaid list were read one by one.
  assert.deepEqual(rompslomp.reads.filter((r) => r.startsWith("get ")), ["get 11", "get 22", "get 44"]);
});

test("Rompslomp: a credited invoice stays open; no bank line means today; one bad order does not stop the rest", async () => {
  const base = fakeBase({
    Merchants: merchants,
    "Unfulfilled Orders Log": [invoiced("recORDER000000001", "11"), invoiced("recORDER000000002", "22"), invoiced("recORDER000000003", "33")]
  });
  const rompslomp = fakeRompslomp({
    invoices: { 11: rsInvoice("11"), 22: rsInvoice("22"), 33: rsInvoice("33") },
    credits: [{ description: "Creditfactuur voor factuur: KC2026-33" }]
  });

  const result = await followRompslompPayments({
    now: new Date("2026-11-05T10:00:00Z"),
    deps: {
      airtable: base.airtable,
      rompslomp,
      markPaid: async (targets, paidAt) => {
        if (targets.some((t) => t.id === "recORDER000000002")) throw new Error("payment in progress at Mollie");
        return { batch_record_id: "recB", notes: [], paidAt };
      }
    }
  });

  assert.deepEqual(result.marked.map((m) => [m.label, m.date, m.how]), [["ORD-001", "2026-11-05", "date not found, today"]]);
  assert.deepEqual(result.errors, [{ labels: ["ORD-002"], message: "payment in progress at Mollie" }]);
  assert.deepEqual(result.skipped.map((s) => [s.label, s.reason]), [["ORD-003", "a credit note refers to this invoice"]]);
});

test("Rompslomp: nothing outside the unpaid list means no further calls", async () => {
  const base = fakeBase({ Merchants: merchants, "Unfulfilled Orders Log": [invoiced("recORDER000000001", "11")] });
  const rompslomp = fakeRompslomp({ unpaid: ["11"] });

  const result = await followRompslompPayments({ deps: { airtable: base.airtable, rompslomp, markPaid: async () => assert.fail("nothing to mark") } });

  assert.equal(result.checked, 1);
  assert.equal(rompslomp.reads.length, 1);
});

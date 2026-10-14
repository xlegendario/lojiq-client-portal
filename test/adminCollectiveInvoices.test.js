import test from "node:test";
import assert from "node:assert/strict";

import { createCollectiveInvoicesStore, dueDate, invoiceReference, invoicePlan, lastDayOf, monthOf } from "../admin/adminCollectiveInvoices.js";

const STORE = "recAPLUG000000001";

function fakeBase(tables) {
  const writes = [];

  return {
    writes,
    tables,
    airtable: {
      async select(table, { formula = "" } = {}) {
        let records = tables[table] || [];
        if (table === "Merchants") records = records.filter((r) => r.fields["Invoice Mode"] === "Self-billing");
        if (/Awaiting self-billing/.test(formula)) records = records.filter((r) => r.fields["Bookkeeping Status"] === "Awaiting self-billing");
        return { records: records.map((r) => ({ id: r.id, fields: r.fields })), offset: "" };
      },
      async byIds(table, ids) {
        return new Map((tables[table] || []).filter((r) => ids.includes(r.id)).map((r) => [r.id, { ...r.fields }]));
      },
      async update(table, id, fields) {
        writes.push({ table, id, fields });
        const record = (tables[table] || []).find((r) => r.id === id);
        if (record) Object.assign(record.fields, fields);
        return { id };
      }
    }
  };
}

function fakeRompslomp({ priceWithVat = null } = {}) {
  const calls = [];
  const invoices = [];
  let next = 3000;

  return {
    calls,
    invoices,
    client: {
      configured: true,
      async getContact() { return null; },
      async searchContacts(q) { calls.push(["search", q]); return [{ id: 77, company_name: "APLUG.PL", vat_number: "PL123" }]; },
      async findInvoice(reference) { return invoices.find((i) => i.api_reference === reference) || null; },
      async getInvoice(id) { return invoices.find((i) => String(i.id) === String(id)) || null; },
      async createInvoice(body) {
        const inv = body.sales_invoice;
        const total = inv.invoice_lines.reduce((s, l) => s + Number(l.price_per_unit), 0);
        const made = { id: ++next, status: "concept", invoice_number: null, date: inv.date, api_reference: inv.api_reference, price_with_vat: priceWithVat ?? total, body };
        invoices.push(made);
        calls.push(["create", body]);
        return made;
      },
      async publishInvoice(id) {
        const inv = invoices.find((i) => i.id === id);
        inv.status = "published";
        inv.invoice_number = `KC202609-${inv.id}`;
        return inv;
      },
      async recentJournals() { return []; },
      async createJournal(body) { calls.push(["journal", body]); return { id: 9000 + calls.length }; }
    }
  };
}

const order = (id, fields) => ({
  id,
  fields: {
    "Order ID": `ORD-${id.slice(-3)}`, Client: [STORE], "Store Name": ["APLUG.PL"], "Bookkeeping Status": "Awaiting self-billing",
    "Fulfillment Status": "Fulfilled", "Fulfilment Date": "2026-09-21T16:11:22.000Z", "VAT Type": ["Margin"], "Client Country": ["Poland"],
    "Final Buying Price": 100, "Product Name": "Jordan 4", Size: "42", "Linked Inventory Unit": [`recUNIT${id.slice(-10)}`],
    ...fields
  }
});

const unit = (orderId, fields) => ({ id: `recUNIT${orderId.slice(-10)}`, fields: { "Final Purchase Price": 80, "Final Purchase Price (ex. VAT)": 66.12, ...fields } });

function base(orders) {
  return fakeBase({
    Merchants: [
      { id: STORE, fields: { "Store Name": "APLUG.PL", "Invoice Mode": "Self-billing", Country: "Poland" } },
      { id: "recOTHER000000001", fields: { "Store Name": "Genky", "Invoice Mode": "Send invoice", Country: "Netherlands" } }
    ],
    "Unfulfilled Orders Log": orders,
    "Inventory Units": orders.map((o) => unit(o.id, o.unitFields || {}))
  });
}

test("dates: the last day of the month, due a week later, months in Dutch time", () => {
  assert.equal(lastDayOf("2026-09"), "2026-09-30");
  assert.equal(lastDayOf("2024-02"), "2024-02-29");
  assert.equal(dueDate("2026-09-30"), "2026-10-07");
  assert.equal(monthOf("2026-09-30T22:30:00.000Z"), "2026-10");
  assert.throws(() => lastDayOf("2026-13"));
});

test("the reference is the same for the same pairs in any order", () => {
  const plan = invoicePlan({ vatType: "Margin" });
  assert.equal(invoiceReference("2026-09", plan, ["recB", "recA"]), invoiceReference("2026-09", plan, ["recA", "recB"]));
  assert.notEqual(invoiceReference("2026-09", plan, ["recA"]), invoiceReference("2026-09", plan, ["recA", "recB"]));
});

test("the list shows only the self-billing store's waiting pairs, with the month of fulfilment", async () => {
  const { airtable } = base([
    order("recORDER000000a01", {}),
    order("recORDER000000a02", { "Fulfillment Status": "Ready to Ship" }),
    order("recORDER000000a03", { "Bookkeeping Status": "Invoiced" }),
    order("recORDER000000a04", { Client: ["recOTHER000000001"] })
  ]);

  const data = await createCollectiveInvoicesStore({ airtable, rompslomp: fakeRompslomp().client }).list();

  assert.equal(data.store.name, "APLUG.PL");
  assert.deepEqual(data.stores.map((s) => s.name), ["APLUG.PL"]);
  assert.deepEqual(data.pairs.map((p) => p.id), ["recORDER000000a01", "recORDER000000a02"]);
  assert.equal(data.pairs[0].month, "2026-09");
  assert.equal(data.pairs[1].month, "", "a pair not fulfilled yet belongs to no month");
  assert.equal(data.pairs[0].route, "Margin");
});

test("booking: one invoice per VAT route, dated the month's last day, a journal each, ids on every order", async () => {
  const { airtable, tables } = base([
    order("recORDER000000b01", { "Final Buying Price": 122.5 }),
    order("recORDER000000b02", { "Final Buying Price": 280, "Fulfillment Status": "Ready to Ship" }),
    order("recORDER000000b03", { "VAT Type": ["VAT0"], "Final Buying Price": 200 })
  ]);
  const rs = fakeRompslomp();

  const result = await createCollectiveInvoicesStore({ airtable, rompslomp: rs.client })
    .book({ store: STORE, month: "2026-09", ids: ["recORDER000000b01", "recORDER000000b02", "recORDER000000b03"] });

  assert.equal(result.invoices.length, 2);
  const [margin, vat0] = rs.calls.filter((c) => c[0] === "create").map((c) => c[1].sales_invoice);

  assert.equal(margin.date, "2026-09-30");
  assert.equal(margin.due_date, "2026-10-07");
  assert.equal(margin.template_id, 322464949);
  assert.equal(margin.vat_number, null);
  assert.equal(margin.invoice_lines.length, 2);
  assert.equal(margin.invoice_lines[0].price_per_unit, "122.5");
  assert.equal(margin.invoice_lines[0].extended_description, "42 · ORD-b01");
  assert.equal(margin.invoice_lines[0].account_id, undefined, "a margin line carries no revenue account, as in the engine");

  assert.equal(vat0.template_id, null);
  assert.equal(vat0.vat_type_id, undefined);
  assert.equal(vat0.invoice_lines[0].vat_type_id, 775036437, "VAT0 to a store outside NL is reverse charge");
  assert.equal(vat0.vat_number, "PL123");
  assert.equal(vat0.invoice_lines[0].account_id, 589136361);

  const journals = rs.calls.filter((c) => c[0] === "journal").map((c) => c[1].journal_entry);
  assert.equal(journals.length, 2);
  assert.equal(journals[0].date, "2026-09-30");
  assert.equal(journals[0].lines[0].account_id, 1537847149);
  assert.equal(journals[0].lines[0].debit_amount, "160");
  assert.equal(journals[1].lines[0].account_id, 306471935);
  assert.equal(journals[1].lines[1].credit_amount, "80");

  const orders = tables["Unfulfilled Orders Log"];
  for (const o of orders) {
    assert.equal(o.fields["Bookkeeping Status"], "Invoiced");
    assert.ok(o.fields["Rompslomp Invoice Number"].startsWith("KC202609-"));
    assert.ok(o.fields["Rompslomp Journal Entry ID"]);
    assert.ok(o.fields["Invoice Sent At"], "the engine's done mark, so it leaves the order alone");
  }
  assert.equal(orders[0].fields["Rompslomp Invoice ID"], orders[1].fields["Rompslomp Invoice ID"]);
  assert.notEqual(orders[0].fields["Rompslomp Invoice ID"], orders[2].fields["Rompslomp Invoice ID"]);

  // The contact found by name is kept on the store.
  assert.equal(tables.Merchants[0].fields["Rompslomp Contact ID"], "77");
});

test("a pair that is no longer waiting, or another store's, is refused before anything is made", async () => {
  const { airtable } = base([
    order("recORDER000000c01", {}),
    order("recORDER000000c02", { "Bookkeeping Status": "Invoiced" }),
    order("recORDER000000c03", { Client: ["recOTHER000000001"] })
  ]);
  const rs = fakeRompslomp();
  const store = createCollectiveInvoicesStore({ airtable, rompslomp: rs.client });

  await assert.rejects(store.book({ store: STORE, month: "2026-09", ids: ["recORDER000000c01", "recORDER000000c02"] }), /not awaiting self-billing/);
  await assert.rejects(store.book({ store: STORE, month: "2026-09", ids: ["recORDER000000c03"] }), /not APLUG\.PL's/);
  await assert.rejects(store.book({ store: "recOTHER000000001", month: "2026-09", ids: ["recORDER000000c01"] }), /not on self-billing/);
  await assert.rejects(store.book({ store: STORE, month: "", ids: ["recORDER000000c01"] }), /Pick a month/);
  assert.equal(rs.invoices.length, 0);
});

test("a run that died after the invoice is finished, not invoiced twice", async () => {
  const { airtable, tables } = base([order("recORDER000000d01", {}), order("recORDER000000d02", {})]);
  const rs = fakeRompslomp();
  const client = { ...rs.client, createJournal: async () => { throw new Error("Rompslomp said no (500)"); } };
  const ids = ["recORDER000000d01", "recORDER000000d02"];

  await assert.rejects(createCollectiveInvoicesStore({ airtable, rompslomp: client }).book({ store: STORE, month: "2026-09", ids }));

  // The invoice is on the orders; they are still waiting.
  assert.ok(tables["Unfulfilled Orders Log"][0].fields["Rompslomp Invoice Number"]);
  assert.equal(tables["Unfulfilled Orders Log"][0].fields["Bookkeeping Status"], "Awaiting self-billing");

  await createCollectiveInvoicesStore({ airtable, rompslomp: rs.client }).book({ store: STORE, month: "2026-09", ids });

  assert.equal(rs.invoices.length, 1, "the same invoice, not a second one");
  assert.equal(rs.calls.filter((c) => c[0] === "journal").length, 1);
  assert.equal(tables["Unfulfilled Orders Log"][1].fields["Bookkeeping Status"], "Invoiced");
});

test("a total Rompslomp works out differently is reported", async () => {
  const { airtable } = base([order("recORDER000000e01", {})]);
  const rs = fakeRompslomp({ priceWithVat: 99 });

  const result = await createCollectiveInvoicesStore({ airtable, rompslomp: rs.client }).book({ store: STORE, month: "2026-09", ids: ["recORDER000000e01"] });
  assert.match(result.notes[0], /came out at €99\.00, the pairs add up to €100\.00/);
});

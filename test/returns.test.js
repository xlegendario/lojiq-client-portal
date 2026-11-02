import test from "node:test";
import assert from "node:assert/strict";
import { createReturns, ownerOf } from "../admin/returns.js";
import { loadPayouts, markUnitsPaid } from "../admin/adminPayouts.js";

/* ---------------- fakes ---------------- */

// Enough of PostgREST for what returns.js asks: eq, in, ilike, or, limit.
function fakeDb(tables = {}) {
  const data = { returns: [], partner_stock: [], consignment_inventory: [], bol_barcodes: [], ...tables };
  let n = 0;

  const match = (row, key, cond) => {
    const [op, ...rest] = cond.split(".");
    const value = decodeURIComponent(rest.join("."));
    const have = row[key] === null || row[key] === undefined ? "" : String(row[key]);
    if (op === "eq") return have === value;
    if (op === "ilike") return have.toLowerCase() === value.toLowerCase();
    if (op === "is") return value === "null" ? !have : true;
    if (op === "in") return value.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/"/g, "")).includes(have);
    throw new Error(`fake db: ${op}`);
  };

  function filter(path) {
    const [table, query = ""] = path.split("?");
    let rows = data[table] || [];
    let limit = Infinity;
    for (const part of query.split("&").filter(Boolean)) {
      const [key, ...v] = part.split("=");
      const cond = v.join("=");
      if (["select", "order"].includes(key)) continue;
      if (key === "limit") { limit = Number(cond); continue; }
      if (key === "or") {
        const alts = cond.replace(/^\(|\)$/g, "").split(",").map((c) => { const [k, ...r] = c.split("."); return [k, r.join(".")]; });
        rows = rows.filter((row) => alts.some(([k, c]) => match(row, k, c)));
        continue;
      }
      rows = rows.filter((row) => match(row, key, cond));
    }
    return { table, rows: rows.slice(0, limit) };
  }

  return {
    data,
    async get(path) { return filter(path).rows.map((r) => ({ ...r })); },
    async insert(table, rows) {
      const made = rows.map((r) => ({ id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, return_number: n, status: "expected", todo: [], log: [], created_at: new Date().toISOString(), ...r }));
      data[table] = [...(data[table] || []), ...made];
      return made;
    },
    async patch(path, fields) {
      const { rows } = filter(path);
      for (const row of rows) Object.assign(row, fields);
      return rows.map((r) => ({ ...r }));
    },
    async remove(path) {
      const { table, rows } = filter(path);
      data[table] = data[table].filter((r) => !rows.includes(r));
    }
  };
}

function fakeAirtable(tables) {
  const writes = [];
  return {
    writes,
    tables,
    async byIds(table, ids) {
      const out = new Map();
      for (const id of ids) if (tables[table]?.[id]) out.set(id, { ...tables[table][id] });
      return out;
    },
    async select(table, { formula = "" } = {}) {
      const rows = Object.entries(tables[table] || {}).map(([id, fields]) => ({ id, fields }));
      // The few formulas used: a unit of a partner on To Pay at a price, an order by sale id.
      if (/Payment Status\} = 'To Pay'/.test(formula)) {
        const price = Number(/Purchase Price\} = ([\d.]+)/.exec(formula)[1]);
        return { records: rows.filter((r) => r.fields["Payment Status"] === "To Pay" && r.fields["Availability Status"] === "Sold" && Number(r.fields["Purchase Price"]) === price) };
      }
      if (/Marketplace Sale ID/.test(formula)) {
        const id = /'([^']+)'/.exec(formula)[1];
        return { records: rows.filter((r) => r.fields["Marketplace Sale ID"] === id || r.fields["Shopify Order Number"] === id) };
      }
      if (/Availability Status\} = 'Troubled'/.test(formula)) return { records: rows.filter((r) => r.fields["Availability Status"] === "Troubled") };
      return { records: rows };
    },
    async update(table, id, fields, options = {}) {
      writes.push({ table, id, fields, typecast: Boolean(options.typecast) });
      Object.assign(tables[table][id], fields);
      return { id, fields };
    }
  };
}

function fakeRompslomp({ invoice }) {
  const made = { invoices: [], journals: [], payments: [] };
  return {
    made,
    configured: true,
    companyId: "1296508534",
    async getInvoice(id) { return String(id) === String(invoice.id) ? invoice : null; },
    async findInvoice(reference) { return made.invoices.find((i) => i.api_reference === reference) || null; },
    async createInvoice(body) {
      const lines = body.sales_invoice.invoice_lines;
      const total = lines.reduce((sum, l) => sum + Number(l.price_per_unit), 0);
      const row = { id: 900 + made.invoices.length, ...body.sales_invoice, status: "concept", price_with_vat: total };
      made.invoices.push(row);
      return row;
    },
    async publishInvoice(id) {
      const row = made.invoices.find((i) => i.id === id);
      Object.assign(row, { status: "published", invoice_number: `KC-CREDIT-${id}` });
      return row;
    },
    async recentJournals() { return made.journals; },
    async createJournal(body) { const j = { id: 1, ...body.journal_entry }; made.journals.push(j); return j; },
    async accounts() { return [{ id: 950141831, name: "Kruisposten", path: "activa.liquid_assets.kruisposten_custom" }]; },
    async createPayment(p) { made.payments.push(p); return { id: made.payments.length }; },
    async searchContacts() { return []; },
    async invoicesOfContact() { return []; }
  };
}

function fakePurchases({ expense = { expense_id: "77", expense_number: "IN-77", amount: 100, credited: false } } = {}) {
  const calls = { credit: [], kruispost: [] };
  return {
    calls,
    async findPurchase() { return expense; },
    async credit(args) { calls.credit.push(args); return { expense_id: "78", expense_number: "IN-78" }; },
    async kruispost(args) { calls.kruispost.push(args); return ["1", "2"]; }
  };
}

const ORDER = "recORDER000000001";
const UNIT = "recUNIT0000000001";
const MERCHANT = "recMERCH000000001";

function world({ unit = {}, order = {}, invoice } = {}) {
  const tables = {
    "Unfulfilled Orders Log": {
      [ORDER]: {
        "Order ID": "ORD-030001", "Fulfillment Status": "Fulfilled", "Shipping Status": "Delivered",
        "Store Name": ["Teststore"], Client: [MERCHANT], "Linked Inventory Unit": [UNIT], SKU: ["DD1391-100"], Size: "42",
        "VAT Type": ["Margin"], "Client Country": ["Netherlands"], "Rompslomp Invoice ID": "500", "Rompslomp Invoice Number": "KC2026-500",
        "Bookkeeping Status": "Invoiced", "Invoice Status": "Awaiting Payment", "Created Time": "2026-10-01T10:00:00.000Z",
        ...order
      }
    },
    "Inventory Units": {
      [UNIT]: {
        "Item ID": "CS-009001", Type: "Consignment", "Availability Status": "Sold", "Payment Status": "To Pay", "Purchase Price": 100,
        "Final Purchase Price": 100, "Seller ID": ["recSELLER00000001"], "Seller ID (Lookup)": ["SE-00035"], "Seller Name": ["Dominik"],
        SKU: ["DD1391-100"], Size: "42", "Product Name": "Dunk Low", "VAT Type": "Margin", "Item Condition": "",
        ...unit
      }
    },
    Merchants: { [MERCHANT]: { "Store Name": "Teststore", Country: "Netherlands", "Rompslomp Contact ID": "12" } }
  };

  const inv = invoice || {
    id: 500, invoice_number: "KC2026-500", description: "ORD-030001", contact_id: 12, template_id: 322464949,
    invoice_lines: [{ description: "Dunk Low", extended_description: "42", price_per_unit: "150.0", quantity: "1.0", vat_type_id: 688369464 }]
  };

  const db = fakeDb();
  const airtable = fakeAirtable(tables);
  const rompslomp = fakeRompslomp({ invoice: inv });
  const purchases = fakePurchases();
  const returns = createReturns({ db, airtable, rompslomp, purchases, locations: async () => ["APLUG.PL", "Emilio"] });
  return { db, airtable, rompslomp, purchases, returns, tables };
}

/* ---------------- who owns a pair ---------------- */

test("a unit is a partner's, a seller's or our own", () => {
  assert.equal(ownerOf({ Type: "Partner Consignment", "Seller ID (Lookup)": ["SE-00781"] }), "partner");
  assert.equal(ownerOf({ Type: "Consignment", "Item ID": "CS-1", "Seller ID (Lookup)": ["SE-00035"] }), "seller");
  assert.equal(ownerOf({ Type: "Direct", "Item ID": "OUT-1", "Seller ID (Lookup)": ["SE-00035"] }), "seller");
  assert.equal(ownerOf({ Type: "Custom", "Item ID": "KC-1" }), "own");
});

/* ---------------- cancelling ---------------- */

test("a shipped pair that comes back: credited, stock back, Kruisposten, expected", async () => {
  const w = world();
  const out = await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" }, by: "Dario" });

  const credit = w.rompslomp.made.invoices[0];
  assert.equal(credit.api_reference, `credit-500-${ORDER}`);
  assert.equal(credit.invoice_lines[0].price_per_unit, "-150.00000");
  assert.equal(w.rompslomp.made.journals.length, 1);
  assert.equal(w.rompslomp.made.journals[0].lines[0].account_id, 1981496874, "stock is debited: the pair is back");
  assert.equal(w.rompslomp.made.journals[0].lines[0].debit_amount, "100");
  assert.deepEqual(w.rompslomp.made.payments.map((p) => p.amount), [150, -150]);
  assert.match(w.rompslomp.made.payments[0].description, /Kruispost ORD-030001: KC2026-500/);

  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Returning");
  assert.equal(unit["Payment Status"], "To Pay", "the seller's money waits for the scan");
  assert.ok(w.airtable.writes.some((x) => x.id === UNIT && x.typecast), "a new select option needs typecast");
  assert.equal(w.tables["Unfulfilled Orders Log"][ORDER]["Fulfillment Status"], "Returned");
  assert.equal(w.tables["Unfulfilled Orders Log"][ORDER]["Rompslomp Credit Invoice Number"], "KC-CREDIT-900");

  assert.equal(w.db.data.returns.length, 1);
  assert.equal(w.db.data.returns[0].status, "expected");
  assert.equal(out.return_number, 1);

  // A second cancel on the same pair is refused: one return per pair.
  w.tables["Unfulfilled Orders Log"][ORDER]["Rompslomp Credit Invoice Number"] = "";
  await assert.rejects(w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } }), /already an open return/);
});

test("lost on the way: credited, but the stock correction stays", async () => {
  const w = world();
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "lost" } });
  assert.equal(w.rompslomp.made.invoices.length, 1);
  assert.equal(w.rompslomp.made.journals.length, 0);
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Lost");
  assert.equal(w.db.data.returns[0].status, "done");
});

test("written off needs a reason, store consign a location", async () => {
  const w = world();
  await assert.rejects(w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "written_off" } }), /Say why/);
  await assert.rejects(w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "store_consign" } }), /location/);

  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "store_consign", location: "__new", new_location: "Reseller Milano" } });
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Available");
  assert.equal(unit.Location, "Reseller Milano");
  assert.ok(w.airtable.writes.find((x) => x.id === UNIT && x.fields.Location).typecast, "a new location is made as an option");
});

test("a paid invoice is not settled on Kruisposten: the store gets its money back", async () => {
  const w = world({ order: { "Invoice Status": "Paid" } });
  const out = await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  assert.equal(w.rompslomp.made.payments.length, 0);
  assert.ok(out.todos.some((t) => t.kind === "refund_store"));
});

test("a collective invoice: only this order's line is credited", async () => {
  const w = world({
    invoice: {
      id: 500, invoice_number: "KC2026-500", description: "APLUG self-billing 2026-10", contact_id: 12,
      invoice_lines: [
        { description: "Dunk Low", extended_description: "41 · ORD-029999", price_per_unit: "120.0", quantity: "1.0", vat_type_id: 688369464 },
        { description: "Dunk Low", extended_description: "42 · ORD-030001", price_per_unit: "150.0", quantity: "1.0", vat_type_id: 688369464 }
      ]
    }
  });
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  const credit = w.rompslomp.made.invoices[0];
  assert.equal(credit.invoice_lines.length, 1);
  assert.equal(credit.invoice_lines[0].price_per_unit, "-150.00000");
  assert.match(credit.description, /KC2026-500 \(ORD-030001\)/);
});

test("a marketplace sale had no invoice: it comes off the booking list", async () => {
  const w = world({ order: { "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  assert.equal(w.rompslomp.made.invoices.length, 0);
  assert.equal(w.tables["Unfulfilled Orders Log"][ORDER]["Bookkeeping Status"], "Cancelled");
});

test("not shipped, the seller still has it: void, not owed, purchase credited, back in his stock", async () => {
  const w = world();
  w.db.data.consignment_inventory.push({ id: "c1", seller_record_id: "recSELLER00000001", sku: "DD1391-100", size: "42", quantity: 0, payout_price: null });
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "consignor_has" } });

  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Void");
  assert.equal(unit["Payment Status"], "Paid");
  assert.match(unit["Payment Note"], /^Not owed/);
  assert.equal(w.purchases.calls.credit.length, 1);
  assert.equal(w.purchases.calls.kruispost.length, 1, "nothing was paid: the purchase and its credit get Kruisposten");
  assert.equal(w.db.data.consignment_inventory[0].quantity, 1);
  assert.equal(w.tables["Unfulfilled Orders Log"][ORDER]["Fulfillment Status"], "Cancelled");
});

test("not shipped, a partner pair: back on his shelf", async () => {
  const w = world({ unit: { Type: "Partner Consignment", "Item ID": "PCS-009001", "Seller ID (Lookup)": ["SE-00781"] } });
  w.db.data.partner_stock.push({ id: "p1", seller_id: "SE-00781", sku: "DD1391-100", size: "42", status: "sold", partner_price: 100, sold_ref: "store order" });
  const plan = await w.returns.describeCancel("store", { id: ORDER, fields: w.tables["Unfulfilled Orders Log"][ORDER] });
  assert.equal(plan.selects.held[0].value, "partner");

  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "partner" } });
  assert.equal(w.db.data.partner_stock[0].status, "in_stock");
  assert.equal(w.db.data.partner_stock[0].sold_ref, null);
});

/* ---------------- the scan ---------------- */

async function expected(w) {
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  return w.db.data.returns[0];
}

test("OK at the scan, a seller's pair: back on sale, the seller is still owed", async () => {
  const w = world();
  const row = await expected(w);
  const done = await w.returns.receive(row.id, { verdict: "ok", by: "WMS" });
  assert.equal(done.status, "done");
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Available");
  assert.equal(unit["Payment Status"], "To Pay");
});

test("a flaw at the scan, a seller's pair we did not pay: back to him, not owed", async () => {
  const w = world();
  const row = await expected(w);
  await assert.rejects(w.returns.receive(row.id, { verdict: "flaw" }), /Describe the flaw/);
  const done = await w.returns.receive(row.id, { verdict: "flaw", note: "Scuffed toe" });
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Void");
  assert.equal(unit["Payment Status"], "Paid");
  assert.match(unit["Item Condition"], /Scuffed toe/);
  assert.ok(done.todo.some((t) => t.kind === "send_back"));
  assert.equal(w.purchases.calls.credit.length, 1);
});

test("a flaw at the scan, our own pair: Troubled Stock", async () => {
  const w = world({ unit: { Type: "Custom", "Item ID": "KC-1", "Seller ID (Lookup)": [], "Payment Status": "Paid" } });
  const row = await expected(w);
  await w.returns.receive(row.id, { verdict: "flaw", note: "Box damaged" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Troubled");
  assert.equal((await w.returns.troubled()).length, 1);
  await w.returns.resolveTroubled(UNIT, { action: "on_sale" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Available");
});

test("OK at the scan, a partner pair already paid: another To Pay pair is settled with it", async () => {
  const w = world({ unit: { Type: "Partner Consignment", "Item ID": "PCS-009001", "Seller ID (Lookup)": ["SE-00781"], "Payment Status": "Paid" } });
  w.tables["Inventory Units"].recUNIT0000000003 = { "Item ID": "PCS-009003", "Payment Status": "To Pay", "Availability Status": "Sold", "Purchase Price": 100, "Purchase Date": "2026-10-30" };
  w.tables["Inventory Units"].recUNIT0000000002 = { "Item ID": "PCS-009002", "Payment Status": "To Pay", "Availability Status": "Sold", "Purchase Price": 100, "Purchase Date": "2026-10-01" };
  w.db.data.partner_stock.push({ id: "p1", seller_id: "SE-00781", sku: "DD1391-100", size: "42", status: "sold", partner_price: 100 });
  const row = await expected(w);
  const done = await w.returns.receive(row.id, { verdict: "ok" });

  assert.equal(w.tables["Inventory Units"].recUNIT0000000002["Payment Status"], "Paid");
  assert.match(w.tables["Inventory Units"].recUNIT0000000002["Payment Note"], /Settled against returned PCS-009001/);
  assert.equal(w.db.data.partner_stock[0].status, "in_stock");
  assert.match(done.result, /PCS-009002/, "the oldest sale is settled first");
  assert.equal(w.tables["Inventory Units"].recUNIT0000000003["Payment Status"], "To Pay");
});

test("OK at the scan, a partner pair already paid and nothing to settle: ours", async () => {
  const w = world({ unit: { Type: "Partner Consignment", "Item ID": "PCS-009001", "Seller ID (Lookup)": ["SE-00781"], "Payment Status": "Paid" } });
  const row = await expected(w);
  await w.returns.receive(row.id, { verdict: "ok" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Available");
  assert.equal(w.db.data.partner_stock.length, 0);
});

test("a barcode typed in at the scan is learned", async () => {
  const w = world();
  assert.equal(await w.returns.learnBarcode("0198437224691", "DD1391-100", "42"), true);
  assert.equal(w.db.data.bol_barcodes[0].ean, "0198437224691");
  assert.equal(await w.returns.learnBarcode("0198437224691", "DD1391-100", "42"), false);
});

test("the scan offers returns of that SKU and size first", async () => {
  const w = world();
  await expected(w);
  const found = await w.returns.match({ sku: "dd1391-100", size: "42" });
  assert.equal(found.exact.length, 1);
});

/* ---------------- marketplaces ---------------- */

test("a marketplace return is written down once, and only that", async () => {
  const w = world({ order: { "Marketplace Sale ID": "W-123", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  const first = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-123", external_return_id: "woovin-W-123", marketplace_status: "return-processing" });
  const again = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-123", external_return_id: "woovin-W-123", marketplace_status: "refunded" });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(w.db.data.returns.length, 1);
  assert.equal(w.db.data.returns[0].marketplace_status, "refunded");
  assert.equal(w.rompslomp.made.invoices.length, 0, "nothing is credited by a marketplace on its own");
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Returning");
});

test("a marketplace sale that ended before shipping waits for a decision", async () => {
  const w = world({ order: { "Marketplace Sale ID": "W-9", "Shipping Status": "Pending", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-9", external_return_id: "woovin-W-9", shipped: false });
  assert.equal(out.return.status, "to_decide");
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Sold", "nothing moves before someone says where the pair is");

  await w.returns.decide(out.return.id, { held: "consignor_has" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Void");
  assert.equal(w.db.data.returns.length, 1);
  assert.equal(w.db.data.returns[0].source, "woovin");
  assert.equal(w.db.data.returns[0].status, "done");
});

/* ---------------- Seller Payouts ---------------- */

test("Seller Payouts shows a running return and will not pay it", async () => {
  const airtable = {
    async select() {
      return { records: [{ id: UNIT, fields: { "Item ID": "CS-009001", "Payment Status": "To Pay", "Final Purchase Price": 100, "Seller ID": ["recS"] } }] };
    },
    async byIds(table, ids) {
      return new Map(ids.map((id) => [id, { "Item ID": "CS-009001", "Payment Status": "To Pay", "Final Purchase Price": 100, "Seller ID": ["recS"] }]));
    },
    async update() {}
  };
  const openReturns = async (ids) => new Map(ids.filter((id) => id === UNIT).map((id) => [id, { return_number: 7, status: "expected" }]));

  const data = await loadPayouts(airtable, {}, { openReturns });
  assert.equal(data.groups[0].rows[0].return.number, "RET-7");
  await assert.rejects(markUnitsPaid({ ids: [UNIT], airtable, openReturns }), /RET-7/);
});

test("a sale that ended unshipped can still turn out to be a return", async () => {
  const w = world({ order: { "Marketplace Sale ID": "W-10", "Shipping Status": "Pending", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-10", external_return_id: "woovin-W-10", shipped: false });
  await w.returns.decide(out.return.id, { held: "coming_back" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Returning");
  assert.equal(w.db.data.returns.length, 1);
  assert.equal(w.db.data.returns[0].status, "expected");
  assert.equal(w.db.data.returns[0].external_return_id, "woovin-W-10");
});

test("a marketplace invoice is settled through its payouts, not on Kruisposten", async () => {
  const w = world({ order: { "Order Source": "Woovin Consignment" } });
  const out = await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  assert.equal(w.rompslomp.made.invoices.length, 1);
  assert.equal(w.rompslomp.made.payments.length, 0);
  assert.ok(out.todos.some((t) => t.kind === "marketplace_settle" && /Woovin/.test(t.text)));
});

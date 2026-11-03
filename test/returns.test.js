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

test("lost on the way: credited, and the cost moves from the cost of sales to Voorraadverschillen", async () => {
  const w = world();
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "lost" } });
  assert.equal(w.rompslomp.made.invoices.length, 1);
  assert.equal(w.rompslomp.made.journals.length, 1);
  const [debit, credit] = w.rompslomp.made.journals[0].lines;
  assert.equal(debit.account_id, 2146917640, "Voorraadverschillen");
  assert.notEqual(credit.account_id, 1981496874, "not the stock: the correction already took it off");
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Lost");
  assert.equal(w.tables["Inventory Units"][UNIT]["Verification Status"], "Lost");
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
  assert.equal(unit["Payment Status"], null, "off Seller Payouts");
  assert.equal(unit["Payment Note"], undefined, "the bank payment code is never written over");
  assert.match(unit["Item Condition"], /Not owed/);
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
  // Inactive until it ships: the seller sends the label.
  assert.equal(unit["Availability Status"], "Inactive");
  assert.equal(unit["Verification Status"], "Rejected");
  assert.equal(unit["Payment Status"], null);
  assert.match(unit["Item Condition"], /Scuffed toe/);
  assert.equal(done.seller_return_status, "label_requested");
  assert.equal(w.purchases.calls.credit.length, 1);

  await w.returns.sellerReturnStep(row.id, { step: "label_received", tracking: "3SABC123" });
  const shipped = await w.returns.sellerReturnStep(row.id, { step: "shipped" });
  assert.equal(shipped.seller_return_tracking, "3SABC123");
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Void");
  await assert.rejects(w.returns.sellerReturnStep(row.id, { step: "label_received" }), /Already/);
  assert.equal((await w.returns.list({ view: "returns_sellers" })).length, 1);
  await w.returns.sellerReturnStep(row.id, { step: "delivered" });
  assert.equal((await w.returns.list({ view: "returns_sellers" })).length, 0);
});

test("a flaw at the scan, a seller's pair we keep: Troubled Stock, and he is paid", async () => {
  const w = world();
  const row = await expected(w);
  await w.returns.receive(row.id, { verdict: "flaw", then: "troubled", note: "Small scuff, we sell it" });
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Troubled");
  assert.notEqual(unit["Payment Status"], null);
  assert.equal(w.purchases.calls.credit.length, 0);
});

test("OK at the scan, but the seller's pair goes back to him", async () => {
  const w = world();
  const row = await expected(w);
  const done = await w.returns.receive(row.id, { verdict: "ok", then: "send_back" });
  assert.equal(w.tables["Inventory Units"][UNIT]["Verification Status"], "Rejected");
  assert.equal(done.seller_return_status, "label_requested");
  assert.equal(w.purchases.calls.credit.length, 1);
});

test("not shipped, in our warehouse: keep, Troubled or back to the seller", async () => {
  const keep = world();
  await keep.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "warehouse", warehouse: "keep" } });
  assert.equal(keep.tables["Inventory Units"][UNIT]["Availability Status"], "Available");

  const trouble = world();
  await assert.rejects(trouble.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "warehouse", warehouse: "troubled" } }), /Describe/);
  await trouble.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "warehouse", warehouse: "troubled", reason: "Glue stains" } });
  assert.equal(trouble.tables["Inventory Units"][UNIT]["Availability Status"], "Troubled");
  assert.equal(trouble.purchases.calls.credit.length, 0);

  const back = world();
  await back.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "warehouse", warehouse: "send_back", reason: "Wrong colourway" } });
  assert.equal(back.tables["Inventory Units"][UNIT]["Availability Status"], "Inactive");
  assert.equal(back.db.data.returns[0].seller_return_status, "label_requested");
  assert.equal(back.purchases.calls.credit.length, 1);
});

test("not shipped, the seller's pair is flawed: void, Rejected, not owed", async () => {
  const w = world();
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "flawed", reason: "Creased on the QC photos" } });
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Void");
  assert.equal(unit["Verification Status"], "Rejected");
  assert.equal(unit["Payment Status"], null);
  assert.equal(w.purchases.calls.credit.length, 1);
});

test("keep the order: credited, back to Outsource without its pair, and the new pair is invoiced", async () => {
  const w = world();
  const out = await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { order_action: "keep", shipped: "not_shipped", held: "consignor_gone" } });
  const order = w.tables["Unfulfilled Orders Log"][ORDER];
  assert.equal(order["Fulfillment Status"], "Outsource");
  assert.deepEqual(order["Linked Inventory Unit"], []);
  assert.equal(order["Rompslomp Invoice ID"], "");
  assert.equal(order["Rompslomp Credit Invoice Number"], "");
  assert.equal(order["Invoice Sent At"], null);
  assert.equal(order["Retry Invoice"], true);
  assert.equal(w.rompslomp.made.invoices.length, 1, "the old invoice is credited");
  assert.match(out.message, /back in Outsource/);
  assert.match(w.db.data.returns[0].result, /Order kept/);
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
  const w = world({ unit: { Type: "Partner Consignment", "Item ID": "PCS-009001", "Seller ID (Lookup)": ["SE-00781"], "Payment Status": "Paid", "Payment Note": "2400 (MO20261509)" } });
  w.tables["Inventory Units"].recUNIT0000000003 = { "Item ID": "PCS-009003", SKU: ["DD1391-100"], "Payment Status": "To Pay", "Availability Status": "Sold", "Purchase Price": 100, "Purchase Date": "2026-10-30" };
  w.tables["Inventory Units"].recUNIT0000000002 = { "Item ID": "PCS-009002", SKU: ["DD1391-100"], "Payment Status": "To Pay", "Availability Status": "Sold", "Purchase Price": 100, "Purchase Date": "2026-10-01" };
  // Older and the same price, but another SKU: never this one.
  w.tables["Inventory Units"].recUNIT0000000004 = { "Item ID": "PCS-009004", SKU: ["U9060ECA"], "Payment Status": "To Pay", "Availability Status": "Sold", "Purchase Price": 100, "Purchase Date": "2026-09-01" };
  w.db.data.partner_stock.push({ id: "p1", seller_id: "SE-00781", sku: "DD1391-100", size: "42", status: "sold", partner_price: 100 });
  const row = await expected(w);
  const done = await w.returns.receive(row.id, { verdict: "ok" });

  const swapped = w.tables["Inventory Units"].recUNIT0000000002;
  assert.equal(swapped["Payment Status"], "Paid");
  assert.equal(swapped["Payment Note"], "2400 (MO20261509)", "the bank payment's own note comes along");
  assert.match(swapped["Item Condition"], /Paid with the payment of returned PCS-009001/);
  const back = w.tables["Inventory Units"][UNIT];
  assert.equal(back["Payment Status"], null);
  assert.equal(back["Payment Note"], null);
  assert.match(back["Item Condition"], /now pays PCS-009002/);
  assert.equal(w.purchases.calls.credit.length, 1, "the returned pair's purchase is credited");
  assert.equal(w.db.data.partner_stock[0].status, "in_stock");
  assert.match(done.result, /PCS-009002/, "the oldest sale is settled first");
  assert.equal(w.tables["Inventory Units"].recUNIT0000000003["Payment Status"], "To Pay");
  assert.equal(w.tables["Inventory Units"].recUNIT0000000004["Payment Status"], "To Pay", "another SKU is never settled");
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

test("a box scanned while its return waits for a decision is taken as returned", async () => {
  const w = world({ order: { "Marketplace Sale ID": "W-11", "Shipping Status": "Pending", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-11", external_return_id: "woovin-W-11", shipped: false });
  const number = out.return.return_number;

  const found = await w.returns.match({ sku: "DD1391-100", size: "42" });
  assert.equal(found.exact.length, 1, "a return waiting for a decision can be scanned");

  const done = await w.returns.receive(out.return.id, { verdict: "ok", by: "WMS" });
  assert.equal(done.status, "done");
  assert.equal(done.return_number, number, "it keeps its RET number");
  assert.equal(w.db.data.returns.length, 1);
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Available");
});

test("a marketplace invoice is settled through its payouts, not on Kruisposten", async () => {
  const w = world({ order: { "Order Source": "Woovin Consignment" } });
  const out = await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "shipped", outcome: "return" } });
  assert.equal(w.rompslomp.made.invoices.length, 1);
  assert.equal(w.rompslomp.made.payments.length, 0);
  assert.ok(out.todos.some((t) => t.kind === "marketplace_settle" && /Woovin/.test(t.text)));
});

test("a partner's pair coming back shows as reserved, not sold, until it is scanned", async () => {
  const w = world({ unit: { "Item ID": "PCS-009001", Type: "Partner Consignment", "Seller ID (Lookup)": ["SE-00781"] }, order: { "Marketplace Sale ID": "W-20", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  w.db.data.partner_stock.push({ id: "p1", seller_id: "SE-00781", sku: "DD1391-100", size: "42", status: "sold", partner_price: 100 });

  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-20", external_return_id: "woovin-W-20" });
  assert.equal(w.db.data.partner_stock[0].status, "reserved");
  assert.equal(out.return.partner_stock_id, "p1");

  await w.returns.receive(out.return.id, { verdict: "ok" });
  assert.equal(w.db.data.partner_stock[0].status, "in_stock");
});

test("a partner's pair that never comes back is sold again", async () => {
  const w = world({ unit: { "Item ID": "PCS-009001", Type: "Partner Consignment", "Seller ID (Lookup)": ["SE-00781"] }, order: { "Marketplace Sale ID": "W-21", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  w.db.data.partner_stock.push({ id: "p1", seller_id: "SE-00781", sku: "DD1391-100", size: "42", status: "sold", partner_price: 100 });

  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-21", external_return_id: "woovin-W-21" });
  await w.returns.notComing(out.return.id, { note: "buyer kept it" });
  assert.equal(w.db.data.partner_stock[0].status, "sold");
});

test("a pair we lost before shipping: off stock, the seller still paid", async () => {
  const w = world({ unit: { "Item ID": "PCS-009001", Type: "Partner Consignment", "Seller ID (Lookup)": ["SE-00781"] }, order: { "Marketplace Sale ID": "W-22", "Shipping Status": "Pending", "Rompslomp Invoice ID": "", "Bookkeeping Status": "To book – marketplace" } });
  const out = await w.returns.announce({ source: "woovin", marketplace_order_id: "W-22", external_return_id: "woovin-W-22", shipped: false });

  await assert.rejects(w.returns.decide(out.return.id, { held: "lost" }), /what happened/);
  await w.returns.decide(out.return.id, { held: "lost", note: "not found on the shelf" });

  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Lost");
  assert.equal(unit["Payment Status"], "To Pay", "the partner is still paid");
  assert.equal(w.purchases.calls.credit.length, 0, "the purchase stands");
  assert.ok(w.db.data.returns[0].todo.some((t) => t.kind === "journal_by_hand"));
});

test("Mark paid writes the Payment Note of the bank payment", async () => {
  const written = [];
  const airtable = {
    async byIds(table, ids) {
      return new Map(ids.map((id) => [id, { "Item ID": "PCS-009001", "Payment Status": "To Pay", "Final Purchase Price": 100, "Seller ID": ["recS"], "Seller ID (Lookup)": ["SE-00781"] }]));
    },
    async update(table, id, fields) { written.push(fields); }
  };
  await markUnitsPaid({ ids: [UNIT], airtable, note: "100 (MON20260211)" });
  assert.deepEqual(written[0], { "Payment Status": "Paid", "Payment Note": "100 (MON20260211)" });
});

test("Seller Payouts shows an external sale's deal number as its order", async () => {
  const airtable = {
    async select() { return { records: [{ id: UNIT, fields: { "Item ID": "PCS-008597", "Payment Status": "To Pay", "Final Purchase Price": 60, "Seller ID": ["recS"], "External Deal ID": "EXTD-000144" } }] }; },
    async byIds() { return new Map(); }
  };
  const data = await loadPayouts(airtable, {});
  assert.equal(data.groups[0].rows[0].reference_id, "EXTD-000144");
});

test("not coming back: the stock the cancel put back goes to Voorraadverschillen", async () => {
  const w = world();
  const row = await expected(w);
  assert.equal(w.rompslomp.made.journals.length, 1, "the cancel put the stock back");
  const closed = await w.returns.notComing(row.id, { note: "buyer kept it" });
  assert.equal(w.rompslomp.made.journals.length, 2);
  const [debit, credit] = w.rompslomp.made.journals[1].lines;
  assert.equal(debit.account_id, 2146917640);
  assert.equal(credit.account_id, 1981496874);
  assert.equal(debit.debit_amount, w.rompslomp.made.journals[0].lines[0].debit_amount, "by the amount the cancel put back");
  assert.ok(!closed.todo.some((t) => t.kind === "journal_by_hand"), "nothing left to book by hand");
  assert.equal(w.tables["Inventory Units"][UNIT]["Verification Status"], "Lost");
});

test("a seller's refund ticked as received: Payment Status empty, Payment Note untouched", async () => {
  const w = world({ unit: { "Payment Status": "Paid", "Payment Note": "110" } });
  await w.returns.cancelOrder({ table: "store", recordId: ORDER, input: { shipped: "not_shipped", held: "consignor_gone" } });
  const row = w.db.data.returns[0];
  const claim = row.todo.find((t) => t.kind === "claim_seller");
  assert.ok(claim);
  assert.equal((await w.returns.list({ view: "refunds_sellers" })).length, 1);
  await w.returns.tick(row.id, claim.id, true, "Dario");
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Payment Status"], null);
  assert.equal(unit["Payment Note"], "110");
  assert.equal((await w.returns.list({ view: "refunds_sellers" })).length, 0);
});

/* ---------------- External Sales pairs ---------------- */

const SALE_ID = "11111111-1111-1111-1111-111111111111";
const PAIR_ID = "22222222-2222-2222-2222-222222222222";

function externalWorld(unit = {}, pair = {}) {
  const w = world({ unit });
  w.db.data.external_sale_pairs = [{ id: PAIR_ID, sale_id: SALE_ID, item_id: "CS-009001", sku: "DD1391-100", size: "42", inventory_unit_record_id: UNIT, purchase_expense_id: "707", purchase_price_ex_vat: 100, consignor_fulfillment_status: "Ready to Ship", consignor_shipping_status: "Pending", ...pair }];
  w.db.data.deal_lines = [{ id: "33333333-3333-3333-3333-333333333333", external_sale_pair_id: PAIR_ID, status: "confirmed" }];
  w.purchases.credit = async (args) => { w.purchases.calls.credit.push(args); return { expense_id: "708", expense_number: "IN-708", original_number: "IN-707", amount: 100 }; };
  const told = [];
  w.returns = createReturns({ db: w.db, airtable: w.airtable, rompslomp: w.rompslomp, purchases: w.purchases, returnToConsignor: async (body) => { told.push(body); return { ok: true }; } });
  w.told = told;
  return w;
}

const extArgs = (w, outcome, extra = {}) => ({ sale: { id: SALE_ID, deal_number: 129 }, pair: w.db.data.external_sale_pairs[0], outcome, deal: "EXTD-000129", buyer: "OVERCEZ", by: "Dario", ...extra });

test("External: back to the consignor - Void, not owed, his purchase credited by its own expense and settled, one RET line (CS-008267)", async () => {
  const w = externalWorld({ "Payment Note": "€ 110" });
  const { row } = await w.returns.cancelExternalPair(extArgs(w, "to_consignor", { books: { credit: "KC-C1", stockBack: true } }));
  const unit = w.tables["Inventory Units"][UNIT];
  assert.equal(unit["Availability Status"], "Void");
  assert.equal(unit["Verification Status"], "Cancelled");
  assert.equal(unit["Payment Status"], null);
  assert.equal(unit["Payment Note"], "€ 110");
  assert.equal(w.purchases.calls.credit[0].expenseId, "707", "the pair's own expense, not one found by name");
  assert.equal(w.purchases.calls.kruispost.length, 1);
  assert.equal(w.db.data.external_sale_pairs[0].purchase_credit_expense_id, "708");
  assert.equal(w.told[0].shipped, false);
  assert.equal(row.source, "external");
  assert.equal(row.order_id, "EXTD-000129");
  assert.equal(row.status, "done");
  assert.ok(row.todo.some((t) => t.kind === "link_kruispost"));
});

test("External: it comes back - Returning and expected; the scan sends the seller's pair back and credits its own purchase", async () => {
  const w = externalWorld();
  const { row } = await w.returns.cancelExternalPair(extArgs(w, "return", { books: { credit: "KC-C1", stockBack: true } }));
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Returning");
  assert.equal(row.status, "expected");
  const done = await w.returns.receive(row.id, { verdict: "flaw", then: "send_back", note: "Wrong pair" });
  assert.equal(done.seller_return_status, "label_requested");
  assert.equal(w.purchases.calls.credit[0].expenseId, "707");

  // Not coming back would have booked the stock off again by the amount put back.
  const w2 = externalWorld();
  const { row: r2 } = await w2.returns.cancelExternalPair(extArgs(w2, "return", { books: { credit: "KC-C1", stockBack: true } }));
  await w2.returns.notComing(r2.id, { note: "kept" });
  assert.equal(w2.rompslomp.made.journals.at(-1).lines[0].account_id, 2146917640);
  assert.equal(w2.rompslomp.made.journals.at(-1).lines[0].debit_amount, "100");
});

test("External: lost by the carrier - Lost, the seller still paid, the cost to Voorraadverschillen", async () => {
  const w = externalWorld();
  await w.returns.cancelExternalPair(extArgs(w, "lost", { books: { credit: "KC-C1", stockBack: false, costAccount: { id: 1537847149, path: "profit.costs.sneakers_marge_custom" } } }));
  assert.equal(w.tables["Inventory Units"][UNIT]["Availability Status"], "Lost");
  assert.equal(w.tables["Inventory Units"][UNIT]["Payment Status"], "To Pay");
  const [debit, credit] = w.rompslomp.made.journals[0].lines;
  assert.equal(debit.account_id, 2146917640);
  assert.equal(credit.account_id, 1537847149);
  assert.equal(w.purchases.calls.credit.length, 0);
});

test("External: our own pair cannot go back to a seller, and a flaw needs words", async () => {
  const w = externalWorld({ Type: "Custom", "Item ID": "KC-1", "Seller ID (Lookup)": [] }, { consignor_fulfillment_status: null });
  await assert.rejects(w.returns.cancelExternalPair(extArgs(w, "to_consignor")), /no seller/);
  await assert.rejects(w.returns.cancelExternalPair(extArgs(w, "troubled")), /reason/);
});

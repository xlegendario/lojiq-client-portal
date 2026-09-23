import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { createOutboundMaker, planOutbound, spreadPrices } from "../admin/externalSalesCreate.js";

/* ---------------- spreading the price ---------------- */

test("the total is spread by purchase, so every pair makes the same margin", () => {
  assert.deepEqual(spreadPrices(660, [500, 100]), [550, 110]);
});

test("the cents always add up to the total", () => {
  const prices = spreadPrices(100, [1, 1, 1]);
  assert.equal(Math.round(prices.reduce((a, b) => a + b, 0) * 100), 10000);
  assert.deepEqual(prices, [33.34, 33.33, 33.33]);

  const many = spreadPrices(1690.5, [65, 90, 90, 90, 95, 90, 85, 88, 88, 88, 88, 88, 88, 160, 180, 200]);
  assert.equal(Math.round(many.reduce((a, b) => a + b, 0) * 100), 169050);
});

test("without purchase prices the split is even", () => {
  assert.deepEqual(spreadPrices(90, [0, 0, 0]), [30, 30, 30]);
});

/* ---------------- the plan ---------------- */

const BUYER = "7f3c2a10-1111-4222-8333-944455556666";
const buyer = (extra = {}) => ({ id: BUYER, buyer_number: 22, company_name: "DPX Capital s.r.o.", email: "b@x.cz", address: "Main 1", zipcode: "100", city: "Praha", country: "Czech Republic", country_code: "CZ", vat_id: "CZ23343567", airtable_record_id: "recBUYERxxxxxxxxx", ...extra });

const unit = (extra = {}) => ({ "Item ID": "IU-1", SKU: "JR9632", Size: "44", "VAT Type": "Margin", "Final Purchase Price": 150, "Availability Status": "Available", ...extra });

test("a margin pair and a VAT pair to a business abroad: margin and 0%", () => {
  const units = new Map([
    ["recUNIT0000000001", unit()],
    ["recUNIT0000000002", unit({ "Item ID": "IU-2", SKU: "IF1787-100", "VAT Type": "VAT21", "Final Purchase Price": 121, "Final Purchase Price (ex. VAT)": 100 })]
  ]);
  const plan = planOutbound({ buyer: buyer(), unitIds: ["recUNIT0000000001", "recUNIT0000000002"], units, total: 275, parcels: [{ tracking_number: "1Z999AA10123456784" }] });

  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.deepEqual(plan.pairs.map((p) => [p.selling_vat_type, p.selling_price]), [["Margin", 165], ["VAT0", 110]]);
  assert.equal(plan.totals.invoices, 2);
  assert.equal(plan.pairs[1].profit, 10);
});

test("everything that blocks the outbound is said at once", () => {
  const units = new Map([["recUNIT0000000001", unit({ "Availability Status": "Reserved", "VAT Type": "", "Final Purchase Price": 0 })]]);
  const plan = planOutbound({
    buyer: buyer({ email: "", address: "" }),
    unitIds: ["recUNIT0000000001"],
    units,
    total: 0,
    parcels: [{ tracking_number: "", label_url: "https://r2/l.pdf" }]
  });
  const all = plan.problems.join(" | ");
  assert.equal(plan.ok, false);
  for (const re of [/no email/, /address is incomplete/, /is Reserved, not Available/, /no VAT Type/, /no purchase price/, /total selling price/, /Label 1 has no tracking number/]) {
    assert.match(all, re);
  }
});

/* ---------------- making it ---------------- */

function fakeAirtable(units, { failOn = "" } = {}) {
  const updates = [];
  const created = [];
  let next = 1;

  return {
    updates,
    created,
    async create(table, fields) {
      if (failOn === "create") throw new Error("Airtable said no");
      const id = `recNEWUNIT${String(next).padStart(6, "0")}`;
      next += 1;
      created.push({ id, fields });
      units[id] = { ...fields, "Item ID": `PCS-00${600 + next}` };
      return { id, fields: units[id] };
    },
    async byIds(table, ids) { return new Map(ids.filter((id) => units[id]).map((id) => [id, units[id]])); },
    async update(table, id, fields) {
      if (id === failOn && fields["Availability Status"] === "Reserved") throw new Error("Airtable said no");
      updates.push({ id, fields });
      Object.assign(units[id], fields);
      return { id, fields: units[id] };
    }
  };
}

test("an outbound: deal, pairs, parcels, units reserved, invoice", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [] });
  // The sequence gives the deal its number.
  const insert = db.insert.bind(db);
  db.insert = async (table, rows) => insert(table, table === "external_sales" ? rows.map((r) => ({ deal_number: 78, ...r })) : rows);

  const units = { recUNIT0000000001: unit(), recUNIT0000000002: unit({ "Item ID": "IU-2", Size: "43" }) };
  const airtable = fakeAirtable(units);
  const invoiced = [];
  const maker = createOutboundMaker({ db, airtable, invoicing: { invoice: async (id, opts) => { invoiced.push({ id, opts }); return { log: ["Invoice KC1"] }; } } });

  const out = await maker.create({ buyer_id: BUYER, unit_ids: ["recUNIT0000000001", "recUNIT0000000002"], total_selling_price: 330, labels_needed: 1, parcels: [{ tracking_number: "1Z999AA10123456784", label_url: "https://r2/l.pdf", label_filename: "l.pdf" }] });

  assert.equal(out.deal, "EXTD-000078");
  assert.deepEqual(out.invoice_log, ["Invoice KC1"]);
  assert.equal(db.tables.external_sales[0].shipping_status, "ready_to_ship");
  assert.equal(db.tables.external_sales[0].buyer_id, "BU-00022");
  assert.equal(db.tables.external_sale_pairs.length, 2);
  assert.deepEqual(db.tables.external_sale_pairs.map((p) => p.selling_price), [165, 165]);
  assert.equal(db.tables.shipments[0].tracking_number, "1Z999AA10123456784");
  assert.deepEqual(airtable.updates.map((u) => u.fields["External Deal ID"]), ["EXTD-000078", "EXTD-000078"]);
  assert.equal(units.recUNIT0000000001["Availability Status"], "Reserved");
  assert.equal(invoiced[0].opts.mail, true);
});

test("when a unit cannot be reserved, nothing is left behind", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [] });
  const units = { recUNIT0000000001: unit(), recUNIT0000000002: unit({ "Item ID": "IU-2" }) };
  const airtable = fakeAirtable(units, { failOn: "recUNIT0000000002" });
  const maker = createOutboundMaker({ db, airtable, invoicing: { invoice: async () => assert.fail("no invoice") } });

  await assert.rejects(maker.create({ buyer_id: BUYER, unit_ids: ["recUNIT0000000001", "recUNIT0000000002"], total_selling_price: 300 }), /was not made: Airtable said no/);
  assert.equal(db.tables.external_sales.length, 0, "the deal is taken out again");
  assert.equal(units.recUNIT0000000001["Availability Status"], "Available", "the first unit is back on Available");
});

test("a failed invoice leaves the deal, and says so", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [] });
  const units = { recUNIT0000000001: unit() };
  const maker = createOutboundMaker({ db, airtable: fakeAirtable(units), invoicing: { invoice: async () => { throw new Error("Rompslomp is down"); } } });

  const out = await maker.create({ buyer_id: BUYER, unit_ids: ["recUNIT0000000001"], total_selling_price: 165 });
  assert.equal(out.invoice_error, "Rompslomp is down");
  assert.equal(db.tables.external_sales[0].bookkeeping_status, "to_invoice");
});

test("paid before the outbound: paid at once, with its date", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [] });
  const units = { recUNIT0000000001: unit() };
  const maker = createOutboundMaker({ db, airtable: fakeAirtable(units), invoicing: { invoice: async () => ({ log: [] }) } });

  await maker.create({ buyer_id: BUYER, unit_ids: ["recUNIT0000000001"], total_selling_price: 165, payment: { method: "paid", paid_at: "2026-09-20", note: "Cash at pickup" } });
  assert.equal(db.tables.external_sales[0].payment_status, "paid");
  assert.equal(db.tables.external_sales[0].paid_at, "2026-09-20T12:00:00Z");
  assert.equal(db.tables.external_sales[0].payment_note, "Cash at pickup");
});

/* ---------------- a partner's pair ---------------- */

const PARTNER_PAIR = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  sku: "A01FW702-BLK",
  size: "42",
  product_name: "Asics Gel-Kayano 14",
  brand: "Asics",
  barcode: "4550456789012",
  vat_type: "Margin",
  partner_price: 100,
  seller_id: "SE-00781",
  seller_record_id: "recPARTNER000001",
  status: "in_stock",
  mode: "both"
};

test("a sale of nothing but partner pairs is a sale", () => {
  const plan = planOutbound({
    buyer: buyer(),
    unitIds: [],
    units: new Map(),
    partnerPairs: [PARTNER_PAIR],
    total: 125
  });

  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.totals.purchase, 100);
});

test("a partner pair becomes ours the moment it is sold", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [], partner_stock: [{ ...PARTNER_PAIR }] });
  const insert = db.insert.bind(db);
  db.insert = async (table, rows) => insert(table, table === "external_sales" ? rows.map((r) => ({ deal_number: 90, ...r })) : rows);

  const units = { recUNIT0000000001: unit() };
  const airtable = fakeAirtable(units);
  const maker = createOutboundMaker({ db, airtable, invoicing: { invoice: async () => ({ log: ["Invoice KC1"] }) } });

  const out = await maker.create({
    buyer_id: BUYER,
    unit_ids: ["recUNIT0000000001"],
    partner_pair_ids: [PARTNER_PAIR.id],
    total_selling_price: 400
  });

  assert.equal(out.pairs, 2);

  // The unit is made with what we owe the partner, to pay later.
  const madeUnit = airtable.created[0].fields;
  assert.equal(madeUnit["Type"], "Partner Consignment");
  assert.equal(madeUnit["Purchase Price"], 100);
  assert.equal(madeUnit["Payment Status"], "To Pay");
  assert.equal(madeUnit["Availability Status"], "Reserved");
  assert.equal(madeUnit["External Deal ID"], "EXTD-000090");
  assert.deepEqual(madeUnit["Seller ID"], ["recPARTNER000001"]);
  assert.equal(madeUnit["Product GTIN"], "4550456789012");
  assert.equal(madeUnit["Ticket Number"], "EXTD-000090");

  // The pair on the deal knows both sides.
  const partnerPairRow = db.tables.external_sale_pairs.find((p) => p.partner_stock_id);
  assert.equal(partnerPairRow.inventory_unit_record_id, airtable.created[0].id);
  assert.equal(partnerPairRow.purchase_price_ex_vat, 100);
  assert.ok(partnerPairRow.item_id);

  // And it is off the partner's shelf, with the deal as its reason.
  const shelf = db.tables.partner_stock[0];
  assert.equal(shelf.status, "sold");
  assert.equal(shelf.sold_ref, "EXTD-000090");
  assert.equal(shelf.inventory_unit_id, partnerPairRow.item_id);
});

test("a partner pair another sale just took stops the outbound", async () => {
  const db = fakeDb({ buyers: [buyer()], external_sales: [], external_sale_pairs: [], shipments: [], partner_stock: [{ ...PARTNER_PAIR, status: "sold" }] });
  const airtable = fakeAirtable({});
  const maker = createOutboundMaker({ db, airtable, invoicing: { invoice: async () => assert.fail("no invoice") } });

  await assert.rejects(
    maker.create({ buyer_id: BUYER, partner_pair_ids: [PARTNER_PAIR.id], total_selling_price: 200 }),
    /not in stock any more/
  );

  assert.equal(db.tables.external_sales.length, 0, "no deal is left behind");
  assert.equal(db.tables.partner_stock[0].status, "sold", "the pair stays with the sale that took it");
  assert.equal(airtable.created.length, 0, "and no unit was made for it");
});

import test from "node:test";
import assert from "node:assert/strict";

import { externalSalesChecks } from "../admin/adminExternalSales.js";
import { fakeDb } from "./fakeSupabase.js";
import { createExternalSalesSync, labelKey, saleMoney, sellingVatType, shippingStatusFor } from "../admin/externalSalesSync.js";

/* ---------------- rules ---------------- */

test("the selling VAT follows the purchase and the buyer", () => {
  assert.equal(sellingVatType("Margin", { buyer_country_code: "DE", buyer_vat_id: "DE123" }), "Margin");
  assert.equal(sellingVatType("VAT21", { buyer_country_code: "NL", buyer_vat_id: "NL123B01" }), "VAT21");
  assert.equal(sellingVatType("VAT21", { buyer_country_code: "DE", buyer_vat_id: "DE123" }), "VAT0");
  assert.equal(sellingVatType("VAT0", { buyer_country_code: "DE", buyer_vat_id: "" }), "VAT21", "a private buyer abroad pays 21%");
  assert.equal(sellingVatType(null, {}), null);
});

test("profit takes the VAT off the margin, not the whole price", () => {
  // Margin: 200 sold, 100 bought -> VAT 100 x 21/121 = 17.36.
  const margin = saleMoney({ total_selling_price: 200, shipping_costs: 10, legacy_selling_vat_type: "Margin" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(margin.selling_ex_vat, 182.64);
  assert.equal(margin.profit, 72.64);

  const vat21 = saleMoney({ total_selling_price: 242, shipping_costs: 0, legacy_selling_vat_type: "VAT21" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(vat21.profit, 100);

  const vat0 = saleMoney({ total_selling_price: 150, shipping_costs: 5, legacy_selling_vat_type: "VAT0" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(vat0.profit, 45);
});

test("a mixed deal has no profit until every pair has its price", () => {
  const pairs = [
    { purchase_price_ex_vat: 100, selling_vat_type: "Margin", selling_price: null },
    { purchase_price_ex_vat: 100, selling_vat_type: "VAT21", selling_price: null }
  ];
  const unknown = saleMoney({ total_selling_price: 400, shipping_costs: 0, legacy_selling_vat_type: null }, pairs);
  assert.equal(unknown.profit, null);

  pairs[0].selling_price = 200;
  pairs[1].selling_price = 242;
  const known = saleMoney({ total_selling_price: 442, shipping_costs: 0, legacy_selling_vat_type: null }, pairs);
  assert.equal(known.selling_ex_vat, 382.64);
  assert.equal(known.profit, 182.64);
});

test("a label keeps its key through the copy to R2", () => {
  assert.equal(labelKey("label_astro (5).pdf"), labelKey("EXTD-000069-label_astro__5_.pdf"));
  assert.equal(labelKey("image.jpeg"), labelKey("EXTD-000063-image.pdf"));
  assert.equal(labelKey("EXTD-000076.pdf"), labelKey("EXTD-000076-EXTD-000076.pdf"));
  assert.notEqual(labelKey("a.pdf"), labelKey("b.pdf"));
});

test("shipping status: parcels make it ready, shipped and cancelled stay", () => {
  assert.equal(shippingStatusFor({ current: "pending", cancelled: false, parcels: 1 }), "ready_to_ship");
  assert.equal(shippingStatusFor({ current: "ready_to_ship", cancelled: false, parcels: 0 }), "pending");
  assert.equal(shippingStatusFor({ current: "ready_to_ship", cancelled: false, airtableStatus: "Ready to Ship", parcels: 0 }), "ready_to_ship");
  assert.equal(shippingStatusFor({ current: "shipped", cancelled: false, parcels: 0 }), "shipped");
  assert.equal(shippingStatusFor({ current: "pending", cancelled: false, airtableStatus: "Shipped", parcels: 0 }), "shipped");
  assert.equal(shippingStatusFor({ current: "shipped", cancelled: true, parcels: 2 }), "cancelled");
});

/* ---------------- checks ---------------- */

test("checks find what is missing or wrong, each on its deal", () => {
  const sale = (n, extra) => ({ id: `s${n}`, deal_number: n, buyer_record_id: "recB", buyer_name: "B", payment_status: "paid", shipping_status: "shipped", bookkeeping_status: "invoiced", total_selling_price: 200, shipping_costs: 0, legacy_selling_vat_type: "VAT0", labels_needed: 0, sale_date: "2026-09-01", ...extra });
  const sales = [
    sale(1, {}),
    sale(2, { payment_status: "cancelled", shipping_status: "cancelled" }),
    sale(3, { bookkeeping_status: "to_invoice", legacy_selling_vat_type: null }),
    sale(4, { shipping_status: "ready_to_ship", labels_needed: 2 })
  ];
  const pairsBySale = new Map([
    ["s1", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 250 }]],
    ["s2", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 100 }]],
    ["s3", [{ purchase_vat_type: "Margin", purchase_price_ex_vat: 50, selling_vat_type: "Margin", selling_price: null }, { purchase_vat_type: null, purchase_price_ex_vat: 0, selling_vat_type: null, selling_price: null }]],
    ["s4", [{ purchase_vat_type: "VAT21", purchase_price_ex_vat: 100 }]]
  ]);
  const parcelsBySale = new Map([["s1", [{ tracking_number: "1Z1" }]], ["s4", [{ label_url: "x", tracking_number: "1Z4" }]]]);
  const invoicesBySale = new Map([["s1", [{ kind: "sale", invoice_number: "KC1", journal_entry_id: null }]], ["s2", [{ kind: "sale", invoice_number: "KC2", journal_entry_id: "j" }]]]);

  const checks = externalSalesChecks({ sales, pairsBySale, parcelsBySale, invoicesBySale, sync: { errors: [], missing: [] }, now: Date.parse("2026-09-22") });
  const by = Object.fromEntries(checks.map((c) => [c.key, c.items.map((i) => i.deal)]));

  assert.deepEqual(by.loss, ["EXTD-000001"]);
  assert.deepEqual(by.invoice_without_journal, ["EXTD-000001"]);
  assert.deepEqual(by.cancelled_invoiced, ["EXTD-000002"]);
  assert.deepEqual(by.purchase_missing, ["EXTD-000003"]);
  assert.deepEqual(by.mixed_vat, ["EXTD-000003"]);
  assert.deepEqual(by.labels_short, ["EXTD-000004"]);
  assert.deepEqual(by.shipped_no_tracking, ["EXTD-000003"], "EXTD-000001 has its tracking");
  assert.deepEqual(by.to_invoice, ["EXTD-000003"]);
});

/* ---------------- sync ---------------- */

function fakeAirtable(record, { units = {}, buyers = {} } = {}) {
  const updates = [];
  return {
    updates,
    async select() {
      return { records: [structuredClone(record)], offset: "" };
    },
    async byIds(table, ids) {
      const source = table === "Inventory Units" ? units : buyers;
      return new Map(ids.filter((id) => source[id]).map((id) => [id, source[id]]));
    },
    async update(table, id, fields) {
      updates.push(fields);
      Object.assign(record.fields, fields);
      // Airtable gives an attachment sent by URL a new id and keeps its name.
      if (fields["Shipping Labels"]) {
        record.fields["Shipping Labels"] = fields["Shipping Labels"].map((a, i) => (a.id ? { ...a, filename: (record._names || {})[a.id] || "" } : { id: `attNew${i}`, url: a.url, filename: a.filename }));
      }
      return structuredClone(record);
    }
  };
}

test("a new outbound from Airtable arrives with its pairs, buyer and parcels", async () => {
  const record = {
    id: "recSALE0000000078",
    fields: {
      "External Deal ID": "EXTD-000078",
      "Buyer ID": ["recBUYER"],
      "Buyer Name": ["Some Store"],
      "Sale Date": "2026-09-22",
      "Total Selling Price": 484,
      "Shipping Costs": 12.5,
      "Payment Status": "Pending",
      "Shipping Status": "Pending",
      "Amount of Labels": 2,
      "Tracking Numbers": "1ZAAA111, 1ZBBB222",
      "Shipping Labels": [{ id: "att1", url: "https://airtable/1", filename: "one.pdf", type: "application/pdf" }, { id: "att2", url: "https://airtable/2", filename: "two.png", type: "image/png" }],
      "Linked Inventory Units": ["recU1", "recU2"]
    }
  };
  const airtable = fakeAirtable(record, {
    units: {
      recU1: { "Item ID": "IU-1", SKU: "A", Size: "42", "VAT Type": "VAT21", "Final Purchase Price": 121, "Final Purchase Price (ex. VAT)": 100 },
      recU2: { "Item ID": "IU-2", SKU: "B", Size: "43" }
    },
    buyers: { recBUYER: { "Full Name": "Jan", "Country Code": "DE", "VAT ID": "DE999" } }
  });
  const db = fakeDb({ external_sales: [], external_sale_pairs: [], shipments: [] });
  const stored = [];
  const sync = createExternalSalesSync({
    airtable,
    db,
    storeLabel: async ({ dealId, filename, mime }) => { stored.push({ dealId, filename, mime }); return { url: `https://r2/${dealId}-${filename}`, filename: `${dealId}-${filename}` }; },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
  });

  const result = await sync.run();
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));

  const [sale] = db.tables.external_sales;
  assert.equal(sale.deal_number, 78);
  assert.equal(sale.buyer_name, "Jan");
  assert.equal(sale.bookkeeping_status, "to_invoice");
  assert.equal(sale.shipping_status, "ready_to_ship");

  const pairs = db.tables.external_sale_pairs;
  assert.equal(pairs.length, 2);
  assert.equal(pairs.find((p) => p.item_id === "IU-1").purchase_price_ex_vat, 100, "VAT21 takes the ex-VAT purchase");
  assert.equal(pairs.find((p) => p.item_id === "IU-1").selling_vat_type, "VAT0", "business abroad with a VAT id");
  assert.equal(pairs.find((p) => p.item_id === "IU-2").purchase_vat_type, null, "missing purchase stays empty, for Checks");

  const parcels = db.tables.shipments;
  assert.equal(parcels.length, 2, "two labels, two tracking numbers: two parcels");
  assert.deepEqual(parcels.map((p) => [p.airtable_attachment_id, p.tracking_number]), [["att1", "1ZAAA111"], ["att2", "1ZBBB222"]]);
  assert.equal(stored[1].mime, "image/png", "an image label goes to the WMS as an image, which makes it a PDF");

  assert.deepEqual(airtable.updates.at(-1), { "Shipping Status": "Ready to Ship" });

  // A second run changes nothing and copies nothing again.
  const again = await sync.run();
  assert.equal(again.changed.length, 0, JSON.stringify(again.changed));
  assert.equal(db.tables.shipments.length, 2);
  assert.equal(stored.length, 2);
});

test("labels copied in step 2 are recognised by name, not copied twice", async () => {
  const record = {
    id: "recSALE0000000069",
    fields: {
      "External Deal ID": "EXTD-000069",
      "Buyer ID": ["recBUYER"],
      "Total Selling Price": 200,
      "Payment Status": "Paid",
      "Shipping Status": "Shipped",
      "Tracking Numbers": "1ZR1J3649122428336",
      "Shipping Labels": [{ id: "attOld", url: "https://airtable/x", filename: "label_astro (5).pdf" }],
      "Linked Inventory Units": ["recU1"]
    }
  };
  const db = fakeDb({
    external_sales: [{ id: "s69", airtable_record_id: record.id, deal_number: 69, buyer_record_id: "recBUYER", payment_status: "paid", paid_at: null, shipping_status: "shipped", bookkeeping_status: "invoiced", total_selling_price: "200.00", shipping_costs: "0.00", sale_date: null, payment_note: null, labels_needed: 0, items_per_parcel: null, legacy_selling_vat_type: "Margin" }],
    external_sale_pairs: [{ id: "p1", sale_id: "s69", inventory_unit_record_id: "recU1", purchase_vat_type: "Margin", purchase_price_ex_vat: "100.00", selling_vat_type: null }],
    shipments: [{ id: "sh1", external_sale_id: "s69", label_url: "https://r2/x", label_filename: "EXTD-000069-label_astro__5_.pdf", tracking_number: "1ZR1J3649122428336", airtable_attachment_id: null, created_at: "2026-09-22" }]
  });
  const sync = createExternalSalesSync({ airtable: fakeAirtable(record), db, storeLabel: async () => assert.fail("nothing to copy"), fetchImpl: async () => assert.fail("nothing to download") });

  const result = await sync.run();
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(db.tables.shipments.length, 1);
  assert.equal(db.tables.shipments[0].airtable_attachment_id, "attOld");
  assert.equal(db.tables.external_sales[0].paid_at, null, "paid before step 2: no made-up date");
  assert.equal(db.tables.external_sale_pairs[0].selling_vat_type, null, "an invoiced deal is not touched");
});

test("an edit writes the parcels back to Airtable and links the new label", async () => {
  const record = {
    id: "recSALE0000000080",
    _names: { attA: "a.pdf" },
    fields: {
      "External Deal ID": "EXTD-000080",
      "Buyer ID": ["recBUYER"],
      "Total Selling Price": 100,
      "Payment Status": "Pending",
      "Shipping Status": "Ready to Ship",
      "Tracking Numbers": "1ZAAA111",
      "Shipping Labels": [{ id: "attA", url: "https://airtable/a", filename: "a.pdf" }],
      "Linked Inventory Units": []
    }
  };
  const db = fakeDb({
    external_sales: [{ id: "s80", airtable_record_id: record.id, deal_number: 80, buyer_record_id: "recBUYER", payment_status: "pending", shipping_status: "ready_to_ship", bookkeeping_status: "to_invoice", total_selling_price: "100.00", shipping_costs: "0.00", sale_date: null, payment_note: null, labels_needed: 0, items_per_parcel: null, legacy_selling_vat_type: null }],
    external_sale_pairs: [],
    shipments: [{ id: "sh1", external_sale_id: "s80", label_url: "https://r2/a", label_filename: "EXTD-000080-a.pdf", tracking_number: "1ZAAA111", airtable_attachment_id: "attA", created_at: "2026-09-22T10:00:00Z" }]
  });
  const airtable = fakeAirtable(record);
  const sync = createExternalSalesSync({ airtable, db, storeLabel: async () => ({}), fetchImpl: async () => assert.fail("nothing to download") });

  await sync.edit(db.tables.external_sales[0], async (sale) => {
    await db.insert("shipments", [{ external_sale_id: sale.id, tracking_number: "1ZBBB222", label_url: "https://r2/b", label_filename: "EXTD-000080-1ZBBB222.pdf", airtable_attachment_id: null }]);
  });

  const written = airtable.updates.at(-1);
  assert.equal(written["Tracking Numbers"], "1ZAAA111, 1ZBBB222");
  assert.deepEqual(written["Shipping Labels"], [{ id: "attA" }, { url: "https://r2/b", filename: "EXTD-000080-1ZBBB222.pdf" }]);
  assert.equal(db.tables.shipments.find((p) => p.tracking_number === "1ZBBB222").airtable_attachment_id, "attNew1");

  // Removing every parcel puts the deal back on Pending, in Airtable too.
  await sync.edit(db.tables.external_sales[0], async () => {
    db.tables.shipments = [];
  });
  assert.equal(db.tables.external_sales[0].shipping_status, "pending");
  assert.equal(airtable.updates.at(-1)["Shipping Status"], "Pending");
});

test("a margin pair sold at a loss has no VAT to take off", () => {
  const loss = saleMoney({ total_selling_price: 80, shipping_costs: 0, legacy_selling_vat_type: "Margin" }, [{ purchase_price_ex_vat: 100 }]);
  assert.equal(loss.selling_ex_vat, 80);
  assert.equal(loss.profit, -20);
});

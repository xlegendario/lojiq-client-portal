import test from "node:test";
import assert from "node:assert/strict";

import { moneyLines, selfBillingPdf } from "../admin/selfBillingPdf.js";
import { createSelfBilling, documentFrom, sellerFrom } from "../admin/adminSelfBilling.js";

const UNIT = {
  "Item ID": "PCS-007999",
  "Product Name": "Maison Mihara Yasuhiro Peterson OG Sole Canvas Low Black",
  "SKU": "A01FW702-BLK",
  "Size": "42",
  "VAT Type": "Margin",
  "Purchase Price": 100,
  "Final Purchase Price": 100,
  "Ticket Number": "EXTD-000078",
  "Purchase Date": "2026-09-23",
  "Seller ID": ["recSELLER0000001"]
};

const SELLER = {
  "Seller ID": "SE-00781",
  "Company Name": "Zhuoyi",
  "Full Name": "Zhuo Yi",
  "Address": "Calle remodelacion 5",
  "Zipcode": "28041",
  "City": "Madrid",
  "Country": "Spain",
  "Email": "zhuoyi@example.com",
  "Payout Info": "ES9121000418450200051332",
  "VAT ID": "ESB12345678"
};

test("a margin purchase says the price and nothing about VAT", () => {
  const money = moneyLines(100, "Margin");

  assert.equal(money.price, 100);
  assert.equal(money.total, 100);
  assert.equal(money.vat, null, "margin VAT is never itemized");
  assert.match(money.note, /Margin VAT Scheme/);
});

test("a 21% purchase shows the VAT beside a price without it", () => {
  const money = moneyLines(121, "VAT21");

  assert.equal(money.price, 100);
  assert.equal(money.vat, 21);
  assert.equal(money.total, 121);
  assert.equal(money.note, "");
});

test("a 0% purchase is reverse-charged, and says so", () => {
  const money = moneyLines(100, "VAT0");

  assert.equal(money.price, 100);
  assert.equal(money.vat, 0);
  assert.equal(money.total, 100);
  assert.match(money.note, /reverse-charged/);
});

test("a VAT type without a template is refused, not guessed", () => {
  assert.equal(moneyLines(100, "Anders"), null);
  assert.throws(() => selfBillingPdf({ document_number: "PCS-1", vat_type: "Anders", product: { price: 100 } }), /No self-billing document/);
  assert.throws(() => selfBillingPdf({ vat_type: "Margin", product: { price: 100 } }), /Item ID/);
});

test("the document is filled from the unit and its seller", () => {
  const doc = documentFrom({ unit: UNIT, seller: SELLER });

  assert.equal(doc.document_number, "PCS-007999");
  assert.equal(doc.order_number, "EXTD-000078");
  assert.equal(doc.date, "2026-09-23");
  assert.equal(doc.vat_type, "Margin");
  assert.equal(doc.product.price, 100);
  assert.deepEqual(sellerFrom(SELLER), {
    seller_id: "SE-00781",
    name: "Zhuoyi",
    address: "Calle remodelacion 5",
    zipcode: "28041",
    city: "Madrid",
    country: "Spain",
    email: "zhuoyi@example.com",
    vat_id: "ESB12345678",
    iban: "ES9121000418450200051332"
  });

  // A caller may say it differently; it wins over what the unit says.
  assert.equal(documentFrom({ unit: UNIT, seller: SELLER, overrides: { order_number: "ORD-025689" } }).order_number, "ORD-025689");
});

test("a unit without a seller has no one to invoice on behalf of", async () => {
  const airtable = {
    byIds: async (table, ids) => new Map(table === "Inventory Units" ? [[ids[0], { ...UNIT, "Seller ID": [] }]] : [])
  };

  await assert.rejects(() => createSelfBilling({ airtable }).forUnit("recUNIT0000000001"), /no seller/);
  await assert.rejects(() => createSelfBilling({ airtable }).forUnit("nonsense"), /not an Inventory Unit id/);
});

test("the PDF is a PDF, and carries what the document says", async () => {
  const airtable = {
    byIds: async (table, ids) => new Map([[ids[0], table === "Inventory Units" ? UNIT : SELLER]])
  };

  const { filename, pdf } = await createSelfBilling({ airtable }).forUnit("recUNIT0000000001");

  assert.equal(filename, "PCS-007999.pdf");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.toString("latin1"), /%%EOF/);

  const drawn = pdf.toString("latin1");
  for (const line of ["SELF-BILLING PURCHASE INVOICE", "PCS-007999", "EXTD-000078", "SE-00781", "Zhuoyi", "A01FW702-BLK", "Margin VAT Scheme"]) {
    assert.ok(drawn.includes(line), `the document says ${line}`);
  }
});

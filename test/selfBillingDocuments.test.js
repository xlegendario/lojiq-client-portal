import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { createSelfBilling } from "../admin/adminSelfBilling.js";
import { createSelfBillingDocuments, kindFor, LIVE_FROM } from "../admin/selfBillingDocuments.js";

const UNIT_ID = "recUNIT0000000001";
const OLD_ID = "recUNIT0000000002";
const SELLER_ID = "recSELLER0000001";

const unit = (extra = {}) => ({
  "Item ID": "OUT-008200",
  "Product Name": "New Balance 9060 Magnet",
  "SKU": "U9060SG",
  "Size": "42",
  "VAT Type": "Margin",
  "Purchase Price": 120,
  "Final Purchase Price": 120,
  "Ticket Number": "ORD-030000",
  "Purchase Date": "2026-11-05",
  "Seller ID": [SELLER_ID],
  "Created Time": "2026-11-05T10:00:00.000Z",
  ...extra
});

const SELLER = { "Seller ID": "SE-00100", "Full Name": "Piet Private", Address: "Dorpsstraat 1", Zipcode: "1234 AB", City: "Huizen", Country: "Netherlands" };

function setup() {
  const units = {
    [UNIT_ID]: unit(),
    [OLD_ID]: unit({ "Item ID": "OUT-001500", "Purchase Date": "2025-03-01", "Created Time": "2025-03-01T09:00:00.000Z" })
  };
  const airtable = {
    byIds: async (table, ids) => new Map(ids.map((id) => [id, table === "Inventory Units" ? units[id] : SELLER]).filter(([, v]) => v)),
    select: async () => ({ records: Object.keys(units).map((id) => ({ id, fields: {} })), offset: "" })
  };
  const files = new Map();
  const storage = {
    configured: true,
    upload: async (name, buffer) => { files.set(name, buffer); return `self-billing/${name}`; },
    download: async (name) => { if (!files.has(name)) throw new Error("missing"); return files.get(name); }
  };
  const db = fakeDb({ self_billing_documents: [] });
  const docs = createSelfBillingDocuments({ db, storage, selfBilling: createSelfBilling({ airtable }), airtable, now: () => new Date("2026-11-05T12:00:00Z") });
  return { db, files, docs };
}

test("a unit from the day the flow went live gets an issued document, an older one a copy", () => {
  assert.equal(kindFor(`${LIVE_FROM}T08:00:00Z`), "issued");
  assert.equal(kindFor("2026-10-30T08:00:00Z"), "reproduced");
});

test("the document is made once, stored, and the same bytes come back every time", async () => {
  const { db, files, docs } = setup();

  const first = await docs.pdf(UNIT_ID);
  const again = await docs.pdf(UNIT_ID);

  assert.equal(db.tables.self_billing_documents.length, 1);
  assert.equal(first.row.kind, "issued");
  assert.equal(first.row.item_id, "OUT-008200");
  assert.equal(first.row.seller_record_id, SELLER_ID);
  assert.equal(first.filename, "OUT-008200.pdf");
  assert.ok(files.has(`${UNIT_ID}.pdf`));
  assert.ok(first.pdf.equals(again.pdf));
  assert.match(first.row.pdf_hash, /^[0-9a-f]{64}$/);
  assert.ok(first.pdf.toString("latin1").includes("no VAT has been deducted"), "a new margin document carries the declaration");
});

test("an older unit is reproduced as a copy, dated as it was bought, in the old wording", async () => {
  const { docs } = setup();
  const { row, pdf } = await docs.pdf(OLD_ID);
  const drawn = pdf.toString("latin1");

  assert.equal(row.kind, "reproduced");
  assert.ok(drawn.includes("reproduced from our records on 2026-11-05"));
  assert.ok(drawn.includes("2025-03-01"));
  assert.ok(!drawn.includes("no VAT has been deducted"));
});

test("an original we hold is kept as it was, and not replaced afterwards", async () => {
  const { docs } = setup();
  const original = Buffer.from("%PDF-1.4 the Eledo original %%EOF");

  const imported = await docs.importOriginal(OLD_ID, original, "OneDrive/Inkoopverklaringen/OUT-001500.pdf");
  assert.equal(imported.row.kind, "imported");
  assert.ok((await docs.pdf(OLD_ID)).pdf.equals(original));
  assert.equal((await docs.importOriginal(OLD_ID, Buffer.from("other"), "x")).skipped, true);
});

test("the sweep makes what is missing and leaves the rest", async () => {
  const { db, docs } = setup();
  await docs.ensure(UNIT_ID);

  const result = await docs.sweep();
  assert.equal(result.checked, 2);
  assert.equal(result.made, 1);
  assert.equal(db.tables.self_billing_documents.length, 2);
  assert.equal((await docs.sweep()).made, 0);
});

import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { createSellerAgreements, sellerAgreementPdf, VAT_DECLARATIONS } from "../admin/sellerAgreement.js";

const SELLER = {
  "Seller ID": "SE-00999",
  "Full Name": "Piet Private",
  Email: "piet@example.com",
  Address: "Dorpsstraat 1",
  Zipcode: "1234 AB",
  City: "Huizen",
  Country: "Netherlands",
  "Payout Info": "NL91ABNA0417164300",
  "T&C Version": "v1.1"
};

test("the agreement says what the seller saw: terms version and the VAT declaration", () => {
  const pdf = sellerAgreementPdf({ seller: SELLER, acceptedAt: "2026-11-11T12:00:00Z", discordId: "123", discordTag: "piet", tcVersion: "v1.1", vatDeclarationVersion: "v1" }).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.includes("version 1.1") && pdf.includes("16-10-2026"));
  assert.ok(pdf.includes("you choose the VAT type yourself"));
  assert.ok(pdf.includes("no VAT ID provided"));
  assert.ok(pdf.includes("SE-00999"));
});

test("without a declaration on the page, none is claimed", () => {
  const pdf = sellerAgreementPdf({ seller: SELLER, acceptedAt: "2026-11-11T12:00:00Z", tcVersion: "v1.0" }).toString("latin1");
  assert.ok(!pdf.includes(VAT_DECLARATIONS.v1.slice(0, 40)));
  assert.ok(pdf.includes("No separate VAT declaration was shown"));
});

test("make stores the PDF, records it and puts a signed address in Agreement PDF", async () => {
  const db = fakeDb({ seller_agreements: [] });
  const updates = [];
  const files = new Map();
  const store = createSellerAgreements({
    db,
    airtable: {
      byIds: async (table, ids) => new Map([[ids[0], SELLER]]),
      update: async (table, id, fields) => updates.push({ table, id, fields })
    },
    storage: {
      upload: async (name, buffer) => { files.set(name, buffer); return `seller-agreements/${name}`; },
      signedUrl: async (name) => `https://signed/${name}`
    }
  });

  const made = await store.make({ airtable_record_id: "recSELLER00000001", discord_id: "123", discord_tag: "piet", accepted_at: "2026-11-11T12:00:00Z", vat_declaration_version: "v1" });
  assert.equal(made.seller_id, "SE-00999");
  assert.equal(db.tables.seller_agreements.length, 1);
  assert.equal(db.tables.seller_agreements[0].tc_version, "v1.1");
  assert.match(db.tables.seller_agreements[0].pdf_hash, /^[0-9a-f]{64}$/);
  assert.equal(updates[0].table, "Sellers Database");
  assert.match(updates[0].fields["Agreement PDF"][0].url, /^https:\/\/signed\//);
  assert.equal(files.size, 1);

  await assert.rejects(store.make({ airtable_record_id: "nonsense" }), /not a seller record id/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import {
  cleanIban, cleanLines, contentHash, createSaleDocuments, feeDefaults, defaultFeeFor, jpegSize, lineFee, partnerView, readSignature
} from "../partner/saleDocuments.js";
import { saleDocumentPdf, sizesText } from "../partner/saleDocumentPdf.js";
import { createCatalogSearch, rankProducts, searchFormula, searchWords } from "../partner/catalogSearch.js";
import { TERMS_VERSION, termsHash, termsText } from "../partner/sellerTerms.js";

const SELLER = "recJIMMY";
const BUYER = "11111111-2222-3333-4444-555555555555";
const account = { id: "u1", sellerRecordId: SELLER, sellerId: "SE-00781" };

// The smallest JPEG a browser would send: a frame header saying 4 x 2.
function tinyJpeg() {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x04, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return `data:image/jpeg;base64,${Buffer.concat([head, Buffer.alloc(300, 0), Buffer.from([0xff, 0xd9])]).toString("base64")}`;
}

const fields = { "Seller ID": "SE-00781", "Full Name": "Yi Dong", Address: "Calle Remodelación 2", Zipcode: "28041", City: "Madrid", Country: "Spain" };

const input = (extra = {}) => ({
  buyer_id: BUYER,
  delivery_date: "2026-10-26",
  payment: { iban: "DK22 8900 0057 9115 59", holder: "Dongyi" },
  lines: [
    { kind: "product", sku: "u9060pb", name: "New Balance 9060 Mushroom", sizes: [{ size: "36", qty: 3 }, { size: "37", qty: 3 }, { size: "41.5", qty: 0 }] },
    { kind: "other", name: "Creases", qty: 500, unit_price: "0,70" }
  ].map((line, i) => ({ unit_price: i === 0 ? 135 : line.unit_price, ...line })),
  signature: tinyJpeg(),
  ...extra
});

function setup({ seller = fields } = {}) {
  const db = fakeDb({
    buyers: [{ id: BUYER, company_name: "Sneaker Store BV", full_name: "Jan", email: "jan@store.nl", vat_id: "NL1", address: "Kalverstraat 1", zipcode: "1012", city: "Amsterdam", country: "Netherlands" }],
    partner_sale_documents: [],
    partner_terms_acceptances: []
  });
  const rendered = [];
  const documents = createSaleDocuments({
    db,
    sellerOf: async () => seller,
    owns: async (sellerRecordId, buyerId) => sellerRecordId === SELLER && buyerId === BUYER,
    renderPdf: async (row, options) => { rendered.push({ row, options }); return saleDocumentPdf(row, options); },
    now: () => new Date("2026-10-26T13:32:00Z")
  });
  return { db, documents, rendered };
}

test("lines: sizes add up to the quantity, prices take a comma, empty sizes drop out", () => {
  const [shoe, other] = cleanLines(input().lines);
  assert.equal(shoe.qty, 6);
  assert.equal(shoe.sku, "U9060PB");
  assert.deepEqual(shoe.sizes, [{ size: "36", qty: 3 }, { size: "37", qty: 3 }]);
  assert.equal(shoe.total, 810);
  assert.equal(other.unit_price, 0.7);
  assert.equal(other.total, 350);
  assert.deepEqual(other.sizes, []);

  assert.throws(() => cleanLines([]), (e) => e.code === "no_lines");
  assert.throws(() => cleanLines([{ kind: "other", name: "x", qty: 1, unit_price: 0 }]), (e) => e.code === "bad_price");
  assert.throws(() => cleanLines([{ kind: "other", name: "", qty: 1, unit_price: 2 }]), (e) => e.code === "line_needs_name");
  assert.throws(() => cleanLines([{ kind: "product", sku: "X", sizes: [], qty: 0, unit_price: 2 }]), (e) => e.code === "bad_qty");
});

test("an IBAN is checked on its own check digits", () => {
  assert.equal(cleanIban("DK22 8900 0057 9115 59"), "DK2289000057911559");
  assert.equal(cleanIban("NL91 ABNA 0417 1643 00"), "NL91ABNA0417164300");
  assert.equal(cleanIban("NL92 ABNA 0417 1643 00"), "");
  assert.equal(cleanIban("hello"), "");
});

test("the signature must be a JPEG, and its size is read from the frame header", () => {
  assert.deepEqual(readSignature(tinyJpeg()).width, 4);
  assert.deepEqual(jpegSize(readSignature(tinyJpeg()).bytes), { width: 4, height: 2 });
  assert.throws(() => readSignature("data:image/png;base64,AAAA"), (e) => e.code === "no_signature");
  assert.throws(() => readSignature(""), (e) => e.code === "no_signature");
});

test("nothing can be signed before the terms are accepted", async () => {
  const { documents } = setup();
  await assert.rejects(documents.request(account, input()), (e) => e.code === "terms_not_accepted");

  const accepted = await documents.acceptTerms(account, { ip: "1.2.3.4", agent: "iPhone" });
  assert.equal(accepted.terms_version, TERMS_VERSION);
  assert.match(accepted.terms_hash, /^[0-9a-f]{64}$/);
  assert.ok(await documents.acceptance(SELLER));
});

test("a signed request keeps the parties, the lines, the signature and a hash over all of it", async () => {
  const { documents } = setup();
  await documents.acceptTerms(account);
  const row = await documents.request(account, input(), { ip: "1.2.3.4", agent: "iPhone" });

  assert.equal(row.status, "requested");
  assert.equal(row.seller.name, "Yi Dong");
  assert.equal(row.buyer.company_name, "Sneaker Store BV");
  assert.equal(row.total, 1160);
  assert.equal(row.payment.iban, "DK2289000057911559");
  assert.equal(row.signed_ip, "1.2.3.4");
  assert.equal(row.doc_number, undefined, "no number until it is released");
  assert.equal(row.content_hash, contentHash(row));
  assert.notEqual(contentHash({ ...row, total: 1 }), row.content_hash, "a changed total no longer matches");

  const view = partnerView(row);
  assert.equal(view.fee_total, null, "he sees no fee before Dario released it");
});

test("only his own buyers, and never for a VAT-registered seller", async () => {
  const { documents } = setup();
  await documents.acceptTerms(account);
  await assert.rejects(documents.request(account, input({ buyer_id: "99999999-2222-3333-4444-555555555555" })), (e) => e.code === "no_buyer");

  const vat = setup({ seller: { ...fields, "VAT ID": "ESX1234567" } });
  await vat.documents.acceptTerms(account);
  await assert.rejects(vat.documents.request(account, input()), (e) => e.code === "vat_registered");
});

test("approving fills in our fee per line, numbers the document and hashes the PDF", async () => {
  const { documents } = setup();
  await documents.acceptTerms(account);
  const row = await documents.request(account, input());

  await assert.rejects(documents.approve(row.id, [{ type: "per_item", value: 5 }], "Dario"), (e) => e.code === "fee_per_line");

  const released = await documents.approve(row.id, [{ type: "per_item", value: 5 }, { type: "percent", value: "10" }], "Dario");
  assert.equal(released.status, "approved");
  assert.equal(released.doc_number, 1);
  assert.equal(released.issue_date, "2026-10-26");
  assert.equal(released.lines[0].fee, 30);
  assert.equal(released.lines[1].fee, 35);
  assert.equal(released.fee_total, 65);
  assert.match(released.pdf_hash, /^[0-9a-f]{64}$/);
  assert.equal(partnerView(released).receive, 1095);

  await assert.rejects(documents.approve(row.id, [{}, {}], "Dario"), (e) => e.code === "not_open");

  const second = await documents.request(account, input());
  assert.equal((await documents.approve(second.id, [{ type: "per_item", value: 0 }, { type: "per_item", value: 0 }], "Dario")).doc_number, 2);
});

test("a fee is a percentage or an amount per item, never more than the sale", async () => {
  assert.equal(lineFee({ total: 200, qty: 4 }, "percent", 7.5), 15);
  assert.equal(lineFee({ total: 200, qty: 4 }, "per_item", "2,5"), 10);
  assert.throws(() => lineFee({ total: 1, qty: 1 }, "percent", 101), (e) => e.code === "bad_fee");
  assert.throws(() => lineFee({ total: 1, qty: 1 }, "flat", 1), (e) => e.code === "bad_fee");

  const { documents } = setup();
  await documents.acceptTerms(account);
  const row = await documents.request(account, input());
  await assert.rejects(documents.approve(row.id, [{ type: "per_item", value: 500 }, { type: "per_item", value: 0 }], "Dario"), (e) => e.code === "fee_above_total");
});

test("the fee last used for a product is offered again", () => {
  const defaults = feeDefaults([
    { approved_at: "2026-10-01", lines: [{ sku: "U9060PB", fee_type: "per_item", fee_value: 4 }] },
    { approved_at: "2026-10-20", lines: [{ sku: "", name: "Creases", fee_type: "percent", fee_value: 10 }] }
  ]);
  assert.deepEqual(defaultFeeFor(defaults, { sku: "U9060PB" }), { type: "per_item", value: 4 });
  assert.deepEqual(defaultFeeFor(defaults, { sku: "", name: "creases" }), { type: "percent", value: 10 });
  assert.deepEqual(defaultFeeFor(defaults, { sku: "NEW1" }), { type: "percent", value: 10 }, "anything new gets the latest fee");
  assert.deepEqual(defaultFeeFor(feeDefaults([]), { sku: "X" }), { type: "per_item", value: 0 });
});

test("rejecting needs a reason; paid can only be set on a released document", async () => {
  const { documents } = setup();
  await documents.acceptTerms(account);
  const row = await documents.request(account, input());

  await assert.rejects(documents.setBuyerPaid(SELLER, row.id, true), (e) => e.code === "not_released");
  await assert.rejects(documents.reject(row.id, ""), (e) => e.code === "reason_needed");
  assert.equal((await documents.reject(row.id, "Wrong buyer")).status, "rejected");
  await assert.rejects(documents.setBuyerPaid("recOTHER", row.id, true), (e) => e.code === "not_found");
});

test("the PDF is the seller's: his name, no Lojiq, draft marked until released", async () => {
  const { documents, rendered } = setup();
  await documents.acceptTerms(account);
  const row = await documents.request(account, input());
  const { pdf } = await documents.pdf(row);
  const raw = pdf.toString("latin1");

  assert.ok(raw.startsWith("%PDF-1.4"));
  assert.ok(raw.includes("(Yi Dong)"));
  assert.ok(raw.includes("DRAFT"));
  assert.ok(!/lojiq|kickz/i.test(raw), "the document never names us");
  assert.ok(raw.includes("/Subtype /Image"), "the signature is on it");
  assert.equal(rendered.at(-1).options.draft, true);
  assert.equal(sizesText({ sizes: [{ size: "36", qty: 3 }, { size: "XS", qty: 1 }] }), "36 × 3, XS × 1");
});

test("catalogue search: every word, in any order, the article number first", async () => {
  assert.deepEqual(searchWords("Essentials  Light-Oatmeal x"), ["essentials", "light", "oatmeal"]);
  assert.match(searchFormula(["light", "oatmeal"]), /^AND\(FIND\('light'/);
  assert.match(searchFormula(["light", "oatmeal"], "any"), /^OR\(/);

  const ranked = rankProducts([
    { sku: "U9060PBX", name: "New Balance 9060 something long", brand: "" },
    { sku: "U9060PB", name: "New Balance 9060 Mushroom", brand: "" }
  ], ["u9060pb"]);
  assert.equal(ranked[0].sku, "U9060PB");

  const asked = [];
  const search = createCatalogSearch({
    async select(table, options) {
      asked.push(options.filterByFormula);
      if (options.filterByFormula.startsWith("AND")) return [];
      return [{ fields: { SKU: "192bt212052f-full", "Product Name": "Fear of God Essentials Light Oatmeal Full Set", "EU Sizes": "XS, S, M" } }];
    }
  });
  const found = await search.search("essentials light oatmeall");
  assert.equal(asked.length, 2, "no product holds every word, so the closest come back");
  assert.equal(found.partial, true);
  assert.deepEqual(found.products[0].sizes, ["XS", "S", "M"]);
  assert.equal(found.products[0].sku, "192BT212052F-FULL");
});

test("the terms carry the seller and change their hash with him", () => {
  const one = termsText({ name: "Yi Dong", seller_id: "SE-00781" });
  assert.ok(one.includes("Yi Dong"));
  assert.ok(one.includes(`Version ${TERMS_VERSION}`));
  assert.ok(one.includes("7.5. Lojiq invoices its fees to the Seller."));
  assert.notEqual(termsHash({ name: "Yi Dong" }), termsHash({ name: "Someone else" }));
});

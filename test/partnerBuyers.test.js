import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { cleanBuyerInput, createPartnerBuyers, similarBuyer } from "../partner/partnerBuyers.js";

const SELLER = "recJIMMY";
const ours = { id: "b-ours", buyer_number: 35, company_name: "Sneaker Palace B.V.", full_name: "Tom", email: "tom@palace.test", zipcode: "1012 AB", city: "Amsterdam", country: "Netherlands", country_code: "NL" };
const input = { company_name: "Kicks Berlin GmbH", full_name: "Lena", email: "lena@kb.test", vat_id: "DE123456789", address: "Torstr 5", zipcode: "10119", city: "Berlin", country: "Germany" };

test("look-alikes: same name without legal form, or same postcode with a name that starts the same", () => {
  assert.equal(similarBuyer([ours], { company_name: "Sneaker-Palace" })?.id, "b-ours");
  assert.equal(similarBuyer([ours], { company_name: "Sneaker Pal Amsterdam", zipcode: "1012ab", country_code: "NL" })?.id, "b-ours");
  assert.equal(similarBuyer([ours], { company_name: "Kicks Berlin", zipcode: "1012ab", country_code: "NL" }), null);
  assert.equal(similarBuyer([ours], { ...ours }), null, "never itself");
});

test("a buyer needs a name, an email and a full address", () => {
  assert.deepEqual(cleanBuyerInput({}).missing, ["name", "email", "address", "zipcode", "city", "country"]);
  assert.deepEqual(cleanBuyerInput(input).missing, []);
  assert.deepEqual(cleanBuyerInput({ ...input, vat_id: "" }).missing, ["vat_id"], "a company needs its VAT number");
  assert.deepEqual(cleanBuyerInput({ ...input, company_name: "", vat_id: "" }).missing, [], "a private buyer does not");
});

function setup(kc) {
  const db = fakeDb({ buyers: [{ ...ours }], partner_buyers: [] });
  const buyers = createPartnerBuyers({ db, callKc: kc });
  return { db, buyers };
}

test("a new buyer is made through Kickz Caviar and linked to the partner", async () => {
  const sent = [];
  const { db, buyers } = setup(async (path, body) => {
    if (path.endsWith("/list")) return { ok: true, countries: ["Germany"] };
    sent.push(body);
    db.tables.buyers.push({ id: "b-new", ...body });
    return { ok: true, option: { id: "b-new" } };
  });

  const out = await buyers.create(SELLER, input);

  assert.equal(out.buyer.id, "b-new");
  assert.deepEqual(db.tables.partner_buyers.map((l) => [l.seller_record_id, l.buyer_id]), [[SELLER, "b-new"]]);
  assert.equal(sent[0].email, "lena@kb.test");
  assert.deepEqual((await buyers.list(SELLER)).buyers.map((b) => b.id), ["b-new"], "he sees only his own");
});

test("a buyer we already have (same email or VAT) is linked, not made twice", async () => {
  const { db, buyers } = setup(async () => {
    throw Object.assign(new Error("409"), { status: 409, data: { existing: { id: "b-ours", buyer_id: "BU-00035" } } });
  });

  const out = await buyers.create(SELLER, { ...input, email: "tom@palace.test" });

  assert.equal(out.buyer.id, "b-ours");
  assert.equal(db.tables.buyers.length, 1);
  assert.equal(db.tables.partner_buyers[0].buyer_id, "b-ours");
});

test("one of his own buyers that looks the same is asked about first", async () => {
  let made = 0;
  const { db, buyers } = setup(async (path, body) => {
    made += 1;
    db.tables.buyers.push({ id: `b-${made}`, ...body });
    return { ok: true, option: { id: `b-${made}` } };
  });

  await buyers.create(SELLER, input);
  const again = await buyers.create(SELLER, { ...input, company_name: "Kicks-Berlin", email: "other@kb.test" });
  assert.equal(again.same.id, "b-1");
  assert.equal(made, 1);

  const confirmed = await buyers.create(SELLER, { ...input, company_name: "Kicks-Berlin", email: "other@kb.test", confirm_new: true });
  assert.equal(confirmed.buyer.id, "b-2");
});

test("the first invoice to a buyer that looks like one of ours waits; a checked buyer does not", async () => {
  const { db, buyers } = setup(async (path, body) => {
    db.tables.buyers.push({ id: "b-new", ...body });
    return { ok: true, option: { id: "b-new" } };
  });

  await buyers.create(SELLER, { ...input, company_name: "Sneaker Palace", email: "info@palace2.test" });
  assert.equal((await buyers.duplicateCheck(SELLER, "b-new"))?.id, "b-ours");

  await buyers.markChecked(SELLER, "b-new");
  assert.equal(await buyers.duplicateCheck(SELLER, "b-new"), null);
});

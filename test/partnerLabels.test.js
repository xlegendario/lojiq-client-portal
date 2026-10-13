import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "./fakeSupabase.js";
import { addressKey, cleanAddress, cleanBoxes, createPartnerLabels, partnerView } from "../partner/partnerLabels.js";

const SELLER = "recJIMMY";
const address = { name: "Lena", company: "Kicks Berlin GmbH", street: "Torstraße", house_number: "5", postal_code: "10119", city: "Berlin", country: "de", phone: "+4930123456" };

test("an address needs what a label needs, and the country as two letters", () => {
  assert.deepEqual(cleanAddress(address).missing, []);
  assert.equal(cleanAddress(address).row.country, "DE");
  assert.deepEqual(cleanAddress({ ...address, house_number: "", phone: "" }).missing, ["house_number", "phone"]);
  assert.deepEqual(cleanAddress({ ...address, country: "XX" }).missing, ["country"]);
  assert.equal(addressKey({ street: "Torstraße ", house_number: "5", postal_code: "10119", country: "DE" }), addressKey(cleanAddress(address).row));
});

test("boxes: at least one, at most twenty, each with a real weight", () => {
  assert.deepEqual(cleanBoxes([{ weight_kg: "2,5" }]), [{ weight_kg: 2.5 }]);
  assert.throws(() => cleanBoxes([]), (e) => e.code === "no_boxes");
  assert.throws(() => cleanBoxes([{ weight_kg: 0 }]), (e) => e.code === "bad_weight");
  assert.throws(() => cleanBoxes(Array.from({ length: 21 }, () => ({ weight_kg: 1 }))), (e) => e.code === "too_many_boxes");
});

function setup(answers = []) {
  const db = fakeDb({ partner_addresses: [], partner_labels: [] });
  const calls = [];
  const labels = createPartnerLabels({
    db,
    async callWms(path, body) {
      calls.push(body);
      return answers.shift() || { status: 200, data: { ok: true, labels: body.boxes.map((b, i) => ({ box: i + 1, tracking: `T${calls.length}-${i}`, label_url: `u${i}` })) } };
    }
  });
  return { db, calls, labels };
}

const ask = (labels, extra = {}) => labels.request({ sellerRecordId: SELLER, sellerId: "SE-00781", requestedBy: "partner", input: { carrier: "dpd", boxes: [{ weight_kg: 2 }, { weight_kg: 3 }], address, ...extra } });

test("a request keeps the address once and a copy on the label", async () => {
  const { db, labels } = setup();
  const one = await ask(labels);
  await ask(labels);

  assert.equal(db.tables.partner_addresses.length, 1, "the same address is not stored twice");
  assert.equal(one.status, "requested");
  assert.equal(one.carrier, "DPD");
  assert.equal(one.address.city, "Berlin");
});

test("check asks for a dry run; create makes every box and keeps the tracking", async () => {
  const { calls, labels } = setup([{ status: 200, data: { ok: true, dry: true, boxes: [] } }]);
  const row = await ask(labels);

  await labels.check(row.id);
  assert.equal(calls[0].dry, true);

  const made = await labels.create(row.id);
  assert.equal(calls[1].dry, false);
  assert.equal(made.status, "created");
  assert.deepEqual(made.tracking_numbers, ["T2-0", "T2-1"]);
});

test("a box that fails keeps the labels already made, and a retry makes only the rest", async () => {
  const { calls, labels } = setup([{ status: 207, data: { ok: false, error: "Sendcloud said no", labels: [{ box: 1, tracking: "T-first", label_url: "u" }] } }]);
  const row = await ask(labels);

  await assert.rejects(labels.create(row.id), (e) => e.code === "sendcloud_refused");
  const failed = await labels.load(row.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.tracking_numbers, ["T-first"]);

  const done = await labels.create(row.id);
  assert.equal(calls[1].boxes.length, 1, "only the box without a label");
  assert.deepEqual(done.tracking_numbers, ["T-first", "T2-0"]);
});

test("paid only with a price; the partner sees no errors or notes", async () => {
  const { labels } = setup();
  const row = await labels.create((await ask(labels, { note: "only for us" })).id);

  await assert.rejects(labels.setPaid(row.id, true), (e) => e.code === "no_price");
  await labels.setPrice(row.id, "21,75");
  const paid = await labels.setPaid(row.id, true);
  assert.equal(paid.payment_status, "paid");

  const view = partnerView(paid);
  assert.equal(view.price, 21.75);
  assert.equal(view.paid, true);
  assert.equal(JSON.stringify(view).includes("only for us"), false);
});

test("the partner asks a number of labels and pairs; we fill in the weights before Create", async () => {
  const { calls, labels } = setup();
  const row = await labels.request({
    sellerRecordId: SELLER, sellerId: "SE-00781", requestedBy: "partner",
    input: { carrier: "UPS", labels_count: 2, pairs: 7, address }
  });

  assert.equal(row.pairs, 7);
  assert.deepEqual(row.boxes, [{ weight_kg: null }, { weight_kg: null }]);
  await assert.rejects(labels.create(row.id), (e) => e.code === "no_weights");
  assert.equal(calls.length, 0, "nothing goes to Sendcloud without weights");

  const set = await labels.setBoxes(row.id, [{ weight_kg: 4.5 }, { weight_kg: 4.5 }, { weight_kg: 1 }]);
  assert.equal(set.boxes.length, 3, "we may add a label when approving");

  const made = await labels.create(row.id);
  assert.equal(made.tracking_numbers.length, 3);
  assert.equal(partnerView(made).pairs, 7);
});

test("a partner's ask needs at least one label and a real number of pairs", async () => {
  const { labels } = setup();
  const ask2 = (input) => labels.request({ sellerRecordId: SELLER, sellerId: "SE-00781", requestedBy: "partner", input: { carrier: "UPS", address, ...input } });

  await assert.rejects(ask2({ labels_count: 0, pairs: 3 }), (e) => e.code === "no_boxes");
  await assert.rejects(ask2({ labels_count: 2, pairs: 0 }), (e) => e.code === "bad_pairs");
  await assert.rejects(ask2({ labels_count: 21, pairs: 3 }), (e) => e.code === "too_many_boxes");
});

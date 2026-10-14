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

test("streetOnly drops a house number typed into the street as well", async () => {
  const { streetOnly } = await import("../partner/partnerLabels.js");
  assert.equal(streetOnly("Teubnerstrasse 14", "14"), "Teubnerstrasse");
  assert.equal(streetOnly("Teubnerstrasse, 14", "14"), "Teubnerstrasse");
  assert.equal(streetOnly("Hauptstr. 114", "14"), "Hauptstr. 114");
  assert.equal(streetOnly("Teubnerstrasse", "14"), "Teubnerstrasse");
  assert.equal(streetOnly("14", "14"), "14");
});

test("splitStreet takes the number from the street when the whole street was typed as the number", async () => {
  const { splitStreet } = await import("../partner/partnerLabels.js");
  assert.deepEqual(splitStreet("Teubnerstrasse 14", "Teubnerstrasse 14"), { street: "Teubnerstrasse", house_number: "14" });
  assert.deepEqual(splitStreet("Rue de Rivoli 10b", ""), { street: "Rue de Rivoli", house_number: "10b" });
  assert.deepEqual(splitStreet("Keizersgracht 12-3", "12-3"), { street: "Keizersgracht", house_number: "12-3" });
  assert.deepEqual(splitStreet("Torstraße", "5"), { street: "Torstraße", house_number: "5" });
});

test("edit changes labels, weights, pairs, carrier and address of an open request, and his saved address too", async () => {
  const { db, labels } = setup();
  const row = await ask(labels);
  const edited = await labels.edit(row.id, {
    carrier: "ups",
    pairs: "12",
    boxes: [{ weight_kg: 5 }, { weight_kg: 5 }, { weight_kg: 4.5 }],
    address: { ...address, street: "Teubnerstrasse 14", house_number: "Teubnerstrasse 14", city: "Pottenstein" },
    note: "fixed"
  });
  assert.equal(edited.carrier, "UPS");
  assert.equal(edited.pairs, 12);
  assert.equal(edited.boxes.length, 3);
  assert.equal(edited.address.street, "Teubnerstrasse");
  assert.equal(edited.address.house_number, "14");
  assert.equal(edited.note, "fixed");
  assert.equal(db.tables.partner_addresses[0].city, "Pottenstein");

  await assert.rejects(labels.edit(row.id, { address: { ...address, phone: "" } }), (e) => e.code === "address_missing");
  await assert.rejects(labels.edit(row.id, { pairs: "0" }), (e) => e.code === "bad_pairs");
});

test("once a box has its label, the carrier and address stay", async () => {
  const { labels } = setup([{ status: 207, data: { ok: false, error: "Sendcloud said no", labels: [{ box: 1, tracking: "T1", label_url: "u1" }] } }]);
  const row = await ask(labels);
  await assert.rejects(labels.create(row.id));
  await assert.rejects(labels.edit(row.id, { carrier: "UPS" }), (e) => e.code === "labels_made");
  await assert.rejects(labels.edit(row.id, { address: { ...address, city: "Hamburg" } }), (e) => e.code === "labels_made");
  assert.equal((await labels.edit(row.id, { pairs: 3 })).pairs, 3);
});

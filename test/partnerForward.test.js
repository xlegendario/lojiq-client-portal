import test from "node:test";
import assert from "node:assert/strict";

import {
  ForwardError,
  cleanLines,
  createPartnerForward,
  labelFile,
  pickPairs,
  summarizeForwardable
} from "../partner/partnerForward.js";

const partner = { name: "Jimmy", sellerId: "SE-00781", sellerRecordId: "recJIMMY00000001" };

const pair = (id, fields = {}) => ({
  id,
  sku: "A05FW702",
  size: "44",
  product_name: "Hank OG",
  brand: "Maison Mihara",
  image_url: "",
  mode: "both",
  partner_price: 100,
  markup: 10,
  forwarding_fee: null,
  received_at: "2026-10-02T09:00:00Z",
  ...fields
});

const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n" + "x".repeat(200)).toString("base64")}`;

test("pairs go in Create Outbound's order: forwarding-only, then dearest, then oldest", () => {
  const rows = [
    pair("cheap", { partner_price: 90 }),
    pair("dear-new", { partner_price: 120, received_at: "2026-10-05T09:00:00Z" }),
    pair("dear-old", { partner_price: 120, received_at: "2026-09-01T09:00:00Z" }),
    pair("fwd-only", { mode: "forwarding", partner_price: 50 })
  ];

  const { ids } = pickPairs(rows, [{ sku: "A05FW702", size: "44", qty: 3 }]);
  assert.deepEqual(ids, ["fwd-only", "dear-old", "dear-new"]);
});

test("pairs that may only be sold are never offered or taken", () => {
  const rows = [pair("a"), pair("b", { mode: "consignment" })];

  const [product] = summarizeForwardable(rows, 2);
  assert.equal(product.sizes[0].available, 1);

  const { short } = pickPairs(rows, [{ sku: "A05FW702", size: "44", qty: 2 }]);
  assert.deepEqual(short, [{ sku: "A05FW702", size: "44", qty: 2, available: 1 }]);
});

test("the fee per pair is its own fee, or the partner's fee, in the order pairs go", () => {
  const [product] = summarizeForwardable([pair("a", { mode: "forwarding", forwarding_fee: 5 }), pair("b")], 2);

  assert.deepEqual(product.sizes[0].fees, [5, 2]);
  assert.equal(JSON.stringify(product).includes("100"), false, "no partner price leaves the server");
  assert.equal(JSON.stringify(product).includes('"a"'), false, "no pair ids leave the server");
});

test("lines are merged per SKU and size and must be whole, positive numbers", () => {
  assert.deepEqual(
    cleanLines([
      { sku: "a05fw702", size: "44", qty: 1 },
      { sku: "A05FW702", size: "44", qty: 2 },
      { sku: "A05FW702", size: "43", qty: 0 },
      { sku: "A05FW702", size: "42", qty: 1.5 }
    ]),
    [{ sku: "A05FW702", size: "44", qty: 3 }]
  );

  assert.throws(() => cleanLines([]), (err) => err instanceof ForwardError && err.code === "no_pairs");
  assert.throws(() => cleanLines([{ sku: "X", size: "1", qty: 501 }]), (err) => err.code === "too_many_pairs");
});

test("a label must really be a PDF, JPEG or PNG", () => {
  assert.equal(labelFile(PDF)?.ext, "pdf");
  assert.equal(labelFile(`data:application/pdf;base64,${Buffer.from("not a pdf at all".repeat(20)).toString("base64")}`), null);
  assert.equal(labelFile("https://example.com/label.pdf"), null);
});

function deps(rows) {
  const calls = [];
  return {
    calls,
    db: { get: async () => rows },
    async callKc(path, body) {
      calls.push({ to: "kc", path, body });
      return { ok: true, forward: { id: "f1", display_id: "FWD-000040", shipping_status: body.labels.length ? "ready_to_ship" : "awaiting_label" } };
    },
    async callWms(path, body) {
      calls.push({ to: "wms", path, body });
      return { url: "https://labels/x.pdf", filename: "x.pdf" };
    }
  };
}

test("a forward is made through the Kickz Caviar portal with the picked pairs", async () => {
  const d = deps([pair("p1"), pair("p2"), pair("p3", { size: "43" })]);

  const result = await createPartnerForward(d, partner, { lines: [{ sku: "A05FW702", size: "44", qty: 2 }], tracking: "1Z FV6 483 68" });

  assert.deepEqual(result, { id: "f1", display_id: "FWD-000040", pairs: 2, shipping_status: "awaiting_label", invoice: null });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].path, "/api/internal/forwarding/create");
  assert.deepEqual(d.calls[0].body.pair_ids.sort(), ["p1", "p2"]);
  assert.equal(d.calls[0].body.seller_record_id, "recJIMMY00000001");
  assert.deepEqual(d.calls[0].body.tracking_numbers, ["1ZFV648368"]);
  assert.equal(d.calls[0].body.buyer, null);
});

test("a label is stored first and goes into the forward", async () => {
  const d = deps([pair("p1")]);

  await createPartnerForward(d, partner, { lines: [{ sku: "A05FW702", size: "44", qty: 1 }], label: PDF });

  assert.deepEqual(d.calls.map((c) => c.to), ["wms", "kc"]);
  assert.equal(d.calls[0].path, "/api/upload-label-file");
  assert.equal(d.calls[1].body.labels[0].url, "https://labels/x.pdf");
});

test("nothing is made when a size no longer has enough pairs", async () => {
  const d = deps([pair("p1")]);

  await assert.rejects(
    createPartnerForward(d, partner, { lines: [{ sku: "A05FW702", size: "44", qty: 2 }], label: PDF }),
    (err) => err.code === "pairs_gone" && err.status === 409
  );
  assert.equal(d.calls.length, 0, "no label stored and no forward made");
});

test("a bad label or tracking number stops the forward before anything happens", async () => {
  const d = deps([pair("p1")]);
  const lines = [{ sku: "A05FW702", size: "44", qty: 1 }];

  await assert.rejects(createPartnerForward(d, partner, { lines, label: "data:text/plain;base64,aGVsbG8=" }), (err) => err.code === "bad_label");
  await assert.rejects(createPartnerForward(d, partner, { lines, tracking: "abc" }), (err) => err.code === "bad_tracking");
  assert.equal(d.calls.length, 0);
});

test("only pairs on our own shelf can be sent from here", async () => {
  const { loadForwardable } = await import("../partner/partnerForward.js");
  const paths = [];
  await loadForwardable({ get: async (path) => (paths.push(path), []) }, "recJIMMY00000001");

  assert.ok(paths[0].includes("warehouse=eq.lojiq"));
  assert.ok(paths[0].includes("status=eq.in_stock"));
});

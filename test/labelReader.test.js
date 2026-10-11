import test from "node:test";
import assert from "node:assert/strict";

import { classifyTracking, createLabelReader, typedTrackingOk, upsValid } from "../partner/labelReader.js";

// Real numbers from our own forwards.
const REAL_UPS = ["1ZR0082Y6898283021", "1Z842FX49112726084", "1ZE00C269111035909", "1ZFV64830405379970", "1ZR1J1029108735641"];

test("the UPS check digit holds on real numbers and catches one wrong character", () => {
  for (const number of REAL_UPS) assert.equal(upsValid(number), true, number);
  assert.equal(upsValid("1ZR0082Y6898283031"), false);
  assert.equal(upsValid("1ZR0082Y6898283121"), false);
  assert.equal(upsValid("1Z5F71W9681324"), false, "a number cut short");
});

test("numbers are recognised as UPS or DPD after spaces are taken out", () => {
  assert.deepEqual(classifyTracking("1Z FV6 483 04 0537 9970"), { carrier: "UPS", tracking: "1ZFV64830405379970", valid: true });
  assert.deepEqual(classifyTracking("0522 2389 0987 11"), { carrier: "DPD", tracking: "05222389098711", valid: true });
  assert.equal(classifyTracking("12345").valid, false);
});

test("a typed number may be another carrier's, but never a broken UPS one", () => {
  assert.equal(typedTrackingOk("CZ123456789").carrier, "other");
  assert.equal(typedTrackingOk("1ZR0082Y6898283031"), null);
  assert.equal(typedTrackingOk("abc"), null);
});

function fakeClient(answer, record = {}) {
  return {
    beta: {
      messages: {
        async create(request) {
          Object.assign(record, request);
          return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] };
        }
      }
    }
  };
}

const PDF = { mime: "application/pdf", ext: "pdf", buffer: Buffer.from("%PDF-1.4 label") };

test("a PDF is sent as a document and only checked numbers come back as valid", async () => {
  const request = {};
  const reader = createLabelReader({
    client: fakeClient({ labels: [{ carrier: "UPS", tracking: "1ZR0082Y6898283021" }, { carrier: "UPS", tracking: "1ZR0082Y6898283031" }, { carrier: "UPS", tracking: "1ZR0082Y6898283021" }] }, request)
  });

  const found = await reader.read(PDF);

  assert.equal(request.messages[0].content[0].type, "document");
  assert.equal(request.model, "claude-opus-5-5");
  assert.deepEqual(found.map((f) => [f.tracking, f.valid]), [["1ZR0082Y6898283021", true], ["1ZR0082Y6898283031", false]], "duplicates dropped, the misread one marked");
});

test("a photo is sent as an image; nothing readable gives an empty list", async () => {
  const request = {};
  const reader = createLabelReader({ client: fakeClient({ labels: [] }, request) });

  assert.deepEqual(await reader.read({ mime: "image/jpeg", ext: "jpg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0]) }), []);
  assert.equal(request.messages[0].content[0].type, "image");
});

test("without a key nothing is read and the partner types the number", async () => {
  const reader = createLabelReader({ apiKey: "" });
  assert.equal(reader.configured, false);
  assert.deepEqual(await reader.read(PDF), []);
});

import test from "node:test";
import assert from "node:assert/strict";

import { createWtbPhoto, readDataUrl } from "../admin/wtbPhoto.js";

const tiny = (media = "image/png", chars = 400) => `data:${media};base64,${"A".repeat(chars)}`;

const reading = (lines) => ({
  messages: {
    create: async (body) => {
      reading.asked = body;
      return { stop_reason: "end_turn", content: [{ type: "text", text: lines }] };
    }
  }
});

test("only a real picture, and not a huge one", () => {
  assert.equal(readDataUrl(tiny("image/png")).media, "image/png");
  assert.equal(readDataUrl(tiny("image/jpeg")).media, "image/jpeg");

  assert.match(readDataUrl("hello").error, /not an image/);
  assert.match(readDataUrl(tiny("application/pdf")).error, /not a kind of picture/);

  // Four base64 characters carry three bytes, so this is just over 5MB.
  assert.match(readDataUrl(tiny("image/png", 7 * 1024 * 1024)).error, /limit is 5MB/);
});

test("the picture goes up and plain lines come back", async () => {
  const client = reading("DM7866-202,42\nDM7866-202,42.5\nIH9246,38 2/3");
  const photo = createWtbPhoto({ client });

  assert.equal(await photo.read(tiny()), "DM7866-202,42\nDM7866-202,42.5\nIH9246,38 2/3");

  const sent = reading.asked;
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.messages[0].content[0].type, "image");
  assert.equal(sent.messages[0].content[0].source.media_type, "image/png");
  assert.match(sent.messages[0].content[1].text, /article number/);
});

test("a fence round the answer is not part of the answer", async () => {
  const photo = createWtbPhoto({ client: reading("```\nJQ4891,43 1/3\n```") });

  assert.equal(await photo.read(tiny()), "JQ4891,43 1/3");
});

test("a reading it declines to give is not a blank list", async () => {
  const photo = createWtbPhoto({
    client: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } }
  });

  await assert.rejects(() => photo.read(tiny()), /could not be read/);
});

test("without a key the feature is simply off", async () => {
  const photo = createWtbPhoto({});

  assert.equal(photo.configured, false);
  await assert.rejects(() => photo.read(tiny()), /needs ANTHROPIC_API_KEY/);
});

test("the model is a setting, because what a picture costs is Dario's call", async () => {
  const client = reading("X,42");
  await createWtbPhoto({ client, model: "claude-haiku-5-5" }).read(tiny());

  assert.equal(reading.asked.model, "claude-haiku-5-5");
});

test("the SDK is only loaded when a picture is really read", async () => {
  let loaded = 0;
  const photo = createWtbPhoto({
    apiKey: "sk-test",
    load: async () => {
      loaded += 1;
      return { default: class { constructor() { this.messages = { create: async () => ({ content: [{ type: "text", text: "A1234,42" }] }) }; } } };
    }
  });

  assert.equal(loaded, 0, "nothing is imported just by making the reader");
  assert.equal(await photo.read(tiny()), "A1234,42");
  assert.equal(loaded, 1);
});

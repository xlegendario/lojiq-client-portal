// partner/labelReader.js
//
// Reading the tracking number off a shipping label the partner adds to a
// forward, so he never has to type one and we never get a label without its
// number.
//
// His labels are UPS or DPD, as a PDF or as a photo, upright or sideways,
// sometimes several in one file. Claude reads them (the same as the WTB
// photo reading in the admin); every number it gives back is then checked on
// its own shape before it is believed:
//
//   UPS  1Z + 16 characters, the last one a check digit over the others
//   DPD  14 digits (the parcel number; its own check character is printed
//        apart and not part of the number)
//
// A number that fails the check is handed back as unreadable, and the page
// asks the partner to type it. A misread digit therefore stops at the page;
// it never becomes a forward with a wrong number on it.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const LABEL_TYPES = ["application/pdf", "image/jpeg", "image/png"];

/* ---------------- what a number may look like ---------------- */

// The UPS check digit: over the 15 characters after "1Z", letters counted
// as (code - 63) mod 10, every second one doubled.
export function upsValid(number) {
  if (!/^1Z[0-9A-Z]{16}$/.test(number)) return false;

  const body = number.slice(2, 17);
  let total = 0;

  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    let n = /\d/.test(c) ? Number(c) : (c.charCodeAt(0) - 63) % 10;
    if (i % 2 === 1) n *= 2;
    total += n;
  }

  return (10 - (total % 10)) % 10 === Number(number[17]);
}

export const dpdValid = (number) => /^0\d{13}$/.test(number);

// Spaces and dashes out, upper case: "1Z FV6 483 68 0405 3799 70" is one number.
export const cleanTracking = (value) => text(value).replace(/[\s-]/g, "").toUpperCase();

/*
 * What a number is, or that it is not one we trust.
 * A typed number of another carrier is allowed through as "other" by the
 * caller; a read one is only believed as UPS or DPD.
 */
export function classifyTracking(value) {
  const number = cleanTracking(value);
  if (upsValid(number)) return { carrier: "UPS", tracking: number, valid: true };
  if (dpdValid(number)) return { carrier: "DPD", tracking: number, valid: true };
  return { carrier: number.startsWith("1Z") ? "UPS" : "", tracking: number, valid: false };
}

// Typed by the partner: a real UPS or DPD number, or at least something that
// looks like a tracking number of another carrier.
export function typedTrackingOk(value) {
  const found = classifyTracking(value);
  if (found.valid) return found;
  if (found.carrier === "UPS") return null; // a 1Z number with a wrong check digit is a typo
  return /^[A-Z0-9]{8,40}$/.test(found.tracking) ? { carrier: "other", tracking: found.tracking, valid: true } : null;
}

/* ---------------- the file ---------------- */

export function labelFromDataUrl(dataUrl) {
  const match = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(text(dataUrl));
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length < 100) return null;
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf", buffer };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", buffer };
  if (buffer.subarray(0, 4).toString("hex") === "89504e47") return { mime: "image/png", ext: "png", buffer };
  return null;
}

/* ---------------- reading ---------------- */

const PROMPT = [
  "This file is one or more parcel shipping labels (UPS or DPD), as a PDF or a photo. A label may be rotated.",
  "Find the tracking number of every label in it.",
  "- UPS: the number that starts with 1Z (18 characters), printed as TRACKING #.",
  "- DPD: the 14-digit parcel number, often printed in groups like 0521 2345 6789 01. Leave out the separate check character after it.",
  "Copy each number exactly as printed. If a number is not clearly readable, leave it out rather than guess.",
  "Answer only with the JSON."
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          carrier: { type: "string", enum: ["UPS", "DPD", "other"] },
          tracking: { type: "string" }
        },
        required: ["carrier", "tracking"],
        additionalProperties: false
      }
    }
  },
  required: ["labels"],
  additionalProperties: false
};

/*
 * deps:
 *   apiKey   ANTHROPIC_API_KEY; empty means labels are not read and the
 *            partner types the numbers
 *   model    Claude Opus 5.5, as the WTB photo reading
 *   client   a stand-in, for the tests
 */
export function createLabelReader({ apiKey = "", model = "claude-opus-5-5", client = null } = {}) {
  const configured = Boolean(text(apiKey)) || Boolean(client);

  async function anthropic() {
    if (client) return client;
    // Loaded on first use, so a broken install cannot take the portal down.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic({ apiKey: text(apiKey) });
  }

  /*
   * The tracking numbers on one file: [{ carrier, tracking, valid }].
   * An empty list means nothing could be read - the page then asks for it.
   */
  async function read(file) {
    if (!configured) return [];

    const source = { type: "base64", media_type: file.mime, data: file.buffer.toString("base64") };
    const sdk = await anthropic();

    const response = await sdk.beta.messages.create({
      model,
      max_tokens: 2000,
      // Plain reading: low effort is enough and keeps it quick on a phone.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      // On a decline the API retries on a fallback model by itself.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{
        role: "user",
        content: [
          file.mime === "application/pdf" ? { type: "document", source } : { type: "image", source },
          { type: "text", text: PROMPT }
        ]
      }]
    });

    if (response?.stop_reason === "refusal") return [];

    const raw = (response?.content || []).filter((block) => block?.type === "text").map((block) => block.text).join("");
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```[a-z]*\s*|\s*```$/gi, ""));
    } catch {
      return [];
    }

    const seen = new Set();
    return (parsed?.labels || [])
      .map((label) => classifyTracking(label?.tracking))
      .filter((label) => label.tracking && !seen.has(label.tracking) && seen.add(label.tracking));
  }

  return { configured, model, read };
}

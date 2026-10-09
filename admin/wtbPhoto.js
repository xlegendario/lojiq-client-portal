// admin/wtbPhoto.js
//
// Reading a want-to-buy off a screenshot.
//
// Most WTBs arrive as text and admin/wtbMatch.js reads those on its own. Some
// arrive as a picture of someone else's list, and until now those had to be
// typed over by hand. This asks Claude to read the picture back as the same
// "sku,size" lines a person would have pasted, and from there nothing is
// different: the lines go through the ordinary parser, and the screen shows
// what it understood before anything is looked up.
//
// That last part is what makes this safe to use. A model misreading a digit
// turns FQ8138-002 into FQ8I38-002 and the matcher would answer "not on any
// shelf" for a pair we hold - so the reading is never acted on directly. It
// lands in the same correction table as everything else, where a wrong line
// is visible and editable before an offer is made on it.
//
// Off unless ANTHROPIC_API_KEY is set, so a portal without one behaves
// exactly as it did before.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Claude takes images up to 5MB each; a phone photo of a Discord message is a
// fraction of that, and a bigger one is a mistake worth naming.
export const PHOTO_LIMIT = 5 * 1024 * 1024;

// A tall screenshot comes in as bands rather than shrunk to fit (the cutting
// is in private/admin-wtb-match.html). Eight of them is already a page and a
// half of grid; past that it is likelier a mistake than a want-to-buy.
export const MOST_BANDS = 8;

/*
 * The picture, out of what the browser sent.
 *
 * A data URL rather than a file upload, because the paste box already works
 * that way and a screenshot is pasted as often as it is chosen.
 */
export function readDataUrl(dataUrl) {
  const found = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(text(dataUrl));

  if (!found) return { error: "That is not an image." };

  const media = found[1].toLowerCase();
  const data = found[2];

  if (!PHOTO_TYPES.includes(media)) {
    return { error: `${media} is not a kind of picture this reads. Use a JPEG, PNG, GIF or WebP.` };
  }

  // Base64 carries three bytes in every four characters.
  const bytes = Math.floor((data.length * 3) / 4);

  if (bytes > PHOTO_LIMIT) {
    return { error: `That picture is ${(bytes / 1024 / 1024).toFixed(1)}MB and the limit is 5MB.` };
  }

  return { media, data };
}

// A screenshot taller than a reader takes in one go arrives cut into bands,
// and then it has to be said that they are one list and not several.
const BANDS = [
  "These pictures are one screenshot, cut into overlapping horizontal bands.",
  "Read them as one list, top to bottom. An item on a seam shows up in two",
  "bands; write it once.",
  ""
];

const LIST = [
  "This is a want-to-buy. It is either a list of lines, or a grid of product",
  "cards - and on a card the name is on top, the article number is the small",
  "faint code under the name, and the sizes are at the foot of the card.",
  "",
  "Write out every item, one line each, as:",
  "",
  "  <article number>,<size>",
  "",
  "The article number is the manufacturer's code - DM7866-202, U9060BPM,",
  "JQ4891, 675033, H03474. It is not the product name, and not a year in",
  "brackets.",
  "",
  "Rules:",
  "- Every item in the picture, without exception. A grid of twenty-four",
  "  cards is twenty-four items, not the handful that read most easily.",
  "- One line per size. A card with three sizes under it becomes three lines.",
  "- Copy the size exactly as written: 42, 42.5, 38 2/3, 38-39, L.",
  "- \"38x2\" means that size twice; write the size once.",
  "- An article number you cannot read with confidence: skip that item,",
  "  rather than guess at a character.",
  "- An item struck through is still an item; include it.",
  "- Nothing else. No heading, no numbering, no commentary, no code fences."
];

const promptFor = (bands) => (bands > 1 ? [...BANDS, ...LIST] : LIST).join("\n");

/*
 * deps:
 *   apiKey   ANTHROPIC_API_KEY. Empty means the whole feature is off.
 *   model    overridable, because what this costs per picture is Dario's
 *            call and not a thing to bury in code.
 *   client   a stand-in, for the tests.
 */
export function createWtbPhoto({
  apiKey = "",
  model = "claude-opus-5-5",
  client = null,
  load = null
} = {}) {
  const configured = Boolean(text(apiKey)) || Boolean(client);

  async function anthropic() {
    if (client) return client;

    /*
      Brought in only when a picture is actually read. The portal starts
      without it, so a missing or broken install cannot take the whole admin
      down for a feature nobody may use that day.
    */
    const { default: Anthropic } = load ? await load() : await import("@anthropic-ai/sdk");

    return new Anthropic({ apiKey: text(apiKey) });
  }

  /*
   * The lines in a picture, as text.
   *
   * Takes the bands the browser cut the screenshot into - one picture is one
   * band - and sends them in order as a single question, because a card on a
   * seam is only whole if both halves are in front of the same reader.
   *
   * Hands back exactly what a person would have pasted, so the caller can
   * put it through the ordinary parser rather than trusting a second reading
   * of its own.
   */
  async function read(pictures) {
    if (!configured) {
      throw Object.assign(
        new Error("Reading a picture needs ANTHROPIC_API_KEY on this service."),
        { statusCode: 503 }
      );
    }

    const bands = (Array.isArray(pictures) ? pictures : [pictures]).filter((band) => text(band));

    if (!bands.length) throw Object.assign(new Error("That is not an image."), { statusCode: 400 });

    if (bands.length > MOST_BANDS) {
      throw Object.assign(
        new Error(`That picture is too tall to read in one go (${bands.length} parts).`),
        { statusCode: 400 }
      );
    }

    const parts = bands.map(readDataUrl);
    const bad = parts.find((part) => part.error);

    if (bad) throw Object.assign(new Error(bad.error), { statusCode: 400 });

    const sdk = await anthropic();

    const response = await sdk.messages.create({
      model,
      // A grid of two dozen cards with several sizes each is a long answer,
      // and a reading cut off halfway is worse than no reading.
      max_tokens: 8000,
      messages: [{
        role: "user",
        content: [
          ...parts.map((part) => ({
            type: "image",
            source: { type: "base64", media_type: part.media, data: part.data }
          })),
          { type: "text", text: promptFor(bands.length) }
        ]
      }]
    });

    // It can decline, and then there is no reading to hand on.
    if (response?.stop_reason === "refusal") {
      throw Object.assign(new Error("The picture could not be read."), { statusCode: 422 });
    }

    const lines = (response?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => text(block.text))
      .join("\n");

    // A model asked for bare lines still sometimes wraps them in a fence.
    return lines.replace(/^```[a-z]*\s*|\s*```$/gi, "").trim();
  }

  return { configured, model, read };
}

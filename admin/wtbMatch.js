// admin/wtbMatch.js
//
// Matching a want-to-buy against everything we can actually get hold of.
//
// A WTB arrives in Discord as a line of text or a screenshot, and answering it
// means opening the warehouse, the consignment stock and the partner stock one
// after another and reading them by eye. This does that in one pass: paste the
// request, see what it was understood to be, and get every unit we hold for it
// with what it costs us.
//
// Everything here is pure. The reading of the three sources happens elsewhere;
// this decides what was asked and what counts as an answer.
//
// What the stock actually looks like, measured 09-10-2026 across all three:
//
//   warehouse    164 available units, 33 size values, not one odd notation
//   consignment  21283 rows, the same notations plus 110 clothing sizes
//   partner      1305 rows, the same, plus S/M/L/XL and 557 Crocs size ranges
//
// Two size families, then: plain and half sizes (42, 42.5) and the adidas
// thirds (36 2/3, 37 1/3). No SKU carries the same foot under two spellings.
// That matters more than it sounds: because a request is matched on its SKU
// first, sizes only ever have to agree within one SKU. A size range like
// "42-43" belongs to one Crocs article and can only ever be hit by a request
// for that article, so it needs no special handling at all.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/*
 * A size as everything here compares it.
 *
 * Case and spacing go, because "42 2/3", "42  2/3" and "42 2/3 " are one size
 * written by three people. Thirds written as a decimal are folded onto the
 * fraction the catalogue uses - nobody stocks "37.33", but a request typed in
 * a hurry says it - and a trailing ".0" is dropped so "42.0" finds 42.
 */
export function sizeKey(value) {
  let size = text(value).toUpperCase().replace(/\s+/g, " ");

  if (!size) return "";

  // "37 1/3" and "371/3" are the same request.
  size = size.replace(/^(\d+)\s*(\d\/\d)$/, "$1 $2");

  const decimal = /^(\d+)[.,](\d+)$/.exec(size);

  if (decimal) {
    const whole = decimal[1];
    const rest = decimal[2];

    if (/^0+$/.test(rest)) return whole;
    if (rest === "5" || rest === "50") return `${whole}.5`;
    if (/^3+$/.test(rest)) return `${whole} 1/3`;
    if (/^6+7?$/.test(rest)) return `${whole} 2/3`;
  }

  return size;
}

// A SKU as everything here compares it. Exact, case-insensitive, and nothing
// else: a SKU with a stray space is a different article, not a near miss.
export const skuKey = (value) => text(value).toUpperCase().replace(/\s+/g, "");

/*
 * A product name as this compares it.
 *
 * Nothing but the words: two sources write the same shoe as "Samba OG
 * (Women's)" and "Samba OG Womens", and neither the brackets, the
 * apostrophe nor the plural is what makes them different shoes. The
 * possessive goes before the punctuation does, so "Women's" leaves "women"
 * behind and not a stray "s", and a trailing "s" comes off the longer words
 * so that "Womens" lands on the same key.
 *
 * The result is not English - "Campus" keys as "campu" - and it does not
 * need to be. Both sides of every comparison are put through this, and a
 * key is only ever compared with another key.
 */
export const nameKey = (value) => text(value)
  .toLowerCase()
  .replace(/['’]s\b/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(" ")
  // Short words are left alone: "00s" is how a shoe is called and "s" on
  // its own is nothing at all.
  .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word))
  .join(" ");

/*
 * Which article a name belongs to.
 *
 * A screenshot of a shop's grid carries the name in readable type and the
 * article number as a smudge four pixels high, so for those the name is all
 * there is to go on. The name is matched whole where it can be, and
 * otherwise one name being contained in the other counts - a shop writing
 * "Samba OG Dark Brown Tweed" and our shelf writing "adidas Samba OG Dark
 * Brown Tweed" is the same shoe.
 *
 * The size is deliberately not part of this. The question here is which
 * shoe he means, and a size we happen not to hold does not make the shoe
 * unrecognisable - it makes it a pair we do not have, which is a different
 * answer and a useful one.
 *
 * What it will not do is guess. If the name reaches more than one article
 * the answer is nothing at all, because "Samba OG" is twenty different
 * shoes and offering on whichever came first is worse than admitting the
 * number could not be read.
 */
export function theArticleCalled(name, index) {
  const asked = nameKey(name).split(" ").filter(Boolean);

  // One word is not a name. "Jordan" is a thousand shoes.
  if (asked.length < 2) return "";

  const whole = index.get(asked.join(" "));

  if (whole?.size === 1) return [...whole][0];

  const found = new Set();

  for (const [key, skus] of index) {
    const words = key.split(" ");
    const [few, many] = words.length < asked.length ? [words, asked] : [asked, words];

    if (!few.every((word) => many.includes(word))) continue;

    for (const sku of skus) found.add(sku);

    // Two is already too many; a third changes nothing.
    if (found.size > 1) return "";
  }

  return found.size === 1 ? [...found][0] : "";
}

/*
 * What a want-to-buy is asking for.
 *
 * Takes what is pasted in, whatever shape it came in: the "sku,size" csv the
 * partner makes with a chatbot, or the raw line from Discord -
 *
 * A size as a word, and nothing else.
 */
const CLOTHING = /^(XXS|XS|S|M|L|XL|XXL|XXXL)$/i;
const RANGE = /^(\d{1,2})-(\d{1,2})$/;

/*
 * A pair of sizes, as a clog or a slide is sold: 38-39, 36-37.
 *
 * Both ends have to be sizes and they have to be next to each other.
 * "Gel-Sonoma 15-50" is what the shoe is called, and reading it as a range
 * from 15 to 50 put a size on the screen that nobody asked for.
 */
function isRange(value) {
  const found = RANGE.exec(value);

  if (!found) return false;

  const low = Number(found[1]);
  const high = Number(found[2]);

  return inSizes(low) && inSizes(high) && high - low > 0 && high - low <= 2;
}
const NUMBER = /^(\d{1,2})(?:[.,]\d+)?(?: \d\/\d)?$/;

/*
 * A word that is a size.
 *
 * The bound on the number is what keeps a product name out: "Jordan 1" and
 * "Dunk Low 85" are not requests for a size 1 or an 85. Everything in all
 * three sources sits between 35 and 49, so 15 to 60 is wide enough for a
 * child's size and narrow enough to ignore the name of the shoe.
 */
const inSizes = (number) => number >= 15 && number <= 60;

function isSize(word) {
  const value = text(word);

  if (CLOTHING.test(value) || isRange(value)) return true;

  const number = NUMBER.exec(value);

  if (!number) return false;

  return inSizes(Number(number[1]));
}

const SKU_TOKEN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

function looksLikeSku(token) {
  const word = text(token);

  if (word.length < 5 || !/\d/.test(word)) return false;
  if (!SKU_TOKEN.test(word) || isSize(word)) return false;

  /*
    Two short numbers either side of a dash. Where they are next to each
    other it is a clog's pair of sizes and isSize has already said so;
    where they are not it is part of a name - the 15-50 in "Gel-Sonoma
    15-50" - and either way it is far too short to be an article. The
    shortest article anywhere in the stock is six characters.
  */
  if (RANGE.test(word)) return false;
  if (/[A-Za-z]/.test(word) || word.includes("-")) return true;

  /*
    All digits and nothing else. "675033" is a real article - 5.818 pairs
    carry one shaped like that, and the shortest article anywhere in the
    stock is six characters - while "2024" and "2025" are the year a shoe
    came out, written in brackets beside its name. The length is the only
    thing that tells them apart.
  */
  return word.length >= 6;
}

/*
 * The articles in one word.
 *
 * A pair can be sold under two numbers and a WTB writes both, either side of
 * a slash: "FQ7928-001 / HM8965-001", or with no spaces at all. Both are
 * looked for, because stock of either is stock of the pair he wants.
 */
const skusIn = (token) => text(token).split("/").map(text).filter(looksLikeSku);

// Brackets hold an article as often as they hold a note: "(U9060BPM)" is one
// and "(Women's)", "(W)" and "(2025)" are not. The brackets come off and what
// is left is judged on its own.
const bare = (token) => text(token).replace(/^[([{]+|[)\]}]+$/g, "");

// What holds two numbers for one pair together: "FQ7928-001 / HM8965-001",
// or with a dash or an "or" between them.
const JOINER = /^(?:[-–—/+&]+|or)$/i;

// The other half of "38 2/3", which is part of a size without looking like
// one on its own.
const FRACTION = /^\d\/\d$/;

/*
 * The article numbers on a line, and where they sit.
 *
 * An article number stands at one end of what he wrote - at the front, the
 * way Discord writes it, or at the back of the name, the way a shop's card
 * prints it under the title. A code in the middle of a name is part of what
 * the shoe is called: the HS4-S in "ASICS HS4-S Gel-Sonoma", the 1906D in
 * "New Balance 1906D Protection Pack White".
 *
 * FIXED - every word that looked like an article was taken for one, so a
 * single card came back as two requests: HS4-S in 43.5 and 1201A440-301 in
 * 43.5, one of them a shoe that does not exist. The same line could also
 * lose its real article to a model code further along.
 *
 * A pair really sold under two numbers writes them side by side, so a run
 * of articles with nothing but a joiner between them counts as one.
 */
export function articlesIn(words = []) {
  const hits = [];

  words.forEach((word, at) => {
    const found = skusIn(bare(word));

    if (found.length) hits.push({ at, found });
  });

  const nothing = { skus: [], from: -1, last: -1 };

  if (!hits.length) return nothing;

  /*
    Where the sizes begin, which is where the name ends. The dash in
    "HQ2037-002 - 43" belongs to neither, and leaving it standing here put
    the article one word short of the end and lost it to the name.
  */
  let end = words.length - 1;

  while (end >= 0) {
    const word = bare(words[end]);

    if (!isSize(word) && !FRACTION.test(word) && !/^eu$/i.test(word) && !JOINER.test(word)) break;

    end -= 1;
  }

  const joined = (left, right) => words
    .slice(left + 1, right)
    .every((word) => JOINER.test(bare(word)));

  const runFrom = (start, step) => {
    let i = start;

    for (;;) {
      const next = i + step;

      if (next < 0 || next >= hits.length) break;
      if (!joined(Math.min(hits[i].at, hits[next].at), Math.max(hits[i].at, hits[next].at))) break;

      i = next;
    }

    return i;
  };

  const kept = [];

  // Anchored at the front of the line.
  if (hits[0].at === 0) kept.push(...hits.slice(0, runFrom(0, 1) + 1));

  // Anchored at the end of the name, right in front of the sizes.
  if (hits[hits.length - 1].at === end) {
    for (const hit of hits.slice(runFrom(hits.length - 1, -1))) {
      if (!kept.includes(hit)) kept.push(hit);
    }
  }

  if (!kept.length) return nothing;

  return {
    skus: kept.flatMap((hit) => hit.found),
    from: kept[0].at,
    last: kept[kept.length - 1].at
  };
}

/*
 * What a want-to-buy is asking for.
 *
 * Takes the paste whatever shape it came in: a "sku,size" list, a Discord
 * line with the article in brackets, a line with the article tucked at the
 * end of the name, or a request spread over several lines -
 *
 *   wtb
 *   Air Jordan 4 Retro OG SP A Ma Maniére While You Were Sleeping (W)
 *   FZ4810-200
 *   47
 *
 * An article with no size after it waits for the sizes on the lines below,
 * and the name above it is kept so the offer can be written in his words.
 * A line holding neither an article nor a size is a heading or a name and is
 * passed over in silence; a line with sizes and no article anywhere is a
 * request we cannot answer, and he is told.
 */
export function parseRequest(input) {
  const rows = [];
  const unreadable = [];

  // An article still waiting for its sizes, and the name that went with it.
  let pending = null;
  // A line of words waiting to turn out to be the name of an article.
  let spare = "";

  for (const raw of text(input).split(/\r?\n/)) {
    /*
      Discord's mark-up comes along with the paste and sticks to the words it
      decorates: a line struck through arrives as "~~1144032-SAN ... 41~~".
      None of these ever appear in an article or a size. The underscore stays,
      because that can be part of an article number.
    */
    const line = text(raw).replace(/[~*`]/g, " ").replace(/\s+/g, " ").trim();

    if (!line) continue;

    const words = line.split(/[\s,;|]+/).map(bare).filter(Boolean);

    // Where the last article sits, so the sizes behind it can be told from
    // the numbers in front of it.
    const { skus, last } = articlesIn(words);

    // "37 1/3" arrives as two words and is one size.
    const tail = skus.length ? words.slice(last + 1) : words;
    const sizes = [];

    for (let i = 0; i < tail.length; i += 1) {
      if (/^\d{1,2}$/.test(tail[i]) && /^\d\/\d$/.test(tail[i + 1] || "")) {
        sizes.push(`${tail[i]} ${tail[i + 1]}`);
        i += 1;
        continue;
      }

      if (isSize(tail[i])) sizes.push(tail[i]);
    }

    const add = (forSkus, forSizes, from) => {
      for (const size of forSizes) {
        for (const sku of forSkus) {
          rows.push({ sku: skuKey(sku), name: "", size: sizeKey(size), line: from });
        }
      }
    };

    if (skus.length && sizes.length) {
      pending = null;
      spare = "";
      add(skus, sizes, line);
      continue;
    }

    if (skus.length) {
      // Its sizes are on the next line or two; the name is on the one above.
      pending = { skus, line: [spare, line].filter(Boolean).join(" ").trim() };
      spare = "";
      continue;
    }

    if (sizes.length) {
      if (pending?.skus?.length) {
        add(pending.skus, sizes, pending.line);
        // Answered, so it is not also reported as an article nobody sized.
        pending = null;
        continue;
      }

      /*
        Sizes and a name, but no article. A screenshot of a shop's grid
        comes out this way every time: the name is in readable type and
        the article number under it is a smudge four pixels high, so the
        name is all there is. It is carried as the name and the shelf is
        asked which article that is.
      */
      const named = [spare, line].filter(Boolean).join(" ").trim();
      const name = productFromLine(named);

      if (name) {
        for (const size of sizes) {
          rows.push({ sku: "", name, size: sizeKey(size), line: named });
        }

        spare = "";
        pending = null;
        continue;
      }

      // Sizes and nothing else at all: a request nobody can answer.
      unreadable.push(line);
      continue;
    }

    /*
      Neither an article nor a size: a heading, or the name belonging to
      the article on the line below. It is kept as a name, and if no
      article ever claims it, a line of any length is reported at the end
      rather than dropped in silence - "wtb" and "some examples:" are not
      requests, but a sentence nobody could read is one.
    */
    if (/[A-Za-z]/.test(line) && !/^wtb/i.test(line)) {
      if (spare && spare.split(" ").length >= 4) unreadable.push(spare);
      spare = line;
      pending = null;
    }
  }

  if (spare && spare.split(" ").length >= 4) unreadable.push(spare);

  // An article whose sizes never arrived was still a request.
  if (pending?.skus?.length) unreadable.push(pending.line);

  // The same pair asked for twice is one question.
  const seen = new Set();
  const wanted = [];

  for (const row of rows) {
    const key = `${row.sku}|${text(row.name)}|${row.size}`;

    if (seen.has(key)) continue;

    seen.add(key);
    wanted.push(row);
  }

  return { wanted, unreadable };
}

/*
 * Every unit we hold for what was asked.
 *
 * One asked-for pair can come back several times over - the same shoe from the
 * warehouse and from two consignors is three offers at three prices, and which
 * one to use is a judgement nobody here should make for him. So they all come
 * back, cheapest first, and a pair we do not have comes back too, empty, so a
 * gap in the list cannot be mistaken for a gap in the reading.
 */
export function matchStock(wanted = [], stock = []) {
  const shelf = new Map();
  const articles = new Map();

  for (const unit of stock) {
    const sku = skuKey(unit.sku);
    const key = `${sku}|${sizeKey(unit.size)}`;

    if (!shelf.has(key)) shelf.set(key, []);
    shelf.get(key).push(unit);

    const name = nameKey(unit.product_name);

    if (!name) continue;

    if (!articles.has(name)) articles.set(name, new Set());
    articles.get(name).add(sku);
  }

  return wanted.map((row) => {
    /*
      A pair recognised by its name answers with the article it turned out
      to be, and is looked up like any other from there on - so the offer,
      the file and the screen all get what they need, and a size we do not
      hold comes back as a pair we do not have rather than as a name we
      could not read. Where the name reached nothing the article stays
      empty, and the line he wrote is what is shown back to him.
    */
    const sku = row.sku || theArticleCalled(row.name, articles);
    const found = sku ? groupOptions(shelf.get(`${sku}|${row.size}`) || []) : [];

    return {
      sku,
      size: row.size,
      line: row.line,
      name: text(row.name),
      by_name: Boolean(!row.sku && sku),
      options: found,
      sources: found.length
    };
  });
}

/*
 * One line per place the pair can come from, not per pair.
 *
 * Five of ours on the shelf is one place to get it, not five offers: it
 * filled the screen with the same row over and over and said nothing a
 * quantity does not say better. A consignor is a place of his own, because
 * asking two men is two conversations, and so is each partner.
 *
 * The cheapest of a group is what the line costs - that is the one you would
 * take - and the quantities add up.
 */
export function groupOptions(options = []) {
  const groups = new Map();

  for (const option of options) {
    const key = text(option.source) === "Warehouse"
      ? "Warehouse"
      : `${text(option.source)}|${text(option.seller_record_id) || text(option.seller)}`;

    const held = groups.get(key);

    if (!held) {
      groups.set(key, { ...option, quantity: Number(option.quantity) || 0, units: 1 });
      continue;
    }

    held.quantity += Number(option.quantity) || 0;
    held.units += 1;

    const cost = Number(option.cost);

    if (Number.isFinite(cost) && (!Number.isFinite(Number(held.cost)) || cost < Number(held.cost))) {
      // The cheapest one in the group is the one an offer would be built on.
      held.cost = option.cost;
      held.id = option.id;
      held.reference = option.reference;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const left = Number(a.cost);
    const right = Number(b.cost);

    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;

    return text(a.source).localeCompare(text(b.source));
  });
}

/* ---------------- the three shelves, in one shape ---------------- */

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
};

/*
 * Our own stock, out of the Airtable Inventory Units, as unitRow leaves it.
 *
 * Only what is actually free: a unit promised to an order is not an answer to
 * a new one. Its cost is what we paid, because the pair is already ours.
 */
export const warehouseOption = (unit) => ({
  source: "Warehouse",
  id: text(unit.id),
  reference: text(unit.item_id),
  sku: skuKey(unit.sku),
  size: sizeKey(unit.size),
  product_name: text(unit.product_name),
  seller: "",
  quantity: 1,
  cost: money(unit.cost),
  cost_means: "what we paid for it",
  vat_type: text(unit.vat_type),
  location: text(unit.location),
  note: text(unit.condition)
});

/*
 * A consignor's pair. His asking price is our cost, not his payout: the
 * payout is what is left after us, and offering on it would be offering on
 * money we never had.
 */
export const consignmentOption = (row) => ({
  source: "Consignment",
  id: text(row.id),
  reference: "",
  sku: skuKey(row.sku),
  size: sizeKey(row.size),
  product_name: text(row.product_name),
  seller: text(row.seller_id),
  seller_record_id: text(row.seller_record_id),
  // Filled in by the store, which is the only thing here that can
  // reach Airtable. Empty for an ordinary consignor.
  seller_source: "",
  quantity: Number(row.quantity) || 0,
  cost: money(row.ask),
  cost_means: "what the consignor asks",
  vat_type: text(row.vat_type),
  // A partner's pair is already on our shelf; a consignor's still has to come.
  location: row.partner ? "Our warehouse" : "With the consignor",
  note: ""
});

/*
 * Partner stock. Only what is on the shelf - reserved is promised to a deal
 * that may still happen, and sold or forwarded is gone.
 */
export const partnerOption = (row) => ({
  source: "Partner",
  id: text(row.id),
  reference: "",
  sku: skuKey(row.sku),
  size: sizeKey(row.size),
  product_name: text(row.product_name),
  seller: text(row.seller_id),
  seller_record_id: text(row.seller_record_id),
  // Filled in by the store, which is the only thing here that can
  // reach Airtable. Empty for an ordinary consignor.
  seller_source: "",
  quantity: 1,
  cost: money(row.partner_price),
  cost_means: "what the partner charges",
  vat_type: text(row.vat_type),
  location: "Our warehouse",
  note: text(row.mode)
});

/*
 * Everything we can actually get hold of, in one list.
 *
 * Each source decides for itself what "available" means, because each means
 * something different by it, and a pair that is spoken for must not turn up
 * as an offer.
 */
export function shelf({ warehouse = [], consignment = [], partner = [] } = {}) {
  return [
    ...warehouse
      .filter((unit) => text(unit.availability).toLowerCase() === "available")
      .map(warehouseOption),
    ...consignment
      .filter((row) => (Number(row.quantity) || 0) > 0)
      .map(consignmentOption),
    ...partner
      .filter((row) => text(row.status) === "in_stock")
      .map(partnerOption)
  ];
}

/* ---------------- the offer, as it goes back to the buyer ---------------- */

export const VAT_TYPES = ["VAT0", "Margin", "VAT21"];

/*
 * What is left of a line once the article and the size are taken out of it.
 *
 * The buyer wrote the name himself, so his own wording goes back to him and
 * he recognises his own request. "WTB", the dashes holding it together and
 * the "EU" after the size are ours to drop; everything else is his.
 */
export function productFromLine(line) {
  // Kept as he wrote them - the brackets round (2025) are part of the name.
  const words = text(line).split(/[\s,;|]+/).filter(Boolean);

  if (!words.length) return "";

  /*
    Everything past the last article is where the sizes live, and everything
    before it is the name. A number in front of the article is part of what
    the shoe is called - the 22 in Adilette 22, the 9060 in New Balance 9060 -
    and only a number behind it is a size.

    FIXED - this cut out the one article and the one size it was handed and
    left the rest where it stood. A line carrying two of each came out as
    "Air Jordan 4 Black Cat (2025) /IB4171 010 41, 44", with half of both
    still in the name, and that is what went to the buyer.
  */
  const { from, last } = articlesIn(words);

  const kept = [];

  /*
    With no article anywhere, everything is behind it. A card off a shop's
    grid is written that way - the name, and then the sizes, with the
    article number a smudge too small to read - and a size is no more part
    of the name there than it is on a line that has an article on it.

    FIXED - this kept the whole line when there was no article in it, so
    "Supreme Hooded Sweatshirt Red L" went looking for a shoe called
    "... Red L" and of course found none.
  */
  const tail = last === -1 ? words : words.slice(last + 1);

  // Everything in front of the article is the name, codes of its own and
  // all: "ASICS HS4-S Gel-Sonoma" is called that, and handing back "ASICS
  // Gel-Sonoma" is not his wording any more.
  for (const word of words.slice(0, from === -1 ? 0 : from)) kept.push(word);

  // Behind the article, whatever is not a size is still how he wrote it.
  // "EU" is ours to drop.
  for (let i = 0; i < tail.length; i += 1) {
    const word = bare(tail[i]);

    if (/^\d{1,2}$/.test(word) && /^\d\/\d$/.test(bare(tail[i + 1] || ""))) {
      i += 1;
      continue;
    }

    /*
      An article is never back here - the run that counts ends where the
      sizes begin - and throwing away anything that merely looks like one
      cost the name its model code: "New Balance 1906D Protection Pack
      White" came back as "New Balance Protection Pack White".
    */
    if (isSize(word) || /^eu$/i.test(word)) continue;

    kept.push(tail[i]);
  }

  /*
    A dash standing on its own is what holds his line together and goes;
    one inside a word is part of the word. Taking every dash out turned
    "ASICS HS4-S Gel-Sonoma" into "ASICS HS4 S Gel Sonoma" and handed him
    back a name he never wrote.
  */
  const left = kept
    .filter((word) => !/^wtb$/i.test(word) && !/^[-–—/]+$/.test(word))
    .join(" ")
    .replace(/\s+[-–—]+\s*|\s*[-–—]+\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "HQ9286,44" leaves nothing but punctuation. A name with no letters in it
  // is not a name, and the stock's own one is used instead.
  return /[a-z]/i.test(left) ? left : "";
}

const euro = (value) => {
  // An empty box is not a price: Number("") is 0, which reads as a finite
  // amount and would offer the pair for nothing. Nor is a real zero.
  if (text(value) === "") return "";

  const number = Number(String(value).replace(",", "."));

  if (!Number.isFinite(number) || number <= 0) return "";

  return Number.isInteger(number)
    ? `€${number}`
    : `€${number.toFixed(2).replace(".", ",")}`;
};

/*
 * One line of an offer, ready to be pasted into the chat with the buyer:
 *
 *   JQ4891 - adidas Campus 00s Mata 43 1/3 €130 VAT0
 *
 * A pair with no price on it is not an offer and comes back empty, so the
 * block that is pasted holds only what was actually priced.
 */
export function offerLine({ sku, size, line = "", product_name = "", price, vat = "" }) {
  const amount = euro(price);

  if (!amount) return "";

  /*
    The name the table shows, which is the stock we are offering. The line
    he pasted is the fallback, for a pair we have not got and therefore have
    no name for - a message that says something other than the row it came
    from is worse than a plainer one.
  */
  const name = text(product_name) || productFromLine(line);

  return [text(sku), "-", name, text(size), amount, text(vat)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// The whole offer, in the order it was asked for.
export const offerText = (rows = []) => rows.map(offerLine).filter(Boolean).join("\n");

/* ---------------- when a pair can actually leave ---------------- */

/*
 * A seller whose stock does not ship with everything else.
 *
 * Sellers Database carries a Source on eleven of nine hundred sellers, and
 * only one of its values says anything about time. Asia and Marketplace
 * describe where a seller buys, not how fast he ships: an Asia consignor
 * ships as quickly as anyone, and a Marketplace pair that shows as stock at
 * all is one that came back to us and is already here.
 *
 * The one that is slower holds four fifths of the consignment stock, so this
 * is the line most consignment hits really get.
 */
const SLOW_SOURCES = { "EU Supplier": "2-5 business days" };

/*
 * How soon this pair could be with the buyer.
 *
 * Everything we can lay hands on goes out inside two days, whether it is on
 * our own shelf or has to come from a consignor first. Only a pair still
 * with one of the slow sellers takes longer.
 */
export function readyIn(option = {}) {
  const stillWithHim = text(option.source) === "Consignment" && text(option.location) !== "Our warehouse";

  return (stillWithHim && SLOW_SOURCES[text(option.seller_source)]) || "within 48 hours";
}

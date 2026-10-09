import test from "node:test";
import assert from "node:assert/strict";

import { matchStock, parseRequest, shelf, sizeKey, skuKey } from "../admin/wtbMatch.js";

/* ---------------- sizes ---------------- */

test("a size is one size however it was typed", () => {
  assert.equal(sizeKey(" 42 "), "42");
  assert.equal(sizeKey("42.0"), "42", "a trailing nought is not a size");
  assert.equal(sizeKey("42,5"), "42.5", "a comma is a decimal point here");
  assert.equal(sizeKey("37  1/3"), "37 1/3");
  assert.equal(sizeKey("371/3"), "37 1/3", "written without the space");

  // Nobody stocks a decimal third, but a request in a hurry says one.
  assert.equal(sizeKey("37.33"), "37 1/3");
  assert.equal(sizeKey("38.67"), "38 2/3");
  assert.equal(sizeKey("38.66"), "38 2/3");

  // Clothing keeps its own shape.
  assert.equal(sizeKey("m"), "M");
  assert.equal(sizeKey("xl"), "XL");

  // And a Crocs range is left exactly as it is: it can only ever be hit by a
  // request for that same article.
  assert.equal(sizeKey("42-43"), "42-43");
});

test("a SKU is exact, but not fussy about case or spacing", () => {
  assert.equal(skuKey("dm7866-202"), "DM7866-202");
  assert.equal(skuKey("  DM7866-202 "), "DM7866-202");
  assert.notEqual(skuKey("DM7866-202"), skuKey("DM7866-203"), "a different article is a different article");
});

/* ---------------- reading the request ---------------- */

test("the line straight out of Discord", () => {
  const { wanted, unreadable } = parseRequest(
    "DM7866-202 - Jordan 1 Retro Low OG SP Travis Scott Velvet Brown 42 + 42.5 + 43 + 44"
  );

  assert.deepEqual(unreadable, []);
  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), [
    "DM7866-202 42",
    "DM7866-202 42.5",
    "DM7866-202 43",
    "DM7866-202 44"
  ]);
});

test("the csv the partner makes himself", () => {
  const { wanted } = parseRequest("DM7866-202,42\nDM7866-202,42.5\nIH9246,38 2/3");

  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), [
    "DM7866-202 42",
    "DM7866-202 42.5",
    "IH9246 38 2/3"
  ]);
});

test("thirds survive being written as two words", () => {
  const { wanted } = parseRequest("IH9246 Samba OG 36 2/3 + 37 1/3 + 38");

  assert.deepEqual(wanted.map((row) => row.size), ["36 2/3", "37 1/3", "38"]);
});

test("the same pair asked for twice is one question", () => {
  const { wanted } = parseRequest("DM7866-202,42\ndm7866-202, 42\nDM7866-202 - shoe 42");

  assert.equal(wanted.length, 1);
});

test("a line it cannot read is handed back, not swallowed", () => {
  const { wanted, unreadable } = parseRequest(
    "looking for anything in 42 please\nDM7866-202 - shoe 43"
  );

  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), ["DM7866-202 43"]);
  assert.deepEqual(unreadable, ["looking for anything in 42 please"], "so the screen can show it");
});

test("a SKU with no size after it is not a request", () => {
  const { wanted, unreadable } = parseRequest("DM7866-202 - Travis Scott Velvet Brown");

  assert.deepEqual(wanted, []);
  assert.equal(unreadable.length, 1);
});

/* ---------------- matching ---------------- */

const unit = (extra) => ({ sku: "DM7866-202", size: "42", source: "warehouse", cost: 300, ...extra });

test("one pair can come back from several shelves at once, cheapest first", () => {
  const { wanted } = parseRequest("DM7866-202,42");

  const [row] = matchStock(wanted, [
    unit({ source: "consignment", seller: "SE-00123", cost: 320 }),
    unit({ source: "warehouse", cost: 300 }),
    unit({ source: "partner", seller: "SE-00781", cost: 290 }),
    unit({ sku: "DM7866-202", size: "43", source: "warehouse", cost: 100 })
  ]);

  assert.equal(row.options.length, 3, "the 43 is not an answer to a 42");
  assert.deepEqual(row.options.map((o) => o.cost), [290, 300, 320]);
});

test("a pair we do not have comes back empty rather than missing", () => {
  const { wanted } = parseRequest("DM7866-202,42\nDM7866-202,44");
  const rows = matchStock(wanted, [unit()]);

  assert.equal(rows.length, 2, "both questions are answered");
  assert.equal(rows[0].options.length, 1);
  assert.deepEqual(rows[1].options, [], "and the gap is visible");
});

test("the shelf is read with the same eyes as the request", () => {
  const { wanted } = parseRequest("ih9246,37.33");

  // The catalogue writes it as a fraction, the request as a decimal.
  const [row] = matchStock(wanted, [{ sku: "IH9246", size: "37 1/3", source: "consignment", cost: 150 }]);

  assert.equal(row.options.length, 1, "they are the same shoe");
});

test("a Crocs range only answers a request for that Crocs", () => {
  const shelf = [{ sku: "205759-610", size: "42-43", source: "partner", cost: 40 }];

  assert.equal(matchStock(parseRequest("205759-610,42-43").wanted, shelf)[0].options.length, 1);
  assert.equal(matchStock(parseRequest("DM7866-202,42").wanted, shelf)[0].options.length, 0);
});

/* ---------------- the three shelves ---------------- */

test("only stock that is really free is an answer", () => {
  const all = shelf({
    warehouse: [
      { id: "u1", item_id: "KC-000001", sku: "DM7866-202", size: "42", availability: "Available", cost: 300, vat_type: "Margin", location: "Our warehouse" },
      { id: "u2", item_id: "KC-000002", sku: "DM7866-202", size: "42", availability: "Reserved", cost: 290 }
    ],
    consignment: [
      { id: "c1", sku: "dm7866-202", size: "42", quantity: 2, ask: 330, seller_id: "SE-00123", vat_type: "Margin" },
      { id: "c2", sku: "DM7866-202", size: "42", quantity: 0, ask: 310, seller_id: "SE-00999" }
    ],
    partner: [
      { id: "p1", sku: "DM7866-202", size: "42", status: "in_stock", partner_price: 320, seller_id: "SE-00781", vat_type: "VAT21" },
      { id: "p2", sku: "DM7866-202", size: "42", status: "reserved", partner_price: 280, seller_id: "SE-00781" },
      { id: "p3", sku: "DM7866-202", size: "42", status: "sold", partner_price: 270, seller_id: "SE-00781" }
    ]
  });

  assert.deepEqual(all.map((o) => `${o.source} ${o.id}`), ["Warehouse u1", "Consignment c1", "Partner p1"]);
  assert.equal(all[1].sku, "DM7866-202", "a consignor's lowercase SKU is the same article");
  assert.equal(all[1].quantity, 2, "two of them");
});

test("a consignor's asking price is the cost, not his payout", () => {
  const [row] = shelf({ consignment: [{ id: "c1", sku: "XA1234", size: "42", quantity: 1, ask: 330, payout: 300, partner: false }] });

  assert.equal(row.cost, 330);
  assert.equal(row.location, "With the consignor", "it still has to come to us");
});

test("the whole way through: a pasted line against all three shelves", () => {
  const { wanted } = parseRequest("DM7866-202 - Travis Scott Velvet Brown 42 + 43");

  const rows = matchStock(wanted, shelf({
    warehouse: [{ id: "u1", sku: "DM7866-202", size: "42", availability: "Available", cost: 300 }],
    consignment: [{ id: "c1", sku: "DM7866-202", size: "42", quantity: 1, ask: 280, seller_id: "SE-00123" }],
    partner: [{ id: "p1", sku: "DM7866-202", size: "42", status: "in_stock", partner_price: 350, seller_id: "SE-00781" }]
  }));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].options.map((o) => [o.source, o.cost]), [["Consignment", 280], ["Warehouse", 300], ["Partner", 350]]);
  assert.deepEqual(rows[1].options, [], "we have no 43");
});

/* ---------------- the screen behind it ---------------- */

const { createWtbMatchStore } = await import("../admin/adminWtbMatch.js");

const stores = ({ warehouse = [], consignment = [], partner = [], broken = "" } = {}) => ({
  inventory: { working: async () => { if (broken === "Warehouse") throw new Error("Airtable timed out"); return warehouse; } },
  consignmentStock: { everything: async () => { if (broken === "Consignment") throw new Error("Supabase said no"); return consignment; } },
  partnerStock: { everything: async () => { if (broken === "Partner") throw new Error("Supabase said no"); return partner; } }
});

test("the three shelves are asked at once and answered side by side", async () => {
  const store = createWtbMatchStore(stores({
    warehouse: [{ id: "u1", sku: "DM7866-202", size: "42", availability: "Available", cost: 300 }],
    consignment: [{ id: "c1", sku: "DM7866-202", size: "42", quantity: 1, ask: 280, seller_id: "SE-00123" }],
    partner: [{ id: "p1", sku: "DM7866-202", size: "42", status: "in_stock", partner_price: 350, seller_id: "SE-00781" }]
  }));

  const out = await store.search("DM7866-202,42");

  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0].options.map((o) => o.source), ["Consignment", "Warehouse", "Partner"]);
  assert.deepEqual(out.missing, []);
});

test("a shelf that cannot be read is said out loud, not left out", async () => {
  const store = createWtbMatchStore(stores({
    broken: "Warehouse",
    consignment: [{ id: "c1", sku: "DM7866-202", size: "42", quantity: 1, ask: 280, seller_id: "SE-00123" }]
  }));

  const out = await store.search("DM7866-202,42");

  assert.deepEqual(out.missing, ["Warehouse"], "so nobody reads this as 'we have one'");
  assert.equal(out.rows[0].options.length, 1, "the shelves that did answer still count");
  assert.match(out.sources.find((s) => s.name === "Warehouse").error, /timed out/);
});

test("nothing readable in the paste means nothing is looked up at all", async () => {
  let asked = false;
  const store = createWtbMatchStore({
    inventory: { working: async () => { asked = true; return []; } },
    consignmentStock: { everything: async () => { asked = true; return []; } },
    partnerStock: { everything: async () => { asked = true; return []; } }
  });

  const out = await store.search("hi, anything nice in 42?");

  assert.deepEqual(out.rows, []);
  assert.equal(out.unreadable.length, 1);
  assert.equal(asked, false, "no point reading three shelves for a question we did not understand");
});

test("the screen and the route are really wired, not just mounted", async () => {
  const { mountWtbMatch } = await import("../admin/adminWtbMatch.js");

  const routes = { get: new Map(), post: new Map() };
  const router = {
    get: (path, ...rest) => {
      for (const one of [].concat(path)) routes.get.set(one, rest.at(-1));
    },
    post: (path, ...rest) => routes.post.set(path, rest.at(-1))
  };

  const store = createWtbMatchStore(stores({
    consignment: [{ id: "c1", sku: "DM7866-202", size: "42", quantity: 1, ask: 280, seller_id: "SE-00123" }]
  }));

  mountWtbMatch(router, { store, pageFile: "private/admin-wtb-match.html" });

  assert.ok(routes.get.has("/admin/wtb-match"), "the page is served");
  assert.ok(routes.post.has("/api/admin/wtb-match"), "and the search answers");

  // The page the router hands out is the real one, with the paste box on it.
  let html = "";
  routes.get.get("/admin/wtb-match")(
    {},
    { set: () => {}, type: () => ({ send: (body) => { html = body; } }) }
  );
  assert.match(html, /id="paste"/);
  assert.match(html, /\/api\/admin\/wtb-match/);

  let answered = null;
  await routes.post.get("/api/admin/wtb-match")(
    { body: { input: "DM7866-202,42" } },
    { json: (body) => { answered = body; } }
  );

  assert.equal(answered.rows.length, 1);
  assert.equal(answered.rows[0].options[0].source, "Consignment");
});

/* ---------------- the shape a real WTB arrives in ---------------- */

const REAL = [
  "WTB New Balance 9060 Triple Black (U9060BPM) 38 EU",
  "WTB Nike Air Max 90 Off-White Desert Ore (AA7293-200) 41 EU",
  "WTB Air Jordan 4 Retro J Balvin Amazonas (IW2872-700) 47 EU",
  "WTB New Balance 9060 Black Castlerock Grey (U9060BLK) 40.5 EU",
  "WTB Nike Mind 001 Slide Light Smoke Grey (Women's) (HQ4309-003) 38 EU",
  "WTB Air Jordan 1 Retro High OG Love Letter (DZ5485-201) 42.5 EU",
  "WTB ike Mind 001 Slide Solar Red (Women's) (HQ4309-600) 42 EU",
  "WTB Air Jordan 4 Retro J Balvin Amazonas (IW2872-700) 42.5 EU",
  "WTB Air Jordan 13 Retro Gym Red Flint Grey (DJ5982-600) 41 EU",
  "WTB Air Jordan 4 Retro TEX Denim Worn Blue (IB6716-100) 44 EU"
].join("\n");

test("the article in brackets is the article, not a number in the name", () => {
  const { wanted, unreadable } = parseRequest(REAL);

  assert.deepEqual(unreadable, [], "every line is a real request");

  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), [
    "U9060BPM 38",
    "AA7293-200 41",
    "IW2872-700 47",
    "U9060BLK 40.5",
    "HQ4309-003 38",
    "DZ5485-201 42.5",
    "HQ4309-600 42",
    "IW2872-700 42.5",
    "DJ5982-600 41",
    "IB6716-100 44"
  ]);
});

test("the name is left alone however many numbers it holds", () => {
  // "9060", "90", "001", "1" and "13" are all model names, not sizes or SKUs.
  const { wanted } = parseRequest([
    "WTB New Balance 9060 Triple Black (U9060BPM) 38 EU",
    "WTB Nike Air Max 90 Off-White Desert Ore (AA7293-200) 41 EU",
    "WTB Air Jordan 13 Retro Gym Red Flint Grey (DJ5982-600) 41 EU"
  ].join("\n"));

  assert.deepEqual(wanted.map((row) => row.sku), ["U9060BPM", "AA7293-200", "DJ5982-600"]);
  assert.deepEqual(wanted.map((row) => row.size), ["38", "41", "41"]);
});

test("a woman's shoe keeps its own bracket out of it", () => {
  const { wanted } = parseRequest("WTB Nike Mind 001 Slide Light Smoke Grey (Women's) (HQ4309-003) 38 EU");

  assert.deepEqual(wanted, [{ sku: "HQ4309-003", size: "38", line: "WTB Nike Mind 001 Slide Light Smoke Grey (Women's) (HQ4309-003) 38 EU" }]);
});

test("Discord's own mark-up is not part of the article", () => {
  const { wanted, unreadable } = parseRequest([
    "~1144032-SAN - UGG Lowmel Sand (Women's) 41~",
    "**HQ2037-002** - Nike Air Force 1 Low Un-Tiffany 43",
    "`JQ4891` - adidas Campus 00s Mata 43 1/3"
  ].join("\n"));

  assert.deepEqual(unreadable, [], "a struck-through line is still a request");
  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), [
    "1144032-SAN 41",
    "HQ2037-002 43",
    "JQ4891 43 1/3"
  ]);
});

test("a line with no article at all is still handed back", () => {
  // A name and a size, which is nothing to match on.
  const { wanted, unreadable } = parseRequest("Supreme Warriors Applique Zip Up Hooded Sweatshirt Red L\nWTB");

  assert.deepEqual(wanted, []);
  // "WTB" on its own is a heading, not a request nobody could read. Saying
  // so about it was noise, and Dario said as much on the first real paste.
  assert.deepEqual(unreadable, ["Supreme Warriors Applique Zip Up Hooded Sweatshirt Red L"]);
});

/* ---------------- the offer that goes back to the buyer ---------------- */

const { offerLine, offerText, productFromLine, VAT_TYPES } = await import("../admin/wtbMatch.js");

test("an offer line is the buyer's own words with a price on the end", () => {
  assert.equal(
    offerLine({ sku: "JQ4891", size: "43 1/3", line: "JQ4891 - adidas Campus 00s Mata 43 1/3", price: 130, vat: "VAT0" }),
    "JQ4891 - adidas Campus 00s Mata 43 1/3 €130 VAT0"
  );

  assert.equal(
    offerLine({ sku: "DD9335-641", size: "38", line: "DD9335-641 - Jordan 1 Retro High OG Atmosphere (Women's) 38", price: 110, vat: "Margin" }),
    "DD9335-641 - Jordan 1 Retro High OG Atmosphere (Women's) 38 €110 Margin"
  );

  // The WTB, the brackets round the article and the EU after the size are
  // ours to drop; the name he wrote is his.
  assert.equal(
    offerLine({ sku: "U9060BPM", size: "38", line: "WTB New Balance 9060 Triple Black (U9060BPM) 38 EU", price: 129.5, vat: "VAT0" }),
    "U9060BPM - New Balance 9060 Triple Black 38 €129,50 VAT0"
  );
});

test("a csv line has no name in it, so the stock's own name is used", () => {
  assert.equal(productFromLine("HQ9286,44", "HQ9286", "44"), "", "a comma is not a name");

  assert.equal(
    offerLine({ sku: "HQ9286", size: "44", line: "HQ9286,44", product_name: "adidas Samba ADV", price: 95, vat: "Margin" }),
    "HQ9286 - adidas Samba ADV 44 €95 Margin"
  );
});

test("a pair with no price on it is not an offer", () => {
  assert.equal(offerLine({ sku: "XA1234", size: "42", line: "XA1234 - shoe 42", vat: "VAT0" }), "");
  assert.equal(offerLine({ sku: "XA1234", size: "42", line: "XA1234 - shoe 42", price: "", vat: "VAT0" }), "");
  assert.equal(offerLine({ sku: "XA1234", size: "42", line: "XA1234 - shoe 42", price: "nonsense" }), "");
});

test("the block that is pasted holds only what was priced, in the order asked", () => {
  const text = offerText([
    { sku: "JQ4891", size: "43 1/3", line: "JQ4891 - adidas Campus 00s Mata 43 1/3", price: 130, vat: "VAT0" },
    { sku: "AA1234", size: "42", line: "AA1234 - something 42" },
    { sku: "DD9335-641", size: "38", line: "DD9335-641 - Jordan 1 38", price: 110, vat: "Margin" }
  ]);

  assert.deepEqual(text.split("\n"), [
    "JQ4891 - adidas Campus 00s Mata 43 1/3 €130 VAT0",
    "DD9335-641 - Jordan 1 38 €110 Margin"
  ]);
});

test("the VAT types are the three the stock actually uses", () => {
  assert.deepEqual(VAT_TYPES, ["VAT0", "Margin", "VAT21"]);
});

test("the offer route writes the message, so the screen never has to", async () => {
  const { mountWtbMatch } = await import("../admin/adminWtbMatch.js");

  const routes = new Map();
  const router = { get: () => {}, post: (path, ...rest) => routes.set(path, rest.at(-1)) };

  mountWtbMatch(router, { store: createWtbMatchStore(stores()), pageFile: "" });

  let answered = null;
  routes.get("/api/admin/wtb-match/offer")(
    {
      body: {
        rows: [
          { sku: "JQ4891", size: "43 1/3", line: "JQ4891 - adidas Campus 00s Mata 43 1/3", price: "130", vat: "VAT0" },
          { sku: "AA1234", size: "42", line: "AA1234 - no price here 42" }
        ]
      }
    },
    { json: (body) => { answered = body; } }
  );

  assert.equal(answered.text, "JQ4891 - adidas Campus 00s Mata 43 1/3 €130 VAT0");
});

test("a seller who cannot ship today says so on the pair", async () => {
  let asked = 0;

  const airtable = {
    select: async (table, options) => {
      asked += 1;
      assert.equal(table, "Sellers Database");
      assert.deepEqual(options.fields, ["Discord", "Source"], "the name he is known by, and whether he is slow");
      return { records: [{ id: "recSUP", fields: { Source: "EU Supplier", Discord: "wizmoneybankin" } }] };
    }
  };

  const store = createWtbMatchStore({
    ...stores({
      consignment: [
        { id: "c1", sku: "XA1234", size: "42", quantity: 1, ask: 129, seller_id: "SE-00930", seller_record_id: "recSUP" },
        { id: "c2", sku: "XA1234", size: "42", quantity: 1, ask: 140, seller_id: "SE-00035", seller_record_id: "recNORMAL" }
      ]
    }),
    airtable
  });

  const out = await store.search("XA1234,42");
  const [supplier, ordinary] = out.rows[0].options;

  assert.equal(supplier.seller_source, "EU Supplier");
  assert.equal(ordinary.seller_source, "", "an ordinary consignor has nothing to say here");

  // Eleven of nine hundred sellers carry one, so it is read once and held.
  await store.search("XA1234,42");
  assert.equal(asked, 1);
});

test("a seller lookup that fails does not hold up the answer", async () => {
  const store = createWtbMatchStore({
    ...stores({ consignment: [{ id: "c1", sku: "XA1234", size: "42", quantity: 1, ask: 129, seller_id: "SE-00930", seller_record_id: "recSUP" }] }),
    airtable: { select: async () => { throw new Error("Airtable timed out"); } }
  });

  const out = await store.search("XA1234,42");

  assert.equal(out.rows[0].options.length, 1, "the stock is still the stock");
  assert.equal(out.rows[0].options[0].seller_source, "");
});

/* ---------------- when a pair can leave ---------------- */

const { readyIn } = await import("../admin/wtbMatch.js");

test("what decides the wait is where the pair is, not who owns it", () => {
  // On our own shelf, whoever it belongs to.
  assert.equal(readyIn({ source: "Warehouse" }), "within 48 hours");
  assert.equal(readyIn({ source: "Partner", seller_source: "Asia" }), "within 48 hours");

  // A Marketplace pair only shows as stock if it came back to us.
  assert.equal(readyIn({ source: "Consignment", location: "Our warehouse", seller_source: "Marketplace" }), "within 48 hours");

  // With the consignor, so it has to travel.
  assert.equal(readyIn({ source: "Consignment", location: "With the consignor" }), "within 48 hours");

  // Asia says where he buys, not how fast he ships.
  assert.equal(readyIn({ source: "Consignment", location: "With the consignor", seller_source: "Asia" }), "within 48 hours");

  // The one that really is slower, and the one that holds most of the stock.
  assert.equal(readyIn({ source: "Consignment", location: "With the consignor", seller_source: "EU Supplier" }), "2-5 business days");
});

test("the wait reaches the screen on the option itself", async () => {
  const store = createWtbMatchStore({
    ...stores({
      warehouse: [{ id: "u1", sku: "XA1234", size: "42", availability: "Available", cost: 300 }],
      consignment: [
        { id: "c1", sku: "XA1234", size: "42", quantity: 1, ask: 129, seller_id: "SE-00930", seller_record_id: "recSLOW" },
        { id: "c2", sku: "XA1234", size: "42", quantity: 1, ask: 140, seller_id: "SE-00035", seller_record_id: "recNORMAL" }
      ]
    }),
    airtable: { select: async () => ({ records: [{ id: "recSLOW", fields: { Source: "EU Supplier", Discord: "wizmoneybankin" } }] }) }
  });

  const out = await store.search("XA1234,42");

  assert.deepEqual(
    out.rows[0].options.map((option) => [option.source, option.ready_in]),
    [["Consignment", "2-5 business days"], ["Consignment", "within 48 hours"], ["Warehouse", "within 48 hours"]],
    "cheapest first, and the cheapest is the one that takes longest"
  );
});

test("the seller is named the way he is known in Discord", async () => {
  const store = createWtbMatchStore({
    ...stores({
      consignment: [
        { id: "c1", sku: "XA1234", size: "42", quantity: 1, ask: 129, seller_id: "SE-00930", seller_record_id: "recA" },
        { id: "c2", sku: "XA1234", size: "42", quantity: 1, ask: 140, seller_id: "SE-00035", seller_record_id: "recNONE" }
      ]
    }),
    airtable: { select: async () => ({ records: [{ id: "recA", fields: { Discord: "wizmoneybankin" } }] }) }
  });

  const [cheap, other] = (await store.search("XA1234,42")).rows[0].options;

  assert.equal(cheap.seller_name, "wizmoneybankin");
  assert.equal(other.seller_name, "SE-00035", "a seller with no Discord still has to show");
});

/* ---------------- the shapes a WTB really arrives in ---------------- */

const asked = (input) => parseRequest(input).wanted.map((row) => `${row.sku} ${row.size}`);

test("the article can sit at the end of the name, with no brackets", () => {
  assert.deepEqual(asked("Adidas Adilette 22 Slides Grey Five GX6949 46"), ["GX6949 46"]);
  assert.deepEqual(asked("Adidas Handball Spezial White Black Gum IE3403 37 1/3"), ["IE3403 37 1/3"]);
  assert.deepEqual(asked("Adidas Samba OG Cow Print (Women's) JR1256 38 2/3"), ["JR1256 38 2/3"]);
});

test("a comma between sizes is not a csv", () => {
  // This read as "sku,size" and made the whole name into one article.
  assert.deepEqual(asked("Adidas XLG Runner Deluxe Wonder Beige JR9632 36, 42"), ["JR9632 36", "JR9632 42"]);
  assert.deepEqual(asked("Adidas Vento XLG Deluxe White Red JS1590 36 2/3, 37 1/3"), ["JS1590 36 2/3", "JS1590 37 1/3"]);

  // A real csv still is one.
  assert.deepEqual(asked("HQ9286,44"), ["HQ9286 44"]);
});

test("a year in brackets is a year", () => {
  assert.deepEqual(asked("Air Jordan 4 Fear (2024) FQ8138-002 / FQ8213-002 43"), ["FQ8138-002 43", "FQ8213-002 43"]);
  assert.deepEqual(asked("Air Jordan 4 Black Cat (2025) FV5029-010/IB4171-010 41, 44"), [
    "FV5029-010 41", "IB4171-010 41", "FV5029-010 44", "IB4171-010 44"
  ]);
});

test("one pair can be sold under two numbers, and both are looked for", () => {
  assert.deepEqual(asked("Air Jordan 4 SE Wet Cement Paris Olympics FQ7928-001 / HM8965-001 44"), [
    "FQ7928-001 44", "HM8965-001 44"
  ]);
  assert.deepEqual(asked("Air Jordan 11 Gamma Blue 378038-047 / CT8012-047 42.5"), [
    "378038-047 42.5", "CT8012-047 42.5"
  ]);
});

test("a request written over several lines is one request", () => {
  const { wanted, unreadable } = parseRequest([
    "wtb ",
    "Air Jordan 4 Retro OG SP A Ma Maniére While You Were Sleeping (W) ",
    "FZ4810-200",
    "47"
  ].join("\n"));

  assert.deepEqual(wanted.map((row) => `${row.sku} ${row.size}`), ["FZ4810-200 47"]);
  assert.deepEqual(unreadable, [], "the name and the wtb are not failures");
  assert.match(wanted[0].line, /While You Were Sleeping/, "the name is kept for the offer");
});

test("every size on a long line is taken, and the same one only once", () => {
  const line = "Adidas XLG Runner Deluxe 2.0 Off White Aurora Coffee KZ7202 36 2/3, 36 2/3, 36 2/3, 37 1/3, 38, 38 2/3, 38 2/3, 39 1/3, 39 1/3, 39 1/3, 39 1/3, 39 1/3, 39 1/3, 40, 40 2/3";

  assert.deepEqual(asked(line), [
    "KZ7202 36 2/3", "KZ7202 37 1/3", "KZ7202 38", "KZ7202 38 2/3", "KZ7202 39 1/3", "KZ7202 40", "KZ7202 40 2/3"
  ]);
});

test("a line with a size but no article is still a failure worth seeing", () => {
  const { wanted, unreadable } = parseRequest([
    "Supreme Warriors Applique Zip Up Hooded Sweatshirt Red L",
    "Adidas XLG Runner Deluxe Wonder Gray - 43 1/3"
  ].join("\n"));

  assert.deepEqual(wanted, []);
  assert.equal(unreadable.length, 2, "he wrote no article, and should be told");
});

/* ---------------- one line per place, not per pair ---------------- */

test("five of our own on the shelf is one place to get it, not five offers", () => {
  const { wanted } = parseRequest("JR9632,36");

  const [row] = matchStock(wanted, shelf({
    warehouse: Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`, sku: "JR9632", size: "36", availability: "Available", cost: 150, product_name: "adidas XLG Runner Deluxe Wonder Beige"
    })),
    consignment: [{ id: "c1", sku: "JR9632", size: "36", quantity: 1, ask: 175, seller_id: "SE-00035", seller_record_id: "recD" }]
  }));

  assert.equal(row.sources, 2, "ours counts once, and the consignor once");
  assert.deepEqual(row.options.map((o) => [o.source, o.quantity]), [["Warehouse", 5], ["Consignment", 1]]);
});

test("two consignors stay two places, and each keeps his own count", () => {
  const { wanted } = parseRequest("1203A537-110,45");

  const [row] = matchStock(wanted, shelf({
    consignment: [
      { id: "c1", sku: "1203A537-110", size: "45", quantity: 3, ask: 145, seller_id: "SE-00569", seller_record_id: "recA" },
      { id: "c2", sku: "1203A537-110", size: "45", quantity: 8, ask: 150, seller_id: "SE-00879", seller_record_id: "recB" }
    ]
  }));

  assert.equal(row.sources, 2);
  assert.deepEqual(row.options.map((o) => o.quantity), [3, 8]);
});

test("the cheapest in a group is what the line costs", () => {
  const { wanted } = parseRequest("JR9632,36");

  const [row] = matchStock(wanted, shelf({
    warehouse: [
      { id: "u1", sku: "JR9632", size: "36", availability: "Available", cost: 180 },
      { id: "u2", sku: "JR9632", size: "36", availability: "Available", cost: 150 },
      { id: "u3", sku: "JR9632", size: "36", availability: "Available", cost: 165 }
    ]
  }));

  assert.equal(row.options.length, 1);
  assert.equal(row.options[0].cost, 150, "the one you would actually take");
  assert.equal(row.options[0].quantity, 3);
  assert.equal(row.options[0].units, 3, "so the screen can say it is the cheapest of three");
});

test("the export is a real workbook, not a semicolon file", async () => {
  const store = createWtbMatchStore(stores());

  const book = store.workbook([
    {
      sku: "JR9632",
      size: "36",
      offer_price: "190",
      offer_vat: "Margin",
      options: [{ source: "Warehouse", product_name: "adidas XLG Runner Deluxe Wonder Beige", quantity: 5, cost: 150, vat_type: "Margin", ready_in: "within 48 hours" }]
    },
    // A pair we have not got still gets a line: a file is read away from the
    // screen, where the sentence above the table is not.
    { sku: "FZ4810-200", size: "47", options: [] }
  ]);

  assert.ok(Buffer.isBuffer(book));
  assert.equal(book.subarray(0, 2).toString("latin1"), "PK", "a zip, which is what an xlsx is");
  assert.ok(book.length > 1000);

  // A zip of xml parts, with a worksheet in it - not text with separators.
  assert.match(book.toString("latin1"), /xl\/worksheets\/sheet1\.xml/);
});

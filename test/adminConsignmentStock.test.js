import test from "node:test";
import assert from "node:assert/strict";

import {
  VAT_FILTERS,
  comparePrice,
  createConsignmentStockStore,
  groupRows,
  stockRow
} from "../admin/adminConsignmentStock.js";

const offer = (extra = {}) => ({
  id: "1f0c0000-0000-4000-8000-000000000001",
  seller_id: "SE-00412",
  seller_record_id: "recCONSIGNOR12345",
  sku: "fv5029-141",
  size: "44",
  product_name: "Jordan 4 Retro Military Blue (2024)",
  brand: "Jordan",
  vat_type: "Margin",
  selling_price_suggested: 170,
  payout_price: null,
  quantity: 1,
  image_url: "https://images.stockx.com/jordan-4.jpg",
  created_at: "2026-09-20T10:00:00.000Z",
  ...extra
});

function fakeDb(rows) {
  const asked = [];

  return {
    asked,
    db: {
      async get(pathAndQuery) {
        asked.push(pathAndQuery);
        // Only the first page has anything; the store stops on a short page.
        return /offset=0/.test(pathAndQuery) ? rows : [];
      }
    }
  };
}

const noNames = { async byIds() { return new Map(); } };
const store = (rows, airtable = noNames) => createConsignmentStockStore({ db: fakeDb(rows).db, airtable });

/* ---------------- what a pair costs ---------------- */

/*
 * A VAT0 consignor asking 100 costs 121 to buy. Comparing his 100 against a
 * margin consignor's 100 would make him look the cheaper of the two, and we
 * would ask the wrong man.
 */
test("a VAT0 ask is grossed up before anything is compared", () => {
  assert.equal(comparePrice(100, "VAT0"), 121);
  assert.equal(comparePrice(100, "Margin"), 100);
  assert.equal(comparePrice(100, "VAT21"), 100);
  assert.equal(comparePrice(170, "vat0"), 205.7);
});

test("an ask of nothing compares as nothing, never as zero euros cheaper", () => {
  assert.equal(comparePrice(0, "Margin"), 0);
  assert.equal(comparePrice(null, "VAT0"), 0);
  assert.equal(comparePrice("", "Margin"), 0);
});

test("the three filters are the ones a member WTB already knows", () => {
  assert.deepEqual(VAT_FILTERS.all, ["Margin", "VAT0", "VAT21"]);
  assert.deepEqual(VAT_FILTERS.margin, ["Margin"]);
  assert.deepEqual(VAT_FILTERS.b2b, ["VAT0", "VAT21"]);
});

test("a row carries both what he asks and what it costs us", () => {
  const row = stockRow(offer({ vat_type: "VAT0", selling_price_suggested: 200 }));

  assert.equal(row.ask, 200);
  assert.equal(row.compare, 242);
  assert.equal(row.sku, "FV5029-141", "SKUs are compared in upper case");
});

test("a partner's pair is marked, because it is already on our shelf", () => {
  assert.equal(stockRow(offer()).partner, false);
  assert.equal(stockRow(offer()).payout, null);

  const partner = stockRow(offer({ payout_price: 150 }));
  assert.equal(partner.partner, true);
  assert.equal(partner.payout, 150);
});

/* ---------------- one line per pair ---------------- */

/*
 * A consignor is not a thing you look for, a pair is. So the list is a list
 * of pairs and the cheapest holder is hoisted onto the line - the one you
 * would ask first.
 */
test("holders of the same shoe and size become one line, cheapest hoisted", () => {
  const pairs = groupRows([
    stockRow(offer({ seller_id: "SE-DEAREST", selling_price_suggested: 190 })),
    stockRow(offer({ seller_id: "SE-CHEAPEST", selling_price_suggested: 170 })),
    stockRow(offer({ seller_id: "SE-OTHER-SIZE", size: "45" }))
  ]);

  assert.equal(pairs.length, 2);

  const line = pairs.find((p) => p.size === "44");

  assert.equal(line.seller_id, "SE-CHEAPEST");
  assert.equal(line.compare, 170);
  assert.equal(line.consignors, 2);
  assert.equal(line.alternatives, 1);
  assert.deepEqual(line.holders.map((h) => h.seller_id), ["SE-CHEAPEST", "SE-DEAREST"]);
});

/*
 * The VAT0 man asks the least and costs the most, so he is not the one to
 * put on the line.
 */
test("the cheapest is the one who costs us least, not the one who asks least", () => {
  const [line] = groupRows([
    stockRow(offer({ seller_id: "SE-LOOKS-CHEAP", selling_price_suggested: 160, vat_type: "VAT0" })),
    stockRow(offer({ seller_id: "SE-REALLY-CHEAP", selling_price_suggested: 170, vat_type: "Margin" }))
  ]);

  assert.equal(line.seller_id, "SE-REALLY-CHEAP");
  assert.equal(line.compare, 170);
  assert.deepEqual(line.holders.map((h) => h.compare), [170, 193.6]);
});

test("a line sums the stock and keeps the newest arrival as its date", () => {
  const [line] = groupRows([
    stockRow(offer({ quantity: 2, created_at: "2026-01-01T10:00:00.000Z" })),
    stockRow(offer({ seller_id: "SE-B", quantity: 3, created_at: "2026-09-30T10:00:00.000Z" }))
  ]);

  assert.equal(line.quantity, 5);
  assert.equal(line.added_at, "2026-09-30T10:00:00.000Z");
});

// A row without a picture or a name must not decide how the pair looks.
test("a line takes a picture and a name from whichever holder has one", () => {
  const [line] = groupRows([
    stockRow(offer({ image_url: "", product_name: "", brand: "" })),
    stockRow(offer({ seller_id: "SE-B", image_url: "https://images.stockx.com/jordan-4.jpg" }))
  ]);

  assert.equal(line.image_url, "https://images.stockx.com/jordan-4.jpg");
  assert.equal(line.product_name, "Jordan 4 Retro Military Blue (2024)");
  assert.equal(line.brand, "Jordan");
});

test("a partner pair anywhere in the line marks the line", () => {
  const [line] = groupRows([
    stockRow(offer()),
    stockRow(offer({ seller_id: "SE-B", payout_price: 150 }))
  ]);

  assert.equal(line.partner, true);
});

/* ---------------- the store ---------------- */

test("only pairs that are held and priced are asked for", async () => {
  const base = fakeDb([]);
  await createConsignmentStockStore({ db: base.db, airtable: noNames }).list({});

  assert.match(base.asked[0], /quantity=gt\.0/);
  assert.match(base.asked[0], /selling_price_suggested=gt\.0/);
});

/*
 * Grouped AFTER the filter, so "1 more" on a Margin Only list means one more
 * margin consignor and not one we are not allowed to use.
 */
test("the tabs count pairs, and grouping happens after the filter", async () => {
  const shop = store([
    offer({ id: "1", vat_type: "Margin", selling_price_suggested: 190 }),
    offer({ id: "2", vat_type: "VAT0", selling_price_suggested: 120, seller_id: "SE-B" }),
    offer({ id: "3", vat_type: "Margin", size: "45" })
  ]);

  const all = await shop.list({ view: "all" });

  assert.deepEqual(all.counts, { all: 2, margin: 2, b2b: 1 });
  assert.equal(all.units.length, 2);

  const margin = await shop.list({ view: "margin" });
  const line = margin.units.find((p) => p.size === "44");

  assert.equal(line.consignors, 1, "the VAT0 holder is not on a margin list");
  assert.equal(line.alternatives, 0);
  assert.equal(line.compare, 190);
});

test("every word has to land, so a shoe and a size narrow together", async () => {
  const shop = store([
    offer({ id: "1", size: "44" }),
    offer({ id: "2", size: "45" }),
    offer({ id: "3", sku: "U9060NRI", product_name: "New Balance 9060 Triple Black", size: "44" })
  ]);

  assert.deepEqual((await shop.list({ q: "military blue 44" })).units.map((p) => p.key), ["FV5029-141|44"]);
  assert.deepEqual((await shop.list({ q: "FV5029-141" })).units.map((p) => p.size).sort(), ["44", "45"]);
  assert.deepEqual((await shop.list({ q: "military blue 46" })).units, []);
});

/*
 * "HQ4409" contains a 44, so searching a size used to turn up cheap pairs in
 * other sizes above the ones actually asked for.
 */
test("a pair whose size matches leads, whatever it costs", async () => {
  const shop = store([
    offer({ id: "1", sku: "HQ4409", size: "38", selling_price_suggested: 39 }),
    offer({ id: "2", size: "44", selling_price_suggested: 210 })
  ]);

  const pairs = (await shop.list({ q: "44" })).units;

  assert.deepEqual(pairs.map((p) => p.key), ["FV5029-141|44", "HQ4409|38"]);
});

test("without a search the newest arrivals lead, because there is no shoe yet", async () => {
  const shop = store([
    offer({ id: "1", size: "41", created_at: "2026-01-01T10:00:00.000Z" }),
    offer({ id: "2", size: "42", created_at: "2026-09-30T10:00:00.000Z" })
  ]);

  assert.deepEqual((await shop.list({})).units.map((p) => p.size), ["42", "41"]);
});

test("the totals say what there is to pick from", async () => {
  const shop = store([
    offer({ id: "1", seller_id: "SE-A", selling_price_suggested: 180 }),
    offer({ id: "2", seller_id: "SE-B", selling_price_suggested: 170 }),
    offer({ id: "3", seller_id: "SE-A", size: "45", selling_price_suggested: 200 })
  ]);

  const out = await shop.list({ q: "FV5029-141" });

  assert.equal(out.totals.units, 2, "two lines, because two sizes");
  assert.equal(out.totals.offers, 3, "three consignors behind them");
  assert.equal(out.totals.consignors, 2);
  assert.equal(out.totals.cheapest, 170);
});

/*
 * A size search also turns up a SKU with those digits in it. Quoting that
 * pair's price as the cheapest would be a number for a different shoe.
 */
test("the cheapest shown is the cheapest of the pairs actually asked for", async () => {
  const shop = store([
    offer({ id: "1", sku: "HQ4409", size: "38", selling_price_suggested: 39 }),
    offer({ id: "2", size: "44", selling_price_suggested: 210 })
  ]);

  assert.equal((await shop.list({ q: "44" })).totals.cheapest, 210);
});

/*
 * The panel lists every holder, so an id among the names there would read as
 * a different kind of thing.
 */
test("every holder on screen gets a name, not only the one on the line", async () => {
  const airtable = {
    async byIds(table) {
      assert.equal(table, "Sellers Database");
      return new Map([
        ["recCONSIGNOR12345", { "Company Name": "Kicksbymattie", "Seller ID": "SE-00412" }],
        ["recCONSIGNOR67890", { "Full Name": "asier camino", "Seller ID": "SE-00198" }]
      ]);
    }
  };

  const shop = store([
    offer({ id: "1", selling_price_suggested: 190 }),
    offer({ id: "2", seller_id: "SE-00198", seller_record_id: "recCONSIGNOR67890", selling_price_suggested: 170 })
  ], airtable);

  const [line] = (await shop.list({})).units;

  assert.equal(line.party, "asier camino", "the cheapest holder is the one on the line");
  assert.deepEqual(line.holders.map((h) => h.party), ["asier camino", "Kicksbymattie"]);
});

test("a consignor without a record keeps his seller id as his name", async () => {
  const shop = store([offer({ seller_record_id: "" })]);
  const [line] = (await shop.list({})).units;

  assert.equal(line.holders[0].party, "SE-00412");
});

test("a name lookup that fails does not take the screen down with it", async () => {
  const airtable = { async byIds() { throw new Error("Airtable is having a moment"); } };
  const [line] = (await store([offer()], airtable).list({})).units;

  assert.equal(line.party, "SE-00412");
});

test("the stock is read once and held, because every view is cut from it", async () => {
  const base = fakeDb([offer()]);
  const shop = createConsignmentStockStore({ db: base.db, airtable: noNames });

  await shop.list({ view: "all" });
  await shop.list({ view: "margin" });
  await shop.count();

  assert.equal(base.asked.length, 1);
});

test("the sidebar count is pairs, the same thing the list shows", async () => {
  const shop = store([
    offer({ id: "1", seller_id: "SE-A" }),
    offer({ id: "2", seller_id: "SE-B" }),
    offer({ id: "3", size: "45" })
  ]);

  assert.deepEqual(await shop.count(), { all: 2 });
});

/* ---------------- bringing out an offer ---------------- */

/*
 * The deal an offer from this screen lands in. `created` collects what was
 * made, so a test can say "nothing was created" as plainly as before.
 */
function offerShop(rows, { kickz = null, created = [] } = {}) {
  const base = fakeDb(rows);
  const asked = [];
  const airtable = noNames;

  const deals = {
    async create(input) {
      created.push({ what: "deal", ...input });
      return { id: "deal-00000001", deal_id: "EXTD-000001" };
    },
    async addLine(input) {
      created.push({ what: "line", ...input });
      return { id: "line-00000001", ...input };
    },
    async answer(input) {
      created.push({ what: "answer", ...input });
      // No seller named on purpose: the portal picks at the moment it runs,
      // so what comes back here is what the screen predicted - which is
      // exactly what these tests are about.
      return kickz ? kickz(input) : { ok: true, did: "offered" };
    }
  };

  return {
    created,
    asked,
    shop: createConsignmentStockStore({
      db: {
        get: async (q) => {
          asked.push(q);
          // The single-pair read the offer does: by shoe and size, the way
          // the portal will go looking for it too.
          if (/sku=eq\./.test(q)) {
            const sku = decodeURIComponent(q.match(/sku=eq\.([^&]+)/)[1]);
            const size = decodeURIComponent(q.match(/size=eq\.([^&]+)/)[1]);
            return rows.filter((r) => String(r.sku).toUpperCase() === sku && String(r.size) === size);
          }
          return base.db.get(q);
        }
      },
      airtable,
      deals
    })
  };
}

test("an offer makes a deal with this pair on it and sends the round out", async () => {
  const { shop, created } = offerShop([offer({ selling_price_suggested: 180 })]);

  const out = await shop.bringOutOffer({
    sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170, filter: "margin", buyerId: "buyer-1"
  });

  const [deal, line, answer] = created;

  assert.equal(deal.what, "deal");
  assert.equal(deal.buyerId, "buyer-1");

  assert.equal(line.what, "line");
  assert.equal(line.saleId, "deal-00000001");
  assert.equal(line.sku, "FV5029-141");
  assert.equal(line.size, "44");
  assert.equal(line.payout, 170, "the budget is what we are willing to pay");
  assert.equal(line.buyerPrice, 200, "and that is what the buyer pays - never worked out from the other");
  assert.equal(line.vatFilter, "margin");

  assert.deepEqual(answer, { what: "answer", lineId: "line-00000001", action: "offer" });

  assert.equal(out.deal_id, "deal-00000001");
  assert.equal(out.asked, true);
  assert.equal(out.margin, 30);
});

test("a pair added to a deal that is already running does not start a second one", async () => {
  const { shop, created } = offerShop([offer({ selling_price_suggested: 180 })]);

  await shop.bringOutOffer({
    sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170, dealId: "deal-already"
  });

  assert.ok(!created.some((row) => row.what === "deal"), "no new deal");
  assert.equal(created[0].saleId, "deal-already");
});

/*
 * Picking Margin Only and then offering a VAT21 consignor would send out the
 * promise the filter was there to prevent.
 */
test("a consignor the filter leaves out is refused, not quietly offered", async () => {
  const { shop, created } = offerShop([offer({ vat_type: "VAT21" })]);

  await assert.rejects(
    shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170, filter: "margin" }),
    /Nobody holding FV5029-141 44 is inside Margin Only/
  );

  assert.equal(created.length, 0, "nothing is created when it may not be offered");
});

test("a pair that has gone since the screen loaded is refused", async () => {
  const { shop } = offerShop([]);

  await assert.rejects(
    shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170 }),
    /no longer in the consignment stock/
  );
});

test("both numbers are needed, and both have to be real", async () => {
  const { shop } = offerShop([offer()]);
  const pair = { sku: "FV5029-141", size: "44" };

  await assert.rejects(shop.bringOutOffer({ ...pair, payout: 170 }), /What does the buyer pay/);
  await assert.rejects(shop.bringOutOffer({ ...pair, buyerPrice: 200 }), /What do we offer the consignor/);
  await assert.rejects(shop.bringOutOffer({ ...pair, buyerPrice: 0, payout: 170 }), /What does the buyer pay/);
  await assert.rejects(shop.bringOutOffer({ sku: "", size: "44", buyerPrice: 200, payout: 170 }), /Which pair/);
});

/*
 * The want-to-buy carries the numbers. Throwing it away because the round
 * could not be started would lose them and tell nobody.
 */
test("a round that cannot be started leaves the line standing, and says so", async () => {
  const { shop, created } = offerShop([offer()], {
    kickz: async () => { throw new Error("Kickz Caviar answered 502."); }
  });

  const out = await shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170 });

  assert.equal(out.asked, false);
  assert.match(out.error, /502/);
  // The deal and its line are still there, with both prices on them, so it
  // can be offered again instead of typed in a second time.
  assert.deepEqual(created.map((row) => row.what), ["deal", "line", "answer"]);
  assert.equal(out.deal_line_id, "line-00000001");
});

test("a service that cannot reach Kickz Caviar refuses rather than half-doing it", async () => {
  const shop = createConsignmentStockStore({ db: fakeDb([offer()]).db, airtable: noNames });

  await assert.rejects(
    shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 200, payout: 170 }),
    /not reachable/
  );
});

/*
 * The portal reads the stock itself, keeps whoever the filter allows and
 * takes the lowest normalised price - so the screen may not name anyone
 * else. The first version of this did, and could have promised a man the
 * round would never reach.
 */
test("the offer names the cheapest inside the filter, not whoever was clicked", async () => {
  const { shop, created } = offerShop([
    offer({ id: "1", seller_id: "SE-DEAREST", selling_price_suggested: 220 }),
    offer({ id: "2", seller_id: "SE-CHEAPEST", selling_price_suggested: 165 }),
    offer({ id: "3", seller_id: "SE-OTHER-SIZE", size: "45", selling_price_suggested: 100 })
  ]);

  const out = await shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 160 });

  assert.equal(out.seller_id, "SE-CHEAPEST");
  assert.equal(out.asks, 165);
  assert.equal(out.offered, 160, "never more than the budget");
  assert.equal(out.consignors, 2, "the other size is a different pair");
  assert.equal(created.find((row) => row.what === "line").sku, "FV5029-141");
});

/*
 * Cheapest on what it COSTS us, which is the comparison the portal makes
 * too: a VAT0 man asking 170 costs 205.70.
 */
test("cheapest means what it costs us, not what he asks", async () => {
  const { shop } = offerShop([
    offer({ id: "1", seller_id: "SE-LOOKS-CHEAP", selling_price_suggested: 170, vat_type: "VAT0" }),
    offer({ id: "2", seller_id: "SE-REALLY-CHEAP", selling_price_suggested: 180, vat_type: "Margin" })
  ]);

  const out = await shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 170 });

  assert.equal(out.seller_id, "SE-REALLY-CHEAP");
});

test("a filter that leaves everyone out refuses before anything is made", async () => {
  const { shop, created } = offerShop([
    offer({ id: "1", vat_type: "VAT21" }),
    offer({ id: "2", vat_type: "VAT0", seller_id: "SE-B" })
  ]);

  await assert.rejects(
    shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 200, filter: "margin" }),
    /Nobody holding FV5029-141 44 is inside Margin Only/
  );

  assert.equal(created.length, 0);
});

test("the filter decides who counts, so a B2B round ignores the cheaper margin man", async () => {
  const { shop, created } = offerShop([
    offer({ id: "1", seller_id: "SE-MARGIN", selling_price_suggested: 150, vat_type: "Margin" }),
    offer({ id: "2", seller_id: "SE-B2B", selling_price_suggested: 190, vat_type: "VAT21" })
  ]);

  const out = await shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 180, filter: "b2b" });

  assert.equal(out.seller_id, "SE-B2B");
  assert.equal(out.consignors, 1);
  assert.equal(created.find((row) => row.what === "line").vatFilter, "b2b", "and the line carries it, so the round asks the same people");
});

/*
 * The list is grouped after the tab's filter, so a line on Margin Only knows
 * nothing about the B2B men holding the same shoe. The offer form lets you
 * switch filter without leaving the page, and has to be able to say what
 * that would reach.
 */
test("a pair carries how many consignors each filter would reach", async () => {
  const shop = store([
    offer({ id: "1", vat_type: "Margin" }),
    offer({ id: "2", vat_type: "Margin", seller_id: "SE-B" }),
    offer({ id: "3", vat_type: "VAT0", seller_id: "SE-C" }),
    offer({ id: "4", vat_type: "VAT21", seller_id: "SE-D" }),
    offer({ id: "5", vat_type: "Margin", size: "45" })
  ]);

  const onMargin = (await shop.list({ view: "margin" })).units.find((p) => p.size === "44");

  assert.equal(onMargin.consignors, 2, "the line itself is what this tab shows");
  assert.deepEqual(onMargin.by_filter, { all: 4, margin: 2, b2b: 2 }, "and this is what the others would reach");

  const other = (await shop.list({ view: "margin" })).units.find((p) => p.size === "45");
  assert.deepEqual(other.by_filter, { all: 1, margin: 1, b2b: 0 });
});

/*
 * The round goes to the cheapest man inside the filter and he is offered the
 * lower of the budget and his own price, so anything above his ask buys
 * nothing. A payout of 200 against an ask of 170 is a typo, not a plan.
 */
test("a payout above what he asks is refused, not quietly capped", async () => {
  const { shop, created } = offerShop([offer({ selling_price_suggested: 170 })]);

  await assert.rejects(
    shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 200 }),
    /asking 170; offering 200 would only ever pay him his own price/
  );

  assert.equal(created.length, 0);

  // His own price exactly is fine: that is simply taking the listing.
  const out = await shop.bringOutOffer({ sku: "FV5029-141", size: "44", buyerPrice: 250, payout: 170 });
  assert.equal(out.offered, 170);
});

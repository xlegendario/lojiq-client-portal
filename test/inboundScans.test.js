import test from "node:test";
import assert from "node:assert/strict";

import {
  createInboundScansStore,
  listRow,
  mergeParcels,
  parcelsFromIncoming,
  parcelsFromPartnerStock
} from "../admin/adminInboundScans.js";

const TRACKING = "1Z14V4W16894846469";

// One row per pair, the way the intake writes them.
const pair = (over = {}) => ({
  tracking_number: TRACKING,
  seller_id: "SE-00781",
  seller_record_id: "recSELLER0000001",
  sku: "208394-2B8",
  size: "M12/W14",
  product_name: "Crocs Classic Clog Lightning McQueen",
  barcode: "191448430952",
  mode: "both",
  partner_price: 30,
  markup: 5,
  status: "in_stock",
  sold_ref: null,
  received_at: "2026-09-24T09:00:00Z",
  ...over
});

const incomingRow = (fields) => ({ id: `rec${Math.random().toString(36).slice(2, 16)}`, fields });

test("a partner parcel folds its pairs back into the lines they were scanned as", () => {
  const parcels = parcelsFromPartnerStock([
    pair(),
    pair(),
    pair({ status: "sold", sold_ref: "EXTD-000081" }),
    pair({ size: "M11/W13", barcode: "191448430945" })
  ]);

  const parcel = parcels.get(TRACKING);

  assert.equal(parcel.pairs, 4);
  assert.equal(parcel.type, "Consignment & Forwarding");
  assert.equal(parcel.seller_id, "SE-00781");
  assert.equal(parcel.value, 120);
  assert.equal(parcel.in_stock, 3);
  assert.equal(parcel.sold, 1);

  const [twelve, eleven] = [...parcel.lines.values()];
  assert.equal(twelve.quantity, 3, "three pairs in one size is one line");
  assert.deepEqual(twelve.refs, ["EXTD-000081"], "and it says where the sold one went");
  assert.equal(eleven.quantity, 1);
});

test("a warehouse parcel counts quantities, and its placeholder is the parcel", () => {
  const parcels = parcelsFromIncoming([
    incomingRow({ "Tracking Number": TRACKING, "Status": "Received", "Received At": "2026-09-23T08:00:00Z", "Supplier": ["recSELLER0000001"] }),
    incomingRow({ "Tracking Number": TRACKING, "SKU": "DD1391-100", "Size": "42", "Quantity": 2, "Type": "Consignment", "Status": "Verified" }),
    incomingRow({ "Tracking Number": TRACKING, "SKU": "DD1391-100", "Size": "43", "Quantity": 1, "Type": "Consignment", "Status": "Verified" })
  ]);

  const parcel = parcels.get(TRACKING);

  assert.equal(parcel.pairs, 3, "a row here is a quantity, not a pair");
  assert.equal(parcel.lines.size, 2, "the placeholder without a SKU is not a line");
  assert.equal(parcel.status, "Received");
  assert.equal(parcel.type, "Consignment");
  assert.equal(parcel.received_at, "2026-09-23T08:00:00Z");
});

test("a parcel that is in both places is told by its pairs", () => {
  const merged = mergeParcels(
    parcelsFromPartnerStock([pair(), pair()]),
    parcelsFromIncoming([incomingRow({ "Tracking Number": TRACKING, "Status": "Verified", "Received At": "2026-09-24T08:00:00Z", "Client": ["recMERCHANT00001"] })])
  );

  const parcel = merged.get(TRACKING);

  assert.equal(parcel.source, "partner");
  assert.equal(parcel.pairs, 2);
  assert.equal(parcel.status, "Verified", "what the placeholder knew is kept");
  assert.equal(listRow(parcel).skus, 1);
});

/* ---------------- the store ---------------- */

function fakes({ rows = [pair(), pair()], records = [] } = {}) {
  const asked = [];

  const airtable = {
    select: async (table, options) => {
      asked.push([table, options.formula || ""]);
      return { records, offset: "" };
    },
    byIds: async (table, ids) => new Map(ids.map((id) => [id, table === "Sellers Database"
      ? { "Seller ID": "SE-00781", "Company Name": "Zhuoyi", "Full Name": "Zhuo Yi" }
      : { "Company Name": "Conquer Shop S.R.L." }]))
  };

  const db = { get: async () => rows };

  return { asked, store: createInboundScansStore({ airtable, db }) };
}

test("the list is newest first, with who sent it and what came out of it", async () => {
  const older = pair({ tracking_number: "DPD-0001", received_at: "2026-09-01T08:00:00Z" });
  const { store } = fakes({ rows: [pair(), pair(), older] });

  const { parcels, totals } = await store.list();

  assert.equal(parcels[0].tracking, TRACKING);
  assert.equal(parcels[0].party, "Zhuoyi", "the Sellers Database gives the name");
  assert.equal(parcels[0].pairs, 2);
  assert.equal(parcels[0].type, "Consignment & Forwarding");
  assert.equal(parcels[1].tracking, "DPD-0001");
  assert.equal(totals.parcels, 2);
  assert.equal(totals.pairs, 3);
  assert.equal(totals.value, 90);
});

test("searching finds a parcel by its number, its SKU or its seller", async () => {
  const { store, asked } = fakes({ rows: [pair(), pair({ tracking_number: "DPD-0001", sku: "DD1391-100" })] });

  assert.equal((await store.list({ q: "1Z14V4W" })).parcels.length, 1);
  assert.equal((await store.list({ q: "DD1391" })).parcels[0].tracking, "DPD-0001");
  assert.equal((await store.list({ q: "SE-00781" })).parcels.length, 2);
  assert.equal((await store.list({ q: "nothing at all" })).parcels.length, 0);

  // Airtable is asked the same question rather than handing over everything.
  assert.match(asked[0][1], /FIND\(UPPER\('1Z14V4W'\)/);
});

test("one parcel gives its lines, and an unknown number says so", async () => {
  const { store } = fakes({ rows: [pair(), pair({ status: "sold", sold_ref: "EXTD-000081" })] });

  const parcel = await store.detail(TRACKING);

  assert.equal(parcel.pairs, 2);
  assert.equal(parcel.sold, 1);
  assert.equal(parcel.lines[0].quantity, 2);
  assert.equal(parcel.lines[0].partner_price, 30);

  const empty = createInboundScansStore({
    airtable: { select: async () => ({ records: [], offset: "" }), byIds: async () => new Map() },
    db: { get: async () => [] }
  });

  await assert.rejects(() => empty.detail("NOPE-1"), /Nothing was scanned on NOPE-1/);
  await assert.rejects(() => empty.detail(""), /Which parcel/);
});

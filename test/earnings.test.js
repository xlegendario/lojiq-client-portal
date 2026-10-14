import test from "node:test";
import assert from "node:assert/strict";

import {
  unitEarning, unitChannel, unitWtbId, externalEarning, inPeriod, totals, byMonth,
  earningsCsv, day, CHANNELS
} from "../admin/earnings.js";

/* ---------------- a pair sold through Airtable ---------------- */

// A store order, exactly as Airtable hands it over.
const SHOP = {
  "Sales Date": ["2026-08-10"],
  "Purchase Price": 129.61,
  "Selling Price": 147.5,
  "Final Selling Price": 147.5,
  "Gross Profit": 17.889999999999986,
  "Gross Profit (after TAX)": 14.785123966942137,
  "Marketplace Commission": 0,
  "UOL Order Source": ["Shopify"],
  "VAT Type": "Margin",
  "Item ID": "PCS-006200",
  SKU: "DM7866-202",
  Size: "42",
  "Shopify Order Number": ["16527"],
  "Date Fulfilled": ["2026-08-10"],
  "Unfulfilled Orders Log": ["recUOL"]
};

test("a lookup holding one thing is still one thing", () => {
  assert.equal(day(["2026-08-10"]), "2026-08-10");
  assert.equal(day("2026-09-03T10:00:00.000Z"), "2026-09-03");
  assert.equal(day([]), "");
  assert.equal(day("soon"), "");
});

test("a sold pair is the figures Airtable already works out", () => {
  const row = unitEarning(SHOP);

  assert.equal(row.channel, "Store orders");
  assert.equal(row.date, "2026-08-10");
  /*
    The number the deal is known by, which for a store order is the one on
    the order itself. The Shopify number is the shop's own and nothing here
    is filed under it; the unit number stands in only when there is no
    order at all - and those are the rows worth looking up, so an empty
    cell would be the wrong kind of honest.
  */
  assert.equal(row.reference, "PCS-006200", "no order yet, so the unit it is");
  assert.equal(unitEarning(SHOP, { order: "ORD-004554" }).reference, "ORD-004554");
  assert.equal(unitEarning({ ...SHOP, "Order ID (UOL)": ["ORD-004554"] }).reference, "ORD-004554");
  assert.equal(row.shop_order, "16527", "the shop's own number is kept, beside it");
  assert.equal(row.where, "Shopify");

  // To the cent, and rounded the way money is rather than left at
  // fourteen decimal places.
  assert.equal(row.purchase, 129.61);
  assert.equal(row.selling, 147.5);
  assert.equal(row.gross, 17.89);
  assert.equal(row.gross_after_tax, 14.79);
  assert.equal(row.commission, 0);
});

test("a Member WTB is dated on the day the deal was made", () => {
  /*
    The unit's own Sales Date is the fulfilment date of a store order or
    the day an old external sale went out. For a Member WTB neither
    happened and the field is empty on every single one of them - which is
    how the whole channel stayed out of every month until someone counted.
  */
  const unit = { ...SHOP, "Sales Date": [], "Date Fulfilled": [], "Unfulfilled Orders Log": [], "Member WTB ID": ["MWTB-000415"] };

  assert.equal(unitEarning(unit).date, "", "no confirmed WTB behind it, and it says so");

  const row = unitEarning(unit, { wtb: { id: "MWTB-000415", created: "2026-09-01T08:21:00.000Z" } });

  assert.equal(row.channel, "Member WTBs");
  assert.equal(row.date, "2026-09-01", "the day it was confirmed, not the day it was paid");
  assert.equal(row.reference, "MWTB-000415");
});

test("the links say which channel, and the ticket number says it where they are silent", () => {
  /*
    Reading the links alone put 4.141 of 4.397 sold pairs under store
    orders. A pair sold since the external sales moved to Supabase has no
    Airtable row to link to - only "EXTD-000113" written on it - and was
    then counted a second time inside its own deal.
  */
  assert.equal(unitChannel(SHOP), "Store orders");
  assert.equal(unitChannel({ "Unfulfilled Orders Log": ["recUOL"] }), "Store orders");

  assert.equal(unitChannel({ "External Deal ID": "EXTD-000113" }), "External sales");
  assert.equal(unitChannel({ "Ticket Number": "EXTD-000109" }), "External sales");
  assert.equal(unitChannel({ "External Sales Log": ["recX"] }), "External sales");

  // The affiliate log is the external sales of before the current one.
  assert.equal(unitChannel({ "Affiliates Sales Log": ["recA"] }), "External sales");

  assert.equal(unitChannel({ "Ticket Number": "MWTB-000311" }), "Member WTBs");
  assert.equal(unitChannel({ "Member WTB ID": ["MWTB-000415"] }), "Member WTBs");

  // A marketplace ticket and nothing else is not placed. Calling it a
  // store order would be a guess dressed as a fact.
  assert.equal(unitChannel({ "Ticket Number": "6389154062202108312" }), "");
  assert.equal(unitChannel({}), "");

  assert.equal(unitWtbId({ "Ticket Number": "MWTB-000311" }), "MWTB-000311");
  assert.equal(unitWtbId({ "Ticket Number": "ORD-004554" }), "");
});

test("an old external sale is dated off the log it was written in", () => {
  const unit = {
    ...SHOP,
    "Unfulfilled Orders Log": [],
    "Date Fulfilled": [],
    "Affiliates Sales Log": ["recA"],
    "Date Sold (External)": ["2025-08-05"]
  };

  const row = unitEarning(unit);

  assert.equal(row.channel, "External sales");
  assert.equal(row.date, "2025-08-05");
});

test("a marketplace takes its cut and a shop of our own does not", () => {
  const woovin = unitEarning({ ...SHOP, "Store Name": ["Woovin"], "Marketplace Commission": 23.4 });

  assert.equal(woovin.where, "Woovin");
  assert.equal(woovin.commission, 23.4);
});

/* ---------------- a deal sold outside ---------------- */

test("an external sale is the deal, less the shipping, less what it cost", () => {
  /*
    The sum Airtable used while it still held these deals. Over the 53 it
    and Supabase both know, this lands on the same cent for 49; the four
    that differ differ in the purchase price, not in the arithmetic.
  */
  const row = externalEarning(
    { deal_number: 67, sale_date: "2026-09-07", total_selling_price: "1690.50", shipping_costs: "15.00", buyer_company: "Hypeneedz" },
    [
      { purchase_price_ex_vat: "1000.00", sku: "A", size: "42", product_name: "Jordan 4 Black Cat" },
      { purchase_price_ex_vat: "1048.69", sku: "B", size: "43", product_name: "Samba OG" }
    ]
  );

  assert.equal(row.channel, "External sales");
  assert.equal(row.reference, "EXTD-000067");
  assert.equal(row.purchase, 2048.69);
  assert.equal(row.selling, 1690.5);
  assert.equal(row.gross, -373.19);
  assert.equal(row.gross_after_tax, -308.42);
  assert.equal(row.pairs, 2);
  assert.equal(row.product, "Jordan 4 Black Cat and 1 other");
});

test("a cancelled pair is not bought twice", () => {
  // The deal's total has already come down for it; counting what it cost
  // would charge us for a pair that came back.
  const row = externalEarning(
    { deal_number: 98, sale_date: "2026-10-05", total_selling_price: "210.00" },
    [
      { purchase_price_ex_vat: "168.00", sku: "A", size: "44", product_name: "Jordan 4" },
      { purchase_price_ex_vat: "150.00", sku: "B", size: "42", cancelled_at: "2026-10-06T09:00:00Z" }
    ]
  );

  assert.equal(row.purchase, 168);
  assert.equal(row.pairs, 1);
  assert.equal(row.sku, "A", "one pair left, so the deal is that pair");
});

/* ---------------- the period, the totals, the months ---------------- */

const row = (extra) => ({
  channel: "Store orders", date: "2026-09-15", reference: "x", sku: "", size: "", product: "",
  where: "", vat_type: "", purchase: 100, selling: 130, commission: 0, gross: 30,
  gross_after_tax: 24.79, pairs: 1, ...extra
});

test("a line with no date is handed back, not dropped", () => {
  const { rows, undated } = inPeriod(
    [row(), row({ date: "" }), row({ date: "2026-08-01" })],
    { from: "2026-09-01", to: "2026-09-30" }
  );

  assert.equal(rows.length, 1, "August is outside the period");
  assert.equal(undated.length, 1, "and the one with no date is not silently gone");
});

test("the newest line is the first one", () => {
  const { rows } = inPeriod([row({ date: "2026-09-01" }), row({ date: "2026-09-20" })], {});

  assert.deepEqual(rows.map((r) => r.date), ["2026-09-20", "2026-09-01"]);
});

test("the three channels add up to the whole", () => {
  const sums = totals([
    row(),
    row({ channel: "Member WTBs", gross_after_tax: 10.74, purchase: 100, selling: 113 }),
    row({ channel: "External sales", gross_after_tax: 34.71, purchase: 168, selling: 210, pairs: 3 })
  ]);

  assert.equal(sums.all.deals, 3);
  assert.equal(sums.all.pairs, 5, "a deal of three pairs is three pairs");
  assert.equal(sums.all.gross_after_tax, 70.24);
  assert.deepEqual(sums.channels.map((c) => c.channel), CHANNELS);
  assert.equal(sums.channels.find((c) => c.channel === "Member WTBs").gross_after_tax, 10.74);

  // A channel with nothing in it reads as nothing, not as zero euros
  // earned - those are different statements.
  assert.equal(totals([]).all.gross_after_tax, null);
});

test("a month is one line", () => {
  const months = byMonth([
    row({ date: "2026-09-15" }),
    row({ date: "2026-09-02" }),
    row({ date: "2026-08-30" })
  ]);

  assert.deepEqual(months.map((m) => m.month), ["2026-09", "2026-08"]);
  assert.equal(months[0].deals, 2);
  assert.equal(months[0].gross_after_tax, 49.58);
});

/* ---------------- the file ---------------- */

test("the file opens in columns, with a dot in the amounts", () => {
  const csv = earningsCsv([row({ product: 'Jordan 4 "Black Cat"', gross_after_tax: 1234.5 })]);
  const lines = csv.trim().split("\n");

  assert.match(lines[0], /^Date,Channel,Reference,SKU,Size,Product,Where,Pairs,VAT type,/);

  // A spreadsheet reading a decimal comma as a thousands separator turns
  // 1.50 into 150 and says nothing about it.
  assert.match(lines[1], /1234\.50$/);
  assert.match(lines[1], /"Jordan 4 ""Black Cat"""/);
});

test("a 21% sale is worth what is left after the VAT, on both columns", () => {
  /*
    EXTD-000127 on 14-10-2026, the first external sale that was not margin
    goods. Three pairs bought for 81, 129 and 91 and sold for 110.11, 168.19
    and 122.21 - ten euro a pair, and the screen said 99.51.
  */
  const row = externalEarning(
    { deal_number: 127, sale_date: "2026-10-14", total_selling_price: "400.51", shipping_costs: "0" },
    [
      { purchase_price_ex_vat: "81.00", selling_price: "110.11", selling_vat_type: "VAT21", sku: "U740WM2", size: "39.5" },
      { purchase_price_ex_vat: "129.00", selling_price: "168.19", selling_vat_type: "VAT21", sku: "U9060ZBS", size: "37.5" },
      { purchase_price_ex_vat: "91.00", selling_price: "122.21", selling_vat_type: "VAT21", sku: "1201A789-020", size: "37.5" }
    ]
  );

  assert.equal(row.purchase, 301);
  assert.equal(row.selling, 400.51);
  assert.equal(row.gross, 30);
  // No tax on the margin of a 21% sale: it came off the price already.
  assert.equal(row.gross_after_tax, 30);
});

test("a reverse-charged sale is net on both columns", () => {
  const row = externalEarning(
    { deal_number: 128, sale_date: "2026-10-14", total_selling_price: "200.00", shipping_costs: "0", buyer_vat_id: "DE123" },
    [{ purchase_price_ex_vat: "180.00", selling_price: "200.00", selling_vat_type: "VAT0", sku: "A", size: "42" }]
  );

  assert.equal(row.gross, 20);
  assert.equal(row.gross_after_tax, 20);
});

test("margin goods keep the tax on the margin", () => {
  const row = externalEarning(
    { deal_number: 129, sale_date: "2026-10-14", total_selling_price: "121.00", shipping_costs: "0" },
    [{ purchase_price_ex_vat: "100.00", selling_price: "121.00", selling_vat_type: "Margin", sku: "A", size: "42" }]
  );

  assert.equal(row.gross, 21);
  // 21 over the margin, so 21 / 1.21 is left.
  assert.equal(row.gross_after_tax, 17.36);
});

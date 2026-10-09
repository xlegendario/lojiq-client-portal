import test from "node:test";
import assert from "node:assert/strict";

import { matchStock, parseRequest, sizeKey, skuKey } from "../admin/wtbMatch.js";

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

import test from "node:test";
import assert from "node:assert/strict";

import { suggestedItems } from "../shelfSuggested.js";

const rows = [
  { sku: "HQ4199-100", name: "Nike Air Max 1 Patta Waves", brand: "Nike", model: "Air Max 1", score: 36, units: 30, lojiq_price: "189.00", fast_sizes: "42 43" },
  { sku: "DD1391-103", name: "Nike Dunk Low Panda", brand: "Nike", model: "Dunk Low", score: 80, units: 70, lojiq_price: null },
  { sku: "U9060BLK", name: "New Balance 9060 Black", brand: "New Balance", score: 40, units: 22 },
  { sku: "IE3437", name: "adidas Samba OG", brand: "adidas", score: 31, units: 12 }
];

test("best score first, with prices as numbers", () => {
  const items = suggestedItems(rows, []);
  assert.deepEqual(items.map((i) => i.sku), ["DD1391-103", "U9060BLK", "HQ4199-100", "IE3437"]);
  assert.equal(items[2].lojiq_price, 189);
  assert.equal(items[0].lojiq_price, null);
});

test("a style decided on drops off; one queued to be added stays, marked", () => {
  const items = suggestedItems(rows, [
    { sku: "dd1391-103", choice: "deactivated", status: "done" },
    { sku: "U9060BLK", choice: "add", status: "done" },
    { sku: "HQ4199-100", choice: "add", status: "pending" }
  ]);
  assert.deepEqual(items.map((i) => [i.sku, i.choice]), [["HQ4199-100", "add"], ["IE3437", null]]);
});

test("search on name, style code, brand and model", () => {
  assert.deepEqual(suggestedItems(rows, [], "air max").map((i) => i.sku), ["HQ4199-100"]);
  assert.deepEqual(suggestedItems(rows, [], "u9060").map((i) => i.sku), ["U9060BLK"]);
  assert.deepEqual(suggestedItems(rows, [], "nike dunk").map((i) => i.sku), ["DD1391-103"]);
});

test("'Not for us' keeps a style off the list; the dismissed view shows only those", () => {
  const withDismissed = rows.concat([{ sku: "IM6687-262", name: "Nike Dunk Low Khaki", score: 90, units: 80, dismissed_at: "2026-11-18T12:00:00Z", dismissed_reason: "longlist-2026-11-14" }]);
  assert.ok(!suggestedItems(withDismissed, []).some((i) => i.sku === "IM6687-262"));
  const set = suggestedItems(withDismissed, [], "", { dismissed: true });
  assert.deepEqual(set.map((i) => [i.sku, i.dismissed_reason]), [["IM6687-262", "longlist-2026-11-14"]]);
});

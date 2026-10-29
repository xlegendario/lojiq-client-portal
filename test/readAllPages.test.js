import test from "node:test";
import assert from "node:assert/strict";

import { readAllPages } from "../admin/readAllPages.js";

test("reads page after page until a short page, so nothing past 1000 rows is lost", async () => {
  const table = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const asked = [];
  const get = async (path) => {
    asked.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    const offset = Number(query.get("offset"));
    return table.slice(offset, offset + Math.min(1000, Number(query.get("limit"))));
  };

  const rows = await readAllPages(get, "things?select=id&order=id.asc");
  assert.equal(rows.length, 2345);
  assert.deepEqual(asked, [
    "things?select=id&order=id.asc&limit=1000&offset=0",
    "things?select=id&order=id.asc&limit=1000&offset=1000",
    "things?select=id&order=id.asc&limit=1000&offset=2000"
  ]);
});

test("an exact multiple of 1000 asks once more and stops at the empty page", async () => {
  const table = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  let calls = 0;
  const rows = await readAllPages(async (path) => {
    calls += 1;
    const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset"));
    return table.slice(offset, offset + 1000);
  }, "things?select=id");
  assert.equal(rows.length, 1000);
  assert.equal(calls, 2);
});

import test from "node:test";
import assert from "node:assert/strict";

import { BolPagesError, createBolPagesStore } from "../admin/adminBolPages.js";

function fakeSupabase(rows) {
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const u = new URL(url);
    const ean = (u.searchParams.get("ean") || "").replace(/^eq\./, "");
    let result = rows;

    if (ean) result = rows.filter((row) => row.ean === ean);

    if (options.method === "PATCH") {
      const change = JSON.parse(options.body);
      result = result.map((row) => Object.assign(row, change));
    }

    return new Response(JSON.stringify(result), { status: 200 });
  };

  return { calls, store: createBolPagesStore({ supabaseUrl: "https://x.supabase.co", serviceKey: "k", fetchImpl }) };
}

test("the sidebar counts only the blocked pages", async () => {
  const { store } = fakeSupabase([
    { ean: "4066755748549", status: "blocked" },
    { ean: "4066749562571", status: "approved" },
    { ean: "4570158713467", status: "blocked" }
  ]);

  assert.deepEqual(await store.counts(), { blocked: 2 });
});

test("a status is only ever blocked or approved", async () => {
  const { store } = fakeSupabase([{ ean: "4066755748549", status: "blocked" }]);

  await assert.rejects(store.setStatus("4066755748549", "deleted"), BolPagesError);
  assert.equal((await store.setStatus("4066755748549", "approved")).status, "approved");
});

test("only a barcode can be looked up", async () => {
  const { store, calls } = fakeSupabase([]);

  await assert.rejects(store.get("1 or 1=1"), /not a barcode/);
  await assert.rejects(store.get("4066755748549"), /not in the list/);
  assert.equal(calls.length, 1);
});

test("the list can be narrowed to one status", async () => {
  const { store, calls } = fakeSupabase([]);

  await store.list({ status: "blocked" });
  await store.list({ status: "anything" });

  assert.match(calls[0].url, /status=eq\.blocked/);
  assert.doesNotMatch(calls[1].url, /status=/);
});

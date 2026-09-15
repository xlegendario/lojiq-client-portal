import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS, availableActions, describeAction, discordLink, runAction } from "../admin/adminActions.js";

function fakeDeps() {
  const calls = [];

  return {
    calls,
    airtable: { update: async (table, id, fields) => calls.push({ kind: "airtable", table, id, fields }) },
    callKc: async (path, body, which) => calls.push({ kind: "kc", path, body, which }),
    callWms: async (path, body) => calls.push({ kind: "wms", path, body }),
    itemShippedUrl: "https://updates.test/",
    deliveredWebhookUrl: "",
    notify: async (url, body, label) => {
      calls.push({ kind: "notify", url, body, label });
      return url ? "" : `No ${label} sent (not configured here).`;
    },
    updateExternalSale: async (orderId, status) => {
      calls.push({ kind: "external", orderId, status });
      return "";
    },
    firstLinked: async () => null
  };
}

const record = (fields) => ({ id: "recAAAAAAAAAAAAAA", fields });

test("buttons only show where they can run", () => {
  const open = { "Fulfillment Status": "Outsource", "Offer To Store": 250, "Offer VAT Type": "Margin" };
  assert.deepEqual(availableActions("store", ["send_offer", "custom_price"], open), ["send_offer", "custom_price"]);
  assert.deepEqual(availableActions("store", ["send_offer"], { ...open, "Offer To Store": null }), []);

  assert.deepEqual(availableActions("store", ["mark_shipped"], { "Fulfillment Status": "Allocated" }), []);
  assert.deepEqual(availableActions("store", ["mark_shipped"], { "Fulfillment Status": "Ready to Ship", "Shipping Status": "Shipped" }), []);
  assert.deepEqual(availableActions("store", ["mark_delivered"], { "Fulfillment Status": "Fulfilled", "Shipping Status": "Shipped" }), ["mark_delivered"]);

  // Links only when there is somewhere to go; Add Note has no Member WTB field.
  assert.deepEqual(availableActions("store", ["track", "discord"], {}), []);
  assert.deepEqual(availableActions("mwtb", ["add_note", "solved"], { "Fulfillment Status": "Ready to Ship" }), []);
});

test("Discord goes to the deal channel in the Kickz Caviar server", () => {
  assert.equal(
    discordLink("store", { "WTB Created Channel ID": "1500000000000000001", "Claimed Channel ID": "1500000000000000002" }),
    "https://discord.com/channels/922818998163361792/1500000000000000002"
  );
  assert.equal(discordLink("store", { "Claimed Channel ID": "not-an-id", "Offer Message URL": "javascript:x" }), "");
});

test("Send Offer on a store order hands it to the automation engine", async () => {
  const deps = fakeDeps();
  await runAction({
    key: "send_offer",
    source: "store",
    record: record({ "Fulfillment Status": "Pending", "Offer To Store": 250, "Offer VAT Type": "VAT0" }),
    deps
  });

  assert.deepEqual(deps.calls, [{ kind: "airtable", table: "Unfulfilled Orders Log", id: "recAAAAAAAAAAAAAA", fields: { "Offer Sent?": true, offer_request_webhook_key: "" } }]);
});

test("Send Offer on a member WTB uses the Kickz Caviar route with the portal secret", async () => {
  const deps = fakeDeps();
  await runAction({
    key: "send_offer",
    source: "mwtb",
    record: record({ "Fulfillment Status": "Outsource", "Offer To Buyer": 120, "Current Lowest Seller Offer": ["recS"], "Buyer Seller ID": ["recB"] }),
    deps
  });

  assert.deepEqual(deps.calls, [{ kind: "kc", path: "/api/member-wtb/send-current-offer-to-buyer", body: { member_wtb_record_id: "recAAAAAAAAAAAAAA" }, which: "portal" }]);
});

test("Custom Price: validated, and an offer already sent goes out again", async () => {
  const deps = fakeDeps();
  const sent = record({ "Fulfillment Status": "Outsource", "Offer Sent?": true, "Custom Offer": 200 });

  await assert.rejects(runAction({ key: "custom_price", source: "store", record: sent, input: { price: "-1" }, deps }), /above € 0/);
  await runAction({ key: "custom_price", source: "store", record: sent, input: { price: "212,5" }, deps });

  assert.deepEqual(deps.calls.at(-1).fields, { "Custom Offer": 212.5, offer_request_webhook_key: "" });

  await runAction({ key: "custom_price", source: "store", record: record({ "Fulfillment Status": "Pending" }), input: { price: "" }, deps });
  assert.deepEqual(deps.calls.at(-1).fields, { "Custom Offer": null });

  await assert.rejects(
    runAction({ key: "custom_price", source: "store", record: record({ "Fulfillment Status": "Allocated" }), input: { price: "10" }, deps }),
    /Only open orders/
  );
});

test("Upload sends the PDF to the WMS the label page uses", async () => {
  const deps = fakeDeps();
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 32)]);
  const rec = record({ "Fulfillment Status": "Requested Label", "Order ID": "ORD-1" });

  await assert.rejects(runAction({ key: "upload_label", source: "store", record: rec, input: { tracking: "1Z 999" }, file: pdf, deps }), /tracking number/);
  await assert.rejects(runAction({ key: "upload_label", source: "store", record: rec, input: { tracking: "1Z999AA10123456784" }, file: Buffer.alloc(300, 65), deps }), /PDF/);

  await runAction({ key: "upload_label", source: "store", record: rec, input: { tracking: "1Z999AA10123456784" }, file: pdf, deps });

  const call = deps.calls.at(-1);
  assert.equal(call.kind, "wms");
  assert.equal(call.path, "/api/label-request-submit");
  assert.equal(call.body.type, "store_order");
  assert.equal(call.body.tracking_number, "1Z999AA10123456784");
  assert.match(call.body.file_data_url, /^data:application\/pdf;base64,JVBERi0x/);
});

test("Mark Shipped does what the tracking job does", async () => {
  const deps = fakeDeps();
  const result = await runAction({
    key: "mark_shipped",
    source: "store",
    record: record({ "Fulfillment Status": "Ready to Ship", "Order ID": "ORD-7", "Store Name": ["Genky"], SKU: "DD1391-100" }),
    deps
  });

  assert.deepEqual(deps.calls[0].fields, { "Fulfillment Status": "Fulfilled", "Shipping Status": "Shipped" });
  assert.deepEqual(deps.calls[1], { kind: "external", orderId: "ORD-7", status: "Shipped" });
  assert.equal(deps.calls[2].body.trigger_type, "item-shipped");
  assert.equal(deps.calls[2].body.store_name, "Genky");
  assert.equal(result.message, "Marked shipped.");

  // A want-to-buy: statuses only, no shipped notification.
  const mwtb = fakeDeps();
  await runAction({ key: "mark_shipped", source: "mwtb", record: record({ "Fulfillment Status": "Ready to Ship" }), deps: mwtb });
  assert.equal(mwtb.calls.length, 1);
});

test("Mark Delivered says when the delivered message could not be posted", async () => {
  const deps = fakeDeps();
  const result = await runAction({
    key: "mark_delivered",
    source: "store",
    record: record({ "Fulfillment Status": "Fulfilled", "Shipping Status": "Shipped", "Order ID": "ORD-8" }),
    deps
  });

  assert.deepEqual(deps.calls[0].fields, { "Fulfillment Status": "Fulfilled", "Shipping Status": "Delivered" });
  assert.match(result.message, /No delivered message sent/);

  await assert.rejects(
    runAction({ key: "mark_delivered", source: "store", record: record({ "Fulfillment Status": "Fulfilled", "Shipping Status": "Delivered" }), deps }),
    /already delivered/
  );
});

test("Solved only on an open issue; links are never run on the server", async () => {
  const deps = fakeDeps();
  await assert.rejects(runAction({ key: "solved", source: "store", record: record({ "Issue Status": "Solved" }), deps }), /no open issue/);
  await runAction({ key: "solved", source: "store", record: record({ "Issue Status": "Troubled" }), deps });
  assert.deepEqual(deps.calls.at(-1).fields, { "Issue Status": "Solved" });

  await assert.rejects(runAction({ key: "track", source: "store", record: record({}), deps }), /does not exist/);
  assert.equal(ACTIONS.add_note.sources.includes("mwtb"), false);
});

/* ---------------- Accept and Counter ---------------- */

// Kickz Caviar's offer lists, as the client portal reads them.
function negotiationDeps(lists) {
  const deps = fakeDeps();

  deps.getKc = async (path, params) => {
    deps.calls.push({ kind: "kc-get", path, params });
    const key = `${path}${params.filter ? `?${params.filter}` : ""}`;
    return { items: lists[key] || [] };
  };

  deps.callKc = async (path, body, which) => {
    deps.calls.push({ kind: "kc", path, body, which });
    return path.endsWith("create-fresh-round") ? { counter_offer_record_id: "recROUND000000001" } : { ok: true };
  };

  return deps;
}

const storeOrder = record({ "Fulfillment Status": "Outsource", "Store Name": ["SneakerAsk"], "Order ID": "ORD-1" });

test("store Accept on a fresh offer: create-fresh-round, then store-accept", async () => {
  const deps = negotiationDeps({
    "/api/dashboard/store-offers": [
      { order_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER001", offer: "€ 155", vat_type: "Margin" },
      { order_record_id: "recOTHERORDER0001", seller_offer_record_id: "recSELLEROFFER999", offer: "€ 90" }
    ]
  });

  const described = await describeAction("accept", "store", storeOrder, deps);
  assert.deepEqual(described.options, [{ id: "fresh:recSELLEROFFER001", label: "Offer € 155 (Margin)" }]);

  await runAction({ key: "accept", source: "store", record: storeOrder, input: { choice: "fresh:recSELLEROFFER001" }, deps });

  const posts = deps.calls.filter((c) => c.kind === "kc");
  assert.deepEqual(posts.map((c) => c.path), ["/api/counter-offers/create-fresh-round", "/api/counter-offers/recROUND000000001/store-accept"]);
  assert.deepEqual(posts[0].body, { order_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER001", store_name: "SneakerAsk" });
  assert.deepEqual(posts[1].body, { store_name: "SneakerAsk" });
});

test("store Accept only in Outsource, and refuses an offer that moved on", async () => {
  const deps = negotiationDeps({ "/api/dashboard/store-offers": [{ order_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER001", offer: "155" }] });
  const pending = record({ ...storeOrder.fields, "Fulfillment Status": "Pending" });

  assert.match((await describeAction("accept", "store", pending, deps)).blocked, /Outsource/);
  await assert.rejects(runAction({ key: "accept", source: "store", record: storeOrder, input: { choice: "fresh:recGONE" }, deps }), /changed in the meantime/);
  assert.equal(deps.calls.some((c) => c.kind === "kc"), false);
});

test("store Counter: round one through create, a seller's counter through store-counter", async () => {
  const fresh = negotiationDeps({ "/api/dashboard/store-offers": [{ order_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER001", offer: "155" }] });

  await assert.rejects(runAction({ key: "counter", source: "store", record: storeOrder, input: { choice: "fresh:recSELLEROFFER001", price: "140.5" }, deps: fresh }), /whole euros/);
  await runAction({ key: "counter", source: "store", record: storeOrder, input: { choice: "fresh:recSELLEROFFER001", price: "140" }, deps: fresh });
  assert.deepEqual(fresh.calls.filter((c) => c.kind === "kc"), [{ kind: "kc", path: "/api/counter-offers/create", body: { order_record_id: "recAAAAAAAAAAAAAA", store_counter_price: 140 }, which: undefined }]);

  const round = negotiationDeps({ "/api/dashboard/store-counter-offers?open": [{ id: "recROUND000000002", order_record_id: "recAAAAAAAAAAAAAA", sellers_offer: "€ 150", sellers_offer_payout: 130, vat_type: "Margin", my_offer: "€ 140" }] });
  await runAction({ key: "counter", source: "store", record: storeOrder, input: { choice: "round:recROUND000000002", price: "145" }, deps: round });
  assert.deepEqual(round.calls.filter((c) => c.kind === "kc")[0].body, { store_name: "SneakerAsk", price: 145 });
  assert.equal(round.calls.filter((c) => c.kind === "kc")[0].path, "/api/counter-offers/recROUND000000002/store-counter");
});

test("nothing to act on: says the counter is waiting for the seller", async () => {
  const deps = negotiationDeps({ "/api/dashboard/store-counter-offers?countered": [{ order_record_id: "recAAAAAAAAAAAAAA", my_offer: "€ 140" }] });
  const described = await describeAction("counter", "store", storeOrder, deps);

  assert.equal(described.options.length, 0);
  assert.match(described.blocked, /counter of € 140 is waiting for the seller/);
});

test("member WTB Accept on a round sends the negotiated payout, as the buyer's button does", async () => {
  const wtb = record({ "Fulfillment Status": "Outsource", "Buyer Seller ID": ["recBUYER000000001"], "Member WTB ID": "MWTB-1" });
  const deps = negotiationDeps({
    "/api/dashboard/buying-counter-offers?open": [{ id: "recROUND000000003", member_wtb_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER002", sellers_offer: "€ 139,10", sellers_offer_payout: 127, vat_type: "VAT21" }]
  });

  await runAction({ key: "accept", source: "mwtb", record: wtb, input: { choice: "round:recROUND000000003" }, deps });

  const post = deps.calls.find((c) => c.kind === "kc");
  assert.equal(post.path, "/api/dashboard/buying/accept-offer");
  assert.deepEqual(post.body, {
    member_wtb_record_id: "recAAAAAAAAAAAAAA",
    seller_record_id: "recBUYER000000001",
    counter_offer_record_id: "recROUND000000003",
    seller_offer_record_id: "recSELLEROFFER002",
    override_price: 127,
    override_vat_type: "VAT21"
  });
  assert.deepEqual(deps.calls.find((c) => c.kind === "kc-get").params, { seller_record_id: "recBUYER000000001" });
});

test("member WTB Counter on a fresh offer starts a round from it", async () => {
  const wtb = record({ "Fulfillment Status": "Pending", "Buyer Seller ID": ["recBUYER000000001"] });
  const deps = negotiationDeps({ "/api/dashboard/buying-offers": [{ id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER003", offer: "€ 90", vat_type: "Margin" }] });

  await runAction({ key: "counter", source: "mwtb", record: wtb, input: { choice: "fresh:recSELLEROFFER003", price: "80" }, deps });

  const post = deps.calls.find((c) => c.kind === "kc");
  assert.equal(post.path, "/api/dashboard/buying-counter-offers/create-from-fresh");
  assert.deepEqual(post.body, { member_wtb_record_id: "recAAAAAAAAAAAAAA", seller_offer_record_id: "recSELLEROFFER003", price: 80, seller_record_id: "recBUYER000000001" });
});

test("Custom Price with Offer Accepted?: price, accepted, not sent again, old offer embeds closed", async () => {
  const deps = fakeDeps();
  deps.discordUpdatesUrl = "https://updates.test/";
  const order = record({ "Fulfillment Status": "Outsource", "Offer Sent?": true, "Store Name": ["Genky"] });

  await assert.rejects(runAction({ key: "custom_price", source: "store", record: order, input: { price: "", accepted: true }, deps }), /Enter the price/);

  const result = await runAction({ key: "custom_price", source: "store", record: order, input: { price: "250", accepted: true }, deps });

  assert.deepEqual(deps.calls[0].fields, { "Custom Offer": 250, "Offer Accepted?": true, "Offer Sent?": false });
  assert.equal(deps.calls[1].kind, "notify");
  assert.equal(deps.calls[1].body.trigger_type, "disable-offer-messages");
  assert.equal(deps.calls[1].body.record_id, "recAAAAAAAAAAAAAA");
  assert.match(result.message, /Offer Accepted\? ticked/);

  // Never sent: exactly the two fields ticked by hand in Airtable, nothing posted.
  const quiet = fakeDeps();
  quiet.discordUpdatesUrl = "https://updates.test/";
  await runAction({ key: "custom_price", source: "store", record: record({ "Fulfillment Status": "Pending", "Store Name": ["Genky"] }), input: { price: "180", accepted: true }, deps: quiet });
  assert.deepEqual(quiet.calls, [{ kind: "airtable", table: "Unfulfilled Orders Log", id: "recAAAAAAAAAAAAAA", fields: { "Custom Offer": 180, "Offer Accepted?": true } }]);

  // Without the tick nothing about acceptance is written.
  const plain = fakeDeps();
  await runAction({ key: "custom_price", source: "store", record: order, input: { price: "250", accepted: false }, deps: plain });
  assert.deepEqual(plain.calls[0].fields, { "Custom Offer": 250, offer_request_webhook_key: "" });
});

test("Manual Deal creates an approved Order Processing Form for the order and the seller", async () => {
  const deps = fakeDeps();
  deps.airtable.select = async (table, { formula }) => {
    deps.calls.push({ kind: "select", table, formula });
    return { records: /SE-00035/.test(formula) ? [{ id: "recSELLER00000035", fields: { "Company Name": "Dominicks" } }] : [] };
  };
  deps.airtable.create = async (table, fields) => {
    deps.calls.push({ kind: "create", table, fields });
    return { id: "recOPF00000000001" };
  };

  const order = record({ "Fulfillment Status": "Outsource", "Order ID": "ORD-1" });

  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "35", payout: "150", vat: "Margin" }, deps }), /SE- followed/);
  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "SE-00001", payout: "150", vat: "Margin" }, deps }), /No seller found/);
  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "SE-00035", payout: "150", vat: "VAT9" }, deps }), /VAT type/);

  const result = await runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "se-00035", payout: "150,5", vat: "VAT0" }, deps });

  const create = deps.calls.find((c) => c.kind === "create");
  assert.equal(create.table, "Order Processing Form");
  assert.deepEqual(create.fields, { "Linked Order ID": ["recAAAAAAAAAAAAAA"], "Linked Seller ID": ["recSELLER00000035"], "Payout (€)": 150.5, "VAT Type": "VAT0", Agreement: true });
  assert.deepEqual(deps.calls.at(-1), { kind: "airtable", table: "Order Processing Form", id: "recOPF00000000001", fields: { "Approved?": true } });
  assert.match(result.message, /Dominicks \(SE-00035\), € 150.5 VAT0, approved/);

  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: record({ "Fulfillment Status": "Allocated" }), input: { seller: "SE-00035", payout: "1", vat: "Margin" }, deps }), /open order/);
});

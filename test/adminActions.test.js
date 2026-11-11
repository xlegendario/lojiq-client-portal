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

test("Edit Offer: the old embeds are deleted before the new price goes out", async () => {
  const deps = { ...fakeDeps(), discordUpdatesUrl: "https://updates.test/" };
  const sent = record({ "Fulfillment Status": "Outsource", "Offer To Store": 97.5, "Offer VAT Type": "Margin", "Offer Sent?": true, "Store Name": ["APLUG.PL"] });

  assert.deepEqual(availableActions("store", ["edit_offer"], sent.fields), ["edit_offer"]);
  assert.deepEqual(availableActions("store", ["edit_offer"], { ...sent.fields, "Offer Sent?": false }), []);
  assert.deepEqual(availableActions("store", ["edit_offer"], { ...sent.fields, "Offer Accepted?": true }), []);

  await assert.rejects(runAction({ key: "edit_offer", source: "store", record: sent, input: { price: "97,5" }, deps }), /already has an offer/);
  await runAction({ key: "edit_offer", source: "store", record: sent, input: { price: "120" }, deps });

  assert.deepEqual(deps.calls.map((call) => call.kind), ["notify", "airtable"]);
  assert.deepEqual(deps.calls[0].body, { trigger_type: "delete-offer-messages", store_name: "APLUG.PL", record_id: "recAAAAAAAAAAAAAA" });
  assert.deepEqual(deps.calls[1].fields, { "Custom Offer": 120, offer_request_webhook_key: "" });
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

test("Custom Price on a claimed deal: only the price, no new offer", async () => {
  const deps = fakeDeps();
  const claimed = record({ "Fulfillment Status": "Claim Processing", "Offer Sent?": true, "Offer VAT Type": "Margin", "Estimated Time": "2-4 days", "Custom Offer": 200, "Store Name": ["Genky"] });

  assert.deepEqual(availableActions("store", ["custom_price"], claimed.fields), ["custom_price"]);
  assert.deepEqual(availableActions("store", ["custom_price"], { "Fulfillment Status": "StockX Processing" }), ["custom_price"]);
  assert.deepEqual(availableActions("mwtb", ["custom_price"], { "Fulfillment Status": "Confirmed" }), ["custom_price"]);
  assert.deepEqual(availableActions("mwtb", ["custom_price"], { "Fulfillment Status": "StockX Processing" }), []);

  const described = await describeAction("custom_price", "store", claimed, deps);
  assert.match(described.confirm, /already claimed/);

  await assert.rejects(runAction({ key: "custom_price", source: "store", record: claimed, input: { price: "" }, deps }), /enter a price/);

  // Offer Accepted? is not touched, and the key matches what the engine would build, so no embed.
  const result = await runAction({ key: "custom_price", source: "store", record: claimed, input: { price: "212,5", accepted: true }, deps });
  assert.deepEqual(deps.calls, [{ kind: "airtable", table: "Unfulfilled Orders Log", id: "recAAAAAAAAAAAAAA", fields: { "Custom Offer": 212.5, offer_request_webhook_key: "Margin|212.5|2-4 days" } }]);
  assert.match(result.message, /No new offer/);

  // Never sent: nothing for the engine to post, so no key.
  await runAction({ key: "custom_price", source: "store", record: record({ "Fulfillment Status": "Confirmed" }), input: { price: "150" }, deps });
  assert.deepEqual(deps.calls.at(-1).fields, { "Custom Offer": 150 });

  // A want-to-buy: not sent to the buyer again.
  await runAction({ key: "custom_price", source: "mwtb", record: record({ "Fulfillment Status": "Claim Processing", "Offer Sent?": true }), input: { price: "99" }, deps });
  assert.deepEqual(deps.calls.at(-1), { kind: "airtable", table: "Member WTBs", id: "recAAAAAAAAAAAAAA", fields: { "Custom Offer": 99 } });
  assert.equal(deps.calls.filter((c) => c.kind !== "airtable").length, 0);
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
  assert.equal(deps.calls[1].body.trigger_type, "item-shipped");
  assert.equal(deps.calls[1].body.store_name, "Genky");
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

test("Manual Deal makes the deal right away: form, unit, booking, label request", async () => {
  const deps = fakeDeps();
  const seller = {
    "Seller ID": "SE-00035", "Company Name": "Dominicks", "Full Name": "Dom", "Email": "dom@example.com",
    "Country Code": "NL", "VAT ID": "123456789B01", "Discord ID": "4242"
  };
  deps.airtable.select = async (table, { formula }) => {
    deps.calls.push({ kind: "select", table, formula });
    if (table === "Label Request Routing") return { records: [{ id: "recROUTE", fields: { "Preferred Courier": "DHL", "Instruction Text": "Drop at DHL" } }] };
    return { records: /SE-00035/.test(formula) ? [{ id: "recSELLER00000035", fields: seller }] : [] };
  };
  deps.airtable.create = async (table, fields) => {
    deps.calls.push({ kind: "create", table, fields });
    return { id: table === "Order Processing Form" ? "recOPF00000000001" : "recUNIT0000000001" };
  };
  deps.airtable.byIds = async (table, ids) => new Map([[ids[0], {
    "Order ID": "ORD-1", "Product Name": "Nike Dunk", "Brand": "Nike", "SKU": "DD1391-100", "Size": "42",
    "Shopify Order Number": "1001", "Shopify Product Name": "Dunk", "Store Name": ["Store"], "Client Label Request Channel ID": ["123"]
  }]]);
  deps.purchases = { book: async (args) => { deps.calls.push({ kind: "book", args }); return { expense_id: "9", expense_number: "IN-9" }; } };
  deps.sendMail = async (m) => deps.calls.push({ kind: "mail", m });
  deps.postJson = async (url, body) => deps.calls.push({ kind: "post", url, body });
  deps.discordUpdatesUrl = "https://updates.test/";

  const order = record({ "Fulfillment Status": "Outsource", "Order ID": "ORD-1" });

  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "35", payout: "150", vat: "Margin" }, deps }), /SE- followed/);
  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "SE-00001", payout: "150", vat: "Margin" }, deps }), /No seller found/);
  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "SE-00035", payout: "150", vat: "VAT9" }, deps }), /VAT type/);

  const result = await runAction({ key: "manual_deal", source: "store", record: order, input: { seller: "se-00035", payout: "150,5", vat: "VAT0" }, deps });

  const [form, unit] = deps.calls.filter((c) => c.kind === "create");
  assert.equal(form.table, "Order Processing Form");
  assert.deepEqual(form.fields, { "Linked Order ID": ["recAAAAAAAAAAAAAA"], "Linked Seller ID": ["recSELLER00000035"], "Payout (€)": 150.5, "VAT Type": "VAT0", Agreement: true, "Approved?": true });

  assert.equal(unit.table, "Inventory Units");
  assert.equal(unit.fields["Purchase Price"], 150.5);
  assert.equal(unit.fields["Payment Note"], "150.5");
  assert.equal(unit.fields["Ticket Number"], "ORD-1");
  assert.deepEqual(unit.fields["Seller ID"], ["recSELLER00000035"]);
  assert.deepEqual(unit.fields["Unfulfilled Orders Log"], ["recAAAAAAAAAAAAAA"]);
  assert.equal(unit.fields["Availability Status"], "Reserved");
  assert.equal(unit.fields["Payment Status"], "To Pay");
  assert.equal(unit.fields["Margin %"], "10%");

  const book = deps.calls.find((c) => c.kind === "book").args;
  assert.equal(book.deal, "ORD-1");
  assert.equal(book.unit.vat_type, "VAT0");
  assert.equal(book.unit.price, 150.5);
  assert.equal(book.seller.vat_id, "NL123456789B01");

  // On Discord: no mail.
  assert.equal(deps.calls.filter((c) => c.kind === "mail").length, 0);

  const label = deps.calls.find((c) => c.kind === "post");
  assert.equal(label.url, "https://updates.test/post-label-request");
  assert.equal(label.body.channel_id, "123");
  assert.equal(label.body.preferred_courier, "DHL");
  assert.equal(label.body.seller_country_code, "NL");

  assert.match(result.message, /Deal made for ORD-1: Dominicks \(SE-00035\), € 150.5 VAT0\. Inventory Unit made\. Booked in Rompslomp \(IN-9\)\. Label request posted\./);

  await assert.rejects(runAction({ key: "manual_deal", source: "store", record: record({ "Fulfillment Status": "Allocated" }), input: { seller: "SE-00035", payout: "1", vat: "Margin" }, deps }), /open order/);
});

test("Manual Deal: a seller without Discord is mailed; a marketplace seller gets no label request", async () => {
  const { completeManualDeal } = await import("../admin/manualDeal.js");
  const calls = [];
  const deps = {
    airtable: {
      byIds: async (t, ids) => new Map([[ids[0], { "Order ID": "ORD-2", SKU: "X", Size: "40" }]]),
      create: async (t, f) => ({ id: "recUNIT" }),
      select: async () => ({ records: [] })
    },
    purchases: { book: async () => { throw new Error("Rompslomp down."); } },
    sendMail: async (m) => calls.push(m),
    postJson: async () => calls.push("post"),
    discordUpdatesUrl: "https://updates.test/"
  };

  const out = await completeManualDeal({
    orderRecordId: "recORDER",
    seller: { id: "recS", fields: { "Seller ID": "SE-00537", "Full Name": "GOAT", Email: "g@example.com" } },
    payout: 99, vat: "Margin", deps
  });

  assert.equal(out.unitId, "recUNIT");
  assert.equal(out.booking, null);
  assert.match(out.notes.join(" "), /Not booked in Rompslomp: Rompslomp down\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "g@example.com");
  assert.match(calls[0].html, /ORD-2/);
  assert.doesNotMatch(calls[0].html, /\{\{/);
  assert.match(out.notes.join(" "), /No label request/);
});

test("Request Label goes through the Kickz Caviar dashboard route", async () => {
  const deps = fakeDeps();

  assert.deepEqual(availableActions("store", ["request_label"], { "Fulfillment Status": "Allocated" }), ["request_label"]);
  assert.deepEqual(availableActions("store", ["request_label"], { "Fulfillment Status": "Requested Label" }), ["request_label"]);
  assert.deepEqual(availableActions("store", ["request_label"], { "Fulfillment Status": "Ready to Ship" }), []);
  // A marketplace label was already made once it is requested.
  assert.deepEqual(availableActions("store", ["request_label"], { "Fulfillment Status": "Requested Label", Marketplace: "bol" }), []);

  await runAction({ key: "request_label", source: "store", record: record({ "Fulfillment Status": "Requested Label", "Store Name": ["UNION"] }), deps });

  assert.deepEqual(deps.calls, [{ kind: "kc", path: "/api/dashboard/request-label", body: { order_record_id: "recAAAAAAAAAAAAAA" }, which: undefined }]);
});

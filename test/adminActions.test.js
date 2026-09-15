import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS, availableActions, discordLink, runAction } from "../admin/adminActions.js";

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

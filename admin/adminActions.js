// admin/adminActions.js
//
// The buttons. Each action does what the existing flow does today, found by
// reading the services that own it - never a bare field write where the real
// flow does more:
//
//   Send Offer      store: Offer Sent? on, which the automation engine turns into
//                   the offer embed in the store's offer-requests channel
//                   (sendOfferRequestWebhook). Clearing offer_request_webhook_key
//                   makes it post again even when nothing changed.
//                   member WTB: the Kickz Caviar route the bots call,
//                   /api/member-wtb/send-current-offer-to-buyer.
//   Custom Price    Custom Offer, which Offer To Store / Offer To Buyer read first.
//                   An offer already sent is refreshed the same way as above.
//   Upload label    the WMS route the label-request page uses, which stores the
//                   PDF and moves a store order to Ready to Ship; a member WTB
//                   is forwarded by the WMS to Kickz Caviar.
//   Mark Shipped /  what the hourly tracking job does when AfterShip reports it
//   Mark Delivered  (lojiq-automation-engine trackingStatusSync): the statuses,
//                   the External Sales Log row and the same notifications.
//   Add Note        Shipping Notes. Nothing else reads it.
//   Solved          Issue Status = Solved, as the store's own button does.
//
// Every action reads the record fresh, checks it may still run, and goes into
// the action log with what it changed.

import { TABLES } from "./adminViews.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

// Kickz Caviar Discord server: claim, consignment and WTB channels live there.
const KC_DISCORD_SERVER = "922818998163361792";
const EXTERNAL_BASE = "appY9ZV7HJMYQbLUA";
const EXTERNAL_SALES_TABLE = "tbloLumvktySBlOvM";

const OPEN = ["Pending", "Outsource"];
const SHIPPABLE = ["Ready to Ship", "Fulfilled"];

class ActionError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/* ---------------- links ---------------- */

function channelUrl(id) {
  const channel = text(first(id));
  return /^\d{15,25}$/.test(channel) ? `https://discord.com/channels/${KC_DISCORD_SERVER}/${channel}` : "";
}

const webUrl = (value) => {
  const raw = text(first(value));
  return /^https?:\/\//i.test(raw) ? raw : "";
};

// Where "Discord" goes: the deal's own channel first, the same order the label
// and delay posts use to find it.
export function discordLink(source, f) {
  if (source === "store") {
    return channelUrl(f["Claimed Channel ID"]) || channelUrl(f["Consignment Created Channel ID"]) ||
      channelUrl(f["WTB Created Channel ID"]) || webUrl(f["Claim Message URL"]) || webUrl(f["Offer Message URL"]);
  }

  if (source === "mwtb") {
    return channelUrl(f["WTB Created Channel ID"]) || webUrl(f["Offer Message URL"]) || channelUrl(f["KC Offer Channel ID"]);
  }

  return "";
}

export const LINK_FIELDS = {
  store: ["Tracking URL", "Claimed Channel ID", "Consignment Created Channel ID", "WTB Created Channel ID", "Claim Message URL", "Offer Message URL"],
  mwtb: ["Tracking URL", "WTB Created Channel ID", "Offer Message URL", "KC Offer Channel ID"],
  queue: []
};

export function rowLinks(source, f) {
  return { track: webUrl(f["Tracking URL"]), discord: discordLink(source, f) };
}

/* ---------------- the actions ---------------- */

const status = (f) => text(f["Fulfillment Status"]);
const shipping = (f) => text(f["Shipping Status"]);

export const ACTIONS = {
  track: { label: "Track", kind: "link", sources: ["store", "mwtb"] },
  discord: { label: "Discord", kind: "link", sources: ["store", "mwtb"] },

  send_offer: {
    label: "Send Offer",
    sources: ["store", "mwtb"],
    needs: {
      store: ["Fulfillment Status", "Offer To Store", "Offer VAT Type", "Offer Sent?"],
      mwtb: ["Fulfillment Status", "Offer To Buyer", "Current Lowest Seller Offer", "Buyer Seller ID", "Offer Sent?"]
    },
    confirm: (source, f) =>
      source === "store"
        ? `Send the offer of € ${f["Offer To Store"]} (${text(f["Offer VAT Type"])}) to the store's offer-requests channel?${f["Offer Sent?"] ? " It was sent before; this posts it again and disables the old one." : ""}`
        : `Send the offer of € ${f["Offer To Buyer"]} to the buyer?${f["Offer Sent?"] ? " It was sent before; this posts it again and disables the old one." : ""}`,
    why(source, f) {
      if (!OPEN.includes(status(f))) return "Only open orders (Pending or Outsource) get an offer.";
      if (source === "store") {
        if (!(Number(f["Offer To Store"]) > 0)) return "There is no offer yet: no seller has offered and there is no Custom Price.";
        if (!text(f["Offer VAT Type"])) return "The offer has no VAT type yet.";
      } else {
        if (!(Number(f["Offer To Buyer"]) > 0)) return "There is no offer yet: no seller has offered and there is no Custom Price.";
        if (!first(f["Current Lowest Seller Offer"])) return "There is no seller offer to send.";
        if (!first(f["Buyer Seller ID"])) return "This want-to-buy has no buyer.";
      }
      return "";
    },
    async run({ source, record, deps }) {
      if (source === "store") {
        const fields = { "Offer Sent?": true, offer_request_webhook_key: "" };
        await deps.airtable.update(TABLES.store, record.id, fields);
        return { message: "Offer sent. The embed appears in the store's offer-requests channel within a minute.", changed: fields };
      }

      await deps.callKc("/api/member-wtb/send-current-offer-to-buyer", { member_wtb_record_id: record.id }, "portal");
      return { message: "Offer sent to the buyer.", changed: { "Offer Sent?": true } };
    }
  },

  custom_price: {
    label: "Custom Price",
    sources: ["store", "mwtb"],
    needs: { store: ["Fulfillment Status", "Custom Offer", "Offer Sent?", "Offer VAT Type"], mwtb: ["Fulfillment Status", "Custom Offer", "Offer Sent?"] },
    inputs: [{ name: "price", label: "Offer price (€), empty to remove the custom price", type: "money", required: false, prefill: "Custom Offer" }],
    note: "An offer that was already sent is sent again at this price. Not sent yet? Press Send Offer afterwards.",
    why: (source, f) => (OPEN.includes(status(f)) ? "" : "Only open orders (Pending or Outsource) can get a custom price."),
    async run({ source, record, input, deps }) {
      const raw = text(input.price).replace(",", ".");
      const price = raw === "" ? null : Number(raw);

      if (price !== null && !(Number.isFinite(price) && price > 0 && price < 100000)) {
        throw new ActionError("Enter a price above € 0, or leave it empty to remove the custom price.", 400);
      }

      const before = record.fields["Custom Offer"] ?? null;
      const wasSent = Boolean(record.fields["Offer Sent?"]);

      if (source === "store") {
        const fields = { "Custom Offer": price };
        if (wasSent) fields.offer_request_webhook_key = "";
        await deps.airtable.update(TABLES.store, record.id, fields);

        return {
          message: price === null ? "Custom price removed." : `Custom price set to € ${price}.${wasSent ? " The offer is sent again." : ""}`,
          changed: { "Custom Offer": { from: before, to: price } }
        };
      }

      await deps.airtable.update(TABLES.mwtb, record.id, { "Custom Offer": price });

      let resent = false;
      if (wasSent && price !== null) {
        await deps.callKc("/api/member-wtb/send-current-offer-to-buyer", { member_wtb_record_id: record.id }, "portal");
        resent = true;
      }

      return {
        message: price === null ? "Custom price removed." : `Custom price set to € ${price}.${resent ? " The offer is sent to the buyer again." : ""}`,
        changed: { "Custom Offer": { from: before, to: price } }
      };
    }
  },

  upload_label: {
    label: "Upload",
    sources: ["store", "mwtb"],
    upload: true,
    needs: { store: ["Fulfillment Status", "Order ID"], mwtb: ["Fulfillment Status", "Member WTB ID"] },
    inputs: [
      { name: "tracking", label: "Tracking number", type: "text", required: true },
      { name: "file", label: "Shipping label (PDF)", type: "file", accept: "application/pdf", required: true }
    ],
    why(source, f) {
      const allowed = source === "store" ? ["Allocated", "Awaiting Label", "Requested Label", "Label Error"] : ["Allocated", "Requested Label"];
      return allowed.includes(status(f)) ? "" : `A label can be uploaded while the status is ${allowed.join(", ")}.`;
    },
    async run({ source, record, input, file, deps }) {
      const tracking = text(input.tracking).replace(/\s+/g, "");

      if (!/^[A-Za-z0-9-]{6,40}$/.test(tracking)) throw new ActionError("Enter the tracking number from the label.", 400);
      if (!file || file.length < 100 || file.subarray(0, 5).toString("latin1") !== "%PDF-") {
        throw new ActionError("The label must be a PDF file.", 400);
      }

      await deps.callWms("/api/label-request-submit", {
        record_id: record.id,
        type: source === "store" ? "store_order" : "member_wtb",
        tracking_number: tracking,
        file_name: `${tracking}.pdf`,
        file_type: "application/pdf",
        file_data_url: `data:application/pdf;base64,${file.toString("base64")}`
      });

      return {
        message: source === "store"
          ? "Label uploaded. The order is Ready to Ship and the label goes to the seller's channel."
          : "Label uploaded. The want-to-buy moves to Ready to Ship and the label goes to the seller.",
        changed: { "Tracking Number": tracking, label: "uploaded" }
      };
    }
  },

  mark_shipped: {
    label: "Mark Shipped",
    sources: ["store", "mwtb"],
    needs: {
      store: ["Fulfillment Status", "Shipping Status", "Order ID", "Store Name", "Shopify Order Number", "Product Name", "Size", "SKU", "Tracking Number", "Tracking URL", "Picture", "Record ID"],
      mwtb: ["Fulfillment Status", "Shipping Status"]
    },
    confirm: () => "Mark this as shipped? Status becomes Fulfilled / Shipped and the store gets the shipped update, as when tracking picks it up.",
    why(source, f) {
      if (["Shipped", "Delivered"].includes(shipping(f))) return `It is already ${shipping(f)}.`;
      return SHIPPABLE.includes(status(f)) ? "" : "Only orders that are Ready to Ship can be marked shipped.";
    },
    async run({ source, record, deps }) {
      const fields = { "Fulfillment Status": "Fulfilled", "Shipping Status": "Shipped" };
      const table = source === "store" ? TABLES.store : TABLES.mwtb;

      await deps.airtable.update(table, record.id, fields);

      // A want-to-buy gets no shipped notification, like in the tracking job.
      if (source === "mwtb") return { message: "Marked shipped.", changed: fields };

      const notes = [];
      notes.push(await deps.updateExternalSale(record.fields["Order ID"], "Shipped"));
      notes.push(await deps.notify(deps.itemShippedUrl, itemShippedBody(record), "shipped update to the store"));

      return { message: ["Marked shipped.", ...notes.filter(Boolean)].join(" "), changed: fields };
    }
  },

  mark_delivered: {
    label: "Mark Delivered",
    sources: ["store", "mwtb"],
    needs: {
      store: ["Fulfillment Status", "Shipping Status", "Order ID", "Store Name", "Shopify Order Number", "Product Name", "SKU", "Size", "Brand", "Linked Seller ID", "Linked Inventory Unit", "Linked Item ID"],
      mwtb: ["Fulfillment Status", "Shipping Status", "Member WTB ID", "Product Name", "SKU", "Size", "Brand", "Buyer Seller ID", "Payment Status"]
    },
    confirm: () => "Mark this as delivered? Status becomes Fulfilled / Delivered and the delivered message is posted, as when tracking picks it up.",
    why(source, f) {
      if (shipping(f) === "Delivered") return "It is already delivered.";
      return SHIPPABLE.includes(status(f)) ? "" : "Only orders that are Ready to Ship or Fulfilled can be marked delivered.";
    },
    async run({ source, record, deps }) {
      const fields = { "Fulfillment Status": "Fulfilled", "Shipping Status": "Delivered" };
      const table = source === "store" ? TABLES.store : TABLES.mwtb;
      const f = record.fields;

      await deps.airtable.update(table, record.id, fields);

      const notes = [];

      if (source === "store") {
        const [seller, unit] = await Promise.all([
          deps.firstLinked("Sellers Database", f["Linked Seller ID"], ["Full Name", "Discord", "Seller ID"]),
          deps.firstLinked(TABLES.units, f["Linked Inventory Unit"], ["Item ID", "Payment Status"])
        ]);

        notes.push(await deps.notify(deps.deliveredWebhookUrl, deliveredBody(f, seller, unit), "delivered message"));
        notes.push(await deps.updateExternalSale(f["Order ID"], "Delivered"));
      } else {
        const buyer = await deps.firstLinked("Sellers Database", f["Buyer Seller ID"], ["Full Name", "Seller ID"]);
        notes.push(await deps.notify(deps.deliveredWebhookUrl, memberWtbDeliveredBody(f, buyer), "delivered message"));
      }

      return { message: ["Marked delivered.", ...notes.filter(Boolean)].join(" "), changed: fields };
    }
  },

  add_note: {
    label: "Add Note",
    sources: ["store"],
    needs: { store: ["Shipping Notes"] },
    inputs: [{ name: "note", label: "Shipping note", type: "text", required: false, prefill: "Shipping Notes", max: 250 }],
    why: () => "",
    async run({ record, input, deps }) {
      const note = text(input.note).slice(0, 250);
      const before = text(record.fields["Shipping Notes"]);

      await deps.airtable.update(TABLES.store, record.id, { "Shipping Notes": note });

      return { message: note ? "Note saved." : "Note removed.", changed: { "Shipping Notes": { from: before, to: note } } };
    }
  },

  solved: {
    label: "Solved",
    sources: ["store"],
    needs: { store: ["Issue Status"] },
    confirm: () => "Mark this issue as solved? The issue note stays on the order.",
    why: (source, f) => (text(f["Issue Status"]) === "Troubled" ? "" : "This order has no open issue."),
    async run({ record, deps }) {
      const fields = { "Issue Status": "Solved" };
      await deps.airtable.update(TABLES.store, record.id, fields);
      return { message: "Issue marked solved.", changed: fields };
    }
  }
};

/* ---------------- notification bodies (as the tracking job sends them) ---------------- */

function itemShippedBody(record) {
  const f = record.fields;

  return {
    trigger_type: "item-shipped",
    store_name: first(f["Store Name"]) || "",
    shopify_order_number: f["Shopify Order Number"] || "",
    product_name: f["Product Name"] || "",
    size: f.Size || "",
    sku: first(f.SKU) || "",
    tracking_number: f["Tracking Number"] || "",
    tracking_url: f["Tracking URL"] || "",
    picture_url: first(f.Picture)?.url || "",
    record_id: f["Record ID"] || record.id
  };
}

function deliveredBody(f, seller, unit) {
  const itemId = first(f["Linked Item ID"]) || first(unit?.["Item ID"]) || "";
  const consignment = String(itemId).includes("CS-");
  const sellerField = consignment
    ? { name: "Seller Name:", value: seller?.["Full Name"] || "Unknown" }
    : { name: "Seller Discord:", value: seller?.Discord || "Unknown" };

  return {
    embeds: [{
      title: "📦 ITEM DELIVERED!",
      description: `**${f["Product Name"] || ""}**\n${first(f.SKU) || ""}\n${f.Size || ""}\n${f.Brand || ""}`,
      color: 16776960,
      fields: [
        { name: "Store:", value: first(f["Store Name"]) || "Unknown", inline: false },
        { name: "Order ID:", value: f["Order ID"] || "", inline: true },
        { name: "Shopify Order:", value: f["Shopify Order Number"] || "", inline: true },
        { name: "​", value: "​", inline: false },
        { ...sellerField, inline: true },
        { name: "Seller ID:", value: seller?.["Seller ID"] || "Unknown", inline: true },
        { name: "Payment Status:", value: unit?.["Payment Status"] || "Unknown", inline: false }
      ]
    }]
  };
}

function memberWtbDeliveredBody(f, buyer) {
  return {
    embeds: [{
      title: "📦 MEMBER WTB DELIVERED!",
      description: `**${f["Product Name"] || ""}**\n${first(f.SKU) || ""}\n${f.Size || ""}\n${f.Brand || ""}`,
      color: 16776960,
      fields: [
        { name: "Buyer:", value: buyer?.["Full Name"] || "Unknown", inline: false },
        { name: "Member WTB:", value: f["Member WTB ID"] || "", inline: true },
        { name: "Buyer ID:", value: buyer?.["Seller ID"] || "Unknown", inline: true },
        { name: "​", value: "​", inline: false },
        { name: "Payment Status:", value: f["Payment Status"] || "Unknown", inline: false }
      ]
    }]
  };
}

/* ---------------- running one ---------------- */

export function actionFields(source, keys) {
  const fields = new Set(["Fulfillment Status"]);

  for (const key of keys) {
    for (const field of ACTIONS[key]?.needs?.[source] || []) fields.add(field);
    for (const input of ACTIONS[key]?.inputs || []) if (input.prefill) fields.add(input.prefill);
  }

  if (source === "queue") fields.delete("Fulfillment Status");

  return [...fields];
}

// Which of a view's actions this record can use right now.
export function availableActions(source, keys, fields) {
  return keys.filter((key) => {
    const action = ACTIONS[key];
    if (!action || !action.sources.includes(source)) return false;
    if (action.kind === "link") return Boolean(rowLinks(source, fields)[key]);
    return !action.why(source, fields);
  });
}

// What the page needs to draw a button and its dialog.
export function publicActions() {
  return Object.fromEntries(
    Object.entries(ACTIONS).map(([key, a]) => [
      key,
      {
        label: a.label,
        kind: a.kind || (a.inputs ? "form" : "confirm"),
        upload: Boolean(a.upload),
        note: a.note || "",
        inputs: (a.inputs || []).map(({ name, label, type, required, accept, max }) => ({ name, label, type, required: Boolean(required), accept, max }))
      }
    ])
  );
}

// The dialog text for one record, filled in with its own values.
export function describeAction(key, source, record) {
  const action = ACTIONS[key];
  const f = record.fields;

  return {
    confirm: action.confirm ? action.confirm(source, f) : "",
    prefill: Object.fromEntries((action.inputs || []).filter((i) => i.prefill).map((i) => [i.name, f[i.prefill] ?? ""])),
    blocked: action.why(source, f)
  };
}

export async function runAction({ key, source, record, input = {}, file = null, deps }) {
  const action = ACTIONS[key];

  if (!action || action.kind === "link" || !action.sources.includes(source)) throw new ActionError("This button does not exist here.", 404);

  const blocked = action.why(source, record.fields);
  if (blocked) throw new ActionError(blocked);

  for (const spec of action.inputs || []) {
    if (spec.type === "file") continue;
    if (spec.required && !text(input[spec.name])) throw new ActionError(`Fill in: ${spec.label}.`, 400);
  }

  return action.run({ source, record, input, file, deps });
}

export { ActionError, EXTERNAL_BASE, EXTERNAL_SALES_TABLE };

// admin/manualDeal.js
//
// What happens after Manual Deal, done right away instead of by Make
// ("Phase 10.1.2: Create Inventory Unit + Expenses (Order Processing)",
// which picked the approved Order Processing Form up within 15 minutes).
//
//   1. the Inventory Unit: the pair bought from the seller, Reserved for the
//      order, To Pay
//   2. the purchase booked in Rompslomp, the way External Sales books one
//      (admin/purchaseExpense.js: same company, Voorraad | Scout, supplier
//      found by Seller ID or made)
//   3. a seller without Discord gets the Deal Confirmation mail
//   4. the label request in the store's Discord channel (not for the
//      marketplace sellers, whose label comes from the marketplace)
//
// The self-billing invoice is not made here: the sweep in
// admin/selfBillingDocuments.js finds every new unit with a seller and a
// price within minutes.
//
// Steps 2-4 never undo step 1: a unit without a booking is said in the
// result, and the booking can be made by hand, as with Make's failures.

import { readFileSync } from "node:fs";

const text = (value) => (value === null || value === undefined ? "" : String(Array.isArray(value) ? value[0] ?? "" : value).trim());

// Sellers that are a marketplace or a supplier with its own label: no label
// request for them (Make's "If not GOAT or StockX" filter).
export const NO_LABEL_REQUEST = new Set(["SE-00537", "SE-00309", "SE-00930", "SE-00469", "SE-00467", "SE-00455"]);

export const SELLER_FIELDS = [
  "Seller ID", "Full Name", "Company Name", "Email", "Address", "Zipcode", "City",
  "Country Code", "VAT ID", "Discord ID"
];

export const ORDER_FIELDS = [
  "Order ID", "Product Name", "Brand", "SKU", "Size", "Shopify Order Number",
  "Shopify Product Name", "Store Name", "Client Label Request Channel ID"
];

const MAIL_TEMPLATE = readFileSync(new URL("./dealConfirmationMail.html", import.meta.url), "utf8");

const amsterdamDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(date);

const escapeHtml = (value) =>
  text(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function dealConfirmationHtml({ fullName, sellerId, orderId, sku, size, payout, date }) {
  const values = { fullName, sellerId, orderId, sku, size, payout, date };
  return MAIL_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, name) => escapeHtml(values[name]));
}

// The unit, field for field as Make made it.
export function unitFields({ order, orderId, sellerRecordId, payout, vat, purchaseDate }) {
  const f = order.fields || {};
  return {
    "Seller ID": [sellerRecordId],
    "Product Name": text(f["Product Name"]),
    Source: "Outsourced",
    Type: "Custom",
    "Selling Method": "Plug & Play",
    "Unfulfilled Orders Log": [order.id],
    "Margin %": "10%",
    "Purchase Price": payout,
    "Availability Status": "Reserved",
    "Payment Note": String(payout),
    "VAT Type": vat,
    "Shipping Deduction": 0,
    "Base Costs": 5,
    "Payment Status": "To Pay",
    Brand: text(f.Brand),
    "Purchase Date": purchaseDate,
    "Verification Status": "Verified",
    "Ticket Number": orderId,
    SKU: text(f.SKU),
    Size: text(f.Size)
  };
}

export function labelRequestBody({ order, sellerCountry, route }) {
  const f = order.fields || {};
  return {
    channel_id: text(f["Client Label Request Channel ID"]),
    record_id: order.id,
    order_id: text(f["Order ID"]),
    shopify_order_number: text(f["Shopify Order Number"]),
    product_name: text(f["Shopify Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    store_name: text(f["Store Name"]),
    label_request_url: `https://lojiq-wms.onrender.com/label-request.html?record_id=${order.id}`,
    seller_country_code: sellerCountry,
    preferred_courier: text(route?.["Preferred Courier"]),
    courier_instruction: text(route?.["Instruction Text"])
  };
}

/*
 * deps:
 *   airtable     the admin's Airtable client (select/create/byIds)
 *   purchases    createPurchaseExpense, or null when Rompslomp is not set up
 *   sendMail     ({ to, from, subject, html }) => sends through SendGrid
 *   mailFrom     the verified sender address
 *   postJson     (url, body) => POST that throws on a non-2xx answer
 *   discordUpdatesUrl  base of airtable-discord-updates, ending in "/"
 */
export async function completeManualDeal({ orderRecordId, seller, payout, vat, deps, now = new Date() }) {
  const notes = [];
  const sf = seller.fields || {};
  const sellerId = text(sf["Seller ID"]);

  const order = {
    id: orderRecordId,
    fields: (await deps.airtable.byIds("Unfulfilled Orders Log", [orderRecordId], ORDER_FIELDS)).get(orderRecordId) || {}
  };
  const orderId = text(order.fields["Order ID"]);

  // 1. The unit. Without it nothing else makes sense, so this one may fail
  // the whole action.
  const unit = await deps.airtable.create(
    "Inventory Units",
    unitFields({ order, orderId, sellerRecordId: seller.id, payout, vat, purchaseDate: amsterdamDate(now) })
  );

  // 2. The purchase in Rompslomp.
  let booking = null;
  if (!deps.purchases) {
    notes.push("Not booked in Rompslomp: Rompslomp is not configured on this service.");
  } else {
    try {
      booking = await deps.purchases.book({
        unit: {
          record_id: unit.id,
          product_name: text(order.fields["Product Name"]),
          size: text(order.fields.Size),
          vat_type: vat,
          price: payout
        },
        seller: {
          seller_id: sellerId,
          company_name: text(sf["Company Name"]),
          full_name: text(sf["Full Name"]),
          email: text(sf.Email),
          address: text(sf.Address),
          zipcode: text(sf.Zipcode),
          city: text(sf.City),
          country_code: text(sf["Country Code"]),
          vat_id: vatNumber(sf)
        },
        deal: orderId
      });
    } catch (err) {
      console.error("[manual-deal] booking failed", orderId, err.message);
      notes.push(`Not booked in Rompslomp: ${err.message} Book "Purchase Order ${orderId}" by hand.`);
    }
  }

  // 3. A seller who is not on Discord hears about the deal by mail.
  if (!text(sf["Discord ID"])) {
    if (!deps.sendMail || !text(sf.Email)) {
      notes.push("No deal confirmation mailed: the seller has no Discord and no email we can send to.");
    } else {
      try {
        await deps.sendMail({
          to: text(sf.Email),
          // The verified sender of this SendGrid account; Make sent from
          // server@kickzcaviar.nl through its own connection.
          from: { email: deps.mailFrom || "noreply@kickzcaviar.nl", name: "Payout by Kickz Caviar" },
          subject: "💰 Deal Confirmation",
          html: dealConfirmationHtml({
            fullName: text(sf["Full Name"]) || text(sf["Company Name"]),
            sellerId,
            orderId,
            sku: text(order.fields.SKU),
            size: text(order.fields.Size),
            payout: String(payout),
            date: amsterdamDate(now).split("-").reverse().join("-")
          })
        });
        notes.push(`Deal confirmation mailed to ${text(sf.Email)}.`);
      } catch (err) {
        console.error("[manual-deal] mail failed", orderId, err.message);
        notes.push(`The deal confirmation mail could not be sent: ${err.message}`);
      }
    }
  }

  // 4. The label request in the store's channel.
  if (NO_LABEL_REQUEST.has(sellerId)) {
    notes.push("No label request (marketplace or supplier seller).");
  } else if (!deps.discordUpdatesUrl) {
    notes.push("No label request: the Discord updates address is not configured here.");
  } else {
    try {
      const country = text(sf["Country Code"]);
      const { records: routes } = await deps.airtable.select("Label Request Routing", {
        formula: `{Country Code} = '${country.replace(/'/g, "\\'")}'`,
        fields: ["Preferred Courier", "Instruction Text"],
        pageSize: 1,
        maxRecords: 1
      });
      await deps.postJson(
        `${deps.discordUpdatesUrl}post-label-request`,
        labelRequestBody({ order, sellerCountry: country, route: routes?.[0]?.fields })
      );
      notes.push("Label request posted.");
    } catch (err) {
      console.error("[manual-deal] label request failed", orderId, err.message);
      notes.push(`The label request could not be posted: ${err.message}`);
    }
  }

  return { unitId: unit.id, booking, notes };
}

// Make's rule: a company whose VAT ID lacks the country prefix got it put in
// front; a private seller has no VAT number in Rompslomp.
export function vatNumber(sf) {
  const vat = text(sf["VAT ID"]).replace(/\s+/g, "");
  if (!vat || !text(sf["Company Name"])) return "";
  const country = text(sf["Country Code"]).toUpperCase();
  return country && !vat.toUpperCase().startsWith(country) ? `${country}${vat}` : vat;
}

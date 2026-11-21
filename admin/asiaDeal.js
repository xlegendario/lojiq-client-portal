// admin/asiaDeal.js
//
// The deal for an order the Asia partner (the Dewu supplier) takes on.
// The Kickz Caviar portal runs the partner's side - the offer in Discord,
// his price, the store's answer - and asks for this once the deal is
// certain:
//
//   POST /api/internal/asia/deal   x-kc-secret
//     { order_record_id, payout, store_price }
//
// It does what Manual Deal does (admin/manualDeal.js), on the Dewu
// supplier, Margin: the store's price as an accepted Custom Offer, the
// approved Order Processing Form, the unit, the purchase in Rompslomp and
// the Deal Confirmation mail.

import express from "express";
import { completeManualDeal, SELLER_FIELDS } from "./manualDeal.js";

const text = (value) => (value === null || value === undefined ? "" : String(Array.isArray(value) ? value[0] ?? "" : value).trim());

// Where an order can still get its Asia deal: waiting on the partner,
// accepted by the store, or back in the open.
export const ASIA_DEAL_STATUSES = ["Dewu Processing", "Confirmed", "Outsource", "Claim Processing"];

export class AsiaDealError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const money = (value) => {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
};

export async function makeAsiaDeal({ input, deps }) {
  const orderRecordId = text(input.order_record_id);
  const payout = money(input.payout);
  const storePrice = money(input.store_price);

  if (!/^rec[A-Za-z0-9]{14}$/.test(orderRecordId)) throw new AsiaDealError("order_record_id is not a record id.");
  if (payout === null) throw new AsiaDealError("payout must be a price above € 0.");
  if (storePrice === null) throw new AsiaDealError("store_price must be a price above € 0.");
  if (storePrice < payout) throw new AsiaDealError("The store would pay less than we pay the partner.");

  const order = (await deps.airtable.byIds("Unfulfilled Orders Log", [orderRecordId], ["Order ID", "Fulfillment Status", "Linked Inventory Unit"])).get(orderRecordId);
  if (!order) throw new AsiaDealError("Order not found.", 404);

  // Asked twice (a retry after a timeout): the first one made the pair.
  const unit = text(order["Linked Inventory Unit"]);
  if (unit) throw new AsiaDealError("The order already has a pair.", 409, { unit_id: unit });

  const status = text(order["Fulfillment Status"]);
  if (!ASIA_DEAL_STATUSES.includes(status)) throw new AsiaDealError(`The order is on ${status || "no status"}; no deal is made on it.`, 409);

  const { records } = await deps.airtable.select("Sellers Database", {
    formula: "{Dewu Supplier?} = 1",
    fields: SELLER_FIELDS,
    pageSize: 1,
    maxRecords: 1
  });
  const seller = records[0];
  if (!seller) throw new AsiaDealError("No seller is marked Dewu Supplier? in the Sellers Database.", 503);

  await deps.airtable.update("Unfulfilled Orders Log", orderRecordId, {
    "Custom Offer": storePrice,
    "Offer Accepted?": true,
    "Offer Denied?": false
  });

  const form = await deps.airtable.create("Order Processing Form", {
    "Linked Order ID": [orderRecordId],
    "Linked Seller ID": [seller.id],
    "Payout (€)": payout,
    "VAT Type": "Margin",
    Agreement: true,
    "Approved?": true
  });

  const deal = await completeManualDeal({ orderRecordId, seller, payout, vat: "Margin", deps });

  return {
    order_id: text(order["Order ID"]),
    seller_id: text(seller.fields?.["Seller ID"]),
    order_processing_form: form.id,
    unit_id: deal.unitId,
    rompslomp_expense: deal.booking?.expense_id || null,
    notes: deal.notes
  };
}

export function mountAsiaDeal(router, { deps, internalSecret = "" }) {
  router.post("/api/internal/asia/deal", express.json({ limit: "5kb" }), async (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) return res.status(401).json({ error: "Unauthorized" });

    try {
      const made = await makeAsiaDeal({ input: req.body || {}, deps });
      console.log(`[asia deal] ${made.order_id}: unit ${made.unit_id} for ${made.seller_id}. ${made.notes.join(" ")}`);
      res.json({ ok: true, ...made });
    } catch (err) {
      const status = err instanceof AsiaDealError ? err.status : 500;
      if (status >= 500) console.error("[asia deal]", err.message);
      res.status(status).json({ error: err.message, ...(err.extra || {}) });
    }
  });
}

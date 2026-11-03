// admin/returns.js
//
// Every pair that comes off a sale, in one list (Supabase `returns`), and the
// one road it takes back into stock or out of the books. Agreed with Dario on
// 02-11-2026; the rules below are his.
//
// The whole flow is written out in the doc "Cancel- en retourflow"
// (03-11-2026). A cancel asks two questions:
//
//   What happens to the order?
//     cancel   the buyer no longer wants it: Cancelled, or Returned
//     keep     we find another pair: back to Outsource, the invoice fields
//              cleared and Retry Invoice ticked, so the new pair is invoiced
//
//   Was the pair shipped?  No, not shipped yet -> what happens to this pair?
//     consignor_has   back in his consignment stock   Void, Cancelled, not owed
//     consignor_gone  the seller does not have it     Void, Cancelled, not owed
//     flawed          the seller's pair is flawed     Void, Rejected, not owed
//     warehouse       in our warehouse, and then:
//        keep         back on sale                    the seller is paid
//        send_back    back to the seller, his label   Inactive, Rejected, not owed
//        troubled     flawed, we keep it              Troubled, the seller is paid
//     partner         back on the partner's shelf     Void, Cancelled, not owed
//     lost            lost here                       Lost, the seller is paid
//
//   Yes -> what happens to this pair?
//     return          comes back; the WMS scan decides (OK or flaw, and for a
//                     seller's pair: keep it or send it back)
//     store_consign   stays at the buyer, Available with a Location
//     lost            lost by the carrier             Lost
//     written_off     the buyer keeps it              Void, Written Off
//
// The books follow every cancel, in three layers, and everything that can be
// booked is booked here - Dario only links payments (03-11-2026):
//   buyer    the sales invoice credited (only this order's line on a
//            collective one); unpaid -> a pair on Kruisposten, paid -> a refund
//   seller   an undone purchase credited; unpaid -> a pair on Kruisposten,
//            paid -> a refund to claim
//   stock    the stock correction reversed when the pair is back with us or
//            the seller; a pair that is gone moves to Voorraadverschillen
//
// What is left for a person is a `todo` on the return, shown on the Returns
// tab until it is ticked off. A pair going back to its seller is tracked on
// the return itself (seller_return_status).

import { creditInvoiceBody } from "./externalSalesInvoicing.js";
import { invoicePlan, pickContact } from "./adminCollectiveInvoices.js";
import { conditionWith } from "./externalSalesCancel.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const enc = (value) => encodeURIComponent(text(value));
const quote = (value) => text(value).replace(/'/g, "\\'");

export class ReturnsError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export const ORDERS = "Unfulfilled Orders Log";
export const WTBS = "Member WTBs";
export const UNITS = "Inventory Units";

export const ORDER_FIELDS = [
  "Order ID", "Fulfillment Status", "Shipping Status", "Store Name", "Client", "Linked Inventory Unit",
  "SKU", "Size", "Product Name", "Shopify Product Name", "Picture", "VAT Type", "Client Country",
  "Rompslomp Invoice ID", "Rompslomp Invoice Number", "Rompslomp Journal Entry ID", "Rompslomp Credit Invoice Number",
  "Bookkeeping Status", "Invoice Status", "Order Source", "Marketplace Sale ID", "Shopify Order Number",
  "Final Buying Price", "Created Time", "Fulfilment Date"
];

export const WTB_FIELDS = [
  "Member WTB ID", "Fulfillment Status", "Shipping Status", "Linked Inventory Unit", "SKU", "Size",
  "Product Name", "Invoice Sent?", "Payment Status", "Final Buying Price"
];

export const UNIT_FIELDS = [
  "Item ID", "Type", "Source", "Availability Status", "Payment Status", "Payment Note", "Purchase Price",
  "Final Purchase Price", "Final Purchase Price (ex. VAT)", "Seller ID", "Seller ID (Lookup)", "Seller Name",
  "Item Condition", "Cancel Status", "Location", "SKU", "Size", "Product Name", "Brand", "Product GTIN", "VAT Type",
  "Picture", "Purchase Date"
];

// Fulfillment statuses an order can be cancelled from: it has a pair.
export const CANCELLABLE = [
  "Confirmed", "Allocated", "Found", "Found & Tracked", "Awaiting Label", "Requested Label", "Label Error",
  "Ready to Ship", "Fulfilled", "Store Fulfilled"
];

export const ORDER_ACTIONS = {
  cancel: "Cancel the order - the buyer no longer wants it",
  keep: "Keep the order, find another pair"
};

// Not shipped yet: what happens to this pair? (wording Dario's, 03-11-2026)
export const HELD = {
  consignor_has: "Consignor has the pair, add back to consignment",
  consignor_gone: "Seller doesn't have it, void pair",
  flawed: "Pair is flawed, void pair",
  warehouse: "In our warehouse",
  partner: "Partner pair, here - back on the partner's shelf",
  lost: "Lost here - the seller is still paid"
};

// In our warehouse: and then?
export const IN_WAREHOUSE = {
  keep: "Keep it, back on sale",
  send_back: "Send it back to the seller - he sends the label",
  troubled: "It has a flaw, we keep it - Troubled Stock"
};

// Shipped: what happens to this pair?
export const OUTCOMES = {
  return: "It comes back to us - scan it when it arrives",
  store_consign: "The buyer keeps it to sell for us (Store Consign)",
  lost: "Lost by the carrier",
  written_off: "The buyer keeps it - write it off"
};

// A pair on its way back to its seller, who sends the label and pays for it.
export const SELLER_RETURN = {
  label_requested: "Label requested",
  label_received: "Label received",
  shipped: "Shipped",
  delivered: "Delivered"
};

// The todo kinds per list on the Returns tab.
export const TODO_LISTS = {
  refunds_buyers: ["refund_store", "marketplace_settle"],
  refunds_sellers: ["claim_seller"],
  rompslomp: ["link_kruispost", "credit_by_hand", "journal_by_hand", "credit_purchase", "move_payment", "credit_invoice"]
};

// Kickz Caviar B.V.'s stock and the account a pair that is gone moves to.
const STOCK_ACCOUNT = { id: 1981496874, path: "activa.current_assets.voorraad_scout_custom" };
const SHRINK_ACCOUNT = { id: 2146917640, path: "profit.costs.voorraad_mutatie_custom" };

// Whose pair the unit is, which decides who is owed what.
export function ownerOf(unit = {}) {
  const type = text(unit.Type);
  if (type === "Partner Consignment") return "partner";
  if (["Consignment", "Direct"].includes(type) || /^(CS|OUT)-/.test(text(unit["Item ID"]))) {
    // A unit with a seller on it that we still owe, or have paid: a seller's.
    if (text(first(unit["Seller ID (Lookup)"]))) return "seller";
  }
  return "own";
}

const ddmmyyyy = (when = new Date()) => when.toISOString().slice(0, 10).split("-").reverse().join("-");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());

const todo = (textValue, kind = "") => ({ id: Math.random().toString(36).slice(2, 10), kind, text: textValue, done: false });

/*
 * deps:
 *   db          createSupabaseRest
 *   airtable    select, byIds, update (admin/adminRouter.js)
 *   rompslomp   createRompslomp, the company the sales invoices are in
 *   purchases   createPurchaseExpense, the company the purchases are in
 *   meta        () -> Location choices (optional)
 */
export function createReturns({ db, airtable, rompslomp = null, purchases = null, locations = null }) {
  /* ---------------- reading ---------------- */

  async function orderOf(table, id) {
    const fields = table === "mwtb" ? WTB_FIELDS : ORDER_FIELDS;
    const found = await airtable.byIds(table === "mwtb" ? WTBS : ORDERS, [id], fields);
    if (!found.has(id)) throw new ReturnsError("That order no longer exists.", 404);
    return { id, table, fields: found.get(id) };
  }

  async function unitOf(order) {
    const unitId = text(first(order.fields["Linked Inventory Unit"]));
    if (!unitId) return null;
    const found = await airtable.byIds(UNITS, [unitId], UNIT_FIELDS);
    return found.has(unitId) ? { id: unitId, fields: found.get(unitId) } : null;
  }

  async function merchantOf(order) {
    const id = text(first(order.fields.Client));
    if (!id) return null;
    const found = await airtable.byIds("Merchants", [id], ["Store Name", "Country", "Rompslomp Contact ID"]);
    return found.has(id) ? { id, ...found.get(id) } : null;
  }

  const orderLabel = (order) => text(order.fields["Order ID"]) || text(order.fields["Member WTB ID"]) || order.id;

  async function openReturnFor(unitId, orderId) {
    const clauses = [];
    if (unitId) clauses.push(`inventory_unit_record_id.eq.${unitId}`);
    if (orderId) clauses.push(`order_record_id.eq.${orderId}`);
    if (!clauses.length) return null;
    const rows = await db.get(`returns?select=*&status=in.(to_decide,expected,received)&or=(${clauses.join(",")})&limit=1`);
    return rows[0] || null;
  }

  async function getReturn(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id))) throw new ReturnsError("Unknown return.", 404);
    const [row] = await db.get(`returns?select=*&id=eq.${text(id)}`);
    if (!row) throw new ReturnsError("That return no longer exists.", 404);
    return row;
  }

  async function saveReturn(id, fields) {
    const [row] = await db.patch(`returns?id=eq.${id}`, { ...fields, updated_at: new Date().toISOString() });
    return row;
  }

  function snapshot(order, unit, merchant) {
    const o = order.fields;
    const u = unit?.fields || {};
    const picture = Array.isArray(u.Picture) && u.Picture[0] ? u.Picture[0].thumbnails?.small?.url || u.Picture[0].url : "";
    const pictureOrder = Array.isArray(o.Picture) && o.Picture[0] ? o.Picture[0].thumbnails?.small?.url || o.Picture[0].url : "";

    return {
      order_table: order.table,
      order_record_id: order.id,
      order_id: orderLabel(order),
      store_name: text(first(o["Store Name"])) || text(merchant?.["Store Name"]) || null,
      marketplace_order_id: text(o["Marketplace Sale ID"]) || null,
      shopify_order_number: text(o["Shopify Order Number"]) || null,
      inventory_unit_record_id: unit?.id || null,
      item_id: text(u["Item ID"]) || null,
      sku: text(first(u.SKU)) || text(first(o.SKU)) || null,
      size: text(u.Size) || text(o.Size) || null,
      product_name: text(u["Product Name"]) || text(o["Product Name"]) || text(o["Shopify Product Name"]) || null,
      ean: text(first(u["Product GTIN"])) || null,
      image_url: picture || pictureOrder || null,
      seller_id: text(first(u["Seller ID (Lookup)"])) || null,
      seller_name: text(first(u["Seller Name"])) || null,
      unit_type: text(u.Type) || null,
      purchase_price: Number.isFinite(Number(u["Purchase Price"])) ? round2(u["Purchase Price"]) : null
    };
  }

  /* ---------------- locations ---------------- */

  let locationCache = { at: 0, list: [] };

  async function locationChoices() {
    if (Date.now() - locationCache.at < 10 * 60_000 && locationCache.list.length) return locationCache.list;

    let list = [];
    if (locations) list = await locations().catch(() => []);

    // Without the schema: whatever the units already carry.
    if (!list.length) {
      const seen = new Set();
      let offset = "";
      let calls = 0;
      do {
        const page = await airtable.select(UNITS, { formula: "NOT({Location} = BLANK())", fields: ["Location"], pageSize: 100, offset });
        for (const r of page.records) if (text(r.fields?.Location)) seen.add(text(r.fields.Location));
        offset = page.offset;
        calls += 1;
      } while (offset && calls < 10);
      list = [...seen];
    }

    locationCache = { at: Date.now(), list: list.sort((a, b) => a.localeCompare(b)) };
    return locationCache.list;
  }

  /* ---------------- the books ---------------- */

  /*
   * The sales invoice this order is on: the id the engine wrote, or for the
   * ones Make made before it, the invoice of this store whose description is
   * the order number.
   */
  async function salesInvoiceOf(order, merchant) {
    if (!rompslomp?.configured) return null;
    const o = order.fields;
    const orderId = orderLabel(order);

    let invoice = null;
    if (text(o["Rompslomp Invoice ID"])) invoice = await rompslomp.getInvoice(text(o["Rompslomp Invoice ID"])).catch(() => null);

    if (!invoice && order.table === "store" && merchant && text(o["Bookkeeping Status"]) !== "To book – marketplace") {
      let contactId = text(merchant["Rompslomp Contact ID"]);
      if (!contactId && text(merchant["Store Name"])) {
        const contact = pickContact(await rompslomp.searchContacts(text(merchant["Store Name"])).catch(() => []), text(merchant["Store Name"]));
        contactId = contact ? String(contact.id) : "";
      }
      if (contactId) {
        const list = await rompslomp.invoicesOfContact(contactId).catch(() => []);
        const hit = list.find((inv) => text(inv.description) === orderId && Number(inv.price_with_vat) > 0);
        if (hit) invoice = await rompslomp.getInvoice(hit.id).catch(() => null);
      }
    }

    if (!invoice) return null;

    const lines = invoice.invoice_lines || [];
    // One order per invoice, or this order's line on a collective one.
    const whole = lines.length <= 1 || text(invoice.description) === orderId;
    const line = whole ? null : lines.find((l) => text(l.extended_description).includes(orderId) || text(l.description).includes(orderId));

    if (!whole && !line) return { invoice, whole: false, line: null, missing: true };
    return { invoice, whole, line };
  }

  async function kruispostSales({ amount, original, credit, deal }) {
    // Their account list comes a hundred at a time; Kruisposten of Kickz
    // Caviar B.V. is known, so a long list never hides it.
    const account = (await rompslomp.accounts().catch(() => [])).find((row) => text(row.name).toLowerCase() === "kruisposten") ||
      (String(rompslomp.companyId) === "1296508534" ? { id: 950141831, path: "activa.liquid_assets.kruisposten_custom" } : null);
    if (!account) throw new ReturnsError("Rompslomp has no account called Kruisposten.", 502);

    const value = round2(Math.abs(amount));
    const paidAt = today();

    for (const [sign, document] of [[1, original], [-1, credit]]) {
      await rompslomp.createPayment({
        amount: sign * value,
        description: `Kruispost ${deal}: ${document} (factuur ${original} tegen credit ${credit})`,
        accountId: account.id,
        accountPath: account.path,
        paidAt
      });
    }
  }

  // One journal entry, made once: found back by its description.
  async function journalOnce({ description, amount, debit, credit }) {
    const existing = (await rompslomp.recentJournals(2).catch(() => [])).find((j) => text(j.description) === description);
    if (existing) return false;
    await rompslomp.createJournal({
      journal_entry: {
        description,
        date: today(),
        lines: [
          { account_id: debit.id, account_path: debit.path, debit_amount: String(amount), credit_amount: null },
          { account_id: credit.id, account_path: credit.path, debit_amount: null, credit_amount: String(amount) }
        ]
      }
    });
    return true;
  }

  /*
   * Credit what this order was invoiced, and put its stock where the pair
   * now is: back into stock when it is with us or the seller again, onto
   * Voorraadverschillen when it is gone (lost, or kept by the buyer). Safe to
   * run twice: the credit is found back by its api_reference, the journals by
   * their description.
   */
  async function creditSale(order, unit, merchant, { stockBack, gone = false, log, todos }) {
    const o = order.fields;
    const orderId = orderLabel(order);

    if (text(o["Rompslomp Credit Invoice Number"])) {
      log.push(`Already credited: ${text(o["Rompslomp Credit Invoice Number"])}.`);
      return;
    }

    // Member WTBs have no invoice flow yet (Dario, 03-11-2026).
    if (order.table === "mwtb") {
      if (o["Invoice Sent?"]) todos.push(todo(`Credit the invoice of ${orderId} in Rompslomp by hand: Member WTB invoices are not linked to the order.`, "credit_by_hand"));
      return;
    }

    const bookkeeping = text(o["Bookkeeping Status"]);
    const found = await salesInvoiceOf(order, merchant).catch((err) => {
      todos.push(todo(`The invoice of ${orderId} could not be looked up (${err.message}). Credit it by hand if there is one.`, "credit_by_hand"));
      return undefined;
    });
    if (found === undefined) return;

    if (!found) {
      // Nothing invoiced: a marketplace sale or a self-billing pair is simply
      // taken off the list it was waiting on.
      if (!bookkeeping || ["To book – marketplace", "Awaiting self-billing"].includes(bookkeeping)) {
        await airtable.update(ORDERS, order.id, { "Bookkeeping Status": "Cancelled" }, { typecast: true });
        log.push(bookkeeping ? `Not invoiced (${bookkeeping}): Bookkeeping Status is now Cancelled.` : "Not invoiced: nothing to credit.");
        if (gone && unit) todos.push(todo(`${orderId} was never invoiced, so no stock correction took ${text(unit.fields["Item ID"])} off stock: book it from Voorraad Scout to Voorraadverschillen by hand.`, "journal_by_hand"));
      } else {
        todos.push(todo(`${orderId} is "${bookkeeping}" but no invoice was found in Rompslomp. Credit it by hand.`, "credit_by_hand"));
      }
      return;
    }

    if (found.missing) {
      todos.push(todo(`${orderId} is on ${found.invoice.invoice_number} but its line was not recognised. Credit that line by hand.`, "credit_by_hand"));
      return;
    }

    const original = found.whole ? found.invoice : { ...found.invoice, invoice_lines: [found.line] };
    const reference = `credit-${found.invoice.id}-${order.id}`;

    let credit = await rompslomp.findInvoice(reference);
    if (!credit) {
      const body = creditInvoiceBody({ original, reference });
      if (!found.whole) body.sales_invoice.description = `Creditfactuur voor factuur: ${found.invoice.invoice_number} (${orderId})`;
      credit = await rompslomp.createInvoice(body);
    }
    if (credit.status !== "published" || !credit.invoice_number) credit = await rompslomp.publishInvoice(credit.id);

    await airtable.update(ORDERS, order.id, { "Rompslomp Credit Invoice Number": text(credit.invoice_number) });
    log.push(`${credit.invoice_number} credits ${found.whole ? found.invoice.invoice_number : `the ${orderId} line of ${found.invoice.invoice_number}`}.`);

    // The stock correction back, for a pair that is ours again.
    if (stockBack && unit) {
      const plan = invoicePlan({ vatType: first(o["VAT Type"]), storeCountry: merchant?.Country, clientCountry: first(o["Client Country"]) });
      const cost = plan ? round2(unit.fields[plan.costAmountField]) : 0;
      const description = `Voorraadcorrectie ${credit.invoice_number}`;

      if (plan && cost > 0) {
        await journalOnce({ description, amount: cost, debit: STOCK_ACCOUNT, credit: { id: plan.costAccountId, path: plan.costAccountPath || "profit.costs.sneakers_custom" } });
        log.push(`${description}: € ${cost.toFixed(2)} back into stock.`);
      } else {
        todos.push(todo(`Book the stock of ${orderId} back by hand: no purchase price to reverse the Voorraadcorrectie with.`, "journal_by_hand"));
      }
    } else if (gone && unit) {
      /*
        The pair is gone and nothing was sold: its cost does not belong on
        the cost of sales (for a margin pair that would shrink the margin
        VAT), but on Voorraadverschillen.
      */
      const plan = invoicePlan({ vatType: first(o["VAT Type"]), storeCountry: merchant?.Country, clientCountry: first(o["Client Country"]) });
      const cost = plan ? round2(unit.fields[plan.costAmountField]) : 0;
      const description = `Voorraadverschillen ${credit.invoice_number}`;

      if (plan && cost > 0) {
        await journalOnce({ description, amount: cost, debit: SHRINK_ACCOUNT, credit: { id: plan.costAccountId, path: plan.costAccountPath || "profit.costs.sneakers_custom" } });
        log.push(`${description}: € ${cost.toFixed(2)} from the cost of sales to Voorraadverschillen, the pair is gone.`);
      } else {
        todos.push(todo(`Book the cost of ${orderId} to Voorraadverschillen by hand: no purchase price on the unit.`, "journal_by_hand"));
      }
    } else if (!stockBack) {
      log.push("The stock correction stays: the pair is gone.");
    } else {
      // No unit on the order any more (moved to a new sale by hand): the cost
      // to put back is not known here.
      todos.push(todo(`Book the stock of ${orderId} back by hand (Voorraadcorrectie ${credit.invoice_number}): the order has no unit to take the purchase price from.`, "journal_by_hand"));
    }

    // No money moved for either document: a matching pair on Kruisposten.
    const amount = round2(-Number(credit.price_with_vat));

    /*
      A marketplace pays out per payout, not per invoice: the sale was in a
      payout already, and the refund comes off a later one as a correction.
      Kruisposten would mark the invoice paid with money that never moved,
      so the credit waits for that payout instead (Woovin payout #7289 paid
      ORD-026411 out before the return, 02-11-2026).
    */
    if (/Consignment$/.test(text(o["Order Source"])) && text(o["Order Source"]) !== "Shopify") {
      const market = text(o["Order Source"]).replace(/ Consignment$/, "");
      todos.push(todo(`${market} paid ${found.invoice.invoice_number} out in a payout and takes € ${amount.toFixed(2)} back as a correction on a later one. Link ${credit.invoice_number} to that payout's bank line, with the sales on it; the payout of the sale itself pays ${found.invoice.invoice_number}.`, "marketplace_settle"));
    } else if (text(o["Invoice Status"]) === "Paid") {
      todos.push(todo(`${text(first(o["Store Name"])) || "The store"} already paid ${found.invoice.invoice_number}: refund € ${amount.toFixed(2)} or take it off the next payment, and link that to ${credit.invoice_number}.`, "refund_store"));
    } else if (amount > 0) {
      try {
        await kruispostSales({ amount, original: found.invoice.invoice_number, credit: credit.invoice_number, deal: orderId });
        log.push(`Two payments of € ${amount.toFixed(2)} on Kruisposten for ${found.invoice.invoice_number} and ${credit.invoice_number}.`);
        todos.push(todo(`In Rompslomp, link the two Kruisposten payments "Kruispost ${orderId}" to ${found.invoice.invoice_number} and ${credit.invoice_number}.`, "link_kruispost"));
      } catch (err) {
        todos.push(todo(`Settle ${credit.invoice_number} against ${found.invoice.invoice_number} in Rompslomp (Kruisposten could not be booked: ${err.message}).`, "link_kruispost"));
      }
    }
  }

  /*
   * The purchase undone: the seller or partner is not owed for this pair any
   * more. Off Seller Payouts, and its expense credited in Rompslomp.
   */
  async function undoPurchase(order, unit, { reason, log, todos }) {
    const orderId = orderLabel(order);
    const u = unit.fields;
    const wasPaid = text(u["Payment Status"]) === "Paid";

    if (wasPaid) {
      todos.push(todo(`${text(first(u["Seller Name"])) || text(first(u["Seller ID (Lookup)"])) || "The seller"} was already paid € ${round2(u["Purchase Price"]).toFixed(2)} for ${text(u["Item ID"])}: claim it back.`, "claim_seller"));
    } else {
      /*
        Off the payout list by emptying Payment Status. Payment Note is not
        touched: Dario writes the bank payment's own code there, and a note
        of ours in it would break the link to that payment. The reason goes
        in Item Condition, read fresh because it was just written above.
      */
      const now = (await airtable.byIds(UNITS, [unit.id], ["Item Condition"])).get(unit.id) || {};
      await airtable.update(UNITS, unit.id, {
        "Payment Status": null,
        "Item Condition": conditionWith(`Not owed: ${reason} (${orderId}, ${ddmmyyyy()})`, text(now["Item Condition"]))
      });
      log.push(`${text(u["Item ID"])} off Seller Payouts (not owed).`);
    }

    if (!purchases) {
      todos.push(todo(`Credit the purchase of ${orderId} in Rompslomp by hand.`, "credit_purchase"));
      return;
    }

    try {
      const from = text(order.fields["Created Time"]).slice(0, 10) || "";
      const found = await purchases.findPurchase({ deal: orderId, from });

      if (found.credited) {
        log.push(`The purchase of ${orderId} was already credited.`);
      } else if (!found.expense_id) {
        todos.push(todo(`No "Purchase Order ${orderId}" in Rompslomp yet. If Make books it later, credit it then.`, "credit_purchase"));
      } else {
        const credit = await purchases.credit({ expenseId: found.expense_id, deal: orderId });
        log.push(`Purchase ${found.expense_number || found.expense_id} credited${credit.expense_number ? ` (${credit.expense_number})` : ""}.`);

        if (!wasPaid && found.amount) {
          try {
            await purchases.kruispost({ amount: found.amount, original: found.expense_number || `Purchase Order ${orderId}`, credit: credit.expense_number || `Credit Purchase Order ${orderId}`, deal: orderId });
            todos.push(todo(`In Rompslomp (Payout), link the two Kruisposten payments "Kruispost ${orderId}" to the purchase and its credit.`, "link_kruispost"));
          } catch (err) {
            todos.push(todo(`Settle the purchase of ${orderId} against its credit in Rompslomp (${err.message}).`, "link_kruispost"));
          }
        } else if (wasPaid) {
          todos.push(todo(`The purchase of ${orderId} was paid: once the money is back, link it to the credit.`, "link_kruispost"));
        }
      }
    } catch (err) {
      todos.push(todo(`Credit the purchase of ${orderId} in Rompslomp by hand (${err.message}).`, "credit_purchase"));
    }
  }

  /*
   * A partner's pair back on his shelf. A store sale marks his cheapest pair
   * sold without saying which unit it became, so the pair is found by SKU,
   * size and price; one that cannot be found is put back as a new row.
   */
  async function partnerShelf(unit, { status = "in_stock", note, held = "" }) {
    const u = unit.fields;
    const sellerId = text(first(u["Seller ID (Lookup)"]));
    const sku = text(first(u.SKU));
    const size = text(u.Size);
    const price = round2(u["Purchase Price"]);
    const stamp = `${note} (${ddmmyyyy()})`;

    // The row held for this return first: it is reserved now, not sold.
    const [mine] = held ? await db.get(`partner_stock?select=id,partner_price,inventory_unit_id,notes&id=eq.${enc(held)}&status=in.(sold,reserved)&limit=1`) : [];
    const rows = mine ? [] : await db.get(`partner_stock?select=id,partner_price,inventory_unit_id,notes&seller_id=eq.${enc(sellerId)}&sku=ilike.${enc(sku)}&size=eq.${enc(size)}&status=eq.sold&order=sold_at.desc&limit=50`);
    const row = mine || rows.find((r) => text(r.inventory_unit_id) === text(u["Item ID"])) ||
      rows.find((r) => round2(r.partner_price) === price) || rows[0];

    const fields = { status, sold_at: null, sold_ref: null, inventory_unit_id: null, updated_at: new Date().toISOString() };

    if (row) {
      await db.patch(`partner_stock?id=eq.${row.id}`, { ...fields, notes: [text(row.notes), stamp].filter(Boolean).join("\n") });
      return row.id;
    }

    const [made] = await db.insert("partner_stock", [{
      seller_record_id: text(first(u["Seller ID"])) || null,
      seller_id: sellerId,
      sku,
      size,
      product_name: text(u["Product Name"]) || null,
      brand: text(first(u.Brand)) || null,
      mode: "both",
      vat_type: ["Margin", "VAT0", "VAT21"].includes(text(u["VAT Type"])) ? text(u["VAT Type"]) : "Margin",
      partner_price: price > 0 ? price : null,
      markup: 0,
      status,
      received_at: new Date().toISOString(),
      warehouse: "lojiq",
      notes: stamp
    }]);
    return made?.id || null;
  }

  /*
   * A partner's pair on its way back: on his dashboard it is reserved, not
   * sold, so he does not ask to be paid for a pair that is coming home. The
   * scan puts it on his shelf; "not coming" makes it sold again.
   */
  async function holdPartnerPair(unit, label) {
    const u = unit.fields;
    const sellerId = text(first(u["Seller ID (Lookup)"]));
    const sku = text(first(u.SKU));
    const size = text(u.Size);
    const price = round2(u["Purchase Price"]);
    const rows = await db.get(`partner_stock?select=id,partner_price,inventory_unit_id,notes&seller_id=eq.${enc(sellerId)}&sku=ilike.${enc(sku)}&size=eq.${enc(size)}&status=eq.sold&order=sold_at.desc&limit=50`);
    const row = rows.find((r) => text(r.inventory_unit_id) === text(u["Item ID"])) ||
      rows.find((r) => round2(r.partner_price) === price) || rows[0];
    if (!row) return null;
    await db.patch(`partner_stock?id=eq.${row.id}&status=eq.sold`, {
      status: "reserved",
      notes: [text(row.notes), `Coming back: ${label} (${ddmmyyyy()})`].filter(Boolean).join("\n"),
      updated_at: new Date().toISOString()
    });
    return row.id;
  }

  // Sold after all: the pair is not coming back.
  async function releasePartnerHold(id, label) {
    if (!id) return;
    const [row] = await db.get(`partner_stock?select=id,notes&id=eq.${enc(id)}&status=eq.reserved&limit=1`);
    if (!row) return;
    await db.patch(`partner_stock?id=eq.${row.id}`, {
      status: "sold",
      notes: [text(row.notes), `Not coming back: ${label} (${ddmmyyyy()})`].filter(Boolean).join("\n"),
      updated_at: new Date().toISOString()
    });
  }

  // A consignor's pair back in his consignment stock.
  async function consignorStock(unit, log, todos) {
    const u = unit.fields;
    const sellerRecord = text(first(u["Seller ID"]));
    const sku = text(first(u.SKU));
    const size = text(u.Size);

    try {
      const [row] = await db.get(`consignment_inventory?select=id,quantity,payout_price&seller_record_id=eq.${enc(sellerRecord)}&sku=ilike.${enc(sku)}&size=eq.${enc(size)}&limit=1`);

      if (row && !(Number(row.payout_price) > 0)) {
        await db.patch(`consignment_inventory?id=eq.${row.id}`, { quantity: Number(row.quantity || 0) + 1, updated_at: new Date().toISOString() });
        log.push(`Back in ${text(first(u["Seller ID (Lookup)"]))}'s consignment stock (${sku} ${size}: ${row.quantity} -> ${Number(row.quantity || 0) + 1}).`);
        return;
      }

      if (!row) {
        await db.insert("consignment_inventory", [{
          seller_record_id: sellerRecord,
          seller_id: text(first(u["Seller ID (Lookup)"])),
          product_name: text(u["Product Name"]) || null,
          sku,
          size,
          brand: text(first(u.Brand)) || null,
          vat_type: text(u["VAT Type"]) || null,
          quantity: 1
        }]);
        log.push(`Added to ${text(first(u["Seller ID (Lookup)"]))}'s consignment stock (${sku} ${size}).`);
        return;
      }

      todos.push(todo(`Put ${sku} ${size} back in ${text(first(u["Seller ID (Lookup)"]))}'s stock by hand.`, "stock_by_hand"));
    } catch (err) {
      todos.push(todo(`Put ${sku} ${size} back in ${text(first(u["Seller ID (Lookup)"]))}'s consignment stock by hand (${err.message}).`, "stock_by_hand"));
    }
  }

  const onSale = (unit, note) => ({
    "Availability Status": "Available",
    "Selling Price": null,
    "Item Condition": conditionWith(note, text(unit.fields["Item Condition"]))
  });

  /* ---------------- planning the dialog ---------------- */

  /*
   * What the Cancel dialog offers for this order: which question comes
   * first, where the pair probably is, and the shops a Store Consign can name.
   */
  async function describeCancel(table, record) {
    const order = { id: record.id, table, fields: record.fields };
    const unit = await unitOf(order);
    const owner = unit ? ownerOf(unit.fields) : "own";
    const shipped = ["Shipped", "Delivered"].includes(text(record.fields["Shipping Status"]));
    const open = unit ? await openReturnFor(unit.id, order.id) : null;

    // The likeliest first: a partner's pair is on our shelf, a seller's with him.
    const held = [...(owner === "partner" ? ["partner", "warehouse"] : owner === "seller" ? ["consignor_has", "consignor_gone", "flawed", "warehouse"] : ["warehouse"]), "lost"];
    const inWarehouse = owner === "own" ? ["keep", "troubled"] : ["keep", "send_back", "troubled"];

    const locs = await locationChoices().catch(() => []);
    const notes = [];
    if (!unit) notes.push("This order has no Inventory Unit: only the books are corrected.");
    if (text(record.fields["Invoice Status"]) === "Paid") notes.push("The store already paid this invoice: the credit becomes a refund to settle.");
    if (unit && text(unit.fields["Payment Status"]) === "Paid" && owner !== "own") notes.push(`${text(first(unit.fields["Seller ID (Lookup)"]))} was already paid for this pair.`);

    return {
      blocked: open ? `There is already an open return for this pair (RET-${open.return_number}). Find it under Warehouse > Returns.` : "",
      prefill: { order_action: "cancel", shipped: shipped ? "shipped" : "not_shipped", outcome: "return", held: held[0], warehouse: "keep" },
      selects: {
        held: [...new Set(held)].map((value) => ({ value, label: HELD[value] })),
        warehouse: inWarehouse.map((value) => ({ value, label: IN_WAREHOUSE[value] })),
        location: [...locs.map((value) => ({ value, label: value })), { value: "__new", label: "+ Add location…" }]
      },
      note: [unit ? `${text(unit.fields["Item ID"])} · ${text(unit.fields.Type) || "unit"}${unit.fields["Seller ID (Lookup)"] ? ` · ${text(first(unit.fields["Seller ID (Lookup)"]))}` : ""} · ${text(unit.fields["Payment Status"])}` : "", ...notes].filter(Boolean).join("\n")
    };
  }

  /* ---------------- cancelling ---------------- */

  async function recordReturn(fields) {
    const [row] = await db.insert("returns", [fields]);
    return row;
  }

  /*
   * Cancel a store order or Member WTB from the admin. Books first, because
   * that is the part that can refuse; the unit and the order after.
   */
  async function cancelOrder({ table, recordId, input = {}, by = "" }) {
    const order = await orderOf(table, recordId);
    const unit = await unitOf(order);
    const merchant = table === "store" ? await merchantOf(order) : null;
    const orderId = orderLabel(order);
    const keep = text(input.order_action) === "keep";
    const shipped = text(input.shipped) === "shipped";
    const outcome = text(input.outcome);
    const held = text(input.held);
    const then = held === "warehouse" ? text(input.warehouse) || "keep" : "";
    const reason = text(input.reason).slice(0, 300);

    if (text(input.order_action) && !ORDER_ACTIONS[text(input.order_action)]) throw new ReturnsError("Choose what happens to the order.", 400);
    if (shipped && !OUTCOMES[outcome]) throw new ReturnsError("Choose what happens to the pair.", 400);
    if (!shipped && !HELD[held]) throw new ReturnsError("Choose what happens to the pair.", 400);
    if (then && !IN_WAREHOUSE[then]) throw new ReturnsError("Choose what we do with the pair in our warehouse.", 400);
    if (shipped && outcome === "written_off" && !reason) throw new ReturnsError("Say why the pair is written off: it goes on the unit.", 400);
    if ((held === "flawed" || then === "troubled" || then === "send_back") && !reason) throw new ReturnsError("Describe the flaw or the reason: it goes on the unit.", 400);

    let location = "";
    if (shipped && outcome === "store_consign") {
      location = text(input.location) === "__new" ? text(input.new_location) : text(input.location);
      if (!location) throw new ReturnsError("Choose or add the location the pair stays at.", 400);
      if (location.length > 60) throw new ReturnsError("Keep the location under 60 characters.", 400);
    }

    if (unit) {
      const open = await openReturnFor(unit.id, order.id);
      if (open) throw new ReturnsError(`There is already an open return for this pair (RET-${open.return_number}).`);
    }

    const owner = unit ? ownerOf(unit.fields) : "own";
    if (!shipped && held === "partner" && owner !== "partner") throw new ReturnsError("This is not a partner pair.", 400);
    if (!shipped && ["consignor_has", "consignor_gone", "flawed"].includes(held) && owner === "own") throw new ReturnsError("This pair has no seller to give it back to.", 400);
    if (then === "send_back" && owner === "own") throw new ReturnsError("This is our own pair: there is no seller to send it back to.", 400);
    if (!shipped && held === "lost" && !reason) throw new ReturnsError("Say what happened to the pair: it goes on the unit.", 400);

    const log = [];
    const todos = [];
    const gone = shipped ? ["lost", "written_off"].includes(outcome) : held === "lost";
    const stockBack = !gone;
    let sellerReturn = null;

    // 1. The books.
    await creditSale(order, unit, merchant, { stockBack, gone, log, todos });

    // 2. The pair.
    const buyer = text(first(order.fields["Store Name"])) || text(merchant?.["Store Name"]) || "the buyer";
    const ended = keep ? `${orderId} kept for another pair` : `${orderId} cancelled`;
    const story = shipped
      ? { return: `Return from ${buyer}`, store_consign: `At ${location}`, lost: `Lost on the way to ${buyer}`, written_off: `Written off, kept by ${buyer}` }[outcome]
      : held === "lost" ? `Not shipped, ${ended}, pair lost here` : held === "flawed" ? `Not shipped, ${ended}, pair flawed` : `Not shipped, ${ended}`;
    const note = `${story} (${orderId}, ${ddmmyyyy()})${reason ? `: ${reason}` : ""}`;
    let status = "done";
    let partnerStockId = null;

    if (unit) {
      if (shipped) {
        const fields = {
          return: { "Availability Status": "Returning", "Cancel Status": "Return" },
          store_consign: { ...onSale(unit, note), "Cancel Status": "Store Consign", Location: location },
          lost: { "Availability Status": "Lost", "Cancel Status": "Lost", "Verification Status": "Lost" },
          written_off: { "Availability Status": "Void", "Cancel Status": "Written Off" }
        }[outcome];
        if (!fields["Item Condition"]) fields["Item Condition"] = conditionWith(note, text(unit.fields["Item Condition"]));
        await airtable.update(UNITS, unit.id, fields, { typecast: true });
        log.push(`${text(unit.fields["Item ID"])}: ${fields["Availability Status"]}${location ? ` at ${location}` : ""}.`);
        if (outcome === "return") status = "expected";
        if (outcome === "return" && owner === "partner") partnerStockId = await holdPartnerPair(unit, `${orderId}, ${buyer}`);
      } else if (held === "lost") {
        // Ours to lose: the seller is owed as if it sold, and it is off stock.
        await airtable.update(UNITS, unit.id, { "Availability Status": "Lost", "Cancel Status": "Lost", "Verification Status": "Lost", "Item Condition": conditionWith(note, text(unit.fields["Item Condition"])) }, { typecast: true });
        log.push(`${text(unit.fields["Item ID"])}: Lost here; ${owner === "own" ? "off stock" : "the seller is still paid"}.`);
      } else if (held === "warehouse" && then === "keep") {
        await airtable.update(UNITS, unit.id, { ...onSale(unit, note), "Cancel Status": "Return" });
        log.push(`${text(unit.fields["Item ID"])} back on sale.`);
      } else if (held === "warehouse" && then === "troubled") {
        await airtable.update(UNITS, unit.id, { "Availability Status": "Troubled", "Cancel Status": "Return", "Item Condition": conditionWith(note, text(unit.fields["Item Condition"])) }, { typecast: true });
        log.push(`${text(unit.fields["Item ID"])}: Troubled Stock${owner === "own" ? "" : "; the seller is paid as normal"}.`);
      } else if (held === "warehouse" && then === "send_back") {
        sellerReturn = await sendBack(unit, { owner, note, label: orderId, log });
        await undoPurchase(order, unit, { reason: "sent back to the seller", log, todos });
      } else {
        const why = held === "partner" ? "back on the partner's shelf" : held === "consignor_has" ? "the seller keeps it" : held === "flawed" ? "the pair is flawed, the seller keeps it" : "the seller no longer has it";
        await airtable.update(UNITS, unit.id, {
          "Availability Status": "Void",
          "Cancel Status": "Return",
          "Verification Status": held === "flawed" ? "Rejected" : "Cancelled",
          "Item Condition": conditionWith(note, text(unit.fields["Item Condition"]))
        }, { typecast: true });
        if (held === "partner") {
          partnerStockId = await partnerShelf(unit, { note: `Back from ${orderId}: not shipped` });
          log.push(`Back on ${text(first(unit.fields["Seller ID (Lookup)"]))}'s shelf.`);
        }
        if (held === "consignor_has" && text(unit.fields.Type) === "Consignment") await consignorStock(unit, log, todos);
        await undoPurchase(order, unit, { reason: why, log, todos });
      }
    }

    // 3. The order: ended, or open again for another pair.
    if (keep) {
      await reopenOrder(order, log);
    } else {
      const orderStatus = shipped && outcome === "return" && table === "store" ? "Returned" : "Cancelled";
      await airtable.update(table === "mwtb" ? WTBS : ORDERS, order.id, { "Fulfillment Status": orderStatus }, { typecast: true });
      log.push(`${orderId}: ${orderStatus}.`);
    }

    const pairResult = shipped ? OUTCOMES[outcome] : then ? `${HELD[held]}: ${IN_WAREHOUSE[then]}` : HELD[held];
    const row = await recordReturn({
      source: table === "mwtb" ? "member_wtb" : "store_order",
      status,
      shipped,
      ...snapshot(order, unit, merchant),
      partner_stock_id: partnerStockId,
      ...(sellerReturn ? { seller_return_status: "label_requested", seller_return_at: new Date().toISOString() } : {}),
      reason: reason || null,
      result: keep ? `Order kept, back to Outsource. ${pairResult}` : pairResult,
      processed_at: status === "done" ? new Date().toISOString() : null,
      todo: todos,
      log: log.map((line) => ({ at: new Date().toISOString(), by, line })),
      created_by: by || null
    });

    return {
      return_id: row?.id,
      return_number: row?.return_number,
      message: [keep ? `${orderId} is back in Outsource.` : `${orderId} cancelled.`, ...log, ...todos.map((t) => `To do: ${t.text}`)].join(" "),
      log,
      todos
    };
  }

  /*
   * Keep the order: it goes back to Outsource for another pair. Everything
   * of the old pair comes off it - the unit, the shipment and the invoice -
   * and Retry Invoice makes the engine invoice the new pair, at its own
   * price, once it is allocated. Fulfillment Sent? stays: that is Shopify's
   * step, done once. The old invoice numbers stay in the return's log.
   */
  async function reopenOrder(order, log) {
    const orderId = orderLabel(order);

    if (order.table === "mwtb") {
      await airtable.update(WTBS, order.id, {
        "Fulfillment Status": "Outsource",
        "Linked Inventory Unit": [],
        "Shipping Status": null,
        "Tracking Number": "",
        "Tracking URL": null,
        "Shipping Label": [],
        "Shipping Label Permanent URL": null,
        "Label Sent To Discord?": false,
        "Label Uploaded At": null,
        "Label Requested At": null
      }, { typecast: true });
      log.push(`${orderId}: open again (Outsource), without its pair.`);
      return;
    }

    await airtable.update(ORDERS, order.id, {
      "Fulfillment Status": "Outsource",
      "Linked Inventory Unit": [],
      "Shipping Status": null,
      "Tracking Number": "",
      "Tracking URL": "",
      "Shipping Label": [],
      "Shipping Label URL (Permanent)": "",
      "Label Sent To Discord?": false,
      "Label Error Message": "",
      "Inbound Tracking Number": "",
      "Inbound Label URL": null,
      "Rompslomp Invoice ID": "",
      "Rompslomp Invoice Number": "",
      "Rompslomp Journal Entry ID": "",
      "Rompslomp Credit Invoice Number": "",
      "Invoice Sent At": null,
      "Invoice Error": "",
      "Invoice Status": null,
      "Bookkeeping Status": null,
      "Retry Invoice": true
    }, { typecast: true });
    log.push(`${orderId}: back to Outsource without its pair; the next pair gets a new invoice.`);
  }

  /*
   * A pair that goes back to its seller from our warehouse. He sends the
   * label and pays for it; until it ships the unit is Inactive, so it is
   * neither sold nor counted, and Rejected says why.
   */
  async function sendBack(unit, { owner, note, label, log, held = "" }) {
    await airtable.update(UNITS, unit.id, {
      "Availability Status": "Inactive",
      "Cancel Status": "Return",
      "Verification Status": "Rejected",
      "Item Condition": conditionWith(`${note}; goes back to the seller`, text(unit.fields["Item Condition"]))
    }, { typecast: true });
    if (owner === "partner") await partnerShelf(unit, { status: "removed", note: `Sent back to the partner from ${label}`, held });
    log.push(`${text(unit.fields["Item ID"])} goes back to ${text(first(unit.fields["Seller ID (Lookup)"])) || "the seller"}: waiting for his label.`);
    return true;
  }

  /*
   * The return to the seller, a step at a time. Shipped is when the pair is
   * really gone from us: then the unit is Void.
   */
  async function sellerReturnStep(id, { step, tracking = "", by = "" } = {}) {
    const row = await getReturn(id);
    const order = Object.keys(SELLER_RETURN);
    if (!row.seller_return_status) throw new ReturnsError("This pair is not going back to its seller.");
    if (!SELLER_RETURN[step]) throw new ReturnsError("Unknown step.", 400);
    if (order.indexOf(step) <= order.indexOf(row.seller_return_status)) throw new ReturnsError(`Already ${SELLER_RETURN[row.seller_return_status]}.`);

    if (step === "shipped" && row.inventory_unit_record_id) {
      const unit = (await airtable.byIds(UNITS, [row.inventory_unit_record_id], ["Item Condition"])).get(row.inventory_unit_record_id) || {};
      await airtable.update(UNITS, row.inventory_unit_record_id, {
        "Availability Status": "Void",
        "Item Condition": conditionWith(`Sent back to the seller${text(tracking) ? ` (${text(tracking)})` : ""} (RET-${row.return_number}, ${ddmmyyyy()})`, text(unit["Item Condition"]))
      });
    }

    return saveReturn(row.id, {
      seller_return_status: step,
      seller_return_at: new Date().toISOString(),
      ...(text(tracking) ? { seller_return_tracking: text(tracking).slice(0, 80) } : {}),
      log: [...(row.log || []), { at: new Date().toISOString(), by, line: `Back to the seller: ${SELLER_RETURN[step]}${text(tracking) ? ` (${text(tracking)})` : ""}.` }]
    });
  }

  /* ---------------- from the marketplaces ---------------- */

  /*
   * A marketplace says a pair is coming back (Woovin return-processing, a
   * bol return) or that a sale ended before it shipped. Only written down:
   * what happens to the pair is decided by a person, at the scan or on the
   * Returns tab. Safe to send again - an open return is updated, not doubled.
   */
  async function announce(input = {}) {
    const source = text(input.source);
    if (!["woovin", "bol", "manual"].includes(source)) throw new ReturnsError("Unknown source.", 400);

    const externalId = text(input.external_return_id) || null;
    if (externalId) {
      const [known] = await db.get(`returns?select=*&source=eq.${source}&external_return_id=eq.${enc(externalId)}&limit=1`);
      if (known) {
        const patch = {};
        for (const key of ["tracking_code", "carrier", "reason", "customer_comment", "marketplace_status"]) {
          if (text(input[key]) && text(input[key]) !== text(known[key])) patch[key] = text(input[key]);
        }
        return { return: Object.keys(patch).length ? await saveReturn(known.id, patch) : known, created: false };
      }
    }

    // The order: by record id, or by the marketplace's own number.
    let order = null;
    if (/^rec[A-Za-z0-9]{14}$/.test(text(input.order_record_id))) {
      order = await orderOf("store", text(input.order_record_id));
    } else if (text(input.marketplace_order_id)) {
      const id = quote(input.marketplace_order_id);
      const { records } = await airtable.select(ORDERS, {
        formula: `OR({Marketplace Sale ID} = '${id}', {Shopify Order Number} = '${id}')`,
        fields: ORDER_FIELDS,
        pageSize: 20
      });
      const wantedSku = text(input.sku).toUpperCase();
      const wantedSize = text(input.size);
      order = records.find((r) => wantedSku && text(first(r.fields.SKU)).toUpperCase() === wantedSku && (!wantedSize || text(r.fields.Size) === wantedSize)) ||
        records.find((r) => first(r.fields["Linked Inventory Unit"])) || records[0] || null;
      if (order) order = { id: order.id, table: "store", fields: order.fields };
    }

    if (!order) throw new ReturnsError(`No order found for ${text(input.marketplace_order_id) || text(input.order_record_id) || "that sale"}.`, 404);

    const unit = await unitOf(order);
    const open = await openReturnFor(unit?.id, order.id);
    if (open) {
      const patch = {};
      for (const key of ["tracking_code", "carrier", "reason", "customer_comment", "marketplace_status"]) {
        if (text(input[key]) && text(input[key]) !== text(open[key])) patch[key] = text(input[key]);
      }
      if (externalId && !open.external_return_id) patch.external_return_id = externalId;
      return { return: Object.keys(patch).length ? await saveReturn(open.id, patch) : open, created: false };
    }

    // Already dealt with by hand in the admin: say so rather than reopen it.
    if (unit && text(unit.fields["Cancel Status"]) && !["Sold", "Reserved"].includes(text(unit.fields["Availability Status"]))) {
      return { return: null, created: false, skipped: `${text(unit.fields["Item ID"])} is already ${text(unit.fields["Availability Status"])} (${text(unit.fields["Cancel Status"])}).` };
    }

    const shipped = input.shipped === undefined
      ? ["Shipped", "Delivered"].includes(text(order.fields["Shipping Status"]))
      : Boolean(input.shipped);

    const orderId = orderLabel(order);
    const label = source === "woovin" ? "Woovin" : source === "bol" ? "bol" : "Hand";

    // A sale that ended before any pair was on it leaves nothing to decide.
    if (!shipped && !unit) return { return: null, created: false, skipped: `${orderId} had no pair yet.` };
    const todos = [];
    const log = [];
    let heldPartner = null;

    if (shipped) {
      if (unit) {
        await airtable.update(UNITS, unit.id, {
          "Availability Status": "Returning",
          "Cancel Status": "Return",
          "Item Condition": conditionWith(`${label} return (${orderId}, ${ddmmyyyy()})`, text(unit.fields["Item Condition"]))
        }, { typecast: true });
        if (ownerOf(unit.fields) === "partner") heldPartner = await holdPartnerPair(unit, `${orderId}, ${label}`);
      }
      await airtable.update(ORDERS, order.id, { "Fulfillment Status": "Returned" }, { typecast: true });
      log.push(`${orderId}: Returned, ${unit ? text(unit.fields["Item ID"]) : "no unit"} Returning.`);

      // The marketplace's sale is booked from its payout; a cancelled one is not.
      const bookkeeping = text(order.fields["Bookkeeping Status"]);
      if (text(order.fields["Rompslomp Invoice ID"])) {
        todos.push(todo(`${orderId} was invoiced (${text(order.fields["Rompslomp Invoice Number"])}): use Credit invoice on this return.`, "credit_invoice"));
      } else if (!bookkeeping || bookkeeping === "To book – marketplace") {
        await airtable.update(ORDERS, order.id, { "Bookkeeping Status": "Cancelled" }, { typecast: true });
      }
    } else {
      log.push(`${orderId}: ended before it shipped, waiting for a decision.`);
    }

    const row = await recordReturn({
      source,
      status: shipped ? "expected" : "to_decide",
      shipped,
      ...snapshot(order, unit, null),
      partner_stock_id: heldPartner,
      external_return_id: externalId,
      marketplace_status: text(input.marketplace_status) || null,
      reason: text(input.reason) || null,
      customer_comment: text(input.customer_comment) || null,
      tracking_code: text(input.tracking_code) || null,
      carrier: text(input.carrier) || null,
      todo: todos,
      log: log.map((line) => ({ at: new Date().toISOString(), by: label, line })),
      created_by: label
    });

    return { return: row, created: true };
  }

  /*
   * A return waiting for a decision (the sale ended before it shipped):
   * the same choice as the Cancel dialog's "not shipped".
   */
  async function decide(id, { held, then = "", orderAction = "", note = "", by = "" } = {}) {
    const row = await getReturn(id);
    if (row.status !== "to_decide") throw new ReturnsError("This return is not waiting for a decision.");
    if (!row.order_record_id) throw new ReturnsError("This return has no order to work from.");

    const result = await cancelOrderFromReturn(row, { held, then, orderAction, note, by });
    return result;
  }

  async function cancelOrderFromReturn(row, { held, then = "", orderAction = "", note = "", by }) {
    // Clear the waiting row first, so the cancel does not refuse on it.
    await saveReturn(row.id, { status: "cancelled", result: "Replaced by the decision" });
    try {
      // It did leave after all: then it is an ordinary return, on its way back.
      const input = held === "coming_back"
        ? { shipped: "shipped", outcome: "return" }
        : { shipped: "not_shipped", held, warehouse: then, order_action: orderAction, reason: note };
      const out = await cancelOrder({ table: row.order_table || "store", recordId: row.order_record_id, input, by });
      // The new row takes over the marketplace's facts and the RET number.
      if (out.return_id) {
        await db.remove(`returns?id=eq.${row.id}`);
        await saveReturn(out.return_id, {
          return_number: row.return_number,
          source: row.source,
          external_return_id: row.external_return_id,
          marketplace_status: row.marketplace_status,
          reason: row.reason,
          customer_comment: row.customer_comment,
          tracking_code: row.tracking_code,
          carrier: row.carrier
        });
        out.return_number = row.return_number;
      }
      return out;
    } catch (err) {
      await saveReturn(row.id, { status: "to_decide", result: null });
      throw err;
    }
  }

  /* ---------------- the scan ---------------- */

  /*
   * Which returns a scanned box can be: open ones of that SKU and size
   * first, then everything still expected, so a box with a wrong label is
   * not a dead end. One still waiting for a decision counts too: a box in
   * hand settles that it came back.
   */
  async function match({ sku = "", size = "" } = {}) {
    const open = await db.get("returns?select=*&status=in.(to_decide,expected,received)&order=created_at.asc&limit=500");
    const s = text(sku).toUpperCase().replace(/\s+/g, "");
    const z = text(size).replace(/^EU\s*/i, "");
    const exact = open.filter((r) => text(r.sku).toUpperCase().replace(/\s+/g, "") === s && (!z || text(r.size).replace(/^EU\s*/i, "") === z));
    const sameSku = open.filter((r) => !exact.includes(r) && s && text(r.sku).toUpperCase().replace(/\s+/g, "") === s);
    return { exact, same_sku: sameSku, others: open.filter((r) => !exact.includes(r) && !sameSku.includes(r)).length };
  }

  /*
   * Another To Pay pair of the partner, of the same SKU and price: the money
   * already paid for the returned pair pays for that one. The same SKU,
   * because Dario tells the partner per payment how many of which SKU it
   * covered (02-11-2026).
   */
  async function partnerSwap(unit, returnedLabel, paymentNote) {
    const u = unit.fields;
    const sellerId = quote(first(u["Seller ID (Lookup)"]));
    const sku = text(first(u.SKU)).toUpperCase();
    const price = round2(u["Purchase Price"]);
    const records = [];
    let offset = "";
    do {
      const page = await airtable.select(UNITS, {
        formula: `AND({Payment Status} = 'To Pay', {Availability Status} = 'Sold', {Purchase Price} = ${price}, FIND('${sellerId}', ARRAYJOIN({Seller ID (Lookup)})), FIND('${quote(sku)}', UPPER({SKU} & '')), OR(FIND('Delivered', {Shipping Status} & ''), FIND('Shipped', {Shipping Status} & '')))`,
        fields: ["Item ID", "SKU", "Payment Note", "Purchase Date", "Item Condition", "Unfulfilled Orders Log"],
        pageSize: 100,
        offset
      });
      records.push(...page.records);
      offset = page.offset;
    } while (offset && records.length < 1000);

    // The oldest sale first: that is the one Dario pays next, so the money
    // already paid settles what is owed soonest (Dario, 02-11-2026).
    const when = (r) => text(r.fields?.["Purchase Date"]) || "9999";
    const sameSku = (r) => text(first(r.fields?.SKU)).toUpperCase() === sku;
    const candidates = records.filter((r) => r.id !== unit.id && sameSku(r)).sort((a, b) => when(a).localeCompare(when(b)));
    if (!candidates.length) return null;

    const busy = await db.get(`returns?select=inventory_unit_record_id&status=in.(to_decide,expected,received)&inventory_unit_record_id=in.(${candidates.map((r) => `"${r.id}"`).join(",")})`);
    const taken = new Set(busy.map((r) => r.inventory_unit_record_id));
    const pick = candidates.find((r) => !taken.has(r.id));
    if (!pick) return null;

    /*
      The returned pair's Payment Note comes along unchanged: it is the code
      of the bank payment that paid it, and that payment now pays this one.
    */
    await airtable.update(UNITS, pick.id, {
      "Payment Status": "Paid",
      "Payment Note": paymentNote || null,
      "Item Condition": conditionWith(`Paid with the payment of returned ${returnedLabel} (€ ${price.toFixed(2)}, ${ddmmyyyy()})`, text(pick.fields?.["Item Condition"]))
    });
    return { id: pick.id, item_id: text(pick.fields?.["Item ID"]), order_record_id: text(first(pick.fields?.["Unfulfilled Orders Log"])) };
  }

  /*
   * The books of a swap. The bank payment stays where it is, on the purchase
   * of the returned pair; that purchase is credited, and the credit and the
   * purchase of the pair it now pays get a matching pair on Kruisposten. All
   * three end up paid, without unlinking anything - which their API cannot.
   */
  async function swapBooks({ returnedOrder, swap, log, todos }) {
    const returnedId = orderLabel(returnedOrder);

    if (!purchases) {
      todos.push(todo(`In Rompslomp (Payout): credit the purchase of ${returnedId} and settle it against the purchase of ${swap.item_id}.`, "move_payment"));
      return;
    }

    try {
      const back = await purchases.findPurchase({ deal: returnedId, from: text(returnedOrder.fields?.["Created Time"]).slice(0, 10) });
      if (!back.expense_id) {
        todos.push(todo(`No "Purchase Order ${returnedId}" found in Rompslomp: credit it by hand once it is there, and settle it against the purchase of ${swap.item_id}.`, "move_payment"));
        return;
      }

      const credit = back.credited ? null : await purchases.credit({ expenseId: back.expense_id, deal: returnedId });
      if (credit) log.push(`Purchase ${back.expense_number || back.expense_id} of ${returnedId} credited (${credit.expense_number}).`);

      const swapOrder = swap.order_record_id ? await orderOf("store", swap.order_record_id).catch(() => null) : null;
      const swapId = swapOrder ? orderLabel(swapOrder) : "";
      const theirs = swapId ? await purchases.findPurchase({ deal: swapId, from: text(swapOrder.fields["Created Time"]).slice(0, 10) }) : { expense_id: "" };

      if (!credit || !theirs.expense_id) {
        todos.push(todo(`In Rompslomp (Payout): settle the credit of the purchase of ${returnedId} against the purchase of ${swapId || swap.item_id}${theirs.expense_id ? "" : " (not booked yet)"}.`, "link_kruispost"));
        return;
      }

      await purchases.kruispost({
        amount: back.amount,
        original: theirs.expense_number || `Purchase Order ${swapId}`,
        credit: credit.expense_number || `Credit Purchase Order ${returnedId}`,
        deal: `${swapId}/${returnedId}`
      });
      todos.push(todo(`In Rompslomp (Payout), link the two Kruisposten payments "Kruispost ${swapId}/${returnedId}" to the purchase of ${swapId} and the credit of ${returnedId}.`, "link_kruispost"));
    } catch (err) {
      todos.push(todo(`In Rompslomp (Payout): credit the purchase of ${returnedId} and settle it against the purchase of ${swap.item_id} (${err.message}).`, "move_payment"));
    }
  }

  /*
   * The box is in hand: OK or flaw. Everything that follows from that is
   * done here, so the person at the scanner only answers that one question.
   */
  async function receive(id, { verdict, then = "", note = "", by = "", barcode = "" } = {}) {
    let row = await getReturn(id);
    // Scanned while still waiting for a decision: it did ship and came back.
    if (row.status === "to_decide") {
      if (!["ok", "flaw"].includes(verdict)) throw new ReturnsError("Say whether the pair is OK or has a flaw.", 400);
      if (verdict === "flaw" && !text(note)) throw new ReturnsError("Describe the flaw: it goes on the unit.", 400);
      const out = await cancelOrderFromReturn(row, { held: "coming_back", by });
      if (!out.return_id) throw new ReturnsError(`RET-${row.return_number} could not be turned into a return.`);
      row = await getReturn(out.return_id);
    }
    if (!["expected", "received"].includes(row.status)) throw new ReturnsError(`RET-${row.return_number} is already ${row.status}.`);
    if (!["ok", "flaw"].includes(verdict)) throw new ReturnsError("Say whether the pair is OK or has a flaw.", 400);
    if (verdict === "flaw" && !text(note)) throw new ReturnsError("Describe the flaw: it goes on the unit.", 400);

    const log = [];
    const todos = [...(row.todo || [])];
    const label = `RET-${row.return_number}`;
    let result = "";
    let sellerReturn = false;

    const unit = row.inventory_unit_record_id
      ? (await airtable.byIds(UNITS, [row.inventory_unit_record_id], UNIT_FIELDS)).get(row.inventory_unit_record_id)
      : null;

    if (!unit) {
      result = "Received - no unit to put back";
      todos.push(todo(`${label} has no Inventory Unit: put ${row.sku} ${row.size} into stock by hand.`, "stock_by_hand"));
    } else {
      const u = { id: row.inventory_unit_record_id, fields: unit };
      const owner = ownerOf(unit);
      const paid = text(unit["Payment Status"]) === "Paid";
      const stamp = `Returned ${verdict === "ok" ? "OK" : `with a flaw: ${text(note)}`} (${row.order_id}, ${label}, ${ddmmyyyy()})`;
      // The order itself, for the date its purchase was booked from.
      const order = row.order_record_id
        ? await orderOf(row.order_table || "store", row.order_record_id).catch(() => null)
        : null;
      const orderForBooks = order || { id: row.order_record_id, table: row.order_table || "store", fields: { "Order ID": row.order_id } };

      if (verdict === "ok") {
        if (owner === "partner" && !paid) {
          await airtable.update(UNITS, u.id, { "Availability Status": "Void", "Item Condition": conditionWith(stamp, text(unit["Item Condition"])) });
          await partnerShelf(u, { note: `Returned OK from ${row.order_id} (${label})`, held: row.partner_stock_id });
          await undoPurchase(orderForBooks, u, { reason: "back on the partner's shelf", log, todos });
          result = "Back on the partner's shelf";
        } else if (owner === "partner" && paid) {
          const swap = await partnerSwap(u, `${text(unit["Item ID"])} (${row.order_id})`, text(unit["Payment Note"]));
          if (swap) {
            // Its payment now belongs to the other pair: Status and Note go
            // with it, and only Item Condition says where.
            await airtable.update(UNITS, u.id, {
              "Availability Status": "Void",
              "Payment Status": null,
              "Payment Note": null,
              "Item Condition": conditionWith(`${stamp}; its payment${text(unit["Payment Note"]) ? ` (${text(unit["Payment Note"])})` : ""} now pays ${swap.item_id}`, text(unit["Item Condition"]))
            });
            await partnerShelf(u, { note: `Returned OK from ${row.order_id} (${label}), its payment settles ${swap.item_id}`, held: row.partner_stock_id });
            result = `Back on the partner's shelf; ${swap.item_id} is settled with the money already paid`;
            await swapBooks({ returnedOrder: orderForBooks, swap, log, todos });
          } else {
            await airtable.update(UNITS, u.id, { ...onSale(u, stamp), "Cancel Status": "Return" });
            await releasePartnerHold(row.partner_stock_id, `${label}, ours now`);
            result = "Ours now: back on sale (the partner was paid and has no other pair to settle it with)";
          }
        } else if (owner === "seller" && then === "send_back") {
          // OK, but we do not want it: it goes back and the purchase with it.
          sellerReturn = await sendBack(u, { owner, note: stamp, label, log });
          await undoPurchase(orderForBooks, u, { reason: "returned OK, sent back to the seller", log, todos });
          result = "Back to the seller (not owed)";
        } else {
          await airtable.update(UNITS, u.id, { ...onSale(u, stamp), "Cancel Status": "Return" });
          result = owner === "seller" ? "Back on sale; the seller is paid as normal" : "Back on sale";
        }
      } else if (owner === "own" || then === "troubled") {
        // Ours, or a seller's we keep as it is: Troubled, and he is paid.
        await airtable.update(UNITS, u.id, { "Availability Status": "Troubled", "Item Condition": conditionWith(stamp, text(unit["Item Condition"])) }, { typecast: true });
        result = owner === "own" ? "Troubled Stock" : "Troubled Stock; the seller is paid as normal";
        if (owner === "partner") await releasePartnerHold(row.partner_stock_id, `${label}, flawed, kept by us`);
      } else {
        // A seller's or partner's flawed pair goes back to him, not owed; one
        // already paid gets a refund to claim (undoPurchase says so).
        sellerReturn = await sendBack(u, { owner, note: stamp, label, log, held: row.partner_stock_id });
        await undoPurchase(orderForBooks, u, { reason: "returned with a flaw, goes back to the seller", log, todos });
        result = paid ? "Back to the seller; he was paid, the refund is to claim" : "Back to the seller (not owed)";
      }
    }

    // A barcode typed in by hand is learned, so the next box just scans.
    if (text(barcode) && row.sku && row.size) await learnBarcode(barcode, row.sku, row.size).catch(() => {});

    return saveReturn(row.id, {
      status: "done",
      verdict,
      ...(sellerReturn ? { seller_return_status: "label_requested", seller_return_at: new Date().toISOString() } : {}),
      condition_note: text(note) || null,
      received_at: new Date().toISOString(),
      received_by: by || null,
      processed_at: new Date().toISOString(),
      result,
      todo: todos,
      log: [...(row.log || []), ...[`Scanned: ${verdict === "ok" ? "OK" : `flaw - ${text(note)}`}. ${result}.`, ...log].map((line) => ({ at: new Date().toISOString(), by, line }))]
    });
  }

  /*
   * A box whose barcode the catalogue did not know, with the SKU and size
   * typed in: stored, so the next one scans. One barcode per SKU and size,
   * so a row that already has one keeps it and the new one fills its gtin.
   */
  async function learnBarcode(barcode, sku, size) {
    const code = text(barcode).replace(/\s+/g, "");
    if (!/^\d{8,14}$/.test(code)) return false;
    const [row] = await db.get(`bol_barcodes?select=sku,size,ean,gtin&sku=eq.${enc(sku)}&size=eq.${enc(size)}&limit=1`);
    if (!row) {
      await db.insert("bol_barcodes", [{ sku: text(sku), size: text(size), ean: code, checked_at: new Date().toISOString() }], "return=minimal");
      return true;
    }
    if (text(row.ean) === code || text(row.gtin) === code) return false;
    if (!text(row.gtin)) await db.patch(`bol_barcodes?sku=eq.${enc(sku)}&size=eq.${enc(size)}`, { gtin: code });
    return true;
  }

  /*
   * An expected return that is not coming: the buyer kept it, or it got lost.
   * The cancel put the stock back as if the pair were here, so it comes out
   * again, onto Voorraadverschillen - by the amount the cancel put back,
   * which its log says. The seller is paid as if it sold.
   */
  async function notComing(id, { note = "", by = "" } = {}) {
    const row = await getReturn(id);
    if (row.status !== "expected") throw new ReturnsError("Only an expected return can be closed as not coming.");
    if (row.inventory_unit_record_id) {
      await airtable.update(UNITS, row.inventory_unit_record_id, { "Availability Status": "Lost", "Cancel Status": "Lost", "Verification Status": "Lost" }, { typecast: true });
    }
    await releasePartnerHold(row.partner_stock_id, `RET-${row.return_number}`);

    const log = [`Closed as not coming back${text(note) ? `: ${text(note)}` : ""}.`];
    const todos = [...(row.todo || [])];
    const putBack = (row.log || []).map((l) => /^Voorraadcorrectie (\S+): € ([\d.]+) back into stock/.exec(text(l.line))).find(Boolean);

    if (putBack && rompslomp?.configured) {
      const description = `Voorraadverschillen ${putBack[1]}`;
      try {
        await journalOnce({ description, amount: round2(putBack[2]), debit: SHRINK_ACCOUNT, credit: STOCK_ACCOUNT });
        log.push(`${description}: € ${round2(putBack[2]).toFixed(2)} off stock again, the pair never came back.`);
      } catch (err) {
        todos.push(todo(`${row.order_id}: book € ${round2(putBack[2]).toFixed(2)} from Voorraad Scout to Voorraadverschillen by hand (${err.message}).`, "journal_by_hand"));
      }
    } else if (putBack) {
      todos.push(todo(`${row.order_id}: book € ${round2(putBack[2]).toFixed(2)} from Voorraad Scout to Voorraadverschillen by hand.`, "journal_by_hand"));
    }

    return saveReturn(row.id, {
      status: "cancelled",
      result: `Not coming back${text(note) ? `: ${text(note)}` : ""}`,
      processed_at: new Date().toISOString(),
      todo: todos,
      log: [...(row.log || []), ...log.map((line) => ({ at: new Date().toISOString(), by, line }))]
    });
  }

  // Credit the invoice of a return that came in from a marketplace.
  async function creditInvoice(id, { by = "" } = {}) {
    const row = await getReturn(id);
    if (!row.order_record_id || row.order_table === "mwtb") throw new ReturnsError("This return has no store order invoice.");
    const order = await orderOf("store", row.order_record_id);
    const unit = await unitOf(order);
    const merchant = await merchantOf(order);
    const log = [];
    const todos = [];
    await creditSale(order, unit, merchant, { stockBack: true, log, todos });
    const left = (row.todo || []).map((t) => (t.kind === "credit_invoice" ? { ...t, done: true } : t));
    return saveReturn(row.id, {
      todo: [...left, ...todos],
      log: [...(row.log || []), ...log.map((line) => ({ at: new Date().toISOString(), by, line }))]
    });
  }

  async function tick(id, todoId, done = true, by = "") {
    const row = await getReturn(id);
    const item = (row.todo || []).find((t) => t.id === todoId);
    const list = (row.todo || []).map((t) => (t.id === todoId ? { ...t, done: Boolean(done), done_by: by, done_at: new Date().toISOString() } : t));

    /*
      A seller's refund received: we are not owed anything any more and
      neither is he, so Payment Status goes empty. Payment Note stays - it
      is the code of the bank payment that paid him.
    */
    if (item?.kind === "claim_seller" && done && !item.done && row.inventory_unit_record_id) {
      const unit = (await airtable.byIds(UNITS, [row.inventory_unit_record_id], ["Item Condition"])).get(row.inventory_unit_record_id) || {};
      await airtable.update(UNITS, row.inventory_unit_record_id, {
        "Payment Status": null,
        "Item Condition": conditionWith(`Refund from the seller received (RET-${row.return_number}, ${ddmmyyyy()})`, text(unit["Item Condition"]))
      });
    }

    return saveReturn(row.id, { todo: list });
  }

  /* ---------------- lists ---------------- */

  const STATUS_SETS = {
    open: "to_decide,expected,received",
    to_decide: "to_decide",
    expected: "expected",
    todo: "",
    refunds_buyers: "",
    refunds_sellers: "",
    returns_sellers: "",
    rompslomp: "",
    done: "done,cancelled",
    all: ""
  };

  async function list({ view = "open", q = "" } = {}) {
    const set = STATUS_SETS[view] ?? STATUS_SETS.open;
    let rows = await db.get(`returns?select=*${set ? `&status=in.(${set})` : ""}&order=created_at.desc&limit=1000`);
    if (view === "todo") rows = rows.filter((r) => (r.todo || []).some((t) => !t.done));
    if (TODO_LISTS[view]) rows = rows.filter((r) => (r.todo || []).some((t) => !t.done && TODO_LISTS[view].includes(t.kind)));
    if (view === "returns_sellers") rows = rows.filter((r) => r.seller_return_status && r.seller_return_status !== "delivered");
    const term = text(q).toLowerCase();
    if (term) {
      rows = rows.filter((r) => [r.return_number && `ret-${r.return_number}`, r.order_id, r.marketplace_order_id, r.shopify_order_number, r.sku, r.item_id, r.seller_id, r.seller_name, r.store_name, r.tracking_code]
        .some((v) => text(v).toLowerCase().includes(term)));
    }
    return rows;
  }

  // For Seller Payouts: which units have a return still running.
  async function openByUnit(unitIds) {
    const ids = [...new Set(unitIds.filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = await db.get(`returns?select=inventory_unit_record_id,return_number,status&status=in.(to_decide,expected,received)&inventory_unit_record_id=in.(${chunk.map((x) => `"${x}"`).join(",")})`);
      for (const r of rows) out.set(r.inventory_unit_record_id, r);
    }
    return out;
  }

  /* ---------------- Troubled Stock ---------------- */

  async function troubled() {
    const out = [];
    let offset = "";
    do {
      const page = await airtable.select(UNITS, { formula: "{Availability Status} = 'Troubled'", fields: UNIT_FIELDS, pageSize: 100, offset });
      out.push(...page.records);
      offset = page.offset;
    } while (offset && out.length < 2000);

    return out.map((r) => {
      const f = r.fields || {};
      const picture = Array.isArray(f.Picture) && f.Picture[0] ? f.Picture[0].thumbnails?.small?.url || f.Picture[0].url : "";
      return {
        id: r.id,
        item_id: text(f["Item ID"]),
        type: text(f.Type),
        product: text(f["Product Name"]),
        sku: text(first(f.SKU)),
        size: text(f.Size),
        picture,
        seller_id: text(first(f["Seller ID (Lookup)"])),
        seller_name: text(first(f["Seller Name"])),
        payment: text(f["Payment Status"]),
        purchase_price: round2(f["Purchase Price"]),
        condition: text(f["Item Condition"])
      };
    });
  }

  const TROUBLE_ACTIONS = {
    on_sale: "Back on sale",
    write_off: "Written off",
    to_seller: "Sent back to the seller"
  };

  async function resolveTroubled(unitId, { action, note = "", by = "" } = {}) {
    if (!TROUBLE_ACTIONS[action]) throw new ReturnsError("Unknown action.", 400);
    const found = await airtable.byIds(UNITS, [unitId], UNIT_FIELDS);
    const f = found.get(unitId);
    if (!f) throw new ReturnsError("That unit no longer exists.", 404);
    if (text(f["Availability Status"]) !== "Troubled") throw new ReturnsError(`${text(f["Item ID"])} is not Troubled any more.`);
    if (action !== "on_sale" && !text(note)) throw new ReturnsError("Add a note: it goes on the unit.", 400);

    const stamp = `${TROUBLE_ACTIONS[action]}${text(note) ? `: ${text(note)}` : ""} (${ddmmyyyy()}${by ? `, ${by}` : ""})`;
    const fields = action === "on_sale"
      ? { "Availability Status": "Available", "Selling Price": null, "Item Condition": conditionWith(stamp, text(f["Item Condition"])) }
      : { "Availability Status": "Void", "Item Condition": conditionWith(stamp, text(f["Item Condition"])) };
    await airtable.update(UNITS, unitId, fields);
    return { item_id: text(f["Item ID"]), action: TROUBLE_ACTIONS[action] };
  }

  return {
    describeCancel,
    cancelOrder,
    announce,
    decide,
    match,
    receive,
    notComing,
    creditInvoice,
    sellerReturnStep,
    tick,
    list,
    get: getReturn,
    openByUnit,
    troubled,
    resolveTroubled,
    locationChoices,
    learnBarcode
  };
}

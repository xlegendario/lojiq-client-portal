// admin/externalSalesCreate.js
//
// A new External Sale, made from the WMS's Create Outbound (block 2 of the
// plan, 22-09-2026). The WMS sends the buyer, the units, the total price and
// the parcels; everything that decides something happens here, once:
//
//   - the total is spread over the pairs by their purchase price excl. VAT,
//     so a pair bought for 500 and one for 100 both make the same margin in
//     percent (500 -> 550, 100 -> 110)
//   - each pair's selling VAT follows its purchase and the buyer
//     (sellingVatType)
//   - the buyer must have what an invoice needs
//   - the deal, its pairs and its parcels go into Supabase, the units are
//     Reserved in Airtable, and the invoice is made and mailed
//
// The WMS shows the preview from the same code before anything is made, so
// what Dario sees is exactly what gets invoiced.

import { ExternalSalesError, dealId, round2, saleMoney, sellingVatType } from "./externalSalesSync.js";
import { trackingList } from "./adminForwarding.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const UNIT_FIELDS = [
  "Item ID", "Product Name", "SKU", "Size", "VAT Type", "Final Purchase Price", "Final Purchase Price (ex. VAT)",
  "Picture", "Availability Status"
];

/*
 * The total spread over the pairs by weight (their purchase excl. VAT), in
 * whole cents that add up to the total exactly. The cents left over after
 * rounding down go to the pairs whose share was cut most (largest
 * remainder), so the result does not depend on the order of the pairs.
 * Without any purchase price the split is even.
 */
export function spreadPrices(total, weights) {
  const cents = Math.round(Number(total) * 100);
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? w.map((x) => (cents * x) / sum) : w.map(() => cents / w.length);

  const floors = shares.map(Math.floor);
  let left = cents - floors.reduce((a, b) => a + b, 0);

  const order = shares
    .map((share, i) => ({ i, frac: share - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }

  return floors.map((c) => c / 100);
}

// A pair from its Inventory Unit, with the purchase fixed as it is now.
export function pairFromUnit(id, fields) {
  const vat = text(fields["VAT Type"]);
  const purchaseVat = ["Margin", "VAT0", "VAT21"].includes(vat) ? vat : null;
  const price = purchaseVat === "VAT21" ? fields["Final Purchase Price (ex. VAT)"] : fields["Final Purchase Price"];

  return {
    inventory_unit_record_id: id,
    item_id: text(fields["Item ID"]) || null,
    sku: text(fields["SKU"]) || null,
    size: text(fields["Size"]) || null,
    product_name: text(fields["Product Name"]) || null,
    image_url: text(first(fields["Picture"])?.thumbnails?.small?.url || first(fields["Picture"])?.url) || null,
    purchase_vat_type: purchaseVat,
    purchase_price_ex_vat: round2(price)
  };
}

/*
 * Everything the outbound will be, or every reason it cannot be made yet -
 * all at once, so one look says what to fix.
 *
 * buyer   a row of public.buyers
 * units   Map of Inventory Unit id -> fields
 * parcels [{ tracking_number, label_url?, label_filename? }]
 */
export function planOutbound({ buyer, unitIds, units, total, parcels = [] }) {
  const problems = [];

  if (!buyer) {
    problems.push("Choose the buyer.");
  } else {
    const name = text(buyer.company_name) || text(buyer.full_name);
    if (!name) problems.push("The buyer has no name.");
    if (!text(buyer.email)) problems.push("The buyer has no email address; the invoice is sent there.");
    if (!text(buyer.address) || !text(buyer.zipcode) || !text(buyer.city)) problems.push("The buyer's address is incomplete.");
    if (!text(buyer.country_code)) problems.push("The buyer has no country.");
  }

  const ids = [...new Set((unitIds || []).filter(Boolean))];
  if (!ids.length) problems.push("Add at least one pair.");
  if (ids.length !== (unitIds || []).filter(Boolean).length) problems.push("The same pair is in the list twice.");

  const pairs = [];
  for (const id of ids) {
    const fields = units.get(id);
    if (!fields) {
      problems.push(`Unit ${id} is not in Inventory Units.`);
      continue;
    }

    const pair = pairFromUnit(id, fields);
    const name = pair.item_id || pair.sku || id;
    const status = text(fields["Availability Status"]);

    if (status !== "Available") problems.push(`${name} is ${status || "not available"}, not Available.`);
    if (!pair.purchase_vat_type) problems.push(`${name} has no VAT Type in Inventory Units.`);
    if (!(pair.purchase_price_ex_vat > 0)) problems.push(`${name} has no purchase price in Inventory Units.`);

    pairs.push(pair);
  }

  const totalPrice = round2(total);
  if (!(totalPrice > 0)) problems.push("Enter the total selling price.");

  const prices = pairs.length && totalPrice > 0 ? spreadPrices(totalPrice, pairs.map((p) => p.purchase_price_ex_vat)) : pairs.map(() => 0);

  const tagged = pairs.map((pair, i) => {
    const sellingVat = sellingVatType(pair.purchase_vat_type, { buyer_country_code: buyer?.country_code, buyer_vat_id: buyer?.vat_id });
    const priced = { ...pair, selling_price: prices[i], selling_vat_type: sellingVat };
    const money = saleMoney({ total_selling_price: prices[i], shipping_costs: 0 }, [priced]);
    return { ...priced, profit: money.profit };
  });

  // Parcels: a label always has its tracking number (for Aftership), and a
  // number is on the deal once.
  const seen = new Set();
  const cleanParcels = [];
  for (const [i, parcel] of (parcels || []).entries()) {
    const tracking = trackingList(parcel?.tracking_number)[0] || "";
    if (!tracking && parcel?.label_url) problems.push(`Label ${i + 1} has no tracking number.`);
    if (tracking && !/^[A-Za-z0-9-]{6,40}$/.test(tracking)) problems.push(`"${tracking}" is not a tracking number.`);
    if (tracking && seen.has(tracking)) problems.push(`${tracking} is in the parcels twice.`);
    if (!tracking && !parcel?.label_url) continue;
    seen.add(tracking);
    cleanParcels.push({ tracking_number: tracking || null, label_url: parcel?.label_url || null, label_filename: parcel?.label_filename || null });
  }

  const money = saleMoney({ total_selling_price: totalPrice, shipping_costs: 0 }, tagged);
  const routes = [...new Set(tagged.map((p) => p.selling_vat_type).filter(Boolean))];

  return {
    ok: problems.length === 0,
    problems,
    pairs: tagged,
    parcels: cleanParcels,
    totals: {
      pairs: tagged.length,
      selling: totalPrice,
      selling_ex_vat: money.selling_ex_vat,
      purchase: money.purchase,
      profit: money.profit,
      invoices: routes.length
    }
  };
}

/*
 * deps:
 *   db         createSupabaseRest
 *   airtable   byIds, update (main base)
 *   invoicing  createExternalSalesInvoicing
 */
export function createOutboundMaker({ db, airtable, invoicing, payments = null }) {
  async function loadBuyer(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id))) return null;
    const [buyer] = await db.get(`buyers?select=*&id=eq.${text(id)}`);
    return buyer || null;
  }

  async function plan(input) {
    const buyer = await loadBuyer(input.buyer_id);
    const unitIds = (input.unit_ids || []).map(text).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id));
    const units = unitIds.length ? await airtable.byIds("Inventory Units", unitIds, UNIT_FIELDS) : new Map();
    return { buyer, plan: planOutbound({ buyer, unitIds, units, total: input.total_selling_price, parcels: input.parcels }) };
  }

  async function preview(input) {
    const { buyer, plan: p } = await plan(input);
    return { ...p, buyer: buyer ? { id: buyer.id, name: text(buyer.company_name) || text(buyer.full_name), country_code: buyer.country_code, vat_id: buyer.vat_id } : null };
  }

  /*
   * Makes the outbound. The deal is written first and the units reserved
   * after; if reserving fails the deal is taken out again, so a deal never
   * exists for units that are still for sale. The invoice comes last: when
   * it fails the deal stands and Checks shows it, with a button to retry.
   */
  async function create(input) {
    const { buyer, plan: p } = await plan(input);
    if (!p.ok) throw new ExternalSalesError(p.problems.join(" "));

    const paidBefore = input.payment?.method === "paid";
    const paidAt = paidBefore ? (text(input.payment?.paid_at) || new Date().toISOString().slice(0, 10)) : null;

    const [sale] = await db.insert("external_sales", [{
      buyer_record_id: buyer.airtable_record_id || null,
      buyer_uuid: buyer.id,
      buyer_id: `BU-${String(buyer.buyer_number).padStart(5, "0")}`,
      buyer_name: text(buyer.full_name) || text(buyer.company_name) || null,
      buyer_company: text(buyer.company_name) || null,
      buyer_email: text(buyer.email) || null,
      buyer_country: text(buyer.country) || null,
      buyer_country_code: text(buyer.country_code) || null,
      buyer_vat_id: text(buyer.vat_id) || null,
      sale_date: new Date().toISOString().slice(0, 10),
      total_selling_price: p.totals.selling,
      shipping_costs: 0,
      payment_status: paidBefore ? "paid" : "pending",
      payment_method: ["bank_transfer", "payment_link", "paid"].includes(input.payment?.method) ? input.payment.method : "bank_transfer",
      paid_amount: paidBefore ? p.totals.selling : null,
      paid_at: paidAt ? `${paidAt}T12:00:00Z` : null,
      payment_note: paidBefore ? (text(input.payment?.note) || "Paid before the outbound") : null,
      shipping_status: p.parcels.length ? "ready_to_ship" : "pending",
      labels_needed: Math.max(0, Number(input.labels_needed) || 0),
      bookkeeping_status: "to_invoice",
      legacy_selling_vat_type: p.totals.invoices === 1 ? p.pairs[0].selling_vat_type : null,
      notes: text(input.notes) || null
    }]);

    const deal = dealId(sale);

    try {
      await db.insert("external_sale_pairs", p.pairs.map(({ profit, ...pair }) => ({ ...pair, sale_id: sale.id })));
      if (p.parcels.length) {
        await db.insert("shipments", p.parcels.map((parcel) => ({ ...parcel, external_sale_id: sale.id, airtable_attachment_id: null })));
      }

      // Reserved, as the WMS always did - plus the deal it went to.
      const reserved = [];
      try {
        for (const pair of p.pairs) {
          await airtable.update("Inventory Units", pair.inventory_unit_record_id, {
            "Availability Status": "Reserved",
            "Selling Method": "Kickz Caviar",
            "External Deal ID": deal
          });
          reserved.push(pair.inventory_unit_record_id);
        }
      } catch (err) {
        for (const id of reserved) {
          await airtable.update("Inventory Units", id, { "Availability Status": "Available", "External Deal ID": "" }).catch(() => {});
        }
        throw err;
      }
    } catch (err) {
      await db.remove(`external_sales?id=eq.${sale.id}`).catch(() => {});
      throw new ExternalSalesError(`${deal} was not made: ${err.message}`, 502);
    }

    // Paid by link: the link is made first, so the invoice mail carries it.
    let linkError = "";
    if (input.payment?.method === "payment_link" && payments) {
      try {
        await payments.paymentLink(sale.id);
      } catch (err) {
        linkError = err.message;
        console.error(`[external sales] ${deal}: payment link failed:`, err.message);
      }
    }

    let invoice = null;
    let invoiceError = "";
    try {
      invoice = await invoicing.invoice(sale.id, { mail: input.mail !== false });
    } catch (err) {
      invoiceError = err.message;
      console.error(`[external sales] ${deal}: invoice failed:`, err.message);
    }

    return {
      id: sale.id,
      deal,
      pairs: p.pairs.length,
      total: p.totals.selling,
      invoice_log: invoice?.log || [],
      invoice_error: [invoiceError, linkError && `Payment link: ${linkError}`].filter(Boolean).join(" ")
    };
  }

  return { preview, create };
}

// admin/externalSalesCancel.js
//
// Taking a pair off a deal, and the money that follows (block 7 of the plan,
// 22-09-2026).
//
// A deal falls apart in more than one way, and where the shoes are decides
// what has to happen:
//
//   never shipped      the pair is still here. Back to Available, and that
//                      is the end of it.
//   return expected    it left and has to come back. The Inventory Unit
//                      carries "Need return from {buyer}" in Item Condition
//                      until someone marks it arrived; the pair is not
//                      offered again while it is away.
// A pair the buyer keeps while we take it off the bill is deliberately not
// one of the choices (23-09-2026). Crediting reverses the stock correction,
// so Rompslomp would put a pair back in stock that is never coming back.
// That case needs its own bookkeeping and waits for the next pass over
// cancelling.
//
// A partner's pair follows the same two, with one question of its own: have
// we paid the partner yet? Not paid means it was never ours, so it goes back
// on his shelf; paid means we bought it, and it stays an Inventory Unit in
// our own stock.
//
// The books follow one rule, the same one Dario uses by hand: an invoice is
// never edited. What was invoiced is credited in full, and what is left of
// the deal is invoiced again. So cancelling a pair on an invoiced deal makes
// a credit invoice and a new invoice, both with their stock correction.
//
// Money that already came in for a cancelled pair goes back by bank - never
// through Mollie - and is written down here as a refund, apart from what was
// paid, so a deal keeps showing both.

import { ExternalSalesError, dealId, round2 } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const UUID = /^[0-9a-f-]{36}$/i;

export const CANCEL_OUTCOMES = ["never_shipped", "return_expected"];

// What the pair is doing now, in the words Dario reads on the unit.
export function conditionNote(sale, outcome) {
  const buyer = text(sale.buyer_company) || text(sale.buyer_name) || "the buyer";
  return outcome === "return_expected" ? `Need return from ${buyer}` : "";
}

// The note goes in front, what was already there stays behind it: the unit's
// own history (a scuff, a missing insole) is worth more than a tidy field.
export function conditionWith(note, existing) {
  const before = text(existing);
  if (!note) return before;
  if (before.startsWith(note)) return before;
  return before ? `${note} - ${before}` : note;
}

/*
 * What cancelling these pairs does to the deal, worked out before anything
 * is written: the money left, whether the books have to be redone, and what
 * has to go back to the buyer.
 */
export function cancelPlan({ sale, pairs, pairIds, invoices = [] }) {
  const live = pairs.filter((pair) => !pair.cancelled_at);
  const chosen = live.filter((pair) => pairIds.includes(pair.id));
  const problems = [];

  if (!chosen.length) problems.push("Pick at least one pair that is still on the deal.");
  if (sale.payment_status === "cancelled") problems.push("This deal is already cancelled.");

  const priced = live.every((pair) => pair.selling_price !== null && pair.selling_price !== undefined);
  if (!priced && live.length > 1) {
    problems.push("Enter the selling price per pair first: without it there is no way to say what this pair was worth.");
  }

  const remaining = live.filter((pair) => !pairIds.includes(pair.id));
  const cancelledValue = round2(chosen.reduce((sum, pair) => sum + Number(pair.selling_price || 0), 0));
  const newTotal = remaining.length
    ? (priced ? round2(remaining.reduce((sum, pair) => sum + Number(pair.selling_price || 0), 0)) : round2(sale.total_selling_price))
    : 0;

  const openInvoices = invoices.filter((i) => i.kind === "sale" && !invoices.some((c) => c.credits_invoice_id === i.id));
  const paid = sale.payment_status === "paid" ? round2(sale.total_selling_price) : round2(sale.paid_amount);
  const refund = round2(Math.max(0, paid - round2(sale.refunded_amount) - newTotal));

  return {
    ok: !problems.length,
    problems,
    pairs: chosen,
    remaining,
    cancelled_value: cancelledValue,
    new_total: newTotal,
    // Everything invoiced is credited; what is left is invoiced again.
    credits: openInvoices.map((i) => i.invoice_number || i.rompslomp_invoice_id),
    reinvoice: Boolean(openInvoices.length && remaining.length),
    refund,
    ends_deal: !remaining.length
  };
}

/*
 * deps:
 *   db          createSupabaseRest
 *   airtable    update, byIds (main base) - Inventory Units
 *   invoicing   credit, invoice (admin/externalSalesInvoicing.js)
 */
export function createExternalSalesCancel({ db, airtable, invoicing }) {
  async function load(id) {
    if (!UUID.test(text(id))) throw new ExternalSalesError("Unknown deal.");
    const [sale] = await db.get(`external_sales?select=*&id=eq.${text(id)}`);
    if (!sale) throw new ExternalSalesError("That deal no longer exists.", 404);

    const pairs = await db.get(`external_sale_pairs?select=*&sale_id=eq.${sale.id}&order=created_at.asc`);
    const links = await db.get(`external_sale_invoice_deals?select=invoice_id&sale_id=eq.${sale.id}`);
    const invoices = links.length
      ? await db.get(`external_sale_invoices?select=*&id=in.(${links.map((l) => `"${l.invoice_id}"`).join(",")})`)
      : [];

    return { sale, pairs, invoices };
  }

  async function plan(id, pairIds = []) {
    const { sale, pairs, invoices } = await load(id);
    return cancelPlan({ sale, pairs, pairIds: pairIds.map(text), invoices });
  }

  /*
   * The unit goes back to where the pair now is. Never left half done: a
   * unit that stays Reserved on a cancelled deal is invisible stock.
   */
  async function releaseUnits(sale, pairs, outcome) {
    const note = conditionNote(sale, outcome);
    const all = pairs.map((pair) => text(pair.inventory_unit_record_id)).filter(Boolean);
    if (!all.length) return [];

    const found = await airtable.byIds("Inventory Units", all, ["Item Condition", "Payment Status"]).catch(() => new Map());
    const failed = [];

    /*
     * A partner pair goes back on the partner's shelf - but only while we
     * still owe him for it. Once it is paid the pair is ours: it stays an
     * Inventory Unit and joins our own stock. Putting a paid pair back would
     * have us buy it twice.
     */
    const toShelf = pairs.filter((pair) =>
      pair.partner_stock_id &&
      text(found.get(text(pair.inventory_unit_record_id))?.["Payment Status"]) !== "Paid");

    for (const pair of toShelf) {
      await db.patch(`partner_stock?id=eq.${pair.partner_stock_id}`, {
        status: "in_stock",
        sold_at: null,
        sold_ref: null,
        inventory_unit_id: null
      }).catch((err) => console.error(`[external sales] partner pair ${pair.partner_stock_id} not put back:`, err.message));

      if (text(pair.inventory_unit_record_id)) {
        await airtable.update("Inventory Units", text(pair.inventory_unit_record_id), {
          "Availability Status": "Inactive",
          "External Deal ID": "",
          "Item Condition": conditionWith(note, "")
        }).catch((err) => console.error(`[external sales] unit ${pair.inventory_unit_record_id} not switched off:`, err.message));
      }
    }

    const backOnShelf = new Set(toShelf.map((pair) => text(pair.inventory_unit_record_id)));
    const ids = all.filter((id) => !backOnShelf.has(id));

    if (!ids.length) return [];

    for (const id of ids) {
      const fields = { "Availability Status": "Available", "External Deal ID": "" };

      const condition = conditionWith(note, found.get(id)?.["Item Condition"]);
      if (note) fields["Item Condition"] = condition;

      try {
        await airtable.update("Inventory Units", id, fields);
      } catch (err) {
        failed.push(`${id}: ${err.message}`);
      }
    }

    return failed;
  }

  /*
   * Cancel one or more pairs. The order is deliberate: the books first,
   * because that is the part that can refuse (Rompslomp down, a VAT route it
   * cannot reverse), and a deal whose pairs are already released but whose
   * invoice still stands is the worst place to stop.
   */
  async function cancelPairs(id, { pair_ids: pairIds = [], reason = "", outcome = "", by = "" } = {}) {
    const wanted = (Array.isArray(pairIds) ? pairIds : [pairIds]).map(text).filter(Boolean);
    const { sale, pairs, invoices } = await load(id);
    const result = cancelPlan({ sale, pairs, pairIds: wanted, invoices });

    if (!result.ok) throw new ExternalSalesError(result.problems.join(" "));

    const how = CANCEL_OUTCOMES.includes(text(outcome))
      ? text(outcome)
      : ["pending", "ready_to_ship"].includes(text(sale.shipping_status)) ? "never_shipped" : "return_expected";

    const log = [];

    // 1. The books, if there are any: credit everything, keep nothing half.
    for (const invoice of invoices.filter((i) => i.kind === "sale" && !invoices.some((c) => c.credits_invoice_id === i.id))) {
      const out = await invoicing.credit(sale.id, invoice.id);
      log.push(`${out.credit} credits ${out.of}`);
    }

    // 2. The pairs come off the deal, and the money with them.
    const now = new Date().toISOString();
    for (const pair of result.pairs) {
      await db.patch(`external_sale_pairs?id=eq.${pair.id}`, {
        cancelled_at: now,
        cancel_reason: text(reason) || null,
        cancel_outcome: how
      });
    }

    const note = [
      text(sale.notes),
      `${new Date().toISOString().slice(0, 10)} - ${result.pairs.length} pair${result.pairs.length === 1 ? "" : "s"} cancelled` +
        `${text(by) ? ` by ${text(by)}` : ""}${text(reason) ? `: ${text(reason)}` : ""} (${how.replace(/_/g, " ")})`
    ].filter(Boolean).join("\n");

    const fields = {
      total_selling_price: result.new_total,
      notes: note,
      bookkeeping_status: result.ends_deal
        ? (invoices.some((i) => i.kind === "sale") ? "credited" : "not_invoiced")
        : (invoices.some((i) => i.kind === "sale") ? "to_invoice" : sale.bookkeeping_status)
    };

    if (result.ends_deal) {
      fields.shipping_status = "cancelled";
      fields.payment_status = "cancelled";
      fields.cancelled_at = now;
    } else if (sale.payment_status === "paid" && result.refund > 0) {
      // Paid more than the deal is now worth: it is open again for the
      // difference until the money has gone back.
      fields.payment_status = "partially_paid";
      fields.paid_amount = round2(sale.total_selling_price);
    }

    await db.patch(`external_sales?id=eq.${sale.id}`, fields);

    // 3. The units, wherever the pairs now are.
    const failed = await releaseUnits(sale, result.pairs, how);
    if (failed.length) log.push(`Could not update ${failed.length} Inventory Unit(s): ${failed.join("; ")}`);

    // 4. What is left of the deal gets its own invoice, as any deal does.
    if (result.reinvoice) {
      try {
        const out = await invoicing.invoice(sale.id, { mail: true });
        log.push(`New invoice ${out.invoices.map((i) => i.invoice_number).join(", ")}`);
      } catch (err) {
        log.push(`The new invoice was not made: ${err.message}. Open the deal and click Create invoice.`);
      }
    }

    if (result.refund > 0) log.push(`Refund the buyer ${result.refund.toFixed(2)} by bank, then register it on the deal.`);

    return { deal: dealId(sale), cancelled: result.pairs.length, outcome: how, refund: result.refund, log };
  }

  /*
   * Money sent back, by bank. Written down rather than worked out: Dario
   * makes the transfer, this records what went out and when.
   */
  async function registerRefund(id, { amount, date = "", note = "", by = "" } = {}) {
    const { sale } = await load(id);
    const value = round2(amount);

    if (!(value > 0)) throw new ExternalSalesError("Enter the amount that went back.");

    const paid = round2(sale.paid_amount);
    const already = round2(sale.refunded_amount);
    if (value + already > paid + 0.005) {
      throw new ExternalSalesError(`That is more than came in: ${(paid - already).toFixed(2)} is all there is to give back.`);
    }

    const when = date ? new Date(date) : new Date();
    if (Number.isNaN(when.getTime())) throw new ExternalSalesError("That is not a date.");

    const refunded = round2(already + value);
    const open = round2(round2(sale.total_selling_price) - round2(paid - refunded));

    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, {
      refunded_amount: refunded,
      refunded_at: when.toISOString(),
      paid_amount: round2(paid - value),
      // Everything that came in has gone back out: nothing is paid any more.
      payment_status: sale.payment_status === "cancelled"
        ? "cancelled"
        : open <= 0.005 ? "paid" : round2(paid - value) > 0 ? "partially_paid" : "pending",
      payment_note: [
        text(sale.payment_note),
        `${when.toISOString().slice(0, 10)} - refunded ${value.toFixed(2)} by bank${text(by) ? ` by ${text(by)}` : ""}${text(note) ? `: ${text(note)}` : ""}`
      ].filter(Boolean).join("\n")
    });

    return saved;
  }

  return { plan, cancelPairs, registerRefund };
}

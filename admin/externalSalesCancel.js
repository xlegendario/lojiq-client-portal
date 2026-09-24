// admin/externalSalesCancel.js
//
// Taking a pair off a deal, and giving money back (blocks 7 and 10, rewritten
// 24-09-2026 to Dario's own four outcomes).
//
// A cancel is always the whole pair, for the whole amount. What differs is
// where the shoe ended up, and that decides two things: whether the unit can
// be sold again, and whether the stock goes back into the books.
//
//   Return         it comes back to us - Available again, stock back
//   Store Consign  it stays at the buyer's shop and we took it over from the
//                  deal - Available again (we can sell it, he ships it for
//                  us), stock back
//   Lost           gone on the way - not sellable, and the stock stays
//                  written off, because we no longer have it
//   Written Off    the buyer keeps it (damaged, settled that way) - the same:
//                  off the bill, but the stock is really gone
//
// The unit says which of the four it is (Cancel Status), keeps the deal it
// came off (External Deal ID) and carries the story in Item Condition, so
// months later it is still clear where a pair went and why.
//
// A discount is not a cancel: the pair stays sold, only cheaper. The invoice
// is credited and written again for less, and the stock correction stays
// exactly as it was - the shoe did leave.

import { ExternalSalesError, dealId, round2 } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const UUID = /^[0-9a-f-]{36}$/i;

/*
 * The four ways a pair leaves a deal.
 *
 *   status     what the Inventory Unit's Cancel Status says
 *   available  whether it can be sold again
 *   stockBack  whether the stock correction is undone in Rompslomp
 *   toPartner  whether a partner's pair goes back on his shelf; with Store
 *              Consign we have taken it over, so it does not
 */
export const CANCEL_OUTCOMES = {
  return: { status: "Return", available: true, stockBack: true, toPartner: true, say: (buyer) => `Return from ${buyer}` },
  store_consign: { status: "Store Consign", available: true, stockBack: true, toPartner: false, say: (buyer) => `At ${buyer}` },
  lost: { status: "Lost", available: false, stockBack: false, toPartner: false, say: (buyer) => `Lost on the way to ${buyer}` },
  written_off: { status: "Written Off", available: false, stockBack: false, toPartner: false, say: (buyer) => `Written off, kept by ${buyer}` }
};

export const buyerOf = (sale) => text(sale.buyer_company) || text(sale.buyer_name) || "the buyer";

/*
 * What the unit says about itself afterwards: where the pair is, which deal
 * it came off and when. Written in front of what the unit already said, so
 * its own history survives.
 */
export function conditionNote(sale, outcome, when = new Date()) {
  const rule = CANCEL_OUTCOMES[outcome];
  if (!rule) return "";

  const day = when.toISOString().slice(0, 10).split("-").reverse().join("-");
  return `${rule.say(buyerOf(sale))} (${dealId(sale)}, ${day})`;
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

  /*
   * What a pair was worth. Older deals have the price on the deal and not on
   * the pair; with one pair on it those are the same number.
   */
  const worth = (pair) => (pair.selling_price === null || pair.selling_price === undefined
    ? (live.length === 1 ? round2(sale.total_selling_price) : 0)
    : round2(pair.selling_price));

  const cancelledValue = round2(chosen.reduce((sum, pair) => sum + worth(pair), 0));
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
 * A discount on pairs that stay sold. The buyer keeps the shoes, so the
 * stock correction is untouched - only the price drops, and with it the
 * margin and the VAT over that margin. Worked out here before anything is
 * written, the same way a cancel is.
 */
export function discountPlan({ sale, pairs, wanted = [], invoices = [] }) {
  const live = pairs.filter((pair) => !pair.cancelled_at);
  const problems = [];
  const lines = [];

  if (sale.payment_status === "cancelled") problems.push("This deal is cancelled: there is nothing left to discount.");
  if (!wanted.length) problems.push("Enter a discount on at least one pair.");

  for (const row of wanted) {
    const pair = live.find((p) => p.id === text(row.id));
    const amount = round2(row.amount);

    if (!pair) {
      problems.push("One of those pairs is no longer on this deal.");
      continue;
    }

    /*
     * Older deals carry the price on the deal and not on the pair. With one
     * pair on it that is the same number, so the discount can still be given.
     */
    const was = pair.selling_price === null || pair.selling_price === undefined
      ? (live.length === 1 ? round2(sale.total_selling_price) : 0)
      : round2(pair.selling_price);

    if (!(was > 0)) {
      problems.push(`Enter the selling price of ${pair.item_id || pair.sku || "the pair"} first: a discount is taken off a price.`);
      continue;
    }
    if (!(amount > 0)) {
      problems.push(`Enter what comes off ${pair.item_id || pair.sku || "the pair"}.`);
      continue;
    }
    if (amount >= was) {
      problems.push(`${amount.toFixed(2)} off ${pair.item_id || pair.sku || "the pair"} is its whole price of ${was.toFixed(2)}: cancel the pair instead.`);
      continue;
    }

    lines.push({
      id: pair.id,
      pair: pair.item_id || pair.sku || "",
      amount,
      reason: text(row.reason),
      was,
      becomes: round2(was - amount),
      discount_so_far: round2(round2(pair.discount) + amount)
    });
  }

  const given = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const newTotal = round2(live.reduce((sum, pair) => {
    const line = lines.find((l) => l.id === pair.id);
    return sum + (line ? line.becomes : round2(pair.selling_price));
  }, 0));

  const openInvoices = invoices.filter((i) => i.kind === "sale" && !invoices.some((c) => c.credits_invoice_id === i.id));
  const paid = sale.payment_status === "paid" ? round2(sale.total_selling_price) : round2(sale.paid_amount);

  return {
    ok: !problems.length && lines.length > 0,
    problems,
    lines,
    given,
    new_total: newTotal,
    credits: openInvoices.map((i) => i.invoice_number || i.rompslomp_invoice_id),
    // Credited and written again for less; the journal follows the new price.
    reinvoice: Boolean(openInvoices.length),
    refund: round2(Math.max(0, paid - round2(sale.refunded_amount) - newTotal))
  };
}

/*
 * deps:
 *   db          createSupabaseRest
 *   airtable    update, byIds (main base) - Inventory Units
 *   invoicing   credit, invoice (admin/externalSalesInvoicing.js)
 *   purchases   createPurchaseExpense - the purchase of a partner pair
 */
export function createExternalSalesCancel({ db, airtable, invoicing, purchases = null }) {
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
   * Every pair put where its outcome says it is: the unit gets its Cancel
   * Status, keeps the deal it came off and carries the story, and a
   * partner's pair goes back on his shelf only when it really returns to us
   * and we had not paid for it yet.
   */
  async function releaseUnits(sale, pairs, outcomes) {
    const ids = pairs.map((pair) => text(pair.inventory_unit_record_id)).filter(Boolean);
    if (!ids.length) return [];

    const found = await airtable.byIds("Inventory Units", ids, ["Item Condition", "Payment Status"]).catch(() => new Map());
    const failed = [];

    for (const pair of pairs) {
      const outcome = outcomes.get(pair.id);
      const rule = CANCEL_OUTCOMES[outcome];
      const unitId = text(pair.inventory_unit_record_id);
      if (!rule || !unitId) continue;

      const unit = found.get(unitId) || {};
      const paidToPartner = text(unit["Payment Status"]) === "Paid";

      /*
       * A partner's pair goes home only on a real return, and only while we
       * still owe him for it: once paid it is ours, and with Store Consign
       * we took it over on purpose.
       */
      if (pair.partner_stock_id && rule.toPartner && !paidToPartner) {
        if (purchases && text(pair.purchase_expense_id)) {
          await purchases
            .credit({ expenseId: text(pair.purchase_expense_id), deal: dealId(sale) })
            .catch((err) => console.error(`[external sales] the purchase of ${pair.item_id} was not credited:`, err.message));
        }

        await db.patch(`partner_stock?id=eq.${pair.partner_stock_id}`, {
          status: "in_stock",
          sold_at: null,
          sold_ref: null,
          inventory_unit_id: null
        }).catch((err) => console.error(`[external sales] partner pair ${pair.partner_stock_id} not put back:`, err.message));

        try {
          await airtable.update("Inventory Units", unitId, {
            "Availability Status": "Inactive",
            "Cancel Status": rule.status,
            "Item Condition": conditionWith(conditionNote(sale, outcome), text(unit["Item Condition"]))
          });
        } catch (err) {
          failed.push(`${pair.item_id || unitId}: ${err.message}`);
        }

        continue;
      }

      try {
        await airtable.update("Inventory Units", unitId, {
          // Sellable again, or off the shelf for good.
          "Availability Status": rule.available ? "Available" : "Inactive",
          "Cancel Status": rule.status,
          // The deal it came off stays on the unit: without it nothing says
          // which sale a lost or consigned pair belonged to.
          "Item Condition": conditionWith(conditionNote(sale, outcome), text(unit["Item Condition"]))
        });
      } catch (err) {
        failed.push(`${pair.item_id || unitId}: ${err.message}`);
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
  async function cancelPairs(id, { pairs: chosen = [], pair_ids: pairIds = [], reason = "", outcome = "", by = "" } = {}) {
    /*
     * Every pair with its own outcome: one can come back while another was
     * lost on the same deal. A plain list of ids with one outcome is taken
     * too, which is all a single-pair deal needs.
     */
    const asked = (Array.isArray(chosen) && chosen.length
      ? chosen
      : (Array.isArray(pairIds) ? pairIds : [pairIds]).map((pairId) => ({ id: pairId, outcome })))
      .map((row) => ({ id: text(row?.id), outcome: text(row?.outcome) || text(outcome) }))
      .filter((row) => row.id);

    const { sale, pairs, invoices } = await load(id);
    const result = cancelPlan({ sale, pairs, pairIds: asked.map((row) => row.id), invoices });

    if (!result.ok) throw new ExternalSalesError(result.problems.join(" "));

    const outcomes = new Map();
    for (const row of asked) {
      if (!CANCEL_OUTCOMES[row.outcome]) {
        throw new ExternalSalesError(`"${row.outcome || "nothing"}" is not one of Return, Store Consign, Lost or Written Off.`);
      }
      outcomes.set(row.id, row.outcome);
    }

    const log = [];

    /*
     * 1. The books. What was invoiced is credited in full, but the stock of
     * a pair that is gone for good stays written off: only what comes back
     * to us is put back.
     */
    const keepStockOut = result.pairs
      .filter((pair) => !CANCEL_OUTCOMES[outcomes.get(pair.id)]?.stockBack)
      .map((pair) => pair.id);

    for (const invoice of invoices.filter((i) => i.kind === "sale" && !invoices.some((c) => c.credits_invoice_id === i.id))) {
      const out = await invoicing.credit(sale.id, invoice.id, { keepStockOut });
      log.push(`${out.credit} credits ${out.of}`);
    }

    // 2. The pairs come off the deal, and the money with them.
    const now = new Date().toISOString();
    for (const pair of result.pairs) {
      await db.patch(`external_sale_pairs?id=eq.${pair.id}`, {
        cancelled_at: now,
        cancel_reason: text(reason) || null,
        cancel_outcome: outcomes.get(pair.id)
      });
    }

    // What happened, in the deal's own notes, so it reads back later.
    await db.insert("external_sale_notes", [{
      sale_id: sale.id,
      written_by: text(by) || null,
      body: `Cancelled ${result.pairs.length} pair${result.pairs.length === 1 ? "" : "s"}: ` +
        result.pairs.map((pair) => `${pair.item_id || pair.sku || "a pair"} (${CANCEL_OUTCOMES[outcomes.get(pair.id)].status})`).join(", ") +
        `${text(reason) ? ` - ${text(reason)}` : ""}`
    }]).catch(() => {});

    const fields = {
      total_selling_price: result.new_total,
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
    const failed = await releaseUnits(sale, result.pairs, outcomes);
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

    return {
      deal: dealId(sale),
      cancelled: result.pairs.length,
      outcomes: result.pairs.map((pair) => ({ pair: pair.item_id || pair.sku, outcome: outcomes.get(pair.id) })),
      refund: result.refund,
      log
    };
  }

  /*
   * Give a discount on pairs that were sold and stay sold. The invoice is
   * credited and written again for less; nothing moves in stock, because
   * nothing came back.
   */
  async function discountPairs(id, { pairs: wanted = [], reason = "", by = "" } = {}) {
    const asked = (Array.isArray(wanted) ? wanted : [wanted])
      .map((row) => ({ id: text(row?.id), amount: Number(row?.amount), reason: text(row?.reason) || text(reason) }))
      .filter((row) => row.id);

    const { sale, pairs, invoices } = await load(id);
    const result = discountPlan({ sale, pairs, wanted: asked, invoices });

    if (!result.ok) throw new ExternalSalesError(result.problems.join(" ") || "Enter a discount on at least one pair.");

    const log = [];

    // 1. The books first, as with a cancel: the old invoice off, in full.
    for (const invoice of invoices.filter((i) => i.kind === "sale" && !invoices.some((c) => c.credits_invoice_id === i.id))) {
      const out = await invoicing.credit(sale.id, invoice.id);
      log.push(`${out.credit} credits ${out.of}`);
    }

    // 2. The pairs, cheaper. What was given off is kept on the pair, so a
    // price that dropped twice still reads back as two discounts.
    const now = new Date().toISOString();
    for (const line of result.lines) {
      await db.patch(`external_sale_pairs?id=eq.${line.id}`, {
        selling_price: line.becomes,
        discount: line.discount_so_far,
        discount_reason: line.reason || null,
        discounted_at: now
      });
    }

    await db.insert("external_sale_notes", [{
      sale_id: sale.id,
      written_by: text(by) || null,
      body: `Discount ${result.given.toFixed(2)}: ` +
        result.lines.map((line) => `${line.pair || "a pair"} ${line.was.toFixed(2)} -> ${line.becomes.toFixed(2)}`).join(", ") +
        `${text(reason) ? ` - ${text(reason)}` : ""}`
    }]).catch(() => {});

    const fields = { total_selling_price: result.new_total };

    if (invoices.some((i) => i.kind === "sale")) fields.bookkeeping_status = "to_invoice";

    if (sale.payment_status === "paid" && result.refund > 0) {
      fields.payment_status = "partially_paid";
      fields.paid_amount = round2(sale.total_selling_price);
    }

    await db.patch(`external_sales?id=eq.${sale.id}`, fields);

    // 3. The new, lower invoice.
    if (result.reinvoice) {
      try {
        const out = await invoicing.invoice(sale.id, { mail: true });
        log.push(`New invoice ${out.invoices.map((i) => i.invoice_number).join(", ")}`);
      } catch (err) {
        log.push(`The new invoice was not made: ${err.message}. Open the deal and click Create invoice.`);
      }
    }

    if (result.refund > 0) log.push(`Refund the buyer ${result.refund.toFixed(2)} by bank, then register it on the deal.`);

    return { deal: dealId(sale), given: result.given, new_total: result.new_total, refund: result.refund, log };
  }

  /*
   * Money sent back, by bank. Written down rather than worked out: Dario
   * makes the transfer, this records what went out and when.
   */
  async function registerRefund(id, { amount, date = "", note = "", by = "" } = {}) {
    const { sale } = await load(id);
    const value = round2(amount);

    if (!(value > 0)) throw new ExternalSalesError("Enter the amount that went back.");

    // paid_amount is what is still held: every refund already came off it,
    // so that alone is the ceiling, however often money went back before.
    const paid = round2(sale.paid_amount);
    const already = round2(sale.refunded_amount);
    if (value > paid + 0.005) {
      throw new ExternalSalesError(`That is more than came in: ${paid.toFixed(2)} is all there is to give back.`);
    }

    const when = date ? new Date(date) : new Date();
    if (Number.isNaN(when.getTime())) throw new ExternalSalesError("That is not a date.");

    const refunded = round2(already + value);
    const left = round2(paid - value);
    const open = round2(round2(sale.total_selling_price) - left);

    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, {
      refunded_amount: refunded,
      refunded_at: when.toISOString(),
      paid_amount: round2(paid - value),
      // Everything that came in has gone back out: nothing is paid any more.
      payment_status: sale.payment_status === "cancelled"
        ? "cancelled"
        : open <= 0.005 ? "paid" : left > 0 ? "partially_paid" : "pending",
      payment_note: [
        text(sale.payment_note),
        `${when.toISOString().slice(0, 10)} - refunded ${value.toFixed(2)} by bank${text(by) ? ` by ${text(by)}` : ""}${text(note) ? `: ${text(note)}` : ""}`
      ].filter(Boolean).join("\n")
    });

    return saved;
  }

  return { plan, cancelPairs, discountPairs, registerRefund };
}

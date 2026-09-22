// admin/externalSalesPayments.js
//
// Getting paid for an External Sale (block 5 of the plan, 22-09-2026).
//
//   Bank transfer  the default. Dario links the ING payment to the invoice in
//                  Rompslomp, as he always has; this reads the invoice's
//                  payment status there and marks the deal paid. Rompslomp is
//                  the one truth: it is never overruled from here, only
//                  followed - a deal marked paid by hand is not set back.
//   Payment link   a Mollie payment link through a row in Airtable's Payment
//                  Batches (field "External Deal IDs"), the same batches and
//                  webhook as store orders and Member WTBs. The webhook marks
//                  the deal paid; the payout reaches the books through the
//                  settlement, as for everything else paid through Mollie.
//   Mark as paid   by hand, with a date, the amount and a note: cash, or a
//                  transfer seen on the bank before Rompslomp has it. Less
//                  than the deal makes it "partially paid".

import { ExternalSalesError, dealId, round2 } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const UUID = /^[0-9a-f-]{36}$/i;
export const PAYMENT_BATCHES = "Payment Batches";

// What a manual payment makes the deal: paid when it covers the deal.
export function paymentAfter(sale, amount) {
  const total = round2(sale.total_selling_price);
  const before = sale.payment_status === "partially_paid" ? round2(sale.paid_amount) : 0;
  const received = round2(before + round2(amount));
  if (!(round2(amount) > 0)) throw new ExternalSalesError("Enter the amount that came in.");
  return received + 0.005 >= total
    ? { payment_status: "paid", paid_amount: total }
    : { payment_status: "partially_paid", paid_amount: received };
}

/*
 * What Rompslomp says about a deal's invoices: paid when every sale invoice
 * that is not credited is paid, partly when some money has come in.
 */
export function paymentFromInvoices(sale, invoices) {
  const open = invoices.filter((i) => i.payment_status !== undefined);
  if (!open.length) return null;
  if (open.every((i) => i.payment_status === "paid")) return { payment_status: "paid" };

  const total = open.reduce((sum, i) => sum + Number(i.price_with_vat || 0), 0);
  const outstanding = open.reduce((sum, i) => sum + Number(i.open_amount ?? i.price_with_vat ?? 0), 0);
  if (outstanding + 0.005 < total) return { payment_status: "partially_paid", paid_amount: round2(total - outstanding) };
  return null;
}

/*
 * deps:
 *   db         createSupabaseRest
 *   airtable   create, update (main base) - Payment Batches
 *   rompslomp  createRompslomp (getInvoice)
 *   mollie     (path, { method, body }) -> JSON, the Mollie API
 *   links      { redirectUrl, webhookUrl }
 */
export function createExternalSalesPayments({ db, airtable, rompslomp, mollie, links = {} }) {
  async function saleById(id) {
    if (!UUID.test(text(id))) throw new ExternalSalesError("Unknown deal.");
    const [sale] = await db.get(`external_sales?select=*&id=eq.${text(id)}`);
    if (!sale) throw new ExternalSalesError("That deal no longer exists.", 404);
    return sale;
  }

  async function saleInvoices(saleId) {
    const links = await db.get(`external_sale_invoice_deals?select=invoice_id&sale_id=eq.${saleId}`);
    if (!links.length) return [];
    const rows = await db.get(`external_sale_invoices?select=*&id=in.(${links.map((l) => `"${l.invoice_id}"`).join(",")})`);
    return rows.filter((i) => i.kind === "sale" && !rows.some((c) => c.credits_invoice_id === i.id));
  }

  /*
   * Follows Rompslomp for every deal still waiting for money. Only ever
   * moves a deal forward (to partly paid or paid), never back.
   */
  async function checkRompslomp({ limit = 60 } = {}) {
    const waiting = await db.get(`external_sales?select=*&payment_status=in.(pending,partially_paid)&bookkeeping_status=eq.invoiced&order=payment_checked_at.asc.nullsfirst&limit=${limit}`);
    const changed = [];
    const errors = [];

    for (const sale of waiting) {
      try {
        const rows = await saleInvoices(sale.id);
        const invoices = [];
        for (const row of rows) invoices.push(await rompslomp.getInvoice(row.rompslomp_invoice_id));

        const next = paymentFromInvoices(sale, invoices.filter(Boolean));
        const fields = { payment_checked_at: new Date().toISOString() };

        if (next?.payment_status === "paid") {
          Object.assign(fields, { payment_status: "paid", paid_at: new Date().toISOString(), paid_amount: round2(sale.total_selling_price), payment_method: sale.payment_method || "bank_transfer" });
        } else if (next?.payment_status === "partially_paid" && Number(next.paid_amount) > Number(sale.paid_amount || 0)) {
          Object.assign(fields, { payment_status: "partially_paid", paid_amount: next.paid_amount });
        }

        await db.patch(`external_sales?id=eq.${sale.id}`, fields);
        if (fields.payment_status) changed.push({ deal: dealId(sale), to: fields.payment_status });
      } catch (err) {
        errors.push({ deal: dealId(sale), message: err.message });
      }
    }

    return { checked: waiting.length, changed, errors };
  }

  async function markPaid(id, { date, amount, note } = {}) {
    const sale = await saleById(id);
    if (sale.payment_status === "paid") throw new ExternalSalesError("This deal is already paid.");
    if (sale.payment_status === "cancelled") throw new ExternalSalesError("This deal is cancelled.");

    const value = amount === undefined || amount === "" ? round2(sale.total_selling_price) - (sale.payment_status === "partially_paid" ? round2(sale.paid_amount) : 0) : Number(String(amount).replace(",", "."));
    const next = paymentAfter(sale, value);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(text(date)) ? text(date) : new Date().toISOString().slice(0, 10);
    const noteLine = [text(note), `${next.payment_status === "paid" ? "Paid" : "Part paid"}: €${round2(value).toFixed(2)} on ${day}`].filter(Boolean).join(" - ");

    const [saved] = await db.patch(`external_sales?id=eq.${sale.id}`, {
      ...next,
      paid_at: next.payment_status === "paid" ? `${day}T12:00:00Z` : sale.paid_at,
      payment_method: sale.payment_method || "bank_transfer",
      payment_note: [text(sale.payment_note), noteLine].filter(Boolean).join("\n")
    });
    return saved;
  }

  /*
   * A Mollie payment link for what is still open on the deal. One live link
   * per deal: asking again gives the same one; `fresh` archives it and makes
   * a new one (for a changed amount, or a buyer who lost it).
   */
  async function paymentLink(id, { fresh = false } = {}) {
    const sale = await saleById(id);
    if (sale.payment_status === "paid") throw new ExternalSalesError("This deal is already paid.");
    if (sale.payment_status === "cancelled") throw new ExternalSalesError("This deal is cancelled.");

    if (sale.payment_link_url && !fresh) return { url: sale.payment_link_url, reused: true };

    if (sale.mollie_link_id) {
      await mollie(`/payment-links/${encodeURIComponent(sale.mollie_link_id)}`, { method: "PATCH", body: { archived: true } }).catch((err) => {
        console.error(`[external sales] ${dealId(sale)}: old link not archived:`, err.message);
      });
      if (sale.payment_batch_id) await airtable.update(PAYMENT_BATCHES, sale.payment_batch_id, { "Payment Status": "Cancelled" }).catch(() => {});
    }

    const open = round2(Number(sale.total_selling_price) - (sale.payment_status === "partially_paid" ? Number(sale.paid_amount || 0) : 0));
    if (!(open > 0)) throw new ExternalSalesError("Nothing is left to pay on this deal.");

    const deal = dealId(sale);
    const batch = await airtable.create(PAYMENT_BATCHES, {
      "Amount": open,
      "Payment Status": "Pending",
      "Payment Provider": "Mollie",
      "Order Numbers": deal,
      "External Deal IDs": deal
    });
    const batchNumber = text(batch?.fields?.["Batch ID"]) || batch.id;

    const link = await mollie("/payment-links", {
      method: "POST",
      body: {
        amount: { currency: "EUR", value: open.toFixed(2) },
        // The webhook finds the batch by the link; the PAYB number is also
        // what the settlement shows for this payment.
        description: `Kickz Caviar ${deal} ${batchNumber}`,
        redirectUrl: links.redirectUrl,
        webhookUrl: links.webhookUrl
      }
    });

    const url = link?._links?.paymentLink?.href;
    if (!link?.id || !url) throw new ExternalSalesError("Mollie made no payment link.", 502);

    await airtable.update(PAYMENT_BATCHES, batch.id, {
      "Payment Status": "Awaiting Payment",
      "Payment Link": url,
      "Mollie Payment Link ID": link.id
    });

    await db.patch(`external_sales?id=eq.${sale.id}`, {
      payment_method: "payment_link",
      payment_batch_id: batch.id,
      payment_link_url: url,
      mollie_link_id: link.id
    });

    return { url, reused: false, batch: batchNumber };
  }

  // The deals a paid Payment Batch settles, by their EXTD numbers.
  async function settleFromBatch(dealIds, { molliePaymentId = "" } = {}) {
    const numbers = (dealIds || []).map((d) => Number(String(d).replace(/\D/g, ""))).filter((n) => n > 0);
    if (!numbers.length) return [];
    const sales = await db.get(`external_sales?select=*&deal_number=in.(${numbers.join(",")})`);
    const settled = [];
    for (const sale of sales) {
      if (sale.payment_status === "paid") continue;
      await db.patch(`external_sales?id=eq.${sale.id}`, {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        paid_amount: round2(sale.total_selling_price),
        payment_method: "payment_link",
        payment_note: [text(sale.payment_note), `Paid through Mollie${molliePaymentId ? ` (${molliePaymentId})` : ""}`].filter(Boolean).join("\n")
      });
      settled.push(dealId(sale));
    }
    return settled;
  }

  return { checkRompslomp, markPaid, paymentLink, settleFromBatch };
}

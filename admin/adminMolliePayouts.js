// admin/adminMolliePayouts.js
//
// Mollie payouts (block 8 of the External Sales plan, 22-09-2026).
//
// Mollie pays out once a day: one amount on the ING, with the payments of
// store orders, Member WTBs and External Sales in it. To book that one bank
// line in Rompslomp, Dario has to know which invoices it covers and what the
// Mollie costs were. That is what this screen answers, per payout:
//
//   what came in    every payment, with the batch it belongs to and the
//                   invoice number of every order, want-to-buy or deal on it
//   what it cost    Mollie's fees, the difference to book as costs
//   what is loose   payments no batch knows (a link made by hand in the
//                   Mollie dashboard), so nothing stays unexplained
//
// Read-only towards Mollie and Airtable; the only thing it writes is the
// note that a payout has been booked (Supabase mollie_payouts).

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const money = (value) => {
  const raw = value && typeof value === "object" ? value.value : value;
  const number = Number(raw);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
};
const firstDate = (...values) => {
  for (const value of values) {
    const date = new Date(text(value));
    if (text(value) && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
};

export class PayoutsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Gross and fees out of a settlement's periods, as the settlement sync reads
// them; the net is what lands on the bank.
export function settlementMoney(settlement) {
  let gross = 0;
  let fees = 0;
  let invoiceReference = "";

  const periods = settlement?.periods;
  if (periods && typeof periods === "object" && !Array.isArray(periods)) {
    for (const year of Object.values(periods)) {
      for (const month of Object.values(year || {})) {
        for (const row of month?.revenue || []) gross += Number(row?.amountGross?.value ?? row?.amountNet?.value ?? 0) || 0;
        for (const row of month?.costs || []) fees += Number(row?.amountGross?.value ?? row?.amountNet?.value ?? 0) || 0;
        if (!invoiceReference && month?.invoiceReference) invoiceReference = text(month.invoiceReference);
      }
    }
  }

  return {
    gross: Math.round(gross * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    net: money(settlement?.amount),
    invoice_reference: invoiceReference
  };
}

// Which batch a payment in a payout belongs to: its payment id, the link it
// was paid through, or the PAYB number in its description.
export function batchForPayment(index, payment) {
  const byId = index.byPayment.get(text(payment?.id));
  if (byId) return { batch: byId, via: "payment" };

  const linkId = text(payment?.paymentLinkId);
  if (linkId && index.byLink.has(linkId)) return { batch: index.byLink.get(linkId), via: "link" };

  const number = text(payment?.description).match(/PAYB-\d+/)?.[0] || "";
  if (number && index.byNumber.has(number)) return { batch: index.byNumber.get(number), via: "description" };

  return { batch: null, via: "" };
}

/*
 * deps:
 *   airtable   select (main base): Payment Batches, Unfulfilled Orders Log, Member WTBs
 *   db         createSupabaseRest (external sales and their invoices)
 *   token      MOLLIE_REPORTING_TOKEN
 *   profileId  MOLLIE_PROFILE_ID (optional)
 */
export function createMolliePayoutsStore({ airtable, db, token = "", profileId = "", fetchImpl = fetch }) {
  const configured = Boolean(text(token));

  async function mollie(pathAndQuery) {
    if (!configured) throw new PayoutsError("Mollie Payouts need MOLLIE_REPORTING_TOKEN on this service.", 503);

    const response = await fetchImpl(`https://api.mollie.com/v2${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new PayoutsError(`Mollie said no: ${data.detail || data.title || response.status}`, 502);
    return data;
  }

  async function settlementPayments(settlementId) {
    const payments = [];
    let from = "";
    do {
      const params = new URLSearchParams({ limit: "250", sort: "asc" });
      if (from) params.set("from", from);
      if (text(profileId)) params.set("profileId", text(profileId));

      const data = await mollie(`/settlements/${encodeURIComponent(settlementId)}/payments?${params}`);
      const page = data?._embedded?.payments || [];
      payments.push(...page);

      const next = data?._links?.next?.href || "";
      const nextFrom = next ? new URL(next).searchParams.get("from") || "" : "";
      from = nextFrom && nextFrom !== from ? nextFrom : "";
    } while (from);

    return payments;
  }

  async function allBatches() {
    const records = [];
    let offset = "";
    do {
      const page = await airtable.select("Payment Batches", {
        fields: ["Batch ID", "Amount", "Payment Status", "Payment Provider", "Mollie Payment ID", "Mollie Payment Link ID", "Order Numbers", "External Deal IDs", "Linked Orders", "Linked Member WTBs", "Store", "Paid At"],
        pageSize: 100,
        offset
      });
      records.push(...page.records);
      offset = page.offset;
    } while (offset);
    return records;
  }

  function indexBatches(records) {
    const index = { byPayment: new Map(), byLink: new Map(), byNumber: new Map() };
    for (const record of records) {
      const entry = { id: record.id, ...record.fields };
      const payment = text(record.fields["Mollie Payment ID"]);
      const link = text(record.fields["Mollie Payment Link ID"]);
      if (payment.startsWith("tr_")) index.byPayment.set(payment, entry);
      if (link || payment.startsWith("pl_")) index.byLink.set(link || payment, entry);
      if (text(record.fields["Batch ID"])) index.byNumber.set(text(record.fields["Batch ID"]), entry);
    }
    return index;
  }

  // The invoice numbers behind a batch: store orders and want-to-buys from
  // Airtable, External Sales from Supabase.
  async function invoicesForBatches(batches) {
    const orderIds = [...new Set(batches.flatMap((b) => b["Linked Orders"] || []))];
    const wtbIds = [...new Set(batches.flatMap((b) => b["Linked Member WTBs"] || []))];
    const dealNumbers = [...new Set(batches.flatMap((b) => text(b["External Deal IDs"]).match(/EXTD-\d+/gi) || []))]
      .map((d) => Number(d.replace(/\D/g, "")))
      .filter((n) => n > 0);

    const orders = orderIds.length ? await airtable.byIds("Unfulfilled Orders Log", orderIds, ["Order ID", "Shopify Order Number", "Store Name", "Rompslomp Invoice Number", "Invoice Price (VAT Included)"]) : new Map();
    const wtbs = wtbIds.length ? await airtable.byIds("Member WTBs", wtbIds, ["Member WTB ID", "Invoice Price", "Final Buying Price"]) : new Map();

    const deals = dealNumbers.length
      ? await db.get(`external_sales?select=id,deal_number,total_selling_price,buyer_company,buyer_name,external_sale_invoice_deals(external_sale_invoices(invoice_number,kind))&deal_number=in.(${dealNumbers.join(",")})`)
      : [];

    const dealsByNumber = new Map(deals.map((d) => [d.deal_number, d]));
    return { orders, wtbs, dealsByNumber };
  }

  function linesForBatch(batch, { orders, wtbs, dealsByNumber }) {
    const lines = [];

    for (const id of batch["Linked Orders"] || []) {
      const f = orders.get(id) || {};
      lines.push({
        kind: "order",
        what: text(f["Order ID"]) || id,
        who: text(Array.isArray(f["Store Name"]) ? f["Store Name"][0] : f["Store Name"]),
        invoice: text(f["Rompslomp Invoice Number"]),
        amount: money(f["Invoice Price (VAT Included)"])
      });
    }

    for (const id of batch["Linked Member WTBs"] || []) {
      const f = wtbs.get(id) || {};
      lines.push({
        kind: "member_wtb",
        what: text(f["Member WTB ID"]) || id,
        who: "",
        invoice: "",
        amount: money(f["Invoice Price"] ?? f["Final Buying Price"])
      });
    }

    for (const deal of text(batch["External Deal IDs"]).match(/EXTD-\d+/gi) || []) {
      const row = dealsByNumber.get(Number(deal.replace(/\D/g, "")));
      const invoices = (row?.external_sale_invoice_deals || [])
        .map((l) => l.external_sale_invoices)
        .filter((i) => i && i.kind === "sale")
        .map((i) => i.invoice_number);
      lines.push({
        kind: "external_sale",
        what: deal.toUpperCase(),
        who: text(row?.buyer_company) || text(row?.buyer_name),
        invoice: [...new Set(invoices)].join(", "),
        amount: money(row?.total_selling_price)
      });
    }

    return lines;
  }

  async function booked(ids) {
    if (!ids.length) return new Map();
    const rows = await db.get(`mollie_payouts?select=*&settlement_id=in.(${ids.map((id) => `"${id}"`).join(",")})`);
    return new Map(rows.map((row) => [row.settlement_id, row]));
  }

  async function list({ limit = 40 } = {}) {
    const data = await mollie(`/settlements?limit=${Math.min(Number(limit) || 40, 250)}`);
    const settlements = (data?._embedded?.settlements || []).filter((s) => text(s?.id) && text(s?.id) !== "next");
    const notes = await booked(settlements.map((s) => text(s.id)));

    return settlements.map((s) => {
      const amounts = settlementMoney(s);
      const note = notes.get(text(s.id));
      return {
        id: text(s.id),
        reference: text(s.reference),
        status: text(s.status),
        payout_date: firstDate(s.paidOutAt, s.settledAt, s.createdAt),
        ...amounts,
        booked_at: note?.booked_at || null,
        note: note?.note || ""
      };
    });
  }

  /*
   * One payout, with every payment in it placed: which batch, which orders
   * or deals, and their invoice numbers. What no batch knows is listed
   * apart - those are the links made by hand in Mollie.
   */
  async function get(settlementId) {
    if (!/^[\w.-]+$/.test(text(settlementId))) throw new PayoutsError("Unknown payout.");

    const settlement = await mollie(`/settlements/${encodeURIComponent(text(settlementId))}`);
    const payments = await settlementPayments(text(settlementId));
    const index = indexBatches(await allBatches());

    const matched = payments.map((payment) => ({ payment, ...batchForPayment(index, payment) }));
    const batches = [...new Set(matched.map((m) => m.batch).filter(Boolean))];
    const lookups = await invoicesForBatches(batches);

    const rows = matched.map(({ payment, batch, via }) => ({
      payment_id: text(payment?.id),
      amount: money(payment?.amount),
      settlement_amount: money(payment?.settlementAmount),
      method: text(payment?.method),
      paid_at: firstDate(payment?.paidAt, payment?.createdAt),
      description: text(payment?.description),
      matched_by: via,
      batch: batch ? text(batch["Batch ID"]) || batch.id : "",
      provider: batch ? text(batch["Payment Provider"]) : "",
      lines: batch ? linesForBatch(batch, lookups) : []
    }));

    const amounts = settlementMoney(settlement);
    const note = (await booked([text(settlementId)])).get(text(settlementId));
    const invoices = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.invoice).filter(Boolean).flatMap((i) => i.split(", "))))];

    return {
      id: text(settlementId),
      reference: text(settlement?.reference),
      status: text(settlement?.status),
      payout_date: firstDate(settlement?.paidOutAt, settlement?.settledAt),
      ...amounts,
      payments: rows,
      unmatched: rows.filter((r) => !r.batch),
      invoices,
      // What the invoices add up to against what came in: a difference means
      // something in this payout is not on an invoice.
      invoiced_total: Math.round(rows.flatMap((r) => r.lines).reduce((sum, l) => sum + Number(l.amount || 0), 0) * 100) / 100,
      booked_at: note?.booked_at || null,
      note: note?.note || ""
    };
  }

  async function setBooked(settlementId, { booked: isBooked = true, note = "", by = "" } = {}) {
    if (!/^[\w.-]+$/.test(text(settlementId))) throw new PayoutsError("Unknown payout.");

    const [row] = await db.insert("mollie_payouts?on_conflict=settlement_id", [{
      settlement_id: text(settlementId),
      booked_at: isBooked ? new Date().toISOString() : null,
      booked_by: isBooked ? text(by) : null,
      note: text(note) || null
    }], "resolution=merge-duplicates,return=representation");

    return row;
  }

  return { configured, list, get, setBooked };
}

export function mountMolliePayouts(router, { store, audit, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof PayoutsError ? err.status : 500;
    if (status >= 500) console.error("[admin mollie payouts]", err.message);
    res.status(status).json({ error: err instanceof PayoutsError ? err.message : `Mollie Payouts failed: ${err.message}` });
  };

  router.get(["/admin/mollie-payouts", "/admin/mollie-payouts/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/mollie-payouts", async (req, res) => {
    try {
      res.json({ payouts: await store.list({ limit: req.query.limit }) });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/mollie-payouts/get", async (req, res) => {
    try {
      res.json({ payout: await store.get(text(req.query.id)) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/mollie-payouts/booked", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const saved = await store.setBooked(text(req.body?.id), { booked: req.body?.booked !== false, note: req.body?.note, by: req.admin?.name || req.admin?.email });
      await audit.record({
        actor: req.admin,
        action: saved.booked_at ? "mollie_payout_booked" : "mollie_payout_unbooked",
        source: "mollie_payouts",
        recordId: text(req.body?.id),
        label: text(req.body?.reference) || text(req.body?.id),
        details: { note: text(req.body?.note) || null }
      }).catch(() => {});
      res.json({ payout: saved });
    } catch (err) {
      send(res, err);
    }
  });
}

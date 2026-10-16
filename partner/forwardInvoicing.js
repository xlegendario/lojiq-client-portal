// partner/forwardInvoicing.js
//
// The invoice on a forward a partner made with "Generate invoice".
//
// It stays a forward: the pairs leave through forwarding_log and Pack & Ship
// like any other. What the invoice adds, in Rompslomp (Dario, 11-10-2026):
//
//   sales invoice   Kickz Caviar B.V., margin template, the total the buyer
//                   pays; "FWD-000040" on the line with the pairs under it,
//                   in the usual KC number series, mailed to the buyer
//   journal entry   "Voorraadcorrectie {invoice}" for total - fee
//   expense         the purchase from the partner, total - fee, in Payout by
//                   Kickz Caviar B.V. (admin/purchaseExpense.js), on his
//                   Seller ID as supplier
//   forward fee     settled by the invoice, so the forward is marked paid in
//                   Forwarding Payments instead of being billed to him
//
// What we keep is the fee, as margin on the sale. The partner is paid the
// purchase once the buyer has paid us; until then it waits.
//
// Built from the External Sales invoicing's parts (the same routes, accounts,
// contact rules and journal), but nothing goes into External Sales.
//
// An invoice can also stand on its own (kind "external", JXT-00004 and on):
// a sale the partner made outside our forwards, invoiced by us for him
// (Dario, 16-10-2026). It has typed lines instead of pairs, and settles the
// open fees Dario ticks - forwards and labels - instead of one forward's fee.
// Same invoice, stock correction, purchase, mail and payout as a forward's.
//
// Every Rompslomp id is written to forward_invoices as soon as it exists, and
// the invoice carries an api_reference, so a run that stops halfway is simply
// run again.

import { ROUTES, contactBody, invoiceDates, journalBody, matchContact } from "../admin/externalSalesInvoicing.js";
import { compareSizes } from "../admin/stockRefine.js";
import { displayId, forwardMoney } from "../admin/adminForwarding.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const euro = (value) => `€${round2(value).toFixed(2)}`;

export const ROUTE = "Margin";
const RETRY_AFTER_MS = 2 * 60_000;

export class InvoiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// What Rompslomp knows this invoice by, so it is found again, never made twice.
export const invoiceReference = (forward) => `${displayId(forward)}-${ROUTE}`;

// Jimmy External: the numbers Dario already used by hand end at JXT-00003.
export const EXTERNAL_PREFIX = "JXT";
export const EXTERNAL_FIRST = 4;
export const externalReference = (n) => `${EXTERNAL_PREFIX}-${String(n ?? "").padStart(5, "0")}`;

// The name an invoice goes by: its forward, or its own JXT number.
export const invoiceName = (row, forward = null) => (row?.kind === "external" ? externalReference(row.jxt_number) : displayId(forward || {}));

const MAX_LINES = 30;

/*
 * The lines Dario types for an external invoice: product, sizes (free text),
 * number of pairs and price per pair.
 */
export function cleanExternalLines(input) {
  const lines = (Array.isArray(input) ? input : [])
    .map((line) => ({
      sku: text(line?.sku).toUpperCase(),
      name: text(line?.name),
      sizes: text(line?.sizes),
      qty: Number(line?.qty),
      price_per_pair: round2(String(line?.price_per_pair ?? "").replace(",", "."))
    }))
    .filter((line) => line.sku || line.name || line.qty || line.price_per_pair);

  if (!lines.length) throw new InvoiceError("Give at least one line.");
  if (lines.length > MAX_LINES) throw new InvoiceError(`At most ${MAX_LINES} lines.`);
  for (const line of lines) {
    if (!line.sku && !line.name) throw new InvoiceError("Every line needs a product.");
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 1000) throw new InvoiceError("Every line needs a number of pairs.");
    if (!(line.price_per_pair > 0) || line.price_per_pair > 100000) throw new InvoiceError("Every line needs a price per pair.");
  }

  return lines.map((line) => ({ ...line, total: round2(line.qty * line.price_per_pair) }));
}

export function externalLineText(line) {
  const name = [line.sku, line.name].filter(Boolean).join(" ");
  const sizes = line.sizes ? ` — ${/[,;]/.test(line.sizes) ? "Sizes" : "Size"} ${line.sizes}` : "";
  return `${name}${sizes} — ${line.qty} ${line.qty === 1 ? "pair" : "pairs"} × ${euro(line.price_per_pair)} = ${euro(line.total)}`;
}

export function externalInvoiceBody({ reference, lines, contactId, buyerVatId = "", now = new Date() }) {
  const route = ROUTES[ROUTE];

  return {
    sales_invoice: {
      ...invoiceDates(now),
      payment_method: "pay_transfer",
      description: "",
      contact_id: Number(contactId),
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: route.templateId,
      vat_number: text(buyerVatId) || null,
      api_reference: `${reference}-${ROUTE}`,
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: lines.map((line) => ({
        description: reference,
        extended_description: externalLineText(line),
        price_per_unit: round2(line.total).toFixed(2),
        quantity: "1.0",
        vat_rate: "",
        vat_type_id: route.vatTypeId
      }))
    }
  };
}

/*
 * The money of one invoiced forward. The fee is the forward's fee as Finance
 * counts it (each pair its own, or the partner's standard); what the partner
 * gets is what is left.
 */
export function forwardInvoiceMoney({ forward, pairs, pricePerPair }) {
  const total = round2(Number(pricePerPair) * pairs.length);
  const fee = round2(forwardMoney({ ...forward, shipping_costs: 0 }, pairs).fee);
  return { total, fee, purchase: round2(total - fee) };
}

/*
 * The pairs under the forward number, counted per size so twenty pairs stay
 * one line: "U9060ECA New Balance 9060 — Size 40 ×2, 41 — 3 pairs × €120 = €360".
 */
export function forwardInvoiceLine(pairs, pricePerPair) {
  const sizes = new Map();
  for (const pair of pairs) sizes.set(text(pair.size) || "?", (sizes.get(text(pair.size) || "?") || 0) + 1);

  const first = pairs[0] || {};
  const name = [text(first.sku), text(first.product_name)].filter(Boolean).join(" ");
  const list = [...sizes].sort(([a], [b]) => compareSizes(a, b)).map(([size, n]) => (n > 1 ? `${size} ×${n}` : size)).join(", ");
  const n = pairs.length;

  return `${name} — ${sizes.size > 1 ? "Sizes" : "Size"} ${list} — ${n} ${n === 1 ? "pair" : "pairs"} × ${euro(pricePerPair)} = ${euro(n * Number(pricePerPair))}`;
}

export function forwardInvoiceBody({ forward, pairs, pricePerPair, contactId, buyerVatId = "", now = new Date() }) {
  const route = ROUTES[ROUTE];
  const total = round2(Number(pricePerPair) * pairs.length);

  return {
    sales_invoice: {
      ...invoiceDates(now),
      payment_method: "pay_transfer",
      description: "",
      contact_id: Number(contactId),
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: route.templateId,
      vat_number: text(buyerVatId) || null,
      api_reference: invoiceReference(forward),
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: [{
        description: displayId(forward),
        extended_description: forwardInvoiceLine(pairs, pricePerPair),
        price_per_unit: total.toFixed(2),
        quantity: "1.0",
        vat_rate: "",
        vat_type_id: route.vatTypeId
      }]
    }
  };
}

export function forwardInvoiceMail({ forward, label = "", invoiceNumber, buyer, total, to, from, replyTo, pdf }) {
  const name = text(buyer?.company_name) || text(buyer?.full_name) || "customer";
  const what = label || displayId(forward);

  return {
    to,
    from: { email: from, name: "Kickz Caviar" },
    replyTo,
    subject: `Your invoice ${invoiceNumber} for ${what}`,
    text:
      `Dear ${name},\n\n` +
      `Please find attached the invoice for ${what} (${euro(total)}).\n` +
      "Payment is due within 7 days of the invoice date; please mention the invoice number with your payment.\n\n" +
      `If you have any questions, email us at ${replyTo || "info@kickzcaviar.nl"} - replies to this address are not read.\n\n` +
      "Thank you for your business.\n\nKind regards,\nKickz Caviar",
    attachments: [{ content: pdf, type: "application/pdf", filename: `Invoice ${invoiceNumber}.pdf`, disposition: "attachment" }]
  };
}

// The partner as the supplier of the purchase, from the Sellers Database.
export function sellerFromFields(sellerId, fields = {}) {
  return {
    seller_id: text(fields["Seller ID"]) || sellerId,
    company_name: text(fields["Company Name"]),
    full_name: text(fields["Full Name"]),
    name: text(fields["Full Name"]) || text(fields["Company Name"]),
    email: text(fields["Email"]),
    address: text(fields["Address"]),
    zipcode: text(fields["Zipcode"]),
    city: text(fields["City"]),
    country_code: text(fields["Country Code"]),
    vat_id: text(fields["VAT ID"])
  };
}

/*
 * deps:
 *   db          createSupabaseRest
 *   rompslomp   createRompslomp (Kickz Caviar B.V., the sales company)
 *   purchases   createPurchaseExpense (books in Payout by Kickz Caviar B.V.)
 *   sellerOf    (sellerRecordId, sellerId) -> seller fields for the supplier
 *   sendMail    ({ to, from, replyTo, subject, text, attachments })
 *   mailFrom, replyTo
 */
export function createForwardInvoicing({ db, rompslomp, purchases, sellerOf, sendMail, mailFrom = "noreply@kickzcaviar.nl", replyTo = "info@kickzcaviar.nl", now = () => new Date() }) {
  const configured = Boolean(rompslomp?.configured);
  const running = new Set();

  async function load(id) {
    const [row] = await db.get(`forward_invoices?select=*&id=eq.${id}`);
    if (!row) throw new InvoiceError("That invoice does not exist.", 404);

    const [forward] = row.forwarding_log_id ? await db.get(`forwarding_log?select=*&id=eq.${row.forwarding_log_id}`) : [];
    const pairs = row.forwarding_log_id
      ? await db.get(`partner_stock?select=id,sku,size,product_name,forwarding_fee&forwarding_log_id=eq.${row.forwarding_log_id}&order=size.asc`)
      : [];
    const [buyer] = row.buyer_id ? await db.get(`buyers?select=*&id=eq.${row.buyer_id}`) : [];

    return { row, forward, pairs: pairs || [], buyer: buyer || null };
  }

  const save = async (id, fields) => {
    const [row] = await db.patch(`forward_invoices?id=eq.${id}`, { ...fields, updated_at: now().toISOString() });
    return row;
  };

  // The forward's invoice row, made when the partner sends the pairs.
  async function open({ forward, pairs, partner, buyerId, pricePerPair, hold = null }) {
    const money = forwardInvoiceMoney({ forward, pairs, pricePerPair });
    const first = pairs[0] || {};

    const [row] = await db.insert("forward_invoices", [{
      forwarding_log_id: forward.id,
      seller_record_id: partner.sellerRecordId,
      seller_id: partner.sellerId,
      buyer_id: buyerId,
      sku: text(first.sku).toUpperCase(),
      product_name: text(first.product_name) || null,
      pair_count: pairs.length,
      price_per_pair: round2(pricePerPair),
      total: money.total,
      fee_total: money.fee,
      purchase_total: money.purchase,
      status: hold ? "on_hold" : "to_invoice",
      hold_reason: hold ? "possible_duplicate_buyer" : null,
      possible_duplicate_of: hold?.id || null,
      buyer_payment_status: "open",
      partner_payout_status: "waiting"
    }]);

    return row;
  }

  /*
   * What a partner still owes us and an external invoice can settle: his
   * unpaid forwards (not cancelled, not invoiced) at what Forwarding Payments
   * asks for them, and his priced labels. Ones another external invoice is
   * already settling are left out.
   */
  async function openFees(sellerRecordId) {
    const seller = encodeURIComponent(sellerRecordId);
    const forwards = (await db.get(`forwarding_log?select=*&seller_record_id=eq.${seller}&payment_status=neq.paid&shipping_status=neq.cancelled&order=created_at.asc&limit=500`)) || [];

    const ids = forwards.map((f) => f.id);
    const pairs = [];
    const invoiced = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const list = ids.slice(i, i + 50).map((id) => `"${id}"`).join(",");
      pairs.push(...((await db.get(`partner_stock?select=forwarding_log_id,forwarding_fee&forwarding_log_id=in.(${list})&limit=5000`)) || []));
      for (const row of (await db.get(`forward_invoices?select=forwarding_log_id&forwarding_log_id=in.(${list})`)) || []) invoiced.add(row.forwarding_log_id);
    }

    const pending = (await db.get(`forward_invoices?select=settled_forward_ids,settled_label_ids&kind=eq.external&status=neq.invoiced&seller_record_id=eq.${seller}`).catch(() => [])) || [];
    const takenForwards = new Set(pending.flatMap((row) => row.settled_forward_ids || []));
    const takenLabels = new Set(pending.flatMap((row) => row.settled_label_ids || []));

    /*
     * Forwards Dario marked paid by hand (no note) in the last 60 days, before
     * the invoice that settled them was booked here (JXT-00003, 16-10-2026).
     * Ticking one only writes down where it was settled; it stays paid.
     */
    const since = new Date(now().getTime() - 60 * 86_400_000).toISOString();
    const byHand = (await db.get(`forwarding_log?select=*&seller_record_id=eq.${seller}&payment_status=eq.paid&payment_note=is.null&paid_at=gte.${since}&order=forwarding_number.asc&limit=500`).catch(() => [])) || [];
    const settledBefore = (await db.get(`forward_invoices?select=settled_forward_ids,settled_label_ids&kind=eq.external&seller_record_id=eq.${seller}`).catch(() => [])) || [];
    const everSettled = new Set(settledBefore.flatMap((row) => row.settled_forward_ids || []));
    const everSettledLabels = new Set(settledBefore.flatMap((row) => row.settled_label_ids || []));
    const labelsByHand = ((await db.get(`partner_labels?select=id,label_number,carrier,price,paid_at&seller_record_id=eq.${seller}&status=eq.created&payment_status=eq.paid&paid_at=gte.${since}`).catch(() => [])) || [])
      .filter((l) => !everSettledLabels.has(l.id) && l.price !== null && l.price !== undefined);
    const handIds = byHand.map((f) => f.id).filter((id) => !everSettled.has(id));
    for (let i = 0; i < handIds.length; i += 50) {
      const list = handIds.slice(i, i + 50).map((id) => `"${id}"`).join(",");
      pairs.push(...((await db.get(`partner_stock?select=forwarding_log_id,forwarding_fee&forwarding_log_id=in.(${list})&limit=5000`)) || []));
    }

    const labels = (await db.get(`partner_labels?select=id,label_number,carrier,price,payment_status,status,created_at&seller_record_id=eq.${seller}&status=eq.created&payment_status=neq.paid`).catch(() => [])) || [];

    return {
      forwards: forwards
        .filter((f) => !invoiced.has(f.id) && !takenForwards.has(f.id))
        .map((f) => ({
          id: f.id,
          name: displayId(f),
          date: f.forwarding_date || text(f.created_at).slice(0, 10),
          pairs: Number(f.pair_count) || 0,
          shipping_status: f.shipping_status,
          amount: forwardMoney(f, pairs.filter((p) => p.forwarding_log_id === f.id)).payable
        })),
      paid_by_hand: byHand
        .filter((f) => handIds.includes(f.id))
        .map((f) => ({
          id: f.id,
          name: displayId(f),
          date: f.forwarding_date || text(f.created_at).slice(0, 10),
          paid_at: f.paid_at,
          pairs: Number(f.pair_count) || 0,
          shipping_status: f.shipping_status,
          amount: forwardMoney(f, pairs.filter((p) => p.forwarding_log_id === f.id)).payable,
          already_paid: true
        })),
      labels_paid_by_hand: labelsByHand.map((l) => ({
        id: l.id,
        name: `LBL-${String(l.label_number ?? "").padStart(6, "0")}`,
        paid_at: l.paid_at,
        carrier: l.carrier,
        amount: round2(l.price),
        already_paid: true
      })),
      labels: labels
        .filter((l) => l.price !== null && l.price !== undefined && !takenLabels.has(l.id))
        .map((l) => ({ id: l.id, name: `LBL-${String(l.label_number ?? "").padStart(6, "0")}`, date: text(l.created_at).slice(0, 10), carrier: l.carrier, amount: round2(l.price) }))
    };
  }

  // The fees Dario ticked, checked against what is still open, never the page's amounts.
  async function ticked(sellerRecordId, forwardIds, labelIds, total) {
    const open = await openFees(sellerRecordId);
    const pick = (list, wanted) => {
      const ids = [...new Set((wanted || []).map(text).filter(Boolean))];
      const found = ids.map((id) => list.find((item) => item.id === id));
      if (found.some((item) => !item)) throw new InvoiceError("A fee you ticked is not open any more. Reload and tick again.");
      return found;
    };
    const forwards = pick([...open.forwards, ...(open.paid_by_hand || [])], forwardIds);
    const labels = pick([...open.labels, ...(open.labels_paid_by_hand || [])], labelIds);
    const settled = round2([...forwards, ...labels].reduce((sum, item) => sum + item.amount, 0));
    if (settled >= total) throw new InvoiceError(`The fees you ticked (${euro(settled)}) are not less than the invoice (${euro(total)}).`);
    return { forwards, labels, settled };
  }

  // What was settled, by name and amount, as it stood when booked.
  const settledItems = (forwards, labels) => [
    ...forwards.map((f) => ({ kind: "forward", id: f.id, name: f.name, amount: f.amount, ...(f.already_paid ? { already_paid: true } : {}) })),
    ...labels.map((l) => ({ kind: "label", id: l.id, name: l.name, amount: l.amount, ...(l.already_paid ? { already_paid: true } : {}) }))
  ];

  /*
   * A JXT invoice Dario already made in Rompslomp by hand (JXT-00001 to
   * -00003): the invoice is read, not made again, and not mailed again; the
   * purchase, the Voorraadcorrectie and the settled fees are booked like any
   * other. Its lines are the invoice's own.
   */
  async function importExternal({ partner, jxtNumber, invoiceNumber, settleForwardIds = [], settleLabelIds = [] }) {
    const number = Number(jxtNumber);
    if (!Number.isInteger(number) || number < 1) throw new InvoiceError("Give the JXT number, e.g. 1 for JXT-00001.");
    const [taken] = await db.get(`forward_invoices?select=id&jxt_number=eq.${number}`);
    if (taken) throw new InvoiceError(`${externalReference(number)} is already here.`);

    const invoice = await rompslomp.invoiceByNumber(invoiceNumber);
    if (!invoice) throw new InvoiceError(`Rompslomp has no invoice ${text(invoiceNumber)} (looked through the newest 1,500).`);
    const [already] = await db.get(`forward_invoices?select=id&invoice_id=eq.${encodeURIComponent(String(invoice.id))}`);
    if (already) throw new InvoiceError(`Invoice ${invoice.invoice_number} is already booked here.`);

    const total = round2(invoice.price_with_vat);
    const lines = (invoice.invoice_lines || []).map((line) => {
      const qty = Number(line.quantity) || 1;
      const price = round2(line.price_per_unit);
      return { sku: text(line.description), name: "", sizes: text(line.extended_description), qty, price_per_pair: price, total: round2(qty * price) };
    });
    const { forwards, labels, settled } = await ticked(partner.sellerRecordId, settleForwardIds, settleLabelIds, total);

    // His buyer when we know the Rompslomp contact; the invoice stands without one.
    const [buyer] = await db.get(`buyers?select=id&rompslomp_contact_id=eq.${encodeURIComponent(String(invoice.contact_id))}`);

    const [row] = await db.insert("forward_invoices", [{
      kind: "external",
      jxt_number: number,
      forwarding_log_id: null,
      seller_record_id: partner.sellerRecordId,
      seller_id: partner.sellerId,
      buyer_id: buyer?.id || null,
      sku: lines[0]?.sku || "",
      product_name: `Invoice ${invoice.invoice_number}`,
      pair_count: lines.reduce((sum, line) => sum + line.qty, 0) || 1,
      price_per_pair: total,
      total,
      fee_total: settled,
      purchase_total: round2(total - settled),
      lines,
      settled_forward_ids: forwards.map((f) => f.id),
      settled_label_ids: labels.map((l) => l.id),
      settled_items: settledItems(forwards, labels),
      rompslomp_contact_id: String(invoice.contact_id),
      invoice_id: String(invoice.id),
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.date,
      // Sent by Dario when he made it; not mailed again.
      mailed_at: invoice.published_at || `${invoice.date}T12:00:00Z`,
      status: "to_invoice",
      buyer_payment_status: "open",
      partner_payout_status: "waiting"
    }]);
    return row;
  }

  /*
   * An invoice of its own (JXT-00004 and on) for a sale the partner made
   * outside our forwards. The amounts settled are worked out here again from
   * what is still open, never taken from the page.
   */
  async function openExternal({ partner, buyerId, lines: input, settleForwardIds = [], settleLabelIds = [] }) {
    const lines = cleanExternalLines(input);
    const total = round2(lines.reduce((sum, line) => sum + line.total, 0));
    const pairs = lines.reduce((sum, line) => sum + line.qty, 0);

    const { forwards, labels, settled } = await ticked(partner.sellerRecordId, settleForwardIds, settleLabelIds, total);

    const [last] = await db.get("forward_invoices?select=jxt_number&kind=eq.external&jxt_number=not.is.null&order=jxt_number.desc&limit=1");
    let number = Math.max(EXTERNAL_FIRST, Number(last?.jxt_number || 0) + 1);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const [row] = await db.insert("forward_invoices", [{
          kind: "external",
          jxt_number: number,
          forwarding_log_id: null,
          seller_record_id: partner.sellerRecordId,
          seller_id: partner.sellerId,
          buyer_id: buyerId,
          sku: lines[0].sku || "",
          product_name: lines[0].name || null,
          pair_count: pairs,
          price_per_pair: round2(total / pairs),
          total,
          fee_total: settled,
          purchase_total: round2(total - settled),
          lines,
          settled_forward_ids: forwards.map((f) => f.id),
          settled_label_ids: labels.map((l) => l.id),
          settled_items: settledItems(forwards, labels),
          status: "to_invoice",
          buyer_payment_status: "open",
          partner_payout_status: "waiting"
        }]);
        return row;
      } catch (err) {
        // Two made at the same moment: the second takes the next number.
        if (attempt < 3 && /duplicate|unique|23505/i.test(err.message)) {
          number += 1;
          continue;
        }
        throw err;
      }
    }
  }

  /*
   * The buyer's contact in Rompslomp: the one stored on the buyer, else one
   * with the same VAT number or exactly the same name, else a new one
   * numbered with the Buyer ID. Stored on the buyer either way.
   */
  async function contactFor(buyer) {
    const stored = text(buyer.rompslomp_contact_id);
    if (stored && (await rompslomp.getContact(stored).catch(() => null))) return stored;

    let id = null;
    for (const q of [text(buyer.vat_id), text(buyer.company_name), text(buyer.full_name)].filter(Boolean)) {
      const match = matchContact(await rompslomp.searchContacts(q), buyer);
      if (match) {
        id = String(match.id);
        break;
      }
    }

    if (!id) {
      const body = contactBody(buyer);
      if (!body.contact.country_code || !body.contact.address) throw new InvoiceError("The buyer has no address or country; the invoice needs them.");
      id = String((await rompslomp.createContact(body)).id);
    }

    await db.patch(`buyers?id=eq.${buyer.id}`, { rompslomp_contact_id: id });
    return id;
  }

  async function journalFor(invoiceNumber, date, amount) {
    const description = `Voorraadcorrectie ${invoiceNumber}`;
    const existing = (await rompslomp.recentJournals()).find((j) => text(j.description) === description);
    if (existing) return existing;
    return rompslomp.createJournal(journalBody({ route: ROUTE, invoiceNumber, date, amount }));
  }

  /*
   * Does every step that is not done yet, in order. Stops at the first that
   * fails, writes down which, and leaves the rest for the next run.
   */
  async function run(id) {
    if (!configured) throw new InvoiceError("Invoicing needs ROMPSLOMP_API_TOKEN on this service.", 503);
    if (running.has(id)) return null;
    running.add(id);

    let step = "loading";

    try {
      let { row, forward, pairs, buyer } = await load(id);
      if (!["to_invoice", "failed"].includes(row.status)) return row;
      const external = row.kind === "external";
      const name = invoiceName(row, forward);
      if (!external && !forward) throw new InvoiceError("The forward is gone.");
      // A buyer is needed to make and mail the invoice; one read in has both done.
      if (!buyer && !(row.invoice_id && row.mailed_at)) throw new InvoiceError("The invoice has no buyer.");
      if (!external && pairs.length !== row.pair_count) throw new InvoiceError(`The forward has ${pairs.length} pairs, the invoice ${row.pair_count}.`);

      step = "contact";
      if (!row.rompslomp_contact_id) row = await save(id, { rompslomp_contact_id: await contactFor(buyer) });


      step = "invoice";
      if (!row.invoice_id) {
        const reference = external ? `${name}-${ROUTE}` : invoiceReference(forward);
        let invoice = await rompslomp.findInvoice(reference);
        if (!invoice) {
          invoice = await rompslomp.createInvoice(external
            ? externalInvoiceBody({ reference: name, lines: row.lines || [], contactId: row.rompslomp_contact_id, buyerVatId: buyer.vat_id, now: now() })
            : forwardInvoiceBody({ forward, pairs, pricePerPair: row.price_per_pair, contactId: row.rompslomp_contact_id, buyerVatId: buyer.vat_id, now: now() }));
        }
        if (invoice.status !== "published" || !invoice.invoice_number) invoice = await rompslomp.publishInvoice(invoice.id);

        // Saved first, whatever comes next: an invoice that exists in
        // Rompslomp must be visible here.
        row = await save(id, { invoice_id: String(invoice.id), invoice_number: invoice.invoice_number, invoice_date: invoice.date });

        if (Math.abs(round2(invoice.price_with_vat) - round2(row.total)) > 0.01) {
          throw new InvoiceError(`Invoice ${invoice.invoice_number} came out at ${euro(invoice.price_with_vat)}, the forward says ${euro(row.total)}. Check it in Rompslomp.`);
        }
      }

      step = "stock correction";
      if (!row.journal_id) {
        const journal = await journalFor(row.invoice_number, row.invoice_date, row.purchase_total);
        row = await save(id, { journal_id: String(journal.id) });
      }

      step = "purchase";
      if (!row.expense_id) {
        const seller = await sellerOf(row.seller_record_id, row.seller_id);
        const sizes = external
          ? (row.lines || []).map((line) => line.sizes).filter(Boolean).join(", ")
          : [...new Set(pairs.map((p) => text(p.size)))].join(", ");
        const product = external && text(row.product_name).startsWith("Invoice ")
          ? `${name} · ${row.product_name}`
          : external
          ? (row.lines || []).map((line) => [line.sku, line.name].filter(Boolean).join(" ")).join(" + ")
          : `${row.sku} ${text(row.product_name)}`.trim();
        const booked = await purchases.book({
          unit: { product_name: product, size: `${row.pair_count} pairs${sizes ? ` (${sizes})` : ""}`, vat_type: ROUTE, price: row.purchase_total },
          seller,
          deal: name,
          date: row.invoice_date
        });
        row = await save(id, { expense_id: booked.expense_id, expense_number: booked.expense_number || null, expense_company_id: booked.company_id });
      }

      step = "forwarding fee";
      if (!row.fee_settled_at) {
        // A forward's own fee, or every fee Dario ticked on an external one.
        const forwardIds = external ? row.settled_forward_ids || [] : [forward.id];
        for (const forwardId of forwardIds) {
          const note = external ? `Settled in ${name} (invoice ${row.invoice_number})` : `Settled in invoice ${row.invoice_number}`;
          const [current] = await db.get(`forwarding_log?select=id,payment_status&id=eq.${forwardId}`);
          // Marked paid by hand already: it keeps its date and only learns where.
          if (external && current?.payment_status === "paid") await db.patch(`forwarding_log?id=eq.${forwardId}`, { payment_note: note });
          else await db.patch(`forwarding_log?id=eq.${forwardId}`, { payment_status: "paid", paid_at: now().toISOString(), payment_note: note });
        }
        for (const labelId of external ? row.settled_label_ids || [] : []) {
          // One already marked paid by hand keeps its date.
          const [current] = await db.get(`partner_labels?select=id,payment_status&id=eq.${labelId}`);
          if (current?.payment_status !== "paid") {
            await db.patch(`partner_labels?id=eq.${labelId}`, { payment_status: "paid", paid_at: now().toISOString(), updated_at: now().toISOString() });
          }
        }
        row = await save(id, { fee_settled_at: now().toISOString() });
      }

      step = "mail";
      if (!row.mailed_at) {
        if (!text(buyer.email)) throw new InvoiceError("The buyer has no email address.");
        const pdf = (await rompslomp.pdf(row.invoice_id)).toString("base64");
        await sendMail(forwardInvoiceMail({ forward, label: name, invoiceNumber: row.invoice_number, buyer, total: row.total, to: text(buyer.email), from: mailFrom, replyTo, pdf }));
        row = await save(id, { mailed_at: now().toISOString() });
      }

      row = await save(id, { status: "invoiced", error: null });
      console.log(`[forward-invoice] ${name}: ${row.invoice_number} ${euro(row.total)}, partner gets ${euro(row.purchase_total)}`);
      return row;
    } catch (err) {
      const message = `${step}: ${err.message}`;
      console.error(`[forward-invoice] ${id} failed at ${message}`);
      await save(id, { status: "failed", error: message.slice(0, 500) }).catch(() => {});
      throw err;
    } finally {
      running.delete(id);
    }
  }

  /*
   * Every few minutes: an invoice left on "to invoice" (the service restarted
   * mid-run) is run again, and an invoiced forward whose invoice is paid in
   * Rompslomp makes the partner's money payable.
   */
  async function sweep() {
    if (!configured) return;

    const stale = new Date(now().getTime() - RETRY_AFTER_MS).toISOString();
    for (const row of await db.get(`forward_invoices?select=id&status=eq.to_invoice&updated_at=lt.${stale}&limit=20`)) {
      await run(row.id).catch(() => {});
    }

    for (const row of await db.get("forward_invoices?select=id,invoice_id,invoice_number&status=eq.invoiced&buyer_payment_status=eq.open&limit=200")) {
      try {
        const invoice = await rompslomp.getInvoice(row.invoice_id);
        if (invoice?.payment_status === "paid") {
          await save(row.id, { buyer_payment_status: "paid", buyer_paid_at: now().toISOString(), partner_payout_status: "to_pay" });
          console.log(`[forward-invoice] ${row.invoice_number} paid by the buyer; partner payout is due`);
        }
      } catch (err) {
        console.warn(`[forward-invoice] payment of ${row.invoice_number} not read:`, err.message);
      }
    }
  }

  async function pdf(row) {
    if (!row?.invoice_id) throw new InvoiceError("No invoice yet.", 404);
    return rompslomp.pdf(row.invoice_id);
  }

  /* ---------------- the admin's side ---------------- */

  // An invoice row with the names the admin reads it by.
  async function withNames(rows) {
    const ids = [...new Set(rows.flatMap((row) => [row.buyer_id, row.possible_duplicate_of]).filter(Boolean))];
    const buyers = ids.length ? await db.get(`buyers?select=id,buyer_number,company_name,full_name,email,city,country&id=in.(${ids.map((id) => `"${id}"`).join(",")})`) : [];
    const byId = new Map(buyers.map((b) => [b.id, b]));
    const describe = (b) => (b ? {
      id: b.id,
      buyer_id: b.buyer_number ? `BU-${String(b.buyer_number).padStart(5, "0")}` : "",
      name: [text(b.company_name), text(b.full_name)].filter(Boolean).join(" · "),
      email: text(b.email),
      place: [text(b.city), text(b.country)].filter(Boolean).join(", ")
    } : null);

    return rows.map((row) => ({ ...row, buyer: describe(byId.get(row.buyer_id)), duplicate: describe(byId.get(row.possible_duplicate_of)) }));
  }

  // The invoices of these forwards, by forward id.
  async function forForwards(forwardIds) {
    if (!forwardIds.length) return new Map();
    const rows = [];
    for (let i = 0; i < forwardIds.length; i += 100) {
      const list = forwardIds.slice(i, i + 100).map((id) => `"${id}"`).join(",");
      rows.push(...(await db.get(`forward_invoices?select=*&forwarding_log_id=in.(${list})`)));
    }
    return new Map((await withNames(rows)).map((row) => [row.forwarding_log_id, row]));
  }

  // Every invoiced forward with what the partner is owed, payable first.
  async function payouts() {
    const rows = await db.get("forward_invoices?select=*&order=created_at.desc&limit=1000");
    const forwardIds = rows.map((r) => r.forwarding_log_id).filter(Boolean);
    const forwards = forwardIds.length
      ? await db.get(`forwarding_log?select=id,forwarding_number,seller_name,seller_id&id=in.(${forwardIds.map((id) => `"${id}"`).join(",")})`)
      : [];
    const byId = new Map(forwards.map((f) => [f.id, f]));
    const names = new Map(((await db.get("partner_users?select=seller_record_id,name").catch(() => [])) || []).map((u) => [u.seller_record_id, text(u.name)]));
    const order = { to_pay: 0, waiting: 1, paid: 2 };

    return (await withNames(rows))
      .map((row) => ({
        ...row,
        display_id: invoiceName(row, byId.get(row.forwarding_log_id)),
        seller_name: text(byId.get(row.forwarding_log_id)?.seller_name) || names.get(row.seller_record_id) || ""
      }))
      .sort((a, b) => (order[a.partner_payout_status] ?? 3) - (order[b.partner_payout_status] ?? 3));
  }

  /*
   * Dario's answer on a held invoice. Same buyer: the invoice goes to the
   * buyer we already had, the partner is linked to that one and the
   * look-alike he just made is dropped. Different: the new buyer is a buyer
   * of its own and is never asked about again. Either way the invoice runs.
   */
  async function resolveHold(id, same, { buyers }) {
    const { row } = await load(id);
    if (row.status !== "on_hold") throw new InvoiceError("This invoice is not waiting for a decision.");

    if (same) {
      if (!row.possible_duplicate_of) throw new InvoiceError("There is no other buyer to use.");
      const made = row.buyer_id;

      await buyers.link(row.seller_record_id, row.possible_duplicate_of);
      await buyers.markChecked(row.seller_record_id, row.possible_duplicate_of);
      await save(id, { buyer_id: row.possible_duplicate_of, status: "to_invoice", hold_reason: null });

      // The forward names its buyer too; it names the right one from now on.
      const [kept] = await db.get(`buyers?select=*&id=eq.${row.possible_duplicate_of}`);
      if (kept && row.forwarding_log_id) {
        await db.patch(`forwarding_log?id=eq.${row.forwarding_log_id}`, {
          buyer_record_id: text(kept.airtable_record_id) || null,
          buyer_id: kept.buyer_number ? `BU-${String(kept.buyer_number).padStart(5, "0")}` : null,
          buyer_name: text(kept.company_name) || text(kept.full_name),
          buyer_country: text(kept.country) || null
        });
      }

      // The look-alike goes when nothing else points at it.
      const others = await db.get(`forward_invoices?select=id&buyer_id=eq.${made}&limit=1`);
      if (!others.length) {
        await db.remove(`partner_buyers?seller_record_id=eq.${encodeURIComponent(row.seller_record_id)}&buyer_id=eq.${made}`).catch(() => {});
        await db.remove(`buyers?id=eq.${made}&rompslomp_contact_id=is.null`).catch((err) => console.warn("[forward-invoice] look-alike buyer kept:", err.message));
      }
    } else {
      await buyers.markChecked(row.seller_record_id, row.buyer_id);
      await save(id, { status: "to_invoice", hold_reason: null });
    }

    return run(id);
  }

  async function setPartnerPaid(id, paid, note = "") {
    const { row } = await load(id);
    if (paid && row.partner_payout_status === "waiting") throw new InvoiceError("The buyer has not paid yet, so the partner is not owed anything yet.");

    return save(id, paid
      ? { partner_payout_status: "paid", partner_paid_at: now().toISOString(), partner_paid_note: text(note) || null }
      : { partner_payout_status: row.buyer_payment_status === "paid" ? "to_pay" : "waiting", partner_paid_at: null, partner_paid_note: null });
  }

  return { configured, open, openFees, openExternal, importExternal, run, sweep, pdf, load, forForwards, payouts, resolveHold, setPartnerPaid };
}

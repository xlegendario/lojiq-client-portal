// admin/externalSalesInvoicing.js
//
// Invoicing an External Sale in Rompslomp: the invoice(s), the journal entry
// that moves the purchase from stock to cost ("Voorraadcorrectie"), the
// buyer's contact, the mail to the buyer - and the credit that undoes it.
//
// The rules, agreed in the plan (21-09-2026):
//   One invoice per selling VAT type on the deal: margin pairs and VAT pairs
//   never share an invoice, so a mixed deal gets two, each with its own
//   journal entry over its own pairs.
//   Margin  margin template, cost account Marge (1537847149)
//   VAT21   21%, cost account Commercieel (306471935)
//   VAT0    0% reverse-charged, buyer's VAT number on it, Commercieel
//   The journal books each pair's purchase excl. VAT as it was fixed at the
//   sale (Final Purchase Price; for a VAT21 purchase its ex-VAT price).
//
// The invoice looks like the ones made by hand until now: one line, the deal
// number as its description and the pairs underneath.
//
// Safe to run again after any failure: an invoice is found back by its
// api_reference (unique in Rompslomp) before one is made, and every id is
// written to Supabase the moment Rompslomp returns it.

import { ExternalSalesError, dealId, round2 } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const ROUTES = {
  Margin: { vatTypeId: 688369464, templateId: 322464949, costAccountId: 1537847149, costAccountPath: "profit.costs.sneakers_marge_custom", lineAccount: false },
  VAT21: { vatTypeId: 701184043, templateId: null, costAccountId: 306471935, costAccountPath: "profit.costs.sneakers_custom", lineAccount: true },
  VAT0: { vatTypeId: 775036437, templateId: null, costAccountId: 306471935, costAccountPath: "profit.costs.sneakers_custom", lineAccount: true }
};

const REVENUE = { id: 589136361, path: "profit.revenue.sneakers_custom" };
const STOCK = { id: 1981496874, path: "activa.current_assets.voorraad_scout_custom" };
const ORDER = ["Margin", "VAT21", "VAT0"];

const VAT_ROUTE = { 688369464: "Margin", 701184043: "VAT21", 775036437: "VAT0" };

// Whether an invoice is about this deal: its number in the description or
// on a line - where it was put on the invoices made by hand.
export function mentionsDeal(invoice, deal) {
  const texts = [invoice?.description, ...(invoice?.invoice_lines || []).flatMap((l) => [l.description, l.extended_description])];
  return texts.some((t) => new RegExp(`\\b${deal}\\b`).test(String(t || "")));
}

// The VAT route of an invoice from its lines, or null when they differ.
export function routeOfInvoice(invoice) {
  const routes = [...new Set((invoice?.invoice_lines || []).map((l) => VAT_ROUTE[l.vat_type_id] || "?"))];
  return routes.length === 1 && routes[0] !== "?" ? routes[0] : null;
}

// Invoices are due in 7 days, always (Dario, 22-09-2026) - sent with the
// invoice so it never depends on Rompslomp's company setting. Dated in Dutch
// time, so an invoice made just after midnight is not a day off.
export const PAYMENT_DAYS = 7;

export function invoiceDates(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(now);
  const due = new Date(`${today}T12:00:00Z`);
  due.setUTCDate(due.getUTCDate() + PAYMENT_DAYS);
  return { date: today, due_date: due.toISOString().slice(0, 10) };
}

const euroText = (n) => `€${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`;

/*
 * The invoices a deal needs, or why it cannot be invoiced yet. Every reason
 * is listed at once, so one look says everything that has to be fixed.
 */
export function invoicePlanFor(sale, pairs) {
  const problems = [];

  if (sale.payment_status === "cancelled") problems.push("The deal is cancelled.");
  if (sale.bookkeeping_status !== "to_invoice") problems.push(`The deal is "${sale.bookkeeping_status}", not "to invoice".`);
  if (!pairs.length) problems.push("The deal has no pairs.");
  if (!text(sale.buyer_record_id)) problems.push("The deal has no buyer.");

  for (const pair of pairs) {
    const name = pair.item_id || pair.sku || pair.inventory_unit_record_id;
    if (!pair.purchase_vat_type) problems.push(`${name} has no purchase VAT type.`);
    if (!(Number(pair.purchase_price_ex_vat) > 0)) problems.push(`${name} has no purchase price.`);
    if (!ROUTES[pair.selling_vat_type]) problems.push(`${name} has no selling VAT type.`);
  }

  const routes = ORDER.filter((route) => pairs.some((p) => p.selling_vat_type === route));
  const priced = pairs.length > 0 && pairs.every((p) => p.selling_price !== null && p.selling_price !== undefined);
  const total = round2(sale.total_selling_price);

  if (routes.length > 1 && !priced) {
    problems.push("Margin and VAT pairs on one deal: enter the selling price of every pair, so each invoice gets its own part.");
  }

  if (priced) {
    const sum = round2(pairs.reduce((s, p) => s + Number(p.selling_price), 0));
    if (Math.abs(sum - total) > 0.005) problems.push(`The prices per pair add up to €${sum.toFixed(2)}, the deal is €${total.toFixed(2)}.`);
  }

  if (!(total > 0)) problems.push("The deal has no selling price.");
  if (routes.includes("VAT0") && !text(sale.buyer_vat_id)) problems.push("A 0% (reverse-charge) invoice needs the buyer's VAT ID.");

  const invoices = routes.map((route) => {
    const own = pairs.filter((p) => p.selling_vat_type === route);
    const amount = routes.length === 1 && !priced ? total : round2(own.reduce((s, p) => s + Number(p.selling_price || 0), 0));
    return {
      route,
      pairs: own,
      amount,
      purchase: round2(own.reduce((s, p) => s + Number(p.purchase_price_ex_vat || 0), 0)),
      priced
    };
  });

  return { ok: problems.length === 0, problems, invoices };
}

// The pairs under the deal number: "SKU — Size 41, 42 — 2 pairs × €90 = €180"
// when every pair has its price, "SKU — Size 41, 42" when only the total is known.
export function pairLines(pairs, priced) {
  const groups = new Map();

  for (const pair of pairs) {
    const key = `${text(pair.sku) || text(pair.product_name) || "—"}|${priced ? Number(pair.selling_price) : ""}`;
    if (!groups.has(key)) groups.set(key, { sku: text(pair.sku) || text(pair.product_name) || "—", price: priced ? Number(pair.selling_price) : null, sizes: [] });
    groups.get(key).sizes.push(text(pair.size) || "?");
  }

  return [...groups.values()].map((g) => {
    const sizes = `${g.sizes.length > 1 ? "Sizes" : "Size"} ${g.sizes.join(", ")}`;
    if (g.price === null) return `${g.sku} — ${sizes}`;
    const n = g.sizes.length;
    return `${g.sku} — ${sizes} — ${n} ${n === 1 ? "pair" : "pairs"} × ${euroText(g.price)} = ${euroText(round2(g.price * n))}`;
  }).join("\n");
}

export const apiReference = (sale, route) => `${dealId(sale)}-${route}`;

export function salesInvoiceBody({ sale, invoice, contactId, now = new Date() }) {
  const route = ROUTES[invoice.route];

  // VAT21 prices go to Rompslomp excl. VAT; it adds the 21% itself. Five
  // decimals, as on the invoices made by hand, so the total incl. VAT comes
  // out on the cent.
  const price = invoice.route === "VAT21" ? (invoice.amount / 1.21).toFixed(5) : invoice.amount.toFixed(2);

  const line = {
    description: dealId(sale),
    extended_description: pairLines(invoice.pairs, invoice.priced),
    price_per_unit: price,
    quantity: "1.0",
    vat_rate: "",
    vat_type_id: route.vatTypeId
  };

  if (route.lineAccount) {
    line.account_id = REVENUE.id;
    line.account_path = REVENUE.path;
  }

  return {
    sales_invoice: {
      ...invoiceDates(now),
      payment_method: "pay_transfer",
      description: "",
      contact_id: Number(contactId),
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: route.templateId,
      vat_number: text(sale.buyer_vat_id) || null,
      api_reference: apiReference(sale, invoice.route),
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: [line]
    }
  };
}

// Purchase from stock to cost; a credit books it back.
export function journalBody({ route, invoiceNumber, date, amount, reverse = false }) {
  const r = ROUTES[route];
  const cost = { account_id: r.costAccountId, account_path: r.costAccountPath };
  const stock = { account_id: STOCK.id, account_path: STOCK.path };
  const value = Number(amount).toFixed(2);

  const [debit, credit] = reverse ? [stock, cost] : [cost, stock];

  return {
    journal_entry: {
      description: `Voorraadcorrectie ${invoiceNumber}`,
      date,
      lines: [
        { ...debit, debit_amount: value, credit_amount: null },
        { ...credit, debit_amount: null, credit_amount: value }
      ]
    }
  };
}

// The credit invoice, the way the ones made by hand look: minus the same
// amount, same VAT type, "Creditfactuur voor factuur: KC...".
export function creditInvoiceBody({ original, reference, now = new Date() }) {
  const lines = (original.invoice_lines || []).map((line) => ({
    description: `Credit: ${text(line.description)}`,
    extended_description: text(line.extended_description),
    price_per_unit: (-Number(line.price_per_unit)).toFixed(5),
    quantity: String(line.quantity || "1.0"),
    vat_rate: "",
    vat_type_id: line.vat_type_id,
    ...(line.account_id ? { account_id: line.account_id, account_path: line.account_path } : {})
  }));

  return {
    sales_invoice: {
      ...invoiceDates(now),
      payment_method: "pay_transfer",
      description: `Creditfactuur voor factuur: ${original.invoice_number}`,
      contact_id: original.contact_id,
      currency: "eur",
      currency_exchange_rate: "1.0",
      template_id: original.template_id ?? null,
      vat_number: original.vat_number || null,
      api_reference: reference,
      sale_type: "supply",
      distance_sale: false,
      invoice_lines: lines
    }
  };
}

// A Rompslomp contact from the Buyers Database.
// A Rompslomp contact from a Supabase buyer, with its Buyer ID as the
// customer number - the number Rompslomp and the admin share from now on.
export function contactBody(buyer) {
  const company = text(buyer.company_name);
  const person = text(buyer.full_name);
  const address = [text(buyer.address), text(buyer.address_line2)].filter(Boolean).join(", ");

  return {
    contact: {
      is_individual: !company,
      company_name: company || null,
      contact_person_name: person || null,
      contact_person_email_address: text(buyer.email) || null,
      address: address || null,
      zipcode: text(buyer.zipcode) || null,
      city: text(buyer.city) || null,
      country_code: text(buyer.country_code).toUpperCase() || null,
      vat_number: text(buyer.vat_id) || null,
      contact_number: buyer.buyer_number ? `BU-${String(buyer.buyer_number).padStart(5, "0")}` : null
    }
  };
}

/*
 * The buyer's contact among Rompslomp's search results: same VAT number
 * first, then exactly the same name. Nothing is taken on a partial match -
 * a new contact is better than an invoice to someone else.
 */
export function matchContact(contacts, buyer) {
  const vat = text(buyer.vat_id).replace(/\s+/g, "").toUpperCase();
  const names = [text(buyer.company_name), text(buyer.full_name)].filter(Boolean).map((n) => n.toLowerCase());

  if (vat) {
    const byVat = contacts.find((c) => text(c.vat_number).replace(/\s+/g, "").toUpperCase() === vat);
    if (byVat) return byVat;
  }

  return contacts.find((c) => names.includes(text(c.company_name || c.name).toLowerCase())) || null;
}

// The invoice mail, or its reminder. A deal with a payment link carries it,
// so the buyer can pay by card or iDEAL instead of a transfer.
export function invoiceMail({ sale, invoices, to, from, replyTo, pdfs, reminder = false }) {
  const numbers = invoices.map((i) => i.invoice_number).join(" and ");
  const name = text(sale.buyer_company) || text(sale.buyer_name) || "customer";
  const link = text(sale.payment_link_url);
  const open = sale.payment_status === "partially_paid"
    ? Number(sale.total_selling_price) - Number(sale.paid_amount || 0)
    : Number(sale.total_selling_price);

  return {
    to,
    from: { email: from, name: "Kickz Caviar" },
    replyTo,
    subject: reminder ? `Reminder: invoice ${numbers} for ${dealId(sale)}` : `Your invoice ${numbers} for ${dealId(sale)}`,
    text:
      `Dear ${name},\n\n` +
      (reminder
        ? `According to our records, ${invoices.length > 1 ? "the invoices" : "the invoice"} for ${dealId(sale)} ${invoices.length > 1 ? "have" : "has"} not been paid yet; €${open.toFixed(2)} is open. ${invoices.length > 1 ? "They are" : "It is"} attached again.\n` +
          "If you have paid in the meantime, thank you - please ignore this message.\n\n"
        : `Please find attached ${invoices.length > 1 ? "the invoices" : "the invoice"} for ${dealId(sale)}.\n` +
          `Payment is due within ${PAYMENT_DAYS} days of the invoice date; please mention the invoice number with your payment.\n\n`) +
      (link ? `You can also pay online: ${link}\n\n` : "") +
      `If you have any questions, email us at ${replyTo || "info@kickzcaviar.nl"} - replies to this address are not read.\n\n` +
      "Thank you for your business.\n\nKind regards,\nKickz Caviar",
    attachments: pdfs.map((pdf, i) => ({
      content: pdf,
      type: "application/pdf",
      filename: `Invoice ${invoices[i].invoice_number}.pdf`,
      disposition: "attachment"
    }))
  };
}

/* ---------------- Rompslomp ---------------- */

export function createRompslomp({ token, companyId = "1296508534", fetchImpl = fetch }) {
  const configured = Boolean(text(token));

  async function call(path, { method = "GET", body, accept = "application/json" } = {}) {
    if (!configured) throw new ExternalSalesError("Invoicing needs ROMPSLOMP_API_TOKEN on this service.", 503);

    const response = await fetchImpl(`https://api.rompslomp.nl/api/v1/companies/${companyId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: accept },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });

    if (accept === "application/pdf") {
      if (!response.ok) throw new ExternalSalesError(`Rompslomp PDF failed (${response.status}).`, 502);
      return Buffer.from(await response.arrayBuffer());
    }

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

    if (!response.ok) throw new ExternalSalesError(`Rompslomp said no (${response.status}): ${JSON.stringify(data).slice(0, 300)}`, 502);
    return data;
  }

  return {
    configured,
    async searchContacts(q) {
      const params = new URLSearchParams({ selection: "customers", "search[q]": q, per_page: "100" });
      return (await call(`/contacts?${params}`))?.contacts || [];
    },
    async getContact(id) {
      return (await call(`/contacts/${id}`))?.contact || null;
    },
    async createContact(body) {
      return (await call("/contacts", { method: "POST", body }))?.contact;
    },
    async findInvoice(reference) {
      const params = new URLSearchParams({ "search[api_reference]": reference, per_page: "5" });
      return ((await call(`/sales_invoices?${params}`))?.sales_invoices || []).find((i) => i.api_reference === reference) || null;
    },
    async getInvoice(id) {
      return (await call(`/sales_invoices/${id}`))?.sales_invoice;
    },
    async createInvoice(body) {
      return (await call("/sales_invoices", { method: "POST", body }))?.sales_invoice;
    },
    async publishInvoice(id) {
      return (await call(`/sales_invoices/${id}`, { method: "PATCH", body: { sales_invoice: { _publish: true } } }))?.sales_invoice;
    },
    async createJournal(body) {
      return (await call("/journal_entries", { method: "POST", body }))?.journal_entry;
    },
    async invoicesOfContact(contactId) {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({ selection: "all", "search[contact_id]": String(contactId), page: String(page), per_page: "100" });
        const rows = (await call(`/sales_invoices?${params}`))?.sales_invoices || [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },
    // Newest first, so the last few hundred cover anything made this month.
    async recentJournals(pages = 3) {
      const out = [];
      for (let page = 1; page <= pages; page++) {
        const rows = (await call(`/journal_entries?page=${page}&per_page=100`))?.journal_entries || [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },
    async pdf(id) {
      return call(`/sales_invoices/${id}/pdf`, { accept: "application/pdf" });
    }
  };
}

/* ---------------- the work ---------------- */

/*
 * deps:
 *   db          createSupabaseRest
 *   airtable    byIds, update (main base) - the buyer and its contact id
 *   rompslomp   createRompslomp
 *   sendMail    ({ to, from, subject, text, attachments }) -> sends
 *   mailFrom    sender address (noreply)
 *   replyTo     where the buyer's questions go
 */
export function createExternalSalesInvoicing({ db, airtable, rompslomp, sendMail, mailFrom = "noreply@kickzcaviar.nl", replyTo = "info@kickzcaviar.nl" }) {

  async function load(id) {
    const [sale] = await db.get(`external_sales?select=*&id=eq.${id}`);
    if (!sale) throw new ExternalSalesError("That deal no longer exists.", 404);
    // A cancelled pair is off the bill; what it was invoiced for is settled
    // by its credit invoice (admin/externalSalesCancel.js).
    const pairs = await db.get(`external_sale_pairs?select=*&sale_id=eq.${sale.id}&cancelled_at=is.null&order=created_at.asc`);
    const links = await db.get(`external_sale_invoice_deals?select=invoice_id&sale_id=eq.${sale.id}`);
    const invoices = links.length ? await db.get(`external_sale_invoices?select=*&id=in.(${links.map((l) => `"${l.invoice_id}"`).join(",")})`) : [];
    return { sale, pairs, invoices };
  }

  // The deal's buyer in Supabase public.buyers: by its id, or by the Airtable
  // row the deal links to (or one merged into it).
  async function buyerOf(sale) {
    if (sale.buyer_uuid) {
      const [byId] = await db.get(`buyers?select=*&id=eq.${sale.buyer_uuid}`);
      if (byId) return byId;
    }

    const record = text(sale.buyer_record_id);
    if (!/^rec[A-Za-z0-9]{14}$/.test(record)) return null;

    const [byRecord] = await db.get(`buyers?select=*&or=(airtable_record_id.eq.${record},airtable_ext_record_id.eq.${record},airtable_aliases.cs.{${record}})&limit=1`);
    return byRecord || null;
  }

  /*
   * The buyer's contact in Rompslomp, in this order:
   *   1. the contact id stored on the buyer
   *   2. the contact of an earlier invoice to this buyer
   *   3. a contact with the same VAT number, or exactly the same name
   *   4. a new one, numbered with the Buyer ID
   * and the id is stored on the buyer, so it is looked up only once.
   */
  async function contactFor(sale, { create = true } = {}) {
    const buyer = await buyerOf(sale);
    if (!buyer) throw new ExternalSalesError("The deal's buyer is not in the buyers list.");

    const remember = async (id, how) => {
      if (create && text(buyer.rompslomp_contact_id) !== String(id)) {
        await db.patch(`buyers?id=eq.${buyer.id}`, { rompslomp_contact_id: String(id) });
      }
      return { id: String(id), how };
    };

    const stored = text(buyer.rompslomp_contact_id);
    if (stored) {
      const contact = await rompslomp.getContact(stored).catch(() => null);
      if (contact) return { id: stored, how: "stored on the buyer" };
    }

    const earlier = await db.get(
      `external_sales?select=id&buyer_uuid=eq.${buyer.id}&bookkeeping_status=in.(invoiced,credited)&limit=50`
    );
    if (earlier.length) {
      const links = await db.get(`external_sale_invoice_deals?select=invoice_id&sale_id=in.(${earlier.map((s) => `"${s.id}"`).join(",")})`);
      const invoices = links.length ? await db.get(`external_sale_invoices?select=rompslomp_invoice_id&kind=eq.sale&id=in.(${links.map((l) => `"${l.invoice_id}"`).join(",")})&order=created_at.desc&limit=1`) : [];
      if (invoices[0]) {
        const invoice = await rompslomp.getInvoice(invoices[0].rompslomp_invoice_id).catch(() => null);
        if (invoice?.contact_id) return remember(invoice.contact_id, "from an earlier invoice");
      }
    }

    for (const q of [text(buyer.vat_id), text(buyer.company_name), text(buyer.full_name)].filter(Boolean)) {
      const match = matchContact(await rompslomp.searchContacts(q), buyer);
      if (match) return remember(match.id, "found in Rompslomp");
    }

    if (!create) return null;

    const body = contactBody(buyer);
    if (!body.contact.country_code || !body.contact.address) {
      throw new ExternalSalesError("The buyer has no address or country code; the invoice needs them. Fill them in on the buyer first.");
    }

    const created = await rompslomp.createContact(body);
    return remember(created.id, "new in Rompslomp");
  }

  /*
   * Invoices made by hand for this deal: on the buyer's contact, naming the
   * deal, and not one this screen made. Until 22-09-2026 every External Sale
   * was invoiced by hand, so a deal on "to invoice" can still have one -
   * EXTD-000066 did.
   */
  async function handMadeInvoices(sale, contactId, known) {
    if (!contactId) return [];
    const found = [];

    for (const inv of await rompslomp.invoicesOfContact(contactId)) {
      if (known.has(String(inv.id))) continue;
      if (text(inv.api_reference).startsWith(dealId(sale))) continue;
      const full = await rompslomp.getInvoice(inv.id);
      if (!mentionsDeal(full, dealId(sale))) continue;
      found.push({ id: String(full.id), invoice_number: full.invoice_number, amount: Number(full.price_with_vat), route: routeOfInvoice(full), status: full.status });
    }

    return found;
  }

  // One journal per invoice, ever: a Voorraadcorrectie with this number that
  // already exists (made by hand, or by a run that died before saving it) is
  // taken instead of a second one.
  async function journalFor({ route, invoiceNumber, date, amount, reverse = false }) {
    const description = `Voorraadcorrectie ${invoiceNumber}`;
    const existing = (await rompslomp.recentJournals()).find((j) => text(j.description) === description);
    if (existing) return { journal: existing, made: false };
    return { journal: await rompslomp.createJournal(journalBody({ route, invoiceNumber, date, amount, reverse })), made: true };
  }

  async function saveInvoice(sale, invoice, published, route) {
    const [row] = await db.insert("external_sale_invoices", [{
      rompslomp_invoice_id: String(published.id),
      invoice_number: published.invoice_number || null,
      kind: "sale",
      vat_route: route,
      amount_incl_vat: round2(published.price_with_vat ?? invoice.amount),
      journal_entry_id: null,
      credits_invoice_id: null,
      sent_at: null
    }]);
    await db.insert("external_sale_invoice_deals", [{ invoice_id: row.id, sale_id: sale.id }]);
    return row;
  }

  /*
   * Invoices a deal: every invoice it needs, each with its journal entry,
   * then the mail. Stops at the first thing that fails and says what is done;
   * running it again carries on from there.
   */
  async function invoice(id, { mail = true } = {}) {
    const { sale, pairs, invoices: existing } = await load(id);
    const plan = invoicePlanFor(sale, pairs);
    if (!plan.ok) throw new ExternalSalesError(plan.problems.join(" "));

    const contact = await contactFor(sale);
    const done = [];
    const log = [`Contact ${contact.id} (${contact.how})`];

    const handMade = await handMadeInvoices(sale, contact.id, new Set(existing.map((e) => e.rompslomp_invoice_id)));
    if (handMade.length) {
      throw new ExternalSalesError(`${dealId(sale)} is already on ${handMade.map((h) => h.invoice_number).join(", ")} in Rompslomp (made by hand). Link that invoice instead of making a new one.`, 409);
    }

    for (const inv of plan.invoices) {
      let row = existing.find((e) => e.kind === "sale" && e.vat_route === inv.route);

      if (!row) {
        const reference = apiReference(sale, inv.route);
        let rs = await rompslomp.findInvoice(reference);
        if (!rs) rs = await rompslomp.createInvoice(salesInvoiceBody({ sale, invoice: inv, contactId: contact.id }));
        if (rs.status !== "published" || !rs.invoice_number) rs = await rompslomp.publishInvoice(rs.id);

        // Saved first, whatever comes next: an invoice that exists in
        // Rompslomp must be visible here.
        row = await saveInvoice(sale, inv, rs, inv.route);
        log.push(`Invoice ${rs.invoice_number} (${inv.route}, €${inv.amount.toFixed(2)})`);
      }

      // Rompslomp works the total out itself: it must be ours to the cent,
      // or nothing is booked on it.
      if (Math.abs(Number(row.amount_incl_vat) - inv.amount) > 0.01) {
        throw new ExternalSalesError(`Invoice ${row.invoice_number} came out at €${row.amount_incl_vat}, the deal says €${inv.amount.toFixed(2)}. Check it in Rompslomp; no journal entry was made.`, 502);
      }

      if (!row.journal_entry_id) {
        const rs = await rompslomp.getInvoice(row.rompslomp_invoice_id);
        const { journal, made } = await journalFor({ route: inv.route, invoiceNumber: rs.invoice_number, date: rs.date, amount: inv.purchase });
        [row] = await db.patch(`external_sale_invoices?id=eq.${row.id}`, { journal_entry_id: String(journal.id), invoice_number: rs.invoice_number });
        log.push(`Voorraadcorrectie ${rs.invoice_number} (€${inv.purchase.toFixed(2)})${made ? "" : " - already there, taken over"}`);
      }

      done.push(row);
    }

    await db.patch(`external_sales?id=eq.${sale.id}`, { bookkeeping_status: "invoiced" });

    if (mail && done.some((row) => !row.sent_at)) {
      try {
        await mailInvoices(id);
        log.push(`Mailed to ${sale.buyer_email}`);
      } catch (err) {
        log.push(`NOT mailed: ${err.message}`);
      }
    }

    return { log, invoices: done };
  }

  // To the buyer, or - with testTo - the same mail to an admin only, to see
  // what the buyer gets. A test changes nothing on the deal.
  async function mailInvoices(id, { testTo = "", reminder = false } = {}) {
    const { sale, invoices } = await load(id);
    const sales = invoices.filter((i) => i.kind === "sale");
    const to = text(testTo) || text(sale.buyer_email);
    if (!sales.length) throw new ExternalSalesError("This deal has no invoice to send.");
    if (!to) throw new ExternalSalesError("The buyer has no email address.");

    const pdfs = [];
    for (const inv of sales) pdfs.push((await rompslomp.pdf(inv.rompslomp_invoice_id)).toString("base64"));

    const message = invoiceMail({ sale, invoices: sales, to, from: mailFrom, replyTo, pdfs, reminder });
    if (testTo) message.subject = `[TEST] ${message.subject}`;
    await sendMail(message);

    if (!testTo && reminder) {
      await db.patch(`external_sales?id=eq.${sale.id}`, { last_reminder_at: new Date().toISOString() });
    } else if (!testTo) {
      const now = new Date().toISOString();
      for (const inv of sales) if (!inv.sent_at) await db.patch(`external_sale_invoices?id=eq.${inv.id}`, { sent_at: now });
    }
    return { to, test: Boolean(testTo), reminder, invoices: sales.map((i) => i.invoice_number) };
  }

  /*
   * Credits one invoice: a credit invoice for the same amount and a journal
   * entry that books the purchase back into stock. When every invoice on the
   * deal is credited, the deal is "credited".
   */
  async function credit(id, invoiceRowId) {
    const { sale, invoices } = await load(id);
    const original = invoices.find((i) => i.id === invoiceRowId && i.kind === "sale");
    if (!original) throw new ExternalSalesError("That invoice is not on this deal.");

    const [already] = await db.get(`external_sale_invoices?select=*&credits_invoice_id=eq.${original.id}`);
    let row = already || null;

    if (!row) {
      const reference = `credit-${original.rompslomp_invoice_id}`;
      let rs = await rompslomp.findInvoice(reference);
      if (!rs) {
        const source = await rompslomp.getInvoice(original.rompslomp_invoice_id);
        rs = await rompslomp.createInvoice(creditInvoiceBody({ original: source, reference }));
      }
      if (rs.status !== "published" || !rs.invoice_number) rs = await rompslomp.publishInvoice(rs.id);

      [row] = await db.insert("external_sale_invoices", [{
        rompslomp_invoice_id: String(rs.id),
        invoice_number: rs.invoice_number,
        kind: "credit",
        vat_route: original.vat_route,
        amount_incl_vat: round2(rs.price_with_vat),
        journal_entry_id: null,
        credits_invoice_id: original.id,
        sent_at: null
      }]);
      await db.insert("external_sale_invoice_deals", [{ invoice_id: row.id, sale_id: sale.id }]);
    }

    // The journal: what the original booked, back. Only when the original had
    // one - a deal from before the journals has nothing to reverse.
    if (!row.journal_entry_id && original.journal_entry_id) {
      const pairs = await db.get(`external_sale_pairs?select=purchase_price_ex_vat,selling_vat_type&sale_id=eq.${sale.id}`);
      const route = ROUTES[original.vat_route] ? original.vat_route : null;
      if (!route) throw new ExternalSalesError(`Invoice ${original.invoice_number} has VAT route "${original.vat_route}"; book its stock back by hand in Rompslomp.`);

      // Old deals have no selling VAT per pair; then the deal's single route
      // is this invoice's route and all its pairs are this invoice's.
      const own = pairs.filter((p) => p.selling_vat_type === route);
      const amount = round2((own.length ? own : pairs).reduce((s, p) => s + Number(p.purchase_price_ex_vat || 0), 0));
      const rs = await rompslomp.getInvoice(row.rompslomp_invoice_id);
      const { journal } = await journalFor({ route, invoiceNumber: rs.invoice_number, date: rs.date, amount, reverse: true });
      [row] = await db.patch(`external_sale_invoices?id=eq.${row.id}`, { journal_entry_id: String(journal.id) });
    }

    const after = (await load(id)).invoices;
    const open = after.filter((i) => i.kind === "sale" && !after.some((c) => c.credits_invoice_id === i.id));
    if (!open.length) await db.patch(`external_sales?id=eq.${sale.id}`, { bookkeeping_status: "credited" });

    return { credit: row.invoice_number, of: original.invoice_number };
  }

  async function preview(id) {
    const { sale, pairs, invoices: existing } = await load(id);
    const plan = invoicePlanFor(sale, pairs);

    // Only looked up, never made here: a preview writes nothing.
    const contact = plan.ok ? await contactFor(sale, { create: false }) : null;
    const handMade = contact ? await handMadeInvoices(sale, contact.id, new Set(existing.map((e) => e.rompslomp_invoice_id))) : [];

    return {
      ok: plan.ok && !handMade.length,
      problems: plan.problems,
      hand_made: handMade,
      contact: contact ? `Rompslomp contact ${contact.id} (${contact.how})` : "A new contact is made in Rompslomp, with the Buyer ID as its customer number.",
      mail_to: sale.buyer_email || null,
      invoices: plan.invoices.map((inv) => ({
        route: inv.route,
        amount: inv.amount,
        purchase: inv.purchase,
        pairs: inv.pairs.length,
        lines: pairLines(inv.pairs, inv.priced)
      }))
    };
  }

  /*
   * Takes over an invoice made by hand: it is put on the deal, gets its
   * Voorraadcorrectie if it has none, and counts as sent. The deal is
   * invoiced once every VAT type on it has its invoice.
   */
  async function link(id, rompslompInvoiceId) {
    const { sale, pairs, invoices: existing } = await load(id);
    if (existing.some((e) => e.rompslomp_invoice_id === String(rompslompInvoiceId))) throw new ExternalSalesError("That invoice is already on this deal.");

    const rs = await rompslomp.getInvoice(rompslompInvoiceId);
    if (!rs) throw new ExternalSalesError("Rompslomp does not know that invoice.");
    if (!mentionsDeal(rs, dealId(sale))) throw new ExternalSalesError(`${rs.invoice_number} does not mention ${dealId(sale)}; not linked.`);
    if (rs.status !== "published") throw new ExternalSalesError(`${rs.invoice_number || "That invoice"} is still a concept in Rompslomp. Publish it there first.`);

    const route = routeOfInvoice(rs);
    if (!route) throw new ExternalSalesError(`${rs.invoice_number} mixes VAT types on its lines; book it by hand.`);

    const [taken] = await db.get(`external_sale_invoices?select=id&rompslomp_invoice_id=eq.${rs.id}`);
    if (taken) throw new ExternalSalesError(`${rs.invoice_number} is already on another deal.`);

    // Pairs of this route; an old deal without selling VAT per pair: all.
    const own = pairs.filter((p) => p.selling_vat_type === route);
    const purchase = round2((own.length ? own : pairs).reduce((s, p) => s + Number(p.purchase_price_ex_vat || 0), 0));
    if (!(purchase > 0)) throw new ExternalSalesError("The pairs have no purchase price; fix that first, the journal needs it.");

    let [row] = await db.insert("external_sale_invoices", [{
      rompslomp_invoice_id: String(rs.id),
      invoice_number: rs.invoice_number,
      kind: "sale",
      vat_route: route,
      amount_incl_vat: round2(rs.price_with_vat),
      journal_entry_id: null,
      credits_invoice_id: null,
      sent_at: rs.published_at || new Date().toISOString()
    }]);
    await db.insert("external_sale_invoice_deals", [{ invoice_id: row.id, sale_id: sale.id }]);

    const { journal, made } = await journalFor({ route, invoiceNumber: rs.invoice_number, date: rs.date, amount: purchase });
    [row] = await db.patch(`external_sale_invoices?id=eq.${row.id}`, { journal_entry_id: String(journal.id) });

    const routes = [...new Set(pairs.map((p) => p.selling_vat_type).filter(Boolean))];
    const covered = new Set([...existing.filter((e) => e.kind === "sale").map((e) => e.vat_route), route]);
    const complete = routes.every((r) => covered.has(r));
    if (complete) await db.patch(`external_sales?id=eq.${sale.id}`, { bookkeeping_status: "invoiced" });

    const log = [`Linked ${rs.invoice_number} (${route}, €${Number(rs.price_with_vat).toFixed(2)})`, `Voorraadcorrectie ${rs.invoice_number} (€${purchase.toFixed(2)})${made ? "" : " - already there, taken over"}`];
    if (Math.abs(Number(rs.price_with_vat) - Number(sale.total_selling_price)) > 0.01 && routes.length <= 1) {
      log.push(`Note: the invoice is €${Number(rs.price_with_vat).toFixed(2)}, the deal €${Number(sale.total_selling_price).toFixed(2)}.`);
    }
    if (!complete) log.push("Other VAT types on this deal still need their invoice.");
    return { log };
  }

  async function invoicePdf(invoiceRowId) {
    if (!/^[0-9a-f-]{36}$/i.test(text(invoiceRowId))) throw new ExternalSalesError("Unknown invoice.");
    const [row] = await db.get(`external_sale_invoices?select=*&id=eq.${text(invoiceRowId)}`);
    if (!row) throw new ExternalSalesError("That invoice is not known here.", 404);
    return { filename: `Invoice ${row.invoice_number || row.rompslomp_invoice_id}.pdf`, pdf: await rompslomp.pdf(row.rompslomp_invoice_id) };
  }

  return { configured: rompslomp.configured, preview, invoice, mailInvoices, credit, link, invoicePdf };
}

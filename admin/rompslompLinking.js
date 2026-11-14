// Linking Rompslomp payments to their documents.
//
// Rompslomp's API can create payments but cannot say which invoice or expense
// a payment pays; that is only possible through their web app. This module
// decides, from API data alone, which unbooked payment pays which document,
// and only when that is certain:
//
//   1. Kruisposten payments made by our own flows. Their description names
//      the one document they pay:
//        "Kruispost ORD-x: KC… (factuur … tegen credit …)"          sales
//        "Kruispost ORD-x: Purchase Order ORD-y (inkoop … tegen credit …)"
//        "Woovin payout #N: KC… (ORD-x)" / "Woovin payout #N: kosten payout invoice #N"
//   2. Bank lines with one reference to one open document, the amount equal
//      to the cent and the name on the bank line matching the contact:
//        incoming   an invoice number (also written "KC202610 2220"), an
//                   order id on its invoice, or SneakerAsk's Shopify order
//                   number (".176299") looked up through the order
//        outgoing   "ORD-x" (or POFF/EXTD/MWTB/EORD) → expense
//                   "Purchase Order ORD-x"; a Payment Note code → the units
//                   paid with it → their one expense
//   3. Woovin payout bank lines: booked to Kruisposten when the Kruisposten
//      payments of that payout add up to the bank line.
//
// Everything that has a reference of ours but fails one of these checks goes
// on the review list, with the reason; nothing is ever guessed. Lines without
// any reference of ours (card payments, PayPal, Mollie, …) are left alone.
// Mollie is out on purpose: 25% of each payout goes to a loan, and how that is
// booked has not been decided.

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const text = (v) => (v == null ? "" : String(v)).trim();
const cents = (n) => Math.round(Number(n) * 100);

export const KRUISPOSTEN_PATH = "activa.liquid_assets.kruisposten_custom";
export const ING_PATH = "activa.liquid_assets.bank_zakelijk_ing_custom";

// ---------------------------------------------------------------- documents

/** An expense's total as Rompslomp shows it: Σ ex-VAT + Σ VAT per line. */
export function expenseTotal(expense) {
  const lines = expense?.invoice_lines || [];
  const ex = lines.reduce((s, l) => s + Number(l.price_without_vat || 0) * Number(l.quantity || 1), 0);
  const vat = lines.reduce((s, l) => s + Number(l.vat_amount || 0), 0);
  return round2(ex + vat);
}

/**
 * Indexes over the documents.
 *   invoices          sales invoices and credits (selection=all, recent)
 *   unpaidExpenseIds  ids from expenses?selection=unpaid: the API has no open
 *                     amount on an expense, this is the only sign it is open.
 *                     Credit expenses never appear there, so a credit's own
 *                     openness is checked on the web pick list instead.
 */
export function indexDocuments({ invoices = [], expenses = [], unpaidExpenseIds = new Set() }) {
  const byNumber = new Map();
  const byOrder = new Map();
  for (const inv of invoices) {
    const number = text(inv.invoice_number);
    if (number) byNumber.set(number, inv);
    const order = text(inv.description).match(/^(?:ORD|POFF|EXTD|MWTB|EORD)-\d+$/)?.[0];
    if (order) {
      if (!byOrder.has(order)) byOrder.set(order, []);
      byOrder.get(order).push(inv);
    }
  }

  const byLine = new Map();
  for (const exp of expenses) {
    const seen = new Set();
    for (const line of exp.invoice_lines || []) {
      const key = text(line.description).replace(/\s+·\s+.*$/, "").replace(/\s+�\s+.*$/, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(exp);
    }
  }

  return { byNumber, byOrder, byLine, unpaidExpenseIds };
}

const openAmount = (inv) => round2(Number(inv.open_amount || 0));

function invoiceTarget(inv) {
  return {
    kind: "invoice",
    id: inv.id,
    number: text(inv.invoice_number),
    contact: text(inv.cached_contact?.name),
    open: openAmount(inv),
    date: text(inv.date)
  };
}

function expenseTarget(exp, label) {
  return {
    kind: "expense",
    id: exp.id,
    number: label,
    contact: text(exp.cached_contact?.name),
    total: expenseTotal(exp),
    date: text(exp.date)
  };
}

// ----------------------------------------------------------------- bank text

/** "Naam: X Omschrijving: Y IBAN: …" as ING writes it into Rompslomp. */
export function parseBankLine(description) {
  const d = text(description);
  const stop = "(?=IBAN:|Kenmerk:|Reden:|Datum/Tijd:|Valutadatum:|Machtiging ID:|Incassant ID:|$)";
  const name = d.match(/^Naam:\s*(.*?)\s*Omschrijving:/)?.[1] || "";
  const about = d.match(new RegExp(`Omschrijving:\\s*(.*?)\\s*${stop}`))?.[1] || "";
  const kenmerk = d.match(new RegExp(`Kenmerk:\\s*(.*?)\\s*${stop}`))?.[1] || "";
  const returned = /Reden:/.test(d);
  return { name, about, kenmerk, returned, structured: /^Naam:/.test(d) };
}

/** Invoice numbers in free text: "KC202610-2280", "KC202610 2280", "KC2026102280". */
export function invoiceNumbersIn(value) {
  const found = new Set();
  for (const m of text(value).matchAll(/KC\s?(20\d{4})\s?[-–]?\s?(\d{3,5})(?!\d)/gi)) found.add(`KC${m[1]}-${m[2]}`);
  return [...found];
}

export function orderIdsIn(value) {
  return [...new Set([...text(value).matchAll(/\b(ORD|POFF|EXTD|MWTB|EORD)[-\s]?(\d{4,7})\b/gi)].map((m) => `${m[1].toUpperCase()}-${m[2]}`))];
}

/** Payment Note codes, "MON20260211" / "AKA20260808-2". */
export function paymentCodesIn(value) {
  return [...new Set([...text(value).matchAll(/\b([A-Z]{2,5}20\d{6}(?:-\d+)?)\b/g)].map((m) => m[1]))];
}

/** SneakerAsk pays with "PO-20261028-040-.176299": the Shopify order number. */
export function sneakerAskOrderNumber(about) {
  return text(about).match(/^PO-\d{8}-\d+-\.(\d{4,7})\b/)?.[1] || "";
}

// --------------------------------------------------------------- name check

const GENERIC = new Set([
  "bv", "b", "v", "nv", "gmbh", "ohg", "kg", "ug", "sl", "sa", "sarl", "srl", "spa", "ltd", "limited", "llc", "inc",
  "bt", "kft", "sp", "z", "oo", "spolka", "ograniczona", "odpowiedzialnoscia", "via", "and", "the", "van", "de", "der",
  "het", "en", "et", "cie", "store", "shop", "sneakers", "sneaker", "kicks", "trading", "handel", "handelsvertrieb",
  "distributor", "distribution", "company", "group", "rabo", "zakelijk", "betaalverzoek", "tikkie", "resell", "studio"
]);

function nameTokens(value) {
  return text(value)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** True when the two names share a distinctive word ("Dominicks Distributor Bt" ↔ "Dominicks Distributor Keresekedelmi"). */
export function namesMatch(bankName, contactName) {
  const a = new Set(nameTokens(bankName));
  const b = nameTokens(contactName);
  if (!a.size || !b.length) return false;
  if (b.some((t) => a.has(t))) return true;
  // "KicksbyMattie" vs "Kicks by Mattie": compare squashed.
  const squash = (v) => nameTokens(v).join("");
  const sa = squash(bankName), sb = squash(contactName);
  return sa.length >= 6 && sb.length >= 6 && (sa.includes(sb) || sb.includes(sa));
}

// --------------------------------------------------------------------- plan

/**
 * payments   unbooked payments (payments?selection=unbooked)
 * allPayments every payment of the period (to add up Woovin payouts)
 * docs       indexDocuments(...)
 * lookups    { shopifyOrder: Map("176299" → { orderId, invoiceNumber, store }),
 *              paymentCode:  Map("MON20260211" → [{ orderId, seller }]) }
 * Returns { link: [...], review: [...], skipped: {reason: count} }.
 */
export function planLinks({ payments = [], allPayments = [], docs, lookups = {} }) {
  const link = [];
  const review = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  const base = (p) => ({
    payment_id: p.id,
    paid_at: text(p.paid_at).slice(0, 10),
    amount: round2(p.amount),
    account: text(p.account_path).includes("kruisposten") ? "Kruisposten" : text(p.account_path).includes("bank_zakelijk_ing") ? "ING" : text(p.account_path),
    description: text(p.description)
  });
  const toReview = (p, reason, extra = {}) => review.push({ ...base(p), reason, ...extra });
  const toLink = (p, rule, target, extra = {}) => link.push({ ...base(p), rule, target, ...extra });

  // A sales document paid by +amount (invoice) or −amount (credit), open for exactly that.
  const checkInvoice = (p, number) => {
    const inv = docs.byNumber.get(number);
    if (!inv) return { error: `${number} not found in Rompslomp` };
    const t = invoiceTarget(inv);
    if (cents(t.open) === 0) return { error: `${number} is already paid` };
    if (cents(t.open) !== cents(p.amount)) return { error: `${number} is open for € ${t.open.toFixed(2)}, the payment is € ${round2(p.amount).toFixed(2)}` };
    return { target: t };
  };

  // One expense with this line text, of this total (sign: an expense is paid by a minus).
  const checkExpense = (p, label, { credit = false } = {}) => {
    const found = docs.byLine.get(label) || [];
    if (!found.length) return { error: `no expense "${label}"` };
    const fit = found.filter((e) => cents(expenseTotal(e)) === cents(-Number(p.amount)));
    if (!fit.length) return { error: `"${label}" is € ${found.map((e) => expenseTotal(e).toFixed(2)).join(" / ")}, the payment is € ${round2(p.amount).toFixed(2)}` };
    // Only open ones; a credit expense is never in selection=unpaid, the web pick list decides.
    const open = credit ? fit : fit.filter((e) => docs.unpaidExpenseIds.has(e.id));
    if (!open.length) return { error: `"${label}" is already paid` };
    if (open.length > 1) return { error: `${open.length} open expenses "${label}" of this amount` };
    return { target: expenseTarget(open[0], label) };
  };

  // Every document claimed by one payment only; a second claim sends both to review.
  const claims = new Map();

  const woovinBank = [];

  for (const p of payments) {
    const d = text(p.description);
    const path = text(p.account_path);

    // ---- 1. Kruisposten, made by our flows
    if (path === KRUISPOSTEN_PATH) {
      let m;
      if ((m = d.match(/^Kruispost [^:]+: (KC\d{6}-\d+) \(factuur /))) {
        const r = checkInvoice(p, m[1]);
        r.target ? toLink(p, "kruispost_sales", r.target) : toReview(p, r.error);
      } else if ((m = d.match(/^Kruispost [^:]+: ((?:Credit )?Purchase Order \S+) \(inkoop /))) {
        const r = checkExpense(p, m[1], { credit: m[1].startsWith("Credit ") });
        r.target ? toLink(p, "kruispost_purchase", r.target) : toReview(p, r.error);
      } else if ((m = d.match(/^Woovin payout #(\d+): (KC\d{6}-\d+) \(/))) {
        const r = checkInvoice(p, m[2]);
        r.target ? toLink(p, "woovin_document", r.target) : toReview(p, r.error);
      } else if ((m = d.match(/^Woovin payout #(\d+): kosten payout invoice #(\d+)$/))) {
        // Fee expense lines read "Woovin payout invoice #N · ORD-x · fee".
        const r = checkExpense(p, `Woovin payout invoice #${m[2]}`);
        r.target ? toLink(p, "woovin_fees", r.target) : toReview(p, r.error);
      } else {
        toReview(p, "Kruisposten payment not made by our flows");
      }
      continue;
    }

    if (path !== ING_PATH) { skip("not ING or Kruisposten"); continue; }

    const bank = parseBankLine(d);
    const amount = Number(p.amount);
    const all = `${bank.about} ${bank.kenmerk}`;

    // ---- 3. Woovin payouts
    const woovin = /WOOVIN B\.V\./i.test(bank.name) && all.match(/Payout (\d+)/i);
    if (woovin) { woovinBank.push({ p, number: woovin[1] }); continue; }

    if (/Mollie/i.test(bank.name) || /Mollie/i.test(d)) { skip("Mollie (out of scope)"); continue; }

    // ---- 2. Bank lines with a reference
    if (amount > 0) {
      const sa = /sneakerask/i.test(bank.name) && sneakerAskOrderNumber(bank.about);
      if (sa) {
        const order = lookups.shopifyOrder?.get(sa);
        if (!order) { toReview(p, `SneakerAsk order .${sa} not found in Airtable`); continue; }
        if (!order.invoiceNumber) { toReview(p, `${order.orderId} (SneakerAsk .${sa}) has no Rompslomp invoice`); continue; }
        const r = checkInvoice(p, order.invoiceNumber);
        if (!r.target) { toReview(p, `${order.orderId}: ${r.error}`); continue; }
        if (!namesMatch(bank.name, r.target.contact)) { toReview(p, `name "${bank.name}" ≠ "${r.target.contact}"`, { target: r.target }); continue; }
        toLink(p, "sneakerask", r.target, { reference: `.${sa} → ${order.orderId}` });
        continue;
      }

      const numbers = invoiceNumbersIn(all);
      const orders = numbers.length ? [] : orderIdsIn(all);
      if (!numbers.length && !orders.length) { skip("incoming without a reference"); continue; }
      if (bank.returned) { toReview(p, "returned payment (Reden:)"); continue; }
      if (numbers.length > 1 || orders.length > 1) {
        const docsOf = numbers.map((n) => docs.byNumber.get(n)).filter(Boolean);
        const sum = round2(docsOf.reduce((s, i) => s + openAmount(i), 0));
        toReview(p, `${numbers.length || orders.length} documents in one payment (${(numbers.length ? numbers : orders).join(", ")})${numbers.length && cents(sum) === cents(amount) ? "; their open amounts add up" : ""}`);
        continue;
      }

      let r;
      if (numbers.length) r = checkInvoice(p, numbers[0]);
      else {
        const open = (docs.byOrder.get(orders[0]) || []).filter((i) => cents(openAmount(i)) > 0);
        r = open.length === 1 ? checkInvoice(p, text(open[0].invoice_number))
          : { error: open.length ? `${open.length} open invoices for ${orders[0]}` : `no open invoice for ${orders[0]}` };
      }
      if (!r.target) { toReview(p, r.error); continue; }
      if (!namesMatch(bank.name, r.target.contact)) { toReview(p, `name "${bank.name}" ≠ "${r.target.contact}"`, { target: r.target }); continue; }
      toLink(p, "bank_invoice", r.target, { reference: numbers[0] || orders[0] });
      continue;
    }

    // Outgoing
    const codes = paymentCodesIn(all);
    const orders = orderIdsIn(all);
    if (!codes.length && !orders.length) { skip("outgoing without a reference"); continue; }
    if (bank.returned) { toReview(p, "returned payment (Reden:)"); continue; }

    if (orders.length === 1 && !codes.length) {
      const r = checkExpense(p, `Purchase Order ${orders[0]}`);
      if (!r.target) { toReview(p, r.error); continue; }
      if (!namesMatch(bank.name, r.target.contact)) { toReview(p, `name "${bank.name}" ≠ "${r.target.contact}"`, { target: r.target }); continue; }
      toLink(p, "bank_expense", r.target, { reference: orders[0] });
      continue;
    }

    if (codes.length === 1) {
      const units = lookups.paymentCode?.get(codes[0]) || [];
      const ids = [...new Set(units.map((u) => u.orderId).filter(Boolean))];
      if (!units.length) { toReview(p, `Payment Note ${codes[0]}: no units found`); continue; }
      if (ids.length !== 1) {
        const sum = round2(units.reduce((s, u) => s + Number(u.price || 0), 0));
        const adds = cents(sum) === cents(-amount) ? "; the units add up to the payment" : `; the units add up to € ${sum.toFixed(2)}`;
        toReview(p, `Payment Note ${codes[0]} pays ${units.length} units${ids.length ? ` (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""})` : ""}${adds}`);
        continue;
      }
      const r = checkExpense(p, `Purchase Order ${ids[0]}`);
      if (!r.target) { toReview(p, `${codes[0]}: ${r.error}`); continue; }
      if (!namesMatch(bank.name, r.target.contact)) { toReview(p, `name "${bank.name}" ≠ "${r.target.contact}"`, { target: r.target }); continue; }
      toLink(p, "bank_payment_note", r.target, { reference: `${codes[0]} → ${ids[0]}` });
      continue;
    }

    toReview(p, `${orders.length + codes.length} references in one payment (${[...orders, ...codes].join(", ")})`);
  }

  // ---- Woovin bank lines: the payout's Kruisposten payments have to add up.
  for (const { p, number } of woovinBank) {
    const tag = `Woovin payout #${number}:`;
    const ours = allPayments.filter((x) => text(x.account_path) === KRUISPOSTEN_PATH && text(x.description).startsWith(tag));
    const sum = round2(ours.reduce((s, x) => s + Number(x.amount), 0));
    if (!ours.length) { toReview(p, `Woovin payout #${number} is not booked yet (upload its PDF in Finance › Woovin Payouts)`); continue; }
    if (cents(sum) !== cents(p.amount)) { toReview(p, `Woovin payout #${number}: Kruisposten payments add up to € ${sum.toFixed(2)}, the bank line is € ${round2(p.amount).toFixed(2)}`); continue; }
    toLink(p, "woovin_bank", { kind: "account", id: "kruisposten", number: "Kruisposten", contact: "WOOVIN B.V.", total: sum }, { reference: `Woovin payout #${number} (${ours.length} payments)` });
  }

  // ---- One payment per document.
  for (const row of link) {
    if (row.target.kind === "account") continue;
    const key = `${row.target.kind}:${row.target.id}`;
    claims.set(key, (claims.get(key) || 0) + 1);
  }
  const certain = [];
  for (const row of link) {
    const key = `${row.target.kind}:${row.target.id}`;
    if (row.target.kind !== "account" && claims.get(key) > 1) review.push({ ...row, reason: `${claims.get(key)} payments point to ${row.target.number}` });
    else certain.push(row);
  }

  return { link: certain, review, skipped };
}

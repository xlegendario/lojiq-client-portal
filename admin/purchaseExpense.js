// admin/purchaseExpense.js
//
// Booking a purchase from a seller (block 10, 23-09-2026).
//
// Buying a pair is an expense in Rompslomp, in a company of its own: the
// sales invoices are Kickz Caviar B.V.'s, but a purchase from a seller is
// made by Payout by Kickz Caviar B.V., the entity that writes the
// self-billing invoice. So this looks that company up by name and works
// there, with its own accounts and VAT types.
//
// The booking is one expense per Inventory Unit:
//
//   supplier     the seller, found by company name or by his own name
//   account      Voorraad Scout - the same stock the sale's correction
//                credits, so the two meet and only the cost is left
//   line         "Purchase Order EXTD-000078", with the pair underneath
//   VAT          margin buys carry none, 0% is reverse-charged, 21% is shown
//   attachment   the self-billing invoice, so the document sits on the
//                booking instead of in a folder
//
// Without this the stock correction takes stock out that was never put in,
// and the purchase is missing from the books entirely.

import { ExternalSalesError } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

export const PAYOUT_COMPANY = "payout by kickz caviar";
// The stock the purchase goes into. Kickz Caviar calls it Voorraad Scout;
// the Payout company may call it plainly Voorraad, so both are tried in
// order and the most specific wins.
export const STOCK_ACCOUNTS = ["voorraad scout", "voorraad", "inkoop"];

// Which of Rompslomp's VAT types a purchase is booked under.
export const PURCHASE_VAT = {
  Margin: "vat_none",
  VAT0: "vat_reverse_charged",
  VAT21: "vat_high"
};

const like = (value) => text(value).toLowerCase();

/*
 * The expense body, so it can be read (and tested) without Rompslomp.
 *
 * A credit is the same expense with the amount the other way round: that is
 * what the Crediteren button does in Rompslomp, and it undoes the stock the
 * purchase put in.
 */
export function expenseBody({ date, contactId, accountId, vatTypeId, vatRate, deal, description, amount, credit = false }) {
  const price = round2(credit ? -Math.abs(amount) : amount);

  return {
    expense: {
      date,
      state: "published",
      currency: "eur",
      contact_id: contactId,
      type_account_id: accountId,
      invoice_lines: [{
        description: `${credit ? "Credit " : ""}Purchase Order ${deal}`,
        extended_description: description,
        price_per_unit: price.toFixed(2),
        quantity: "1.0",
        vat_rate: String(vatRate ?? 0),
        vat_type_id: vatTypeId,
        account_id: accountId
      }]
    }
  };
}

/*
 * deps:
 *   rompslomp    createRompslomp, for the company the sales invoices live in
 *   forCompany   (companyId) -> a Rompslomp client for that company
 *   selfBilling  createSelfBilling, for the document to attach
 */
export function createPurchaseExpense({ rompslomp, forCompany, selfBilling = null }) {
  let payout = null;

  // Looked up once: the company, the stock account and the VAT types it has.
  async function company() {
    if (payout) return payout;

    const companies = await rompslomp.companies();
    const found = companies.find((row) => like(row.name).includes(PAYOUT_COMPANY));

    if (!found) {
      throw new ExternalSalesError(`Rompslomp has no company whose name contains "${PAYOUT_COMPANY}"; a purchase cannot be booked.`, 502);
    }

    const client = forCompany(found.id);
    const [accounts, vatTypes] = await Promise.all([client.accounts(), client.vatTypes()]);
    let account = null;
    for (const wanted of STOCK_ACCOUNTS) {
      account = accounts.find((row) => like(row.name).includes(wanted) || like(row.path_name).includes(wanted));
      if (account) break;
    }

    if (!account) {
      // Say what it does have, so the right name can be picked without
      // hunting through Rompslomp.
      const names = accounts.map((row) => text(row.name)).filter(Boolean).slice(0, 25).join(", ");
      throw new ExternalSalesError(
        `${found.name} has no account named ${STOCK_ACCOUNTS.map((name) => `"${name}"`).join(" or ")}. It has: ${names || "nothing this token may see"}.`,
        502
      );
    }

    payout = { id: found.id, name: found.name, client, account, vatTypes };
    return payout;
  }

  function vatTypeFor(vatTypes, purchaseVatType) {
    const wanted = PURCHASE_VAT[text(purchaseVatType)];
    if (!wanted) throw new ExternalSalesError(`A ${purchaseVatType || "unknown"} purchase has no VAT type to book it under.`);

    const found = vatTypes.find((row) => text(row.name) === wanted)
      || (wanted === "vat_none" ? vatTypes.find((row) => text(row.name) === "vat_zero") : null);

    if (!found) throw new ExternalSalesError(`Rompslomp has no VAT type "${wanted}" in the purchase company.`, 502);
    return found;
  }

  /*
   * The supplier in Rompslomp. Found by his company name, else by his own
   * name; never created here, because a supplier carries bank details and
   * VAT numbers that belong in Rompslomp itself.
   */
  async function supplier(client, seller) {
    for (const term of [text(seller.company_name), text(seller.name), text(seller.full_name)].filter(Boolean)) {
      const matches = await client.searchSuppliers(term);
      const exact = matches.find((row) => like(row.company_name) === like(term) || like(row.contact_person_name) === like(term));
      if (exact) return exact;
      if (matches.length === 1) return matches[0];
    }

    throw new ExternalSalesError(`No supplier in Rompslomp for ${text(seller.company_name) || text(seller.name) || "this seller"}; add the contact there first.`, 502);
  }

  /*
   * Book one bought pair. Returns what was made, so the pair can keep it and
   * a cancel can undo it.
   *
   * unit    { record_id, item_id, product_name, sku, size, vat_type, price }
   * seller  { company_name, name }
   */
  async function book({ unit, seller, deal, date = "" }) {
    const { client, account, vatTypes } = await company();
    const vat = vatTypeFor(vatTypes, unit.vat_type);
    const contact = await supplier(client, seller);

    const body = expenseBody({
      date: text(date) || new Date().toISOString().slice(0, 10),
      contactId: contact.id,
      accountId: account.id,
      vatTypeId: vat.id,
      vatRate: vat.value,
      deal,
      description: [text(unit.product_name), text(unit.size)].filter(Boolean).join(" - "),
      amount: unit.price
    });

    const expense = await client.createExpense(body);

    // The self-billing invoice belongs on the booking. It is the document
    // the purchase rests on, but a booking without it is still a booking:
    // a failure here is said, not thrown.
    let attached = false;
    if (selfBilling && text(unit.record_id)) {
      try {
        const { filename, pdf } = await selfBilling.forUnit(unit.record_id, { order_number: deal });
        await client.updateExpense(expense.id, {
          expense: {
            attachment_objects: [{ attachment: pdf.toString("base64"), attachment_file_name: filename }]
          }
        });
        attached = true;
      } catch (err) {
        console.error(`[purchase] ${unit.item_id || unit.record_id}: the self-billing invoice was not attached:`, err.message);
      }
    }

    return {
      expense_id: String(expense.id),
      expense_number: text(expense.invoice_number),
      company_id: String(client.companyId),
      supplier: text(contact.company_name) || text(contact.contact_person_name),
      attached
    };
  }

  /*
   * Undo a purchase we never made: the pair goes back to the partner, so the
   * stock it put in has to come out. Rompslomp has no Crediteren over the
   * API, so this is its counterpart - the same expense, negative.
   */
  async function credit({ expenseId, deal, date = "" }) {
    const { client, account, vatTypes } = await company();
    const original = await client.getExpense(expenseId);

    if (!original) throw new ExternalSalesError("That expense is not in Rompslomp any more.", 404);

    const line = (original.invoice_lines || [])[0] || {};
    const vat = vatTypes.find((row) => row.id === line.vat_type_id) || vatTypeFor(vatTypes, "Margin");

    const expense = await client.createExpense(expenseBody({
      date: text(date) || new Date().toISOString().slice(0, 10),
      contactId: original.contact_id,
      accountId: line.account_id || account.id,
      vatTypeId: vat.id,
      vatRate: vat.value,
      deal,
      description: text(line.extended_description),
      amount: Number(line.price_per_unit) || 0,
      credit: true
    }));

    return { expense_id: String(expense.id), expense_number: text(expense.invoice_number) };
  }

  return { book, credit, company };
}

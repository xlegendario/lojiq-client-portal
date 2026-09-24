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
/*
 * The stock the purchase goes into, recognised in the order that is most
 * certain first. The same account is written differently per company -
 * "Voorraad Scout" in one, "Voorraad | Scout" in the other - so names are
 * compared with the punctuation taken out, and the path is only a fallback
 * because it can point at the heading above the account.
 */
export const STOCK_ACCOUNT_RULES = [
  { why: "Voorraad Scout", match: (name) => name.includes("voorraadscout") },
  { why: "Scout under Voorraad", match: (name, path) => path.includes("voorraad") && name.includes("scout") },
  { why: "an account named Voorraad", match: (name) => name.includes("voorraad") },
  { why: "anything under Voorraad", match: (name, path) => path.includes("voorraad") }
];

// Names to compare by: lower case, letters and digits only, so "Voorraad |
// Scout" and "Voorraad Scout" are the same thing.
const key = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/g, "");

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
 * A seller as a supplier in Rompslomp. His Seller ID is the contact number,
 * the way a buyer's BU number is on the other side, so the two can always be
 * matched without going by name.
 */
export function supplierBody(seller) {
  const company = text(seller.company_name);
  const person = text(seller.full_name) || text(seller.name);

  return {
    contact: {
      is_individual: !company,
      is_supplier: true,
      company_name: company || null,
      contact_person_name: person || null,
      contact_person_email_address: text(seller.email) || null,
      address: text(seller.address) || null,
      zipcode: text(seller.zipcode) || null,
      city: text(seller.city) || null,
      country_code: text(seller.country_code).toUpperCase() || null,
      vat_number: text(seller.vat_id) || null,
      contact_number: text(seller.seller_id) || null
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
    for (const rule of STOCK_ACCOUNT_RULES) {
      account = accounts.find((row) => rule.match(key(row.name), key(`${row.path_name || ""} ${row.path || ""}`)));
      if (account) break;
    }

    if (!account) {
      // Say what it does have, so the right one can be picked without
      // hunting through Rompslomp.
      const names = accounts.map((row) => `${text(row.name)} (${text(row.path_name)})`).filter(Boolean).slice(0, 30).join("; ");
      throw new ExternalSalesError(
        `${found.name} has no stock account this recognises. It has: ${names || "nothing this token may see"}.`,
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
   * The supplier in Rompslomp: by his Seller ID first, which is his contact
   * number there, and by name for the ones from before that.
   */
  async function findSupplier(client, seller) {
    const sellerId = text(seller.seller_id);

    if (sellerId) {
      const byNumber = await client.searchSuppliers(sellerId);
      const exact = byNumber.find((row) => like(row.contact_number) === like(sellerId));
      if (exact) return exact;
    }

    for (const term of [text(seller.company_name), text(seller.name), text(seller.full_name)].filter(Boolean)) {
      const matches = await client.searchSuppliers(term);
      const exact = matches.find((row) => like(row.company_name) === like(term) || like(row.contact_person_name) === like(term));
      if (exact) return exact;
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  /*
   * The supplier to book this purchase on, made now if he has none.
   *
   * On the first purchase, not at registration: there are 889 sellers and we
   * buy from a handful, so making a contact for every one of them would turn
   * Rompslomp into a phone book. Everything a contact needs is on the seller
   * (name, address, VAT id, email), so there is nothing to invent.
   */
  async function supplier(client, seller) {
    const found = await findSupplier(client, seller);
    if (found) return found;

    if (!text(seller.company_name) && !text(seller.full_name) && !text(seller.name)) {
      throw new ExternalSalesError("This seller has no name in the Sellers Database, so no supplier can be made for him.", 502);
    }

    const made = await client.createContact(supplierBody(seller));
    console.log(`[purchase] supplier made in Rompslomp: ${text(seller.seller_id)} ${text(made?.company_name) || text(made?.contact_person_name)}`);
    return made;
  }

  /*
   * The supplier a seller should have, made when he has none. Called when a
   * seller registers, so the contact is there long before we buy from him -
   * and so a purchase never has to invent one in a hurry.
   */
  async function ensureSupplier(seller) {
    const { client } = await company();
    const found = await findSupplier(client, seller);

    if (found) {
      return { contact_id: String(found.id), name: text(found.company_name) || text(found.contact_person_name), made: false };
    }

    if (!text(seller.company_name) && !text(seller.full_name) && !text(seller.name)) {
      throw new ExternalSalesError("A supplier needs a name.");
    }

    const made = await client.createContact(supplierBody(seller));
    return { contact_id: String(made.id), name: text(made.company_name) || text(made.contact_person_name), made: true };
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

    /*
     * The self-billing invoice would belong on the booking, but Rompslomp's
     * API has no way to put it there: attachment_objects is refused on an
     * expense and the upload route it documents for sales invoices answers
     * "Endpoint does not exist" (tried 23-09-2026). Attachments are the
     * Schoenendoos or dragging the file in.
     *
     * So the document is not sent; it is made on demand and hangs on the
     * pair in the admin, ready to drag into Rompslomp or simply to keep.
     */
    const attachError = "";
    const attached = false;

    return {
      expense_id: String(expense.id),
      expense_number: text(expense.invoice_number),
      company_id: String(client.companyId),
      supplier: text(contact.company_name) || text(contact.contact_person_name),
      attached,
      attach_error: attachError
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

  // Whether a booking we wrote down is still in Rompslomp: one thrown away
  // there has to be made again here.
  async function exists(expenseId) {
    if (!text(expenseId)) return false;

    try {
      const { client } = await company();
      return Boolean(await client.getExpense(text(expenseId)));
    } catch (err) {
      // Gone is a 404; anything else is Rompslomp having a moment, and
      // then the safe answer is "it is still there".
      return !/404/.test(err.message);
    }
  }

  /*
   * Give the suppliers Rompslomp already has their Seller ID as contact
   * number, so they are found by number from now on instead of by name.
   *
   * Only an exact, single name match is linked. Two sellers with the same
   * name, or a supplier that is no seller at all (Sendcloud, the landlord),
   * are left alone and listed - matching those by guesswork would put the
   * wrong number on the wrong contact, which is worse than none.
   */
  async function linkSuppliers({ sellers, apply = false, limit = 100, pauseMs = 400, whenSeveral = "none" }) {
    const { client } = await company();
    const suppliers = await client.allSuppliers();

    // Every seller that goes by a name, so the ones sharing it are known
    // rather than lost to whoever came first.
    const byName = new Map();
    for (const seller of sellers) {
      // A seller whose company and own name come out the same ("Zhuoyi" and
      // "Zhuo Yi") is one seller, not two claimants to the name.
      for (const name of new Set([seller.company_name, seller.full_name].map(key).filter(Boolean))) {
        byName.set(name, [...(byName.get(name) || []), seller]);
      }
    }

    const newest = (list) => [...list].sort((a, b) => text(b.seller_id).localeCompare(text(a.seller_id)))[0];

    /*
     * Which of the sellers sharing a name this supplier is.
     *
     * The email settles it: two people with the same name do not share one.
     * Without that there is no proof, so it is a guess - taken only when
     * asked for, and then the newest record, which is the one a seller uses
     * now.
     */
    function pick(list, supplier) {
      if (list.length === 1) return { seller: list[0], how: "name" };

      const mail = key(supplier.contact_person_email_address || supplier.email);
      const byMail = mail ? list.filter((seller) => key(seller.email) === mail) : [];
      if (byMail.length === 1) return { seller: byMail[0], how: "email" };

      if (whenSeveral === "newest") return { seller: newest(list), how: "newest" };
      return null;
    }

    const out = { suppliers: suppliers.length, sellers: sellers.length, linked: [], already: [], ambiguous: [], unmatched: [], left: 0, stopped: "" };
    let written = 0;

    for (const supplier of suppliers) {
      const name = text(supplier.company_name) || text(supplier.contact_person_name);
      const number = text(supplier.contact_number);

      if (/^SE-\d+$/i.test(number)) {
        out.already.push({ id: supplier.id, name, seller_id: number });
        continue;
      }

      const sharing = byName.get(key(supplier.company_name)) || byName.get(key(supplier.contact_person_name));

      if (!sharing) {
        out.unmatched.push({ id: supplier.id, name, number: number || null });
        continue;
      }

      const chosen = pick(sharing, supplier);

      if (!chosen) {
        out.ambiguous.push({
          id: supplier.id,
          name,
          why: `${sharing.length} sellers have this name`,
          sellers: sharing.map((seller) => seller.seller_id)
        });
        continue;
      }

      const match = chosen.seller;

      /*
       * Rompslomp counts requests per minute and answers 429 when there are
       * too many, so the writes go in portions with a pause between them.
       * What is left over is said, and the next run picks it up - nothing is
       * written twice, because a linked supplier is "already" next time.
       */
      let applied = false;

      if (apply && !out.stopped && written < limit) {
        try {
          await client.updateContact(supplier.id, { contact: { contact_number: match.seller_id } });
          applied = true;
          written += 1;
          if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        } catch (err) {
          out.stopped = err.message;
        }
      }

      if (apply && !applied) out.left += 1;

      out.linked.push({ id: supplier.id, name, seller_id: match.seller_id, how: chosen.how, applied });
    }

    return out;
  }

  return { book, credit, company, exists, ensureSupplier, linkSuppliers };
}

import test from "node:test";
import assert from "node:assert/strict";

import { PURCHASE_VAT, createPurchaseExpense, expenseBody } from "../admin/purchaseExpense.js";

const COMPANIES = [
  { id: 1296508534, name: "Kickz Caviar B.V." },
  { id: 987654321, name: "Payout by Kickz Caviar B.V." }
];

const ACCOUNTS = [
  { id: 111, name: "Commercieel", path_name: "Kosten" },
  { id: 222, name: "Voorraad Scout", path_name: "Activa" }
];

const VAT_TYPES = [
  { id: 688, name: "vat_none", friendly_name: "Geen btw", value: "0.0" },
  { id: 701, name: "vat_high", friendly_name: "21%", value: "0.21" },
  { id: 775, name: "vat_reverse_charged", friendly_name: "Verlegd", value: "0.0" }
];

function fakes({ suppliers = [{ id: 42, company_name: "Zhuoyi" }], expense = { id: 9001, invoice_number: "2026-0042" } } = {}) {
  const calls = [];

  const client = {
    companyId: 987654321,
    async accounts() { return ACCOUNTS; },
    async vatTypes() { return VAT_TYPES; },
    async searchSuppliers(q) { calls.push(["search", q]); return suppliers; },
    async createContact(body) { calls.push(["contact", body]); return { id: 77, ...body.contact }; },
    async createExpense(body) { calls.push(["create", body]); return expense; },
    async attachToExpense(id, file) {
      calls.push(["attach", id, file.filename]);
      return { id: 555, attachment_file_name: file.filename };
    },
    async getExpense(id) {
      calls.push(["get", id]);
      return {
        id,
        contact_id: 42,
        invoice_lines: [{ price_per_unit: "100.0", vat_type_id: 688, account_id: 222, extended_description: "Peterson OG - 42" }]
      };
    }
  };

  const rompslomp = { async companies() { return COMPANIES; } };
  const selfBilling = { async forUnit() { return { filename: "PCS-007999.pdf", pdf: Buffer.from("%PDF-1.4 test") }; } };

  return { calls, client, purchases: createPurchaseExpense({ rompslomp, forCompany: () => client, selfBilling }) };
}

test("a purchase is one expense on the stock account, named after the deal", () => {
  const body = expenseBody({
    date: "2026-09-23",
    contactId: 42,
    accountId: 222,
    vatTypeId: 688,
    vatRate: "0.0",
    deal: "EXTD-000078",
    description: "Peterson OG Sole Canvas Low Black - 42",
    amount: 100
  });

  assert.equal(body.expense.state, "published");
  assert.equal(body.expense.type_account_id, 222);
  assert.equal(body.expense.invoice_lines[0].description, "Purchase Order EXTD-000078");
  assert.equal(body.expense.invoice_lines[0].extended_description, "Peterson OG Sole Canvas Low Black - 42");
  assert.equal(body.expense.invoice_lines[0].price_per_unit, "100.00");
});

test("a credit is the same expense the other way round", () => {
  const body = expenseBody({ date: "2026-09-24", contactId: 42, accountId: 222, vatTypeId: 688, vatRate: "0.0", deal: "EXTD-000078", description: "x", amount: 100, credit: true });

  assert.equal(body.expense.invoice_lines[0].price_per_unit, "-100.00");
  assert.equal(body.expense.invoice_lines[0].description, "Credit Purchase Order EXTD-000078");
});

test("the purchase lands in the Payout company, on Voorraad Scout, with the document on it", async () => {
  const { calls, purchases } = fakes();

  const out = await purchases.book({
    deal: "EXTD-000078",
    unit: { record_id: "recUNIT0000000001", item_id: "PCS-007999", product_name: "Peterson OG", sku: "A01FW702-BLK", size: "42", vat_type: "Margin", price: 100 },
    seller: { company_name: "Zhuoyi", name: "Zhuoyi" }
  });

  assert.equal(out.expense_id, "9001");
  assert.equal(out.expense_number, "2026-0042");
  assert.equal(out.supplier, "Zhuoyi");
  assert.equal(out.attached, false, "Rompslomp takes no attachment on an expense");

  const created = calls.find((call) => call[0] === "create")[1];
  assert.equal(created.expense.contact_id, 42);
  assert.equal(created.expense.type_account_id, 222, "Voorraad Scout, not the first account there is");
  assert.equal(created.expense.invoice_lines[0].vat_type_id, 688, "a margin purchase carries no VAT");

  // Nothing is uploaded: the document hangs on the pair in the admin.
  assert.equal(calls.some((call) => call[0] === "attach"), false);
});

test("a company or an account that is not there stops the booking with a reason", async () => {
  const rompslomp = { async companies() { return [COMPANIES[0]]; } };
  const noCompany = createPurchaseExpense({ rompslomp, forCompany: () => ({}) });
  await assert.rejects(() => noCompany.company(), /no company whose name contains/);

  const client = { companyId: 1, async accounts() { return [ACCOUNTS[0]]; }, async vatTypes() { return VAT_TYPES; } };
  const noAccount = createPurchaseExpense({ rompslomp: { async companies() { return COMPANIES; } }, forCompany: () => client });
  await assert.rejects(() => noAccount.company(), /no stock account this recognises. It has: Commercieel/);
});

test("the stock account is found however its name is punctuated", async () => {
  const client = {
    companyId: 987654321,
    async accounts() {
      return [
        { id: 1, name: "Voorraad", path_name: "Activa • Vlottende activa" },
        { id: 2, name: "Voorraad | Scout", path_name: "Activa • Vlottende activa" },
        { id: 3, name: "Commercieel", path_name: "Kosten" }
      ];
    },
    async vatTypes() { return VAT_TYPES; }
  };

  const purchases = createPurchaseExpense({ rompslomp: { async companies() { return COMPANIES; } }, forCompany: () => client });
  const { account } = await purchases.company();

  assert.equal(account.id, 2, "Voorraad | Scout, punctuation and all, not the heading above it");
});

test("a seller who is no supplier yet becomes one on the first purchase", async () => {
  const { calls, purchases } = fakes({ suppliers: [] });

  const out = await purchases.book({
    deal: "EXTD-000078",
    unit: { vat_type: "Margin", price: 100 },
    seller: { seller_id: "SE-00781", company_name: "Zhuoyi", email: "z@x.es", address: "Calle remodelacion 5", zipcode: "28041", city: "Madrid", country_code: "es", vat_id: "ESB12345678" }
  });

  const made = calls.find((call) => call[0] === "contact")[1].contact;
  assert.equal(made.is_supplier, true);
  assert.equal(made.company_name, "Zhuoyi");
  assert.equal(made.contact_number, "SE-00781", "his Seller ID is his number there, so he is found again by it");
  assert.equal(made.country_code, "ES");
  assert.equal(made.vat_number, "ESB12345678");
  assert.equal(out.supplier, "Zhuoyi");
});

test("a seller without a name cannot become a supplier", async () => {
  const { purchases } = fakes({ suppliers: [] });

  await assert.rejects(
    () => purchases.book({ deal: "EXTD-000078", unit: { vat_type: "Margin", price: 100 }, seller: { seller_id: "SE-00999" } }),
    /no name in the Sellers Database/
  );
});

test("every VAT type we buy under has a Rompslomp type, and an unknown one is refused", async () => {
  assert.deepEqual(PURCHASE_VAT, { Margin: "vat_none", VAT0: "vat_reverse_charged", VAT21: "vat_high" });

  const { calls, purchases } = fakes();
  await purchases.book({ deal: "EXTD-1", unit: { vat_type: "VAT21", price: 121 }, seller: { company_name: "Zhuoyi" } });
  assert.equal(calls.find((call) => call[0] === "create")[1].expense.invoice_lines[0].vat_type_id, 701);

  await assert.rejects(
    () => purchases.book({ deal: "EXTD-2", unit: { vat_type: "Anders", price: 1 }, seller: { company_name: "Zhuoyi" } }),
    /no VAT type to book it under/
  );
});

test("crediting reads the original and books its opposite", async () => {
  const { calls, purchases } = fakes();

  const out = await purchases.credit({ expenseId: "9001", deal: "EXTD-000078" });

  assert.equal(out.expense_id, "9001");
  const created = calls.find((call) => call[0] === "create")[1];
  assert.equal(created.expense.invoice_lines[0].price_per_unit, "-100.00");
  assert.equal(created.expense.invoice_lines[0].extended_description, "Peterson OG - 42");
  assert.equal(created.expense.contact_id, 42);
});

/* ---------------- sellers as suppliers ---------------- */

const SELLERS = [
  { seller_id: "SE-00100", full_name: "luca codini", company_name: "", email: "luca@old.it" },
  { seller_id: "SE-00800", full_name: "luca codini", company_name: "", email: "luca@new.it" },
  { seller_id: "SE-00781", full_name: "Zhuo Yi", company_name: "Zhuoyi", email: "z@x.es" }
];

function linker(suppliers, calls = []) {
  const client = {
    companyId: 9,
    async accounts() { return ACCOUNTS; },
    async vatTypes() { return VAT_TYPES; },
    async allSuppliers() { return suppliers; },
    async updateContact(id, body) { calls.push([id, body.contact.contact_number]); return { id }; }
  };

  return createPurchaseExpense({ rompslomp: { async companies() { return COMPANIES; } }, forCompany: () => client });
}

test("a supplier whose name is a seller's gets that Seller ID", async () => {
  const calls = [];
  const out = await linker([{ id: 1, company_name: "Zhuoyi", contact_number: "L02697" }], calls).linkSuppliers({ sellers: SELLERS, apply: true });

  assert.deepEqual(calls, [[1, "SE-00781"]]);
  assert.equal(out.linked[0].how, "name");
});

test("two sellers with one name are settled by the email, not by guesswork", async () => {
  const calls = [];
  const suppliers = [{ id: 2, contact_person_name: "luca codini", contact_person_email_address: "luca@new.it" }];
  const out = await linker(suppliers, calls).linkSuppliers({ sellers: SELLERS, apply: true });

  assert.deepEqual(calls, [[2, "SE-00800"]]);
  assert.equal(out.linked[0].how, "email");
});

test("without an email to go on, nothing is written unless the newest is asked for", async () => {
  const suppliers = [{ id: 3, contact_person_name: "luca codini" }];

  const careful = await linker(suppliers).linkSuppliers({ sellers: SELLERS, apply: true });
  assert.equal(careful.linked.length, 0);
  assert.equal(careful.ambiguous[0].why, "2 sellers have this name");
  assert.deepEqual(careful.ambiguous[0].sellers, ["SE-00100", "SE-00800"]);

  const calls = [];
  const guessing = await linker(suppliers, calls).linkSuppliers({ sellers: SELLERS, apply: true, whenSeveral: "newest" });
  assert.deepEqual(calls, [[3, "SE-00800"]], "the newest record is the one a seller uses now");
  assert.equal(guessing.linked[0].how, "newest");
});

test("a supplier who is no seller is left alone", async () => {
  const calls = [];
  const out = await linker([{ id: 4, company_name: "Netcup GmbH", contact_number: "L02667" }], calls).linkSuppliers({ sellers: SELLERS, apply: true });

  assert.deepEqual(calls, []);
  assert.equal(out.unmatched[0].name, "Netcup GmbH");
});

test("a supplier that already carries a Seller ID is not touched", async () => {
  const calls = [];
  const out = await linker([{ id: 5, company_name: "Zhuoyi", contact_number: "SE-00781" }], calls).linkSuppliers({ sellers: SELLERS, apply: true });

  assert.deepEqual(calls, []);
  assert.equal(out.already[0].seller_id, "SE-00781");
});

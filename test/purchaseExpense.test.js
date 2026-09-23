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
    async createExpense(body) { calls.push(["create", body]); return expense; },
    async updateExpense(id, body) { calls.push(["update", id, Object.keys(body.expense)]); return { id }; },
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
  assert.equal(out.attached, true, "the self-billing invoice goes on the booking");

  const created = calls.find((call) => call[0] === "create")[1];
  assert.equal(created.expense.contact_id, 42);
  assert.equal(created.expense.type_account_id, 222, "Voorraad Scout, not the first account there is");
  assert.equal(created.expense.invoice_lines[0].vat_type_id, 688, "a margin purchase carries no VAT");

  const attachment = calls.find((call) => call[0] === "update");
  assert.deepEqual(attachment[2], ["attachment_objects"]);
});

test("a company or an account that is not there stops the booking with a reason", async () => {
  const rompslomp = { async companies() { return [COMPANIES[0]]; } };
  const noCompany = createPurchaseExpense({ rompslomp, forCompany: () => ({}) });
  await assert.rejects(() => noCompany.company(), /no company whose name contains/);

  const client = { companyId: 1, async accounts() { return [ACCOUNTS[0]]; }, async vatTypes() { return VAT_TYPES; } };
  const noAccount = createPurchaseExpense({ rompslomp: { async companies() { return COMPANIES; } }, forCompany: () => client });
  await assert.rejects(() => noAccount.company(), /has no account named .*It has: Commercieel/);
});

test("a seller who is no supplier in Rompslomp is said, not invented", async () => {
  const { purchases } = fakes({ suppliers: [] });

  await assert.rejects(
    () => purchases.book({ deal: "EXTD-000078", unit: { vat_type: "Margin", price: 100 }, seller: { company_name: "Zhuoyi" } }),
    /No supplier in Rompslomp for Zhuoyi/
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

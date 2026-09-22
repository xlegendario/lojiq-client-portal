import test from "node:test";
import assert from "node:assert/strict";

import { batchForPayment, createMolliePayoutsStore, settlementMoney } from "../admin/adminMolliePayouts.js";

const settlement = {
  id: "19561756.2608.01",
  reference: "1956175.2608.01",
  status: "paidout",
  paidOutAt: "2026-08-27T10:00:00+00:00",
  amount: { value: "1880.53", currency: "EUR" },
  periods: {
    2026: {
      8: {
        revenue: [{ amountGross: { value: "1881.25" } }],
        costs: [{ amountGross: { value: "0.72" } }],
        invoiceReference: "2026.10000123"
      }
    }
  }
};

test("gross, fees and net come out of the settlement's periods", () => {
  assert.deepEqual(settlementMoney(settlement), {
    gross: 1881.25,
    fees: 0.72,
    net: 1880.53,
    invoice_reference: "2026.10000123"
  });

  assert.deepEqual(settlementMoney({ amount: { value: "10.00" } }), { gross: 0, fees: 0, net: 10, invoice_reference: "" });
});

test("a payment finds its batch by payment id, by link, or by the PAYB number in its description", () => {
  const payment = { id: "tr_aaa" };
  const link = { id: "tr_bbb", paymentLinkId: "pl_xyz" };
  const described = { id: "tr_ccc", description: "PAYB-000048 DripOrDrop" };

  const index = {
    byPayment: new Map([["tr_aaa", { "Batch ID": "PAYB-000012" }]]),
    byLink: new Map([["pl_xyz", { "Batch ID": "PAYB-000033" }]]),
    byNumber: new Map([["PAYB-000048", { "Batch ID": "PAYB-000048" }]])
  };

  assert.equal(batchForPayment(index, payment).batch["Batch ID"], "PAYB-000012");
  assert.equal(batchForPayment(index, payment).via, "payment");
  assert.equal(batchForPayment(index, link).via, "link");
  assert.equal(batchForPayment(index, described).via, "description");
  assert.deepEqual(batchForPayment(index, { id: "tr_ddd" }), { batch: null, via: "" });
});

// Mollie, Airtable and Supabase as they answer for the DripOrDrop payout:
// four deals on one invoice, collected through one fake order, plus a payment
// no batch knows.
function fakes() {
  const fetchImpl = async (url) => {
    const path = String(url).replace("https://api.mollie.com/v2", "");

    if (path.startsWith("/settlements/19561756.2608.01/payments")) {
      return new Response(JSON.stringify({
        _embedded: {
          payments: [
            { id: "tr_batch", amount: { value: "1511.25", currency: "EUR" }, method: "banktransfer", paidAt: "2026-08-26T09:00:00+00:00", description: "PAYB-000048" },
            { id: "tr_loose", amount: { value: "370.00", currency: "EUR" }, method: "ideal", paidAt: "2026-08-26T11:00:00+00:00", description: "Sneakers" }
          ]
        },
        _links: {}
      }), { status: 200 });
    }

    if (path.startsWith("/settlements/")) return new Response(JSON.stringify(settlement), { status: 200 });
    throw new Error(`unexpected Mollie call ${path}`);
  };

  const airtable = {
    select: async () => ({
      records: [{
        id: "recBatch",
        fields: {
          "Batch ID": "PAYB-000048",
          "Payment Provider": "Mollie",
          "Mollie Payment ID": "tr_batch",
          "Linked Orders": ["recOrder"],
          "External Deal IDs": "EXTD-000028, EXTD-000029"
        }
      }]
    }),
    byIds: async (table) => (table === "Unfulfilled Orders Log"
      ? new Map([["recOrder", { "Order ID": "ORD-020169", "Store Name": ["DripOrDrop"], "Rompslomp Invoice Number": "KC202607-1839", "Invoice Price (VAT Included)": 300 }]])
      : new Map())
  };

  const written = [];
  const db = {
    get: async (query) => {
      if (query.startsWith("mollie_payouts")) return [];
      return [
        { deal_number: 28, total_selling_price: 150, buyer_company: "DripOrDrop", external_sale_invoice_deals: [{ external_sale_invoices: { invoice_number: "KC202607-1839", kind: "sale" } }] },
        { deal_number: 29, total_selling_price: 150, buyer_company: "DripOrDrop", external_sale_invoice_deals: [{ external_sale_invoices: { invoice_number: "KC202607-1839", kind: "sale" } }] }
      ];
    },
    insert: async (query, rows) => {
      written.push({ query, rows });
      return [{ ...rows[0] }];
    }
  };

  return { written, store: createMolliePayoutsStore({ airtable, db, token: "access_x", fetchImpl }) };
}

test("a payout lists its payments with the invoices behind them, and what no batch knows", async () => {
  const { store } = fakes();
  const payout = await store.get("19561756.2608.01");

  assert.equal(payout.gross, 1881.25);
  assert.equal(payout.net, 1880.53);
  assert.equal(payout.payments.length, 2);

  const [batched, loose] = payout.payments;
  assert.equal(batched.batch, "PAYB-000048");
  assert.equal(batched.matched_by, "payment");
  assert.deepEqual(batched.lines.map((line) => line.what), ["ORD-020169", "EXTD-000028", "EXTD-000029"]);
  assert.equal(batched.lines[0].invoice, "KC202607-1839");

  assert.equal(loose.batch, "");
  assert.deepEqual(payout.unmatched.map((p) => p.payment_id), ["tr_loose"]);

  // One invoice number, however many deals sit on it.
  assert.deepEqual(payout.invoices, ["KC202607-1839"]);
  // 300 for the order plus 150 + 150 for the deals: the 370 stays unexplained.
  assert.equal(payout.invoiced_total, 600);
});

test("booking a payout only remembers that it is booked", async () => {
  const { store, written } = fakes();
  const row = await store.setBooked("19561756.2608.01", { note: "op 27-08 geboekt", by: "Dario" });

  assert.equal(written[0].query, "mollie_payouts?on_conflict=settlement_id");
  assert.equal(row.settlement_id, "19561756.2608.01");
  assert.equal(row.booked_by, "Dario");
  assert.equal(row.note, "op 27-08 geboekt");
  assert.ok(row.booked_at);

  await assert.rejects(() => store.setBooked("../etc"), /Unknown payout/);
});

test("without a reporting token the tab says so instead of failing", async () => {
  const store = createMolliePayoutsStore({ airtable: {}, db: {}, token: "" });
  assert.equal(store.configured, false);
  await assert.rejects(() => store.list(), /MOLLIE_REPORTING_TOKEN/);
});

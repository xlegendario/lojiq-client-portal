import test from "node:test";
import assert from "node:assert/strict";

import { expenseTotal, indexDocuments, invoiceNumbersIn, namesMatch, parseBankLine, paymentCodesIn, planLinks, sneakerAskOrderNumber, KRUISPOSTEN_PATH, ING_PATH } from "../admin/rompslompLinking.js";
import { choosePick, modalBody, parsePaymentRows, parsePickRows, runLinking, searchFor, webAmount } from "../admin/rompslompWeb.js";

const line = (description, ex, vat = 0, qty = 1) => ({ description, price_without_vat: String(ex), vat_amount: String(vat), quantity: String(qty), price_with_vat: String(ex + vat) });
const invoice = (id, number, open, contact, description = "") => ({ id, invoice_number: number, open_amount: String(open), cached_contact: { name: contact }, description, date: "2026-10-15" });
const expense = (id, label, total, contact, date = "2026-11-03") => ({ id, date, cached_contact: { name: contact }, invoice_lines: [line(label, total)] });
const pay = (id, amount, description, account = ING_PATH, paid_at = "2026-11-12T00:00:00.000+01:00") => ({ id, amount: String(amount), description, account_path: account, paid_at });

test("bank line text is split into name, description and kenmerk", () => {
  const b = parseBankLine("Naam: WOOVIN B.V.Omschrijving: Payout 7440 - UNIONAmsterdamIBAN: NL44RABO0339087692Kenmerk: PAYOUT-7440Valutadatum: 11-11-2026");
  assert.equal(b.name, "WOOVIN B.V.");
  assert.equal(b.about, "Payout 7440 - UNIONAmsterdam");
  assert.equal(b.kenmerk, "PAYOUT-7440");
  assert.equal(parseBankLine("Naam: XOmschrijving: ORD-1Reden: Bank begunstigde niet bereikbaar").returned, true);
});

test("references are read the ways people write them", () => {
  assert.deepEqual(invoiceNumbersIn("Factuur KC202610 2279"), ["KC202610-2279"]);
  assert.deepEqual(invoiceNumbersIn("Payment invoiceKC202610-2349, KC202610-2256"), ["KC202610-2349", "KC202610-2256"]);
  assert.equal(sneakerAskOrderNumber("PO-20261028-040-.176299"), "176299");
  assert.deepEqual(paymentCodesIn("MON20260211"), ["MON20260211"]);
  assert.deepEqual(paymentCodesIn("AKA20260808-1"), ["AKA20260808-1"]);
});

test("names match on a distinctive word, not on legal forms", () => {
  assert.ok(namesMatch("Dominicks Distributor Keresekedelmi es Szolgaltato", "Dominicks Distributor Bt"));
  assert.ok(namesMatch("CREATOR FLYWHEEL BV", "Creator Flywheel B.V."));
  assert.ok(namesMatch("Kicks by Mattie", "KicksbyMattie B.V."));
  assert.ok(!namesMatch("SAS SNEAK BY BRICK", "Etienne Leconte"));
  assert.ok(!namesMatch("ALC Select Store SL", "Emanuele De Martino"));
});

test("an expense's total is ex-VAT plus the VAT amounts, as Rompslomp rounds", () => {
  assert.equal(expenseTotal({ invoice_lines: [line("a", 12.33, 2.59), line("b", 1.1, 0.23)] }), 16.25);
});

test("plan: our Kruisposten, bank lines and Woovin, only when certain", () => {
  const docs = indexDocuments({
    invoices: [
      invoice(1, "KC202611-2672", 118.75, "Store A"),
      { ...invoice(2, "KC202611-2673", -118.75, "Store A"), payment_status: "overpaid" },
      invoice(3, "KC202610-2280", 150, "ALC SELECT STORE SL", "ORD-028551"),
      invoice(4, "KC202610-2384", 148, "SneakerAsk"),
      invoice(5, "KC202610-2290", 0, "ALC SELECT STORE SL")
    ],
    expenses: [
      expense(10, "Purchase Order ORD-030979", 100, "Zhuoyi"),
      expense(11, "Credit Purchase Order ORD-030979", -100, "Zhuoyi"),
      expense(12, "Purchase Order ORD-029187", 110, "KicksbyMattie B.V."),
      expense(13, "Purchase Order ORD-030090", 110, "KicksbyMattie B.V."),
      { id: 14, date: "2026-11-11", cached_contact: { name: "WOOVIN B.V." }, invoice_lines: [line("Woovin payout invoice #7459 � ORD-030168 � transaction fee", 717.42, 150.63)] }
    ],
    unpaidExpenseIds: new Set([10, 12, 13, 14])
  });
  const woovin = [pay(30, 118.75, "Woovin payout #7459: KC202611-2672 (ORD-1)", KRUISPOSTEN_PATH), pay(31, -868.05, "Woovin payout #7459: kosten payout invoice #7459", KRUISPOSTEN_PATH)];
  const payments = [
    pay(20, 118.75, "Kruispost ORD-032613: KC202611-2672 (factuur KC202611-2672 tegen credit KC202611-2673)", KRUISPOSTEN_PATH),
    pay(21, -118.75, "Kruispost ORD-032613: KC202611-2673 (factuur KC202611-2672 tegen credit KC202611-2673)", KRUISPOSTEN_PATH),
    pay(22, 100, "Kruispost ORD-030979: Credit Purchase Order ORD-030979 (inkoop Purchase Order ORD-030979 tegen credit Credit Purchase Order ORD-030979)", KRUISPOSTEN_PATH),
    pay(23, 150, "Naam: ALC SELECT STORE SLOmschrijving: Invoice KC202610 2280IBAN: ES57"),
    pay(24, 148, "Naam: SneakerAskOmschrijving:PO-20261028-040-.176299IBAN: NL53"),
    pay(25, -110, "Naam: KicksbyMattie B.V.Omschrijving: ORD-029187IBAN: NL21"),
    pay(26, -110, "Naam: Someone ElseOmschrijving: ORD-030090IBAN: NL21"),
    pay(27, -150, "Naam: Dominicks DistributorOmschrijving: ORD-028743IBAN: BEReden: Bank begunstigde niet bereikbaar"),
    pay(28, 9612.51, "Naam: Stichting Mollie PaymentsOmschrijving: REF T19561756"),
    pay(29, 100, "Naam: ALC SELECT STORE SLOmschrijving: Factuur KC202610 2290IBAN: ES57"),
    pay(32, -749.3, "Naam: WOOVIN B.V.Omschrijving: Payout 7459 - UNIONIBAN: NL44Kenmerk: PAYOUT-7459"),
    ...woovin
  ];
  const plan = planLinks({
    payments,
    allPayments: payments,
    docs,
    lookups: { shopifyOrder: new Map([["176299", { orderId: "ORD-030199", invoiceNumber: "KC202610-2384" }]]) }
  });
  const by = new Map(plan.link.map((r) => [r.payment_id, r]));
  // 30 and 20 both pay KC202611-2672: neither is certain.
  assert.ok(!by.has(20) && !by.has(30));
  assert.equal(by.get(21).target.number, "KC202611-2673");
  assert.equal(by.get(22).target.id, 11);
  assert.equal(by.get(23).target.number, "KC202610-2280");
  assert.equal(by.get(24).rule, "sneakerask");
  assert.equal(by.get(25).target.id, 12);
  assert.equal(by.get(31).target.id, 14);
  assert.equal(by.get(32).rule, "woovin_bank");
  const why = new Map(plan.review.map((r) => [r.payment_id, r.reason]));
  assert.match(why.get(26), /name/);
  assert.match(why.get(27), /returned/);
  assert.match(why.get(29), /already paid/);
  assert.match(why.get(20), /2 payments point to KC202611-2672/);
  assert.equal(plan.skipped["Mollie (out of scope)"], 1);
});

test("a Woovin bank line waits until its Kruisposten add up", () => {
  const docs = indexDocuments({ invoices: [], expenses: [], unpaidExpenseIds: new Set() });
  const bank = pay(1, 100, "Naam: WOOVIN B.V.Omschrijving: Payout 7500IBAN: NLKenmerk: PAYOUT-7500");
  const plan = planLinks({ payments: [bank], allPayments: [bank, pay(2, 99.99, "Woovin payout #7500: KC1 (x)", KRUISPOSTEN_PATH)], docs });
  assert.equal(plan.link.length, 0);
  assert.match(plan.review[0].reason, /add up to € 99.99/);
});

// --- web pages, as Rompslomp sent them on 14-11-2026 (trimmed)

const PAYMENT_ROW = `<tr class="payment"> <td> <div class="styled-checkbox"> <input class="selection_checkbox form-control" id="check26010190" type="checkbox" value="26010190"> </div> </td> <td> <div class="small"> 13/11/2026 P20261105674 </div> <div class="label neutral"> Kruisposten </div> </td> <td class="breakable"> <strong>Kruispost ORD-030979: Credit Purchase Order ORD-030979 (inkoop Purchase Order ORD-030979 tegen credit Credit Purchase Order ORD-030979)</strong> </td> <td></td> <td align="right" style="min-width: 110px;"> <div class="visible-xs"> Bedrag: </div> <strong><span class="currency_amount pos">€ 100,00 &uarr;</span></strong> <div class="small"> Nog in te boeken: <span class="currency_amount pos">€ 100,00 &uarr;</span> </div> </td> <td><a class="btn btn-primary btn-sm " data-remote="true" href="/ondernemingen/payout-by-kickz-caviar-b-v/betalingen/26010190/book?payment_account_id=kruisposten">Inboeken</a></td></tr>`;

const PICK = `<tr id="expense_5831fe9a" class="odd"><td class="small">13/11/2026</td> <td> <div class="small"> <a href="/x">Zhuoyi</a> </div> </td> <td class="truncate"> <a href="/ondernemingen/payout-by-kickz-caviar-b-v/kosten/pick">Credit Purchase Order ORD-030979</a> <br> <div class="label-holder" id="expense_5831fe9a_paid_label_holder"> <div class="label yellow"><a data-remote="true" href="/x">Nog niet betaald</a></div> </div> </td> <td align="right" class="currency_amount"> <div class="with_vat">-€ 100,00</div> </td> <td align="right" class="currency_amount"> <a class="btn btn-primary" data-pick-expense="26755169" href="#">Kiezen</a> </td> </tr><tr id="expense_03afa6a3" class="even"><td class="small">03/11/2026</td> <td> <div class="small"> <a href="/x">Zhuoyi</a> </div> </td> <td class="truncate"> <a href="/x">Purchase Order ORD-030979</a> <br> <div class="label-holder" id="expense_03afa6a3_paid_label_holder"> <div class="label yellow"><a data-remote="true" href="/x">Nog niet betaald</a></div> </div> </td> <td align="right" class="currency_amount"> <div class="with_vat">€ 100,00</div> </td> <td><a class="btn btn-primary" data-pick-expense="26730291" href="#">Kiezen</a> </td> </tr></table>`;

const PICK_EARNING = `<tr id="earning_d44e" class="odd"><td class="small"> 15/10/2026 <br> <a href="/x">KC202610-2280</a> </td> <td> <div class="small"> <a href="/x"> ALC SELECT STORE SL</a> </div> </td> <td class="truncate"> <a data-swipe-left="true" href="/x">ORD-028551</a> <br> <div class="label-holder" id="earning_d44e_paid_label_holder"> <div class="label red"><a data-remote="true" href="/x">Nog niet betaald: verlopen</a></div> </div> </td> <td align="right" class="currency_amount"> <div class="with_vat">€ 150,00</div> </td> <td><a class="btn btn-primary" data-pick-earning="28096588" href="#">Kiezen</a> </td> </tr></table>`;

test("web amounts keep their sign", () => {
  assert.equal(webAmount("€ 1.576,21 ↑"), 1576.21);
  assert.equal(webAmount("-€ 100,00"), -100);
  assert.equal(webAmount("€ 868,05 &darr;"), -868.05);
});

test("the payments list is read row by row", () => {
  const [row] = parsePaymentRows(PAYMENT_ROW);
  assert.deepEqual(row, { id: "26010190", date: "2026-11-13", description: "Kruispost ORD-030979: Credit Purchase Order ORD-030979 (inkoop Purchase Order ORD-030979 tegen credit Credit Purchase Order ORD-030979)", amount: 100, left: 100 });
});

test("pick lists give id, label, status and amount", () => {
  const body = modalBody(`window.modal.open(${JSON.stringify({ body: PICK, name: "pick" })});`);
  const rows = parsePickRows(body, "expense");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "26755169", date: "2026-11-13", number: "", contact: "Zhuoyi", label: "Credit Purchase Order ORD-030979", status: "Nog niet betaald", amount: -100 });
  const [earning] = parsePickRows(PICK_EARNING, "earning");
  assert.equal(earning.number, "KC202610-2280");
  assert.equal(earning.amount, 150);
  assert.match(earning.status, /^Nog niet betaald/);
});

test("the planned document is chosen on the web only when it is the same one", () => {
  const rows = parsePickRows(PICK, "expense");
  const credit = { amount: 100, target: { kind: "expense", number: "Credit Purchase Order ORD-030979", date: "2026-11-13" } };
  assert.equal(choosePick(rows, credit).pick.id, "26755169");
  const purchase = { amount: -100, target: { kind: "expense", number: "Purchase Order ORD-030979", date: "2026-11-03" } };
  assert.equal(choosePick(rows, purchase).pick.id, "26730291");
  assert.match(choosePick(rows, { ...purchase, amount: -90 }).error, /expected € 90.00/);
  const paid = rows.map((r) => ({ ...r, status: "Betaald" }));
  assert.match(choosePick(paid, purchase).error, /Betaald/);
  const inv = { amount: 150, target: { kind: "invoice", number: "KC202610-2280", open: 150 } };
  assert.equal(choosePick(parsePickRows(PICK_EARNING, "earning"), inv).pick.id, "28096588");
});

test("a payment is searched by its kenmerk, description or Kruispost head", () => {
  assert.equal(searchFor({ account: "ING", description: "Naam: WOOVIN B.V.Omschrijving: Payout 7440IBAN: NLKenmerk: PAYOUT-7440Valutadatum: 1" }), "PAYOUT-7440");
  assert.equal(searchFor({ account: "ING", description: "Naam: KicksbyMattie B.V.Omschrijving: ORD-029187IBAN: NL21" }), "ORD-029187");
  assert.equal(searchFor({ account: "Kruisposten", description: "Kruispost ORD-1: KC1 (factuur …)" }), "Kruispost ORD-1: KC1");
});

test("a run books only what is planned, and only what the web confirms", async () => {
  const pages = {
    "/payments?selection=unbooked": { payments: [pay(25, -110, "Naam: KicksbyMattie B.V.Omschrijving: ORD-029187IBAN: NL21")] },
    "/sales_invoices?selection=all": { sales_invoices: [] },
    "/expenses?selection=all": { expenses: [expense(12, "Purchase Order ORD-029187", 110, "KicksbyMattie B.V.", "2026-10-23")] },
    "/expenses?selection=unpaid": { expenses: [{ id: 12 }] },
    "/payments?selection=all": { payments: [] }
  };
  const rompslomp = { read: async (path) => (path.includes("page=1&") ? pages[path.split("&page=")[0]] : { payments: [], expenses: [], sales_invoices: [] }) };
  const booked = [];
  const web = {
    configured: true,
    payments: async () => [{ id: "999", date: "2026-11-12", amount: -110, left: -110, description: "Naam: KicksbyMattie B.V.Omschrijving: ORD-029187IBAN: NL21" }],
    pick: async () => [{ id: "777", date: "2026-10-23", label: "Purchase Order ORD-029187", status: "Nog niet betaald", amount: 110 }],
    book: async (id, what) => { booked.push([id, what]); return { ok: true, body: "window.nextMutation()" }; }
  };
  const dry = await runLinking({ deps: { rompslomp, web, airtable: null }, dry: true });
  assert.equal(dry.planned, 1);
  assert.equal(booked.length, 0);
  const real = await runLinking({ deps: { rompslomp, web, airtable: null }, dry: false });
  assert.equal(real.linked.length, 1);
  assert.deepEqual(booked, [["999", { expenseId: "777" }]]);
});

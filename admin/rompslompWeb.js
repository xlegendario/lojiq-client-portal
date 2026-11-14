// Rompslomp's web app, for the one thing its API cannot do: book a payment
// on a document (or on Kruisposten), as the bot user ROMPSLOMP_WEB_EMAIL.
//
// The routes, tested 05-11-2026 and 14-11-2026:
//   payments list   /ondernemingen/<slug>/betalingen?payment_account_id=…&search[q]=…
//                   one <tr class="payment"> per payment, its web id in the checkbox
//   pick a document /kosten/pick | /inkomsten/pick?payment_id=…&selection=all&search[q]=…
//                   (remote modal; data-pick-expense / data-pick-earning)
//   link            POST /betalingen/{id}/book  mutation[expense_id] | mutation[earning_id]
//                   answer calls window.nextMutation() when it worked
//   journal         GET /boekingen/new_from_payment?payment_id=… → POST its form
// Web ids are not the API ids, so a payment is found back by date, amount and
// description, and a document by its number, date, amount and "Nog niet betaald".
//
// Never Rompslomp's own "Auto-inboeken" (book_predictions): it proposed the
// wrong supplier for € 110 on 05-11-2026.

import { KRUISPOSTEN_PATH, ING_PATH, indexDocuments, parseBankLine, paymentCodesIn, planLinks, sneakerAskOrderNumber } from "./rompslompLinking.js";

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const text = (v) => (v == null ? "" : String(v)).trim();
const cents = (n) => Math.round(Number(n) * 100);

const WEB = "https://app.rompslomp.nl";
export const COMPANY_SLUG = "payout-by-kickz-caviar-b-v";
const KRUISPOSTEN_LABEL = "Activa • Liquide middelen • Kruisposten";

// ------------------------------------------------------------------ parsing

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", uarr: "↑", darr: "↓", euro: "€" };
export const decode = (value) => text(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (all, code) => {
  if (code[0] === "#") return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return ENTITIES[code.toLowerCase()] ?? all;
});
export const strip = (html) => decode(text(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// Rompslomp's API hands "·" back as U+FFFD; the web shows it right.
const sameText = (a, b) => strip(a).replace(/�/g, "·") === strip(b).replace(/�/g, "·");

/** "€ 1.576,21 ↑" → 1576.21, "-€ 100,00" or "… ↓" → negative. */
export function webAmount(value) {
  const s = strip(value);
  const m = s.match(/(-?)\s*€\s*(-?)([\d.]+,\d{2})/);
  if (!m) return null;
  const n = Number(m[3].replace(/\./g, "").replace(",", "."));
  return m[1] || m[2] || /↓/.test(s) ? -n : n;
}

/** The HTML inside a remote modal answer: window.modal.open({"body":"…","name":…}). */
export function modalBody(raw) {
  const s = text(raw);
  const start = s.indexOf("\"body\":\"");
  if (!s.startsWith("window.modal.open(") || start < 0) return s;
  const end = s.lastIndexOf("\",\"name\"");
  try { return JSON.parse(`"${s.slice(start + 8, end > start ? end : undefined)}"`); } catch { return s; }
}

/** Rows of the payments list. */
export function parsePaymentRows(html) {
  return text(html).split(/<tr class="payment"/).slice(1).map((row) => {
    const id = row.match(/id="check(\d+)"/)?.[1] || row.match(/betalingen\/(\d+)\/book/)?.[1] || "";
    const date = row.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const description = row.match(/<td class="breakable">\s*<strong>([\s\S]*?)<\/strong>/)?.[1] || "";
    const amount = webAmount(row.match(/<strong><span class="currency_amount[^"]*">[^<]*<\/span><\/strong>/)?.[0] || "");
    const left = webAmount(row.match(/Nog in te boeken:\s*<span class="currency_amount[^"]*">[^<]*<\/span>/)?.[0] || "");
    return { id, date: date ? `${date[3]}-${date[2]}-${date[1]}` : "", description: strip(description), amount, left };
  }).filter((r) => r.id);
}

/** Rows of a pick list; kind "expense" or "earning". */
export function parsePickRows(html, kind) {
  const attr = kind === "expense" ? "data-pick-expense" : "data-pick-earning";
  const prefix = kind === "expense" ? "expense_" : "earning_";
  return text(html).split(`<tr id="${prefix}`).slice(1).map((chunk) => {
    const row = chunk.split("</tr>")[0];
    const cells = row.split("<td").slice(1);
    const date = row.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return {
      id: row.match(new RegExp(`${attr}="(\\d+)"`))?.[1] || "",
      date: date ? `${date[3]}-${date[2]}-${date[1]}` : "",
      number: kind === "earning" ? strip(cells[0]?.match(/<a [^>]*>([^<]*)<\/a>/)?.[1] || "") : "",
      contact: strip(cells[1]?.match(/<a [^>]*>([^<]*)<\/a>/)?.[1] || ""),
      label: strip(row.match(/<td class="truncate">\s*<a [^>]*>([\s\S]*?)<\/a>/)?.[1] || ""),
      status: strip(row.match(/_paid_label_holder">\s*<div class="label[^"]*">([\s\S]*?)<\/div>/)?.[1] || ""),
      // Two amounts: one ex-VAT and the one marked "incl. btw"; the payment pays the latter.
      amount: webAmount(row.match(/<div class="without_vat">([^<]*)<br>\s*incl\. btw/)?.[1]
        || row.match(/<div class="[^"]*">([^<]*)<br>\s*incl\. btw/)?.[1]
        || row.match(/<div class="with_vat">([^<]*)<\/div>/)?.[1] || "")
    };
  }).filter((r) => r.id);
}

// ------------------------------------------------------------------ session

export class RompslompWebError extends Error {}
class Mismatch extends RompslompWebError {}

export function createRompslompWeb({ email, password, slug = COMPANY_SLUG, fetchImpl = fetch }) {
  const configured = Boolean(text(email) && text(password));
  const jar = new Map();
  let csrf = "";
  let loggedIn = false;

  const keepCookies = (response) => {
    const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
    for (const line of list) {
      const pair = String(line).split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };

  async function raw(path, { method = "GET", form = null, xhr = false } = {}) {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "User-Agent": "Mozilla/5.0 (Lojiq portal; payment linking)" };
    if (xhr) Object.assign(headers, { "X-Requested-With": "XMLHttpRequest", Accept: "text/javascript, application/javascript, */*; q=0.01" });
    else headers.Accept = "text/html,application/xhtml+xml";
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (csrf) headers["X-CSRF-Token"] = csrf;
      body = new URLSearchParams(form).toString();
    }
    const response = await fetchImpl(`${WEB}${path}`, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(45_000) });
    keepCookies(response);
    const out = await response.text();
    const token = out.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
    if (token) csrf = decode(token);
    return { status: response.status, location: response.headers.get("location") || "", body: out };
  }

  async function login() {
    if (!configured) throw new RompslompWebError("Linking needs ROMPSLOMP_WEB_EMAIL and ROMPSLOMP_WEB_PASSWORD on this service.");
    jar.clear();
    const form = await raw("/login");
    const token = decode(form.body.match(/name="authenticity_token" value="([^"]+)"/)?.[1] || "");
    if (!token) throw new RompslompWebError("Rompslomp's login page has no form token.");
    const res = await raw("/login", {
      method: "POST",
      form: { authenticity_token: token, "user[email]": email, "user[password]": password, "user[remember_me]": "0", commit: "Inloggen" }
    });
    // Rails answers 302 or 303; sent back to /login means the password was not taken.
    const where = res.location.replace(/^https?:\/\/[^/]+/, "");
    if (![301, 302, 303].includes(res.status) || /\/login\b/.test(where)) throw new RompslompWebError(`Rompslomp did not accept the bot login (${res.status}${where ? ` to ${where}` : ""}).`);
    const home = await raw(`/ondernemingen/${slug}/betalingen`);
    if (home.status !== 200 || !csrf) throw new RompslompWebError(`The bot user cannot open ${slug} (${home.status}).`);
    loggedIn = true;
  }

  async function page(path, options = {}) {
    if (!loggedIn) await login();
    let res = await raw(path, options);
    if ([301, 302, 303].includes(res.status) && /\/login\b/.test(res.location)) {
      await login();
      res = await raw(path, options);
    }
    if (res.status >= 400) throw new RompslompWebError(`Rompslomp ${options.method || "GET"} ${path.split("?")[0]} gave ${res.status}.`);
    return res;
  }

  const base = `/ondernemingen/${slug}`;

  return {
    configured,
    login,

    async payments(account, q) {
      const res = await page(`${base}/betalingen?payment_account_id=${encodeURIComponent(account)}&search[q]=${encodeURIComponent(q)}`);
      return parsePaymentRows(res.body);
    },

    async pick(kind, paymentId, q, selection = "all") {
      const what = kind === "expense" ? "kosten" : "inkomsten";
      const res = await page(`${base}/${what}/pick?payment_id=${paymentId}&selection=${selection}&search[q]=${encodeURIComponent(q)}`, { xhr: true });
      return parsePickRows(modalBody(res.body), kind);
    },

    /** Link a payment to one document. */
    async book(paymentId, { expenseId = "", earningId = "" }) {
      const form = { authenticity_token: csrf };
      if (expenseId) form["mutation[expense_id]"] = String(expenseId);
      else form["mutation[earning_id]"] = String(earningId);
      const res = await page(`${base}/betalingen/${paymentId}/book`, { method: "POST", form, xhr: true });
      return { ok: /nextMutation\(\)/.test(res.body), body: res.body.slice(0, 400) };
    },

    /**
     * A journal entry from a bank payment for its whole amount: the bank on
     * its own side, `toLabel` (as Rompslomp names the account) on the other.
     */
    async bookToAccount(paymentId, { toLabel, description }) {
      const res = await page(`${base}/boekingen/new_from_payment?payment_id=${paymentId}`, { xhr: true });
      const form = modalBody(res.body);
      const action = decode(form.match(/<form[^>]+action="([^"]*\/boekingen\?[^"]*)"/)?.[1] || "");
      if (!action) throw new RompslompWebError("Rompslomp shows no journal form for this payment.");
      const value = (name) => decode(form.match(new RegExp(`name="${name.replace(/[[\]]/g, "\\$&")}"[^>]*value="([^"]*)"`))?.[1]
        || form.match(new RegExp(`value="([^"]*)"[^>]*name="${name.replace(/[[\]]/g, "\\$&")}"`))?.[1] || "");
      const select = form.match(/<select[^>]+name="transfer\[transfer_lines_attributes\]\[0\]\[account_id\]"[\s\S]*?<\/select>/)?.[0] || "";
      const options = [...select.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ id: m[1].match(/value="(\d+)"/)?.[1] || "", selected: /selected/.test(m[1]), label: decode(m[2]).trim() }));
      const fromId = options.find((o) => o.selected)?.id || "";
      const toId = options.find((o) => o.label === toLabel)?.id || "";
      const amount = Number(value("transfer[transfer_lines_attributes][0][amount]"));
      if (!fromId || !toId || !amount) throw new RompslompWebError(`Journal form incomplete (from ${fromId || "?"}, to ${toId || "?"}, amount ${amount || "?"}).`);

      // is_negative is a hidden "false" followed by a checkbox "true": the
      // bank keeps the side the form gave it, the other line the opposite.
      const bankNegative = /name="transfer\[transfer_lines_attributes\]\[0\]\[is_negative\]"[^>]*checked/.test(form) || amount < 0;
      const body = new URLSearchParams();
      for (const [k, v] of [
        ["authenticity_token", csrf],
        ["is_unprocessed_pre_payment", value("is_unprocessed_pre_payment") || "false"],
        ["form_backup_key_hash", value("form_backup_key_hash")],
        ["transfer[description]", description],
        ["transfer[date]", value("transfer[date]")],
        ["transfer[transfer_lines_attributes][0][account_id]", fromId],
        ["transfer[transfer_lines_attributes][0][amount]", String(Math.abs(amount))],
        ["transfer[transfer_lines_attributes][0][is_negative]", "false"],
        ...(bankNegative ? [["transfer[transfer_lines_attributes][0][is_negative]", "true"]] : []),
        ["transfer[transfer_lines_attributes][1][account_id]", toId],
        ["transfer[transfer_lines_attributes][1][amount]", String(Math.abs(amount))],
        ["transfer[transfer_lines_attributes][1][is_negative]", "false"],
        ...(bankNegative ? [] : [["transfer[transfer_lines_attributes][1][is_negative]", "true"]])
      ]) body.append(k, v);
      const posted = await page(action, { method: "POST", form: body, xhr: true });
      return { ok: posted.status < 300 && !/has-error|error_explanation|inline-errors/.test(posted.body), body: posted.body.slice(0, 400) };
    }
  };
}

// --------------------------------------------------------------------- job

const WEB_ACCOUNT = { Kruisposten: "kruisposten", ING: "bank-zakelijk-ing" };
const RULE_ORDER = ["kruispost_sales", "kruispost_purchase", "woovin_document", "woovin_fees", "bank_invoice", "sneakerask", "bank_expense", "bank_payment_note", "woovin_bank"];

/** What to type into the payments search to find this payment back. */
export function searchFor(row) {
  if (row.account === "Kruisposten") return row.description.split(" (")[0].slice(0, 80);
  const bank = parseBankLine(row.description);
  const kenmerk = /^\d{2}-\d{2}-\d{4}/.test(bank.kenmerk) ? "" : bank.kenmerk;
  return (kenmerk || bank.about || row.description).slice(0, 80);
}

/** The web's row for the planned document, or why there is none. */
export function choosePick(rows, row) {
  const t = row.target;
  const expected = round2(t.kind === "invoice" ? t.open : -row.amount);
  const fit = rows.filter((r) => t.kind === "invoice"
    ? r.number === t.number
    : (r.label === t.number || r.label.startsWith(`${t.number} `) || r.label.startsWith(`${t.number},`)) && r.date === t.date);
  if (fit.length !== 1) return { error: `${fit.length} rows for ${t.number} on the web` };
  const pick = fit[0];
  if (!/^Nog niet betaald/i.test(pick.status)) return { error: `${t.number} shows "${pick.status || "no status"}" on the web` };
  if (pick.amount == null || cents(pick.amount) !== cents(expected)) return { error: `${t.number} is € ${pick.amount} on the web, expected € ${expected.toFixed(2)}` };
  return { pick };
}

/** Airtable: SneakerAsk's Shopify order numbers and Payment Note codes on these lines. */
export async function loadLookups({ airtable, payments }) {
  const shopifyOrder = new Map();
  const paymentCode = new Map();
  if (!airtable) return { shopifyOrder, paymentCode };

  const all = async (table, formula, fields) => {
    const out = [];
    let offset = "";
    do {
      const page = await airtable.select(table, { formula, fields, pageSize: 100, offset });
      out.push(...page.records);
      offset = page.offset;
    } while (offset && out.length < 3000);
    return out;
  };
  const quote = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

  const numbers = [...new Set(payments.map((p) => {
    const b = parseBankLine(p.description);
    return /sneakerask/i.test(b.name) ? sneakerAskOrderNumber(b.about) : "";
  }).filter(Boolean))];
  for (let i = 0; i < numbers.length; i += 30) {
    const chunk = numbers.slice(i, i + 30);
    const rows = await all("Unfulfilled Orders Log", `OR(${chunk.map((n) => `{Shopify Order Number}&''=${quote(n)}`).join(",")})`,
      ["Order ID", "Shopify Order Number", "Store Name", "Rompslomp Invoice Number"]);
    const seen = new Map();
    for (const r of rows) {
      const f = r.fields || {};
      if (!/sneakerask/i.test([].concat(f["Store Name"] || []).join(","))) continue;
      const n = text(f["Shopify Order Number"]);
      // Two SneakerAsk orders with one number: not certain, so not found.
      seen.set(n, seen.has(n) ? null : { orderId: text(f["Order ID"]), invoiceNumber: text(f["Rompslomp Invoice Number"]) });
    }
    for (const [n, v] of seen) if (v) shopifyOrder.set(n, v);
  }

  const codes = [...new Set(payments.filter((p) => Number(p.amount) < 0).flatMap((p) => {
    const b = parseBankLine(p.description);
    return paymentCodesIn(`${b.about} ${b.kenmerk}`);
  }))];
  for (const code of codes) {
    const rows = await all("Inventory Units", `FIND(${quote(code)},{Payment Note}&'')`, ["Item ID", "Payment Note", "Final Purchase Price"]);
    const exact = rows.filter((r) => new RegExp(`\\(${code}\\)|^${code}$`).test(text(r.fields?.["Payment Note"])));
    paymentCode.set(code, exact.map((r) => ({ unit: text(r.fields["Item ID"]), orderId: "", price: Number(r.fields["Final Purchase Price"] || 0) })));
  }

  return { shopifyOrder, paymentCode };
}

/**
 * Read (API + Airtable), plan, and unless dry, link through the web.
 * deps: rompslomp (createRompslomp: read), web (createRompslompWeb), airtable (select)
 */
// verify: look everything up on the web (login, payment, document) but book nothing.
export async function runLinking({ deps, dry = true, verify = false, limit = Infinity, rules = null, log = () => {} }) {
  const { rompslomp, web, airtable } = deps;
  const started = Date.now();

  const readAll = async (path, key, until = "") => {
    const out = [];
    for (let page = 1; page <= 400; page++) {
      const rows = (await rompslomp.read(`${path}&page=${page}&per_page=100`))?.[key] || [];
      out.push(...rows);
      const last = text(rows.at(-1)?.date || rows.at(-1)?.paid_at).slice(0, 10);
      if (rows.length < 100 || (until && last && last < until)) break;
    }
    return out;
  };
  const back = (day, days) => new Date(Date.parse(day) - days * 86_400_000).toISOString().slice(0, 10);

  const unbooked = await readAll("/payments?selection=unbooked", "payments");
  const ours = unbooked.filter((p) => [KRUISPOSTEN_PATH, ING_PATH].includes(text(p.account_path)));
  const oldest = ours.map((p) => text(p.paid_at).slice(0, 10)).filter((d) => d >= "2025-01-01").sort()[0] || new Date().toISOString().slice(0, 10);
  const since = back(oldest, 120) < "2025-09-01" ? "2025-09-01" : back(oldest, 120);

  // One after the other: Rompslomp answers 429 to a burst.
  const invoices = await readAll("/sales_invoices?selection=all", "sales_invoices", since);
  const expenses = await readAll("/expenses?selection=all", "expenses", since);
  const unpaidExpenses = await readAll("/expenses?selection=unpaid", "expenses");
  const allPayments = await readAll("/payments?selection=all", "payments", back(oldest, 30));
  log(`read ${unbooked.length} unbooked payments, ${invoices.length} invoices and ${expenses.length} expenses since ${since}`);

  const lookups = await loadLookups({ airtable, payments: ours });
  const docs = indexDocuments({ invoices, expenses, unpaidExpenseIds: new Set(unpaidExpenses.map((e) => e.id)) });
  const plan = planLinks({ payments: ours, allPayments, docs, lookups });

  const wanted = plan.link
    .filter((r) => !rules || rules.includes(r.rule))
    .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) || a.paid_at.localeCompare(b.paid_at));

  const linked = [];
  const failed = [];
  if (!dry || verify) {
    if (!web?.configured) throw new RompslompWebError("Linking needs ROMPSLOMP_WEB_EMAIL and ROMPSLOMP_WEB_PASSWORD on this service.");
    let streak = 0;
    for (const row of wanted) {
      if (linked.length >= limit) break;
      if (streak >= 5) { failed.push({ ...row, reason: "not tried: stopped after 5 failures in a row" }); continue; }
      try {
        const found = (await web.payments(WEB_ACCOUNT[row.account], searchFor(row)))
          .filter((r) => r.date === row.paid_at && cents(r.amount) === cents(row.amount) && sameText(r.description, row.description));
        if (found.length !== 1) throw new Mismatch(`${found.length} matching payments on the web`);
        const payment = found[0];
        if (payment.left == null || cents(payment.left) !== cents(row.amount)) throw new Mismatch(`the payment has € ${payment.left} left to book on the web`);

        let result;
        if (verify) {
          if (row.target.kind !== "account") {
            const kind = row.target.kind === "invoice" ? "earning" : "expense";
            const choice = choosePick(await web.pick(kind, payment.id, row.target.number, "all"), row);
            if (!choice.pick) throw new Mismatch(choice.error);
          }
          result = { ok: true };
        } else if (row.target.kind === "account") {
          result = await web.bookToAccount(payment.id, { toLabel: KRUISPOSTEN_LABEL, description: row.reference.replace(/ \(.*$/, "") });
        } else {
          const kind = row.target.kind === "invoice" ? "earning" : "expense";
          const choice = choosePick(await web.pick(kind, payment.id, row.target.number, "all"), row);
          if (!choice.pick) throw new Mismatch(choice.error);
          result = await web.book(payment.id, kind === "expense" ? { expenseId: choice.pick.id } : { earningId: choice.pick.id });
        }
        if (!result.ok) throw new RompslompWebError(`Rompslomp did not confirm: ${strip(result.body).slice(0, 160)}`);
        linked.push({ ...row, web_payment_id: payment.id });
        streak = 0;
      } catch (err) {
        // A document that does not look as planned is that payment's own
        // problem; anything else (login, errors, no confirmation) may be all
        // of them, so five of those in a row stop the run.
        if (!(err instanceof Mismatch)) streak += 1;
        failed.push({ ...row, reason: err.message });
      }
    }
    log(`linked ${linked.length}, failed ${failed.length}`);
  }

  return {
    dry,
    verify,
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    planned: wanted.length,
    by_rule: wanted.reduce((m, r) => ((m[r.rule] = (m[r.rule] || 0) + 1), m), {}),
    linked,
    failed,
    review: plan.review,
    skipped: plan.skipped,
    plan: dry && !verify ? wanted : undefined
  };
}

// Routes and the daily run for linking Rompslomp payments to their documents
// (admin/rompslompLinking.js decides, admin/rompslompWeb.js books).
//
//   POST /api/internal/rompslomp/link        {dry, limit, rules}  x-kc-secret
//   GET  /api/internal/rompslomp/link        the run going on, or the last one
//   GET  /api/admin/rompslomp-linking/last.xlsx  what was linked, what failed,
//                                            and Dario's list, as Excel
//
// One run at a time. The daily run starts from 06:00 Amsterdam time, checked
// hourly so a restart cannot skip a day.

import express from "express";
import { runLinking } from "./rompslompWeb.js";
import { xlsx } from "./xlsxWriter.js";

const text = (v) => (v == null ? "" : String(v)).trim();

const RULE = {
  kruispost_sales: "1. Kruispost → invoice/credit",
  kruispost_purchase: "1. Kruispost → purchase/credit",
  woovin_document: "1. Woovin Kruispost → invoice/credit",
  woovin_fees: "1. Woovin Kruispost → fee expense",
  bank_invoice: "2. ING in → invoice",
  sneakerask: "2. ING in → invoice (SneakerAsk order no.)",
  bank_expense: "2. ING out → Purchase Order",
  bank_payment_note: "2. ING out → Payment Note",
  woovin_bank: "3. Woovin payout → Kruisposten"
};

export function linkingWorkbook(result) {
  const done = (result.dry && !result.verify ? result.plan : result.linked) || [];
  const row = (r) => [RULE[r.rule] || r.rule, r.paid_at, r.account, r.amount, r.description, r.target?.number || "", r.target?.kind || "", r.target?.contact || "", r.reference || ""];
  const cols = [
    { label: "Rule", width: 36 }, { label: "Paid at", width: 11 }, { label: "Account", width: 12 }, { label: "Amount", type: "money" },
    { label: "Payment description", width: 70 }, { label: "Document", width: 30 }, { label: "Type", width: 10 }, { label: "Contact", width: 28 }, { label: "Reference used", width: 26 }
  ];
  return xlsx([
    { name: result.verify ? "Verified" : result.dry ? "Would link" : "Linked", columns: cols, rows: done.map(row) },
    { name: "Failed", columns: [...cols, { label: "Why", width: 60 }], rows: (result.failed || []).map((r) => [...row(r), r.reason]) },
    {
      name: "For Dario",
      columns: [{ label: "Paid at", width: 11 }, { label: "Account", width: 12 }, { label: "Amount", type: "money" }, { label: "Why not linked", width: 60 },
        { label: "Payment description", width: 70 }, { label: "Candidate document", width: 28 }, { label: "Candidate contact", width: 26 }],
      rows: [...(result.review || [])].sort((a, b) => b.paid_at.localeCompare(a.paid_at))
        .map((r) => [r.paid_at, r.account, r.amount, r.reason, r.description, r.target?.number || "", r.target?.contact || ""])
    }
  ]);
}

export function mountRompslompLinking(router, { deps, internalSecret = "", daily = false, audit = null }) {
  let running = null;
  let last = null;

  function start({ dry = true, verify = false, limit = Infinity, rules = null, by = "" } = {}) {
    if (running) return running;
    running = { started: new Date().toISOString(), dry, by, done: false };
    running.promise = runLinking({ deps, dry, verify, limit, rules, log: (m) => console.log("[rompslomp linking]", m) })
      .then((result) => {
        last = result;
        console.log("[rompslomp linking]", JSON.stringify({ dry, planned: result.planned, linked: result.linked.length, failed: result.failed.length, review: result.review.length, seconds: result.seconds }));
        for (const f of result.failed.slice(0, 20)) console.log("[rompslomp linking] failed:", f.payment_id, f.target?.number, f.reason);
        if (!dry && result.linked.length) audit?.record?.({ actor: { name: by || "Rompslomp linking", email: "" }, action: "Rompslomp payments linked", source: "rompslomp", recordId: "", label: `${result.linked.length} payments`, details: { by_rule: result.by_rule, failed: result.failed.length } });
        return result;
      })
      .catch((err) => {
        last = { error: err.message, at: new Date().toISOString(), dry };
        console.error("[rompslomp linking]", err.message);
      })
      .finally(() => { running = null; });
    return running;
  }

  const guard = (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

  const summary = (r) => r && (r.error ? r : {
    dry: r.dry, verify: r.verify, at: r.at, seconds: r.seconds, planned: r.planned, by_rule: r.by_rule,
    linked: r.linked.length, failed: r.failed.map((f) => ({ payment_id: f.payment_id, paid_at: f.paid_at, amount: f.amount, document: f.target?.number, reason: f.reason })),
    review: r.review.length, skipped: r.skipped
  });

  router.post("/api/internal/rompslomp/link", express.json({ limit: "4kb" }), (req, res) => {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const limit = Number(body.limit) > 0 ? Number(body.limit) : Infinity;
    const rules = Array.isArray(body.rules) && body.rules.length ? body.rules.map(text) : null;
    const job = start({ dry: body.dry !== false, verify: body.verify === true, limit, rules, by: text(body.by) || "Script" });
    res.json({ ok: true, started: job.started, dry: job.dry });
  });

  router.get("/api/internal/rompslomp/link", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ running: running ? { started: running.started, dry: running.dry } : null, last: summary(last) });
  });

  const sendXlsx = (req, res) => {
    if (!last || last.error) return res.status(404).json({ error: last?.error || "No linking run since the last restart." });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="rompslomp-linking-${last.at.slice(0, 10)}.xlsx"`);
    res.send(linkingWorkbook(last));
  };
  router.get("/api/admin/rompslomp-linking/last.xlsx", sendXlsx);
  router.get("/api/internal/rompslomp/link.xlsx", (req, res) => { if (guard(req, res)) sendXlsx(req, res); });

  if (daily) {
    let lastDay = "";
    const tick = () => {
      const [day, hour] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam", dateStyle: "short", timeStyle: "short" }).format(new Date()).split(" ");
      if (day === lastDay || Number(hour.slice(0, 2)) < 6) return;
      lastDay = day;
      start({ dry: false, by: "Daily linking" });
    };
    setTimeout(tick, 5 * 60_000).unref?.();
    setInterval(tick, 60 * 60_000).unref?.();
  }

  return { start, last: () => last };
}

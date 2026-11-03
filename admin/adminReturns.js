// admin/adminReturns.js
//
// Warehouse > Returns and Troubled Stock (private/admin-returns.html), and the
// internal routes the WMS scan and the marketplace services call. The work is
// in admin/returns.js; this only checks who is asking and logs what happened.
//
//   /api/admin/returns ...            signed-in admin
//   /api/internal/returns/announce    a marketplace saw a return or a cancel
//   /api/internal/returns/match       the WMS scanned a box
//   /api/internal/returns/receive     the WMS says OK or flaw
//   /api/internal/returns/:id/:step   decide, not-coming, tick from a script
//   The internal ones behind x-kc-secret (COUNTER_OFFERS_SECRET).

import express from "express";
import fs from "fs";
import { ReturnsError } from "./returns.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export function mountReturns(router, { returns, audit, internalSecret = "", pageFile = "" }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[returns]", err.message);
    res.status(status).json({ error: err instanceof ReturnsError || status < 500 ? err.message : `Returns failed: ${err.message}` });
  };

  const guard = (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

  const record = (req, action, row, details = {}) =>
    audit?.record({
      actor: req.admin || { email: "", name: text(req.body?.by) || "WMS" },
      action,
      source: "returns",
      recordId: row?.id || "",
      label: row?.return_number ? `RET-${row.return_number} ${row.order_id || ""}`.trim() : "",
      details
    }).catch(() => {});

  const who = (req) => text(req.admin?.name) || text(req.admin?.email);

  router.get(["/admin/returns", "/admin/returns/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  /* ----- admin ----- */

  router.get("/api/admin/returns", async (req, res) => {
    try {
      res.json({ returns: await returns.list({ view: text(req.query.view) || "open", q: text(req.query.q) }) });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/returns/troubled", async (req, res) => {
    try {
      res.json({ units: await returns.troubled() });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/returns/troubled/:unit", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const out = await returns.resolveTroubled(text(req.params.unit), { action: text(req.body?.action), note: text(req.body?.note), by: who(req) });
      await audit?.record({ actor: req.admin, action: "troubled_resolved", source: "returns", recordId: req.params.unit, label: out.item_id, details: out }).catch(() => {});
      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/returns/:id", async (req, res) => {
    try {
      res.json({ return: await returns.get(text(req.params.id)) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/returns/:id/:step", express.json({ limit: "20kb" }), async (req, res) => {
    const id = text(req.params.id);
    const body = req.body || {};

    try {
      let row;

      switch (req.params.step) {
        case "receive":
          row = await returns.receive(id, { verdict: text(body.verdict), then: text(body.then), note: text(body.note), by: who(req) });
          break;
        case "decide": {
          const out = await returns.decide(id, { held: text(body.held), then: text(body.then), orderAction: text(body.order_action), note: text(body.note), by: who(req) });
          row = out.return_id ? await returns.get(out.return_id) : null;
          break;
        }
        case "not-coming":
          row = await returns.notComing(id, { note: text(body.note), by: who(req) });
          break;
        case "credit-invoice":
          row = await returns.creditInvoice(id, { by: who(req) });
          break;
        case "seller-return":
          row = await returns.sellerReturnStep(id, { step: text(body.step), tracking: text(body.tracking), by: who(req) });
          break;
        case "tick":
          row = await returns.tick(id, text(body.todo), body.done !== false, who(req));
          break;
        default:
          return res.status(404).json({ error: "Unknown step." });
      }

      if (req.params.step !== "tick") record(req, `return_${req.params.step.replace(/-/g, "_")}`, row, body);
      res.json({ return: row });
    } catch (err) {
      send(res, err);
    }
  });

  /* ----- internal: marketplaces and the WMS ----- */

  router.post("/api/internal/returns/announce", express.json({ limit: "20kb" }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const out = await returns.announce(req.body || {});
      if (out.created) record(req, "return_announced", out.return, { source: req.body?.source, marketplace_order_id: req.body?.marketplace_order_id });
      res.json({ ok: true, created: out.created, skipped: out.skipped || "", return_id: out.return?.id || null, return_number: out.return?.return_number || null });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/returns/match", express.json({ limit: "10kb" }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      res.json({ ok: true, ...(await returns.match({ sku: text(req.body?.sku), size: text(req.body?.size) })) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/returns/open", express.json({ limit: "10kb" }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      res.json({ ok: true, returns: await returns.list({ view: "open", q: text(req.body?.q) }) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/returns/receive", express.json({ limit: "10kb" }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const row = await returns.receive(text(req.body?.id), {
        verdict: text(req.body?.verdict),
        then: text(req.body?.then),
        note: text(req.body?.note),
        by: text(req.body?.by) || "WMS",
        barcode: text(req.body?.barcode)
      });
      record(req, "return_receive", row, { verdict: req.body?.verdict, note: req.body?.note });
      res.json({ ok: true, return: row });
    } catch (err) {
      send(res, err);
    }
  });

  // The admin's own steps, for work done from a script with the secret.
  router.post("/api/internal/returns/:id/:step", express.json({ limit: "10kb" }), async (req, res) => {
    if (!guard(req, res)) return;
    const id = text(req.params.id);
    const body = req.body || {};
    const by = text(body.by) || "Script";
    try {
      let row;
      if (req.params.step === "decide") {
        const out = await returns.decide(id, { held: text(body.held), then: text(body.then), orderAction: text(body.order_action), note: text(body.note), by });
        row = out.return_id ? await returns.get(out.return_id) : null;
      } else if (req.params.step === "not-coming") {
        row = await returns.notComing(id, { note: text(body.note), by });
      } else if (req.params.step === "tick") {
        row = await returns.tick(id, text(body.todo), body.done !== false, by);
      } else if (req.params.step === "seller-return") {
        row = await returns.sellerReturnStep(id, { step: text(body.step), tracking: text(body.tracking), by });
      } else {
        return res.status(404).json({ ok: false, error: "Unknown step." });
      }
      record(req, `return_${req.params.step}`, row, body);
      res.json({ ok: true, return: row });
    } catch (err) {
      send(res, err);
    }
  });
}

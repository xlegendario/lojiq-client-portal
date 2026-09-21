// admin/adminBolPages.js
//
// bol pages: the bol product pages our offer sync refused to sell on.
//
// bol decides which page a barcode lands on, and its catalogue is sometimes
// wrong - a Yeezy Foam Runner barcode on a Jordan 4 page (ORD-025234). The
// offer sync (sneakerask-consignment, bolPageCheck.js) holds every page
// against our pair and writes the ones that fail to Supabase
// bol_page_checks. Here they are listed, and a refusal the check got wrong
// can be approved: the next sync, within two hours, offers the pair again.
//
// An approval covers the page title it was given for. If bol changes the page
// afterwards, the sync checks it again and blocks it if it fails.

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const PAGE_STATUSES = ["blocked", "approved"];

export class BolPagesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createBolPagesStore({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  async function request(pathAndQuery, options = {}) {
    if (!configured) throw new BolPagesError("bol pages needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this service.", 503);

    const response = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: AbortSignal.timeout(20_000)
    });

    const body = await response.text();
    const data = body ? JSON.parse(body) : null;

    if (!response.ok) {
      throw new BolPagesError(text(data?.message) || `Supabase answered ${response.status}.`, 502);
    }

    return data;
  }

  async function list({ status = "all" } = {}) {
    const params = new URLSearchParams({ select: "*", order: "last_seen.desc", limit: "2000" });
    if (PAGE_STATUSES.includes(status)) params.set("status", `eq.${status}`);
    return request(`bol_page_checks?${params}`);
  }

  async function get(ean) {
    const clean = text(ean);
    if (!/^\d{8,14}$/.test(clean)) throw new BolPagesError("That is not a barcode.");

    const rows = await request(`bol_page_checks?select=*&ean=eq.${clean}`);
    if (!rows?.length) throw new BolPagesError("That page is not in the list.", 404);
    return rows[0];
  }

  async function setStatus(ean, status) {
    if (!PAGE_STATUSES.includes(status)) throw new BolPagesError("Unknown status.");

    const rows = await request(`bol_page_checks?ean=eq.${text(ean)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status })
    });

    return rows?.[0];
  }

  // Only the blocked ones, for the sidebar.
  async function counts() {
    const rows = await request("bol_page_checks?select=status&limit=5000");
    return { blocked: (rows || []).filter((row) => row.status === "blocked").length };
  }

  return { configured, list, get, setStatus, counts };
}

export function mountBolPages(router, { store, audit, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof BolPagesError ? err.status : 500;
    if (status >= 500) console.error("[admin bol pages]", err.message);
    res.status(status).json({ error: err instanceof BolPagesError ? err.message : "bol pages failed." });
  };

  router.get(["/admin/bol-pages", "/admin/bol-pages/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/bol-pages", async (req, res) => {
    try {
      res.json({ pages: await store.list({ status: text(req.query.status) || "all" }) });
    } catch (err) {
      send(res, err);
    }
  });

  // Approve a refusal the check got wrong, or block a page again.
  router.post("/api/admin/bol-pages/status", express.json({ limit: "10kb" }), async (req, res) => {
    try {
      const before = await store.get(req.body?.ean);
      const status = text(req.body?.status);

      if (!PAGE_STATUSES.includes(status)) throw new BolPagesError("Unknown status.");
      if (before.status === status) return res.json({ page: before });

      const page = await store.setStatus(before.ean, status);

      await audit.record({
        actor: req.admin,
        action: status === "approved" ? "Approve bol page" : "Block bol page",
        source: "bol_pages",
        recordId: before.ean,
        label: `${before.sku} ${before.size}`,
        details: { changed: { status: { from: before.status, to: status } }, page_title: before.page_title }
      });

      res.json({ page });
    } catch (err) {
      send(res, err);
    }
  });
}

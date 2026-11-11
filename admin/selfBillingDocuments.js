// admin/selfBillingDocuments.js
//
// Every purchase's self-billing document, made once and kept.
//
// Until now Eledo made them inside the Make scenarios and they went to
// OneDrive, apart from External Sales, which made them here on demand and
// kept nothing. From 05-11-2026 every Inventory Unit we bought gets its
// document from here, whichever flow made the unit: a sweep looks for units
// without one and makes it. The PDF goes into a private Supabase bucket and
// a row in self_billing_documents says what it is, so the same document is
// handed out every time after - to us, and to the seller from his dashboard -
// even when the unit changes later.
//
// Three kinds:
//   issued      made by this flow, for a unit created on or after LIVE_FROM
//   imported    an older document as it was issued (an Eledo PDF from OneDrive)
//   reproduced  an older unit whose original we do not hold: a copy from our
//               records, marked as such, in the wording of then
//
// Nothing here books or mails anything.

import crypto from "crypto";
import express from "express";
import fs from "fs";

import { SelfBillingError } from "./adminSelfBilling.js";

export const BUCKET = "self-billing";
export const LIVE_FROM = "2026-11-05";

const SWEEP_DAYS = 3;
const SWEEP_MAX = 200;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const amsterdamDay = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

// A unit made before the flow went live gets a copy, never a new original.
export const kindFor = (createdTime) => (text(createdTime) && amsterdamDay(new Date(createdTime)) < LIVE_FROM ? "reproduced" : "issued");

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/*
 * Why a new document cannot be made yet, or "" when it can.
 *
 * VAT0 and VAT21 are a business's invoice and wait for its VAT number.
 * Margin never waits: a company without a number gets the neutral wording.
 * Copies of older documents keep the wording of then and never wait.
 */
export function missingVatId(document = {}) {
  const seller = document.seller || {};
  if (text(seller.vat_id)) return "";
  if (["VAT0", "VAT21"].includes(text(document.vat_type))) return "missing_vat_id";
  // A Margin purchase from a company without a number is made with the
  // neutral wording (marginWording in selfBillingPdf.js); it no longer waits.
  return "";
}

/*
 * Supabase Storage, private: files go in and come out with the service key
 * only. The seller never gets an address of his own; his dashboard asks the
 * Kickz Caviar portal, which asks here.
 */
export function createPrivateStorage({ supabaseUrl, serviceKey, bucket = BUCKET, fetchImpl = fetch }) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  async function upload(name, buffer) {
    const response = await fetchImpl(`${base}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/pdf", "x-upsert": "true" },
      body: buffer,
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Storage answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    return `${bucket}/${name}`;
  }

  async function download(name) {
    const response = await fetchImpl(`${base}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Storage answered ${response.status} for ${name}`);
    return Buffer.from(await response.arrayBuffer());
  }

  return { configured, upload, download };
}

/*
 * deps:
 *   db           createSupabaseRest (self_billing_documents)
 *   storage      createPrivateStorage
 *   selfBilling  createSelfBilling: forUnit(unitId, overrides) -> { pdf, document, unit }
 *   airtable     the admin's reader (select), for the sweep
 */
export function createSelfBillingDocuments({ db, storage, selfBilling, airtable, now = () => new Date() }) {
  const configured = Boolean(db?.configured && storage?.configured);
  const failed = new Map();

  const fileName = (unitId) => `${unitId}.pdf`;

  async function get(unitId) {
    const id = text(unitId);
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new SelfBillingError("That is not an Inventory Unit id.");
    const [row] = await db.get(`self_billing_documents?select=*&unit_record_id=eq.${id}`);
    return row || null;
  }

  async function save({ unitId, document, unit, pdf, kind, source = "" }) {
    const path = await storage.upload(fileName(unitId), pdf);
    const row = {
      unit_record_id: unitId,
      item_id: text(document?.document_number || unit?.["Item ID"]),
      seller_record_id: text(first(unit?.["Seller ID"])),
      seller_id: text(document?.seller?.seller_id),
      seller_name: text(document?.seller?.name),
      vat_type: text(document?.vat_type || unit?.["VAT Type"]),
      amount: Number(document?.product?.price ?? unit?.["Final Purchase Price"] ?? 0) || 0,
      product: text(document?.product?.name || unit?.["Product Name"]),
      size: text(document?.product?.size || unit?.Size),
      purchase_date: text(unit?.["Purchase Date"]) || null,
      kind,
      source: text(source).slice(0, 300) || null,
      storage_path: path,
      pdf_hash: sha256(pdf),
      pdf_size: pdf.length,
      issued_at: now().toISOString()
    };
    const [saved] = await db.insert("self_billing_documents", [row]);
    return saved;
  }

  /*
   * The document of a unit: the one we keep, or made now. A unit created
   * before the flow went live gets a reproduction, dated as the purchase was.
   */
  async function ensure(unitId) {
    const existing = await get(unitId);
    if (existing) return existing;

    const probe = await selfBilling.forUnit(unitId, {});
    const kind = kindFor(probe.unit?.["Created Time"]);
    const today = amsterdamDay(now());

    const waiting = kind === "issued" ? missingVatId(probe.document) : "";
    if (waiting) {
      await hold(unitId, probe, waiting);
      throw new SelfBillingError("The seller has no VAT number on file yet.", 409);
    }
    const made = kind === "reproduced"
      ? await selfBilling.forUnit(unitId, { date: text(probe.unit?.["Purchase Date"]) || today, copy: { reproduced_at: today } })
      : await selfBilling.forUnit(unitId, { date: today });

    const saved = await save({ unitId, document: made.document, unit: made.unit, pdf: made.pdf, kind });
    await db.remove(`self_billing_holds?unit_record_id=eq.${unitId}`).catch(() => {});
    return saved;
  }

  async function hold(unitId, probe, reason) {
    const row = {
      unit_record_id: unitId,
      item_id: text(probe.document?.document_number),
      seller_record_id: text(first(probe.unit?.["Seller ID"])),
      seller_id: text(probe.document?.seller?.seller_id),
      seller_name: text(probe.document?.seller?.name),
      vat_type: text(probe.document?.vat_type),
      reason,
      checked_at: now().toISOString()
    };
    const [existing] = await db.get(`self_billing_holds?select=unit_record_id&unit_record_id=eq.${unitId}`);
    if (existing) await db.patch(`self_billing_holds?unit_record_id=eq.${unitId}`, { checked_at: row.checked_at, seller_name: row.seller_name });
    else await db.insert("self_billing_holds", [row]);
  }

  async function holds() {
    return (await db.get("self_billing_holds?select=*&order=created_at.desc&limit=500")) || [];
  }

  // An older document as it was issued, from a file we hold.
  async function importOriginal(unitId, pdf, source) {
    const existing = await get(unitId);
    if (existing) return { row: existing, skipped: true };
    const probe = await selfBilling.forUnit(unitId, {}).catch(() => null);
    if (!probe) throw new SelfBillingError("The unit could not be read.");
    return { row: await save({ unitId, document: probe.document, unit: probe.unit, pdf, kind: "imported", source }), skipped: false };
  }

  async function pdf(unitId) {
    const row = await ensure(unitId);
    const bytes = await storage.download(fileName(row.unit_record_id));
    return { row, filename: `${row.item_id || row.unit_record_id}.pdf`, pdf: bytes };
  }

  async function list({ search = "", kind = "", limit = 100, offset = 0 } = {}) {
    const filters = [];
    if (["issued", "imported", "reproduced"].includes(kind)) filters.push(`kind=eq.${kind}`);
    const q = text(search).replace(/[^A-Za-z0-9 -]/g, "").slice(0, 40);
    if (q) filters.push(`or=(item_id.ilike.*${q}*,seller_id.ilike.*${q}*,seller_name.ilike.*${q}*,product.ilike.*${q}*)`);
    const rows = await db.get(
      `self_billing_documents?select=unit_record_id,item_id,seller_id,seller_name,vat_type,amount,product,size,purchase_date,kind,issued_at&order=issued_at.desc&limit=${Math.min(500, Number(limit) || 100)}&offset=${Math.max(0, Number(offset) || 0)}${filters.length ? `&${filters.join("&")}` : ""}`
    );
    return rows || [];
  }

  /*
   * Units bought in the last few days that have no document yet. Asked of
   * Airtable by creation time, so it costs one call however big the table
   * gets; the documents table answers which of them are done.
   */
  async function sweep() {
    const formula = `AND({Purchase Price} > 0, {Seller ID} != '', IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -${SWEEP_DAYS}, 'days')))`;
    const ids = [];
    let offset = "";
    for (let page = 0; page < 10; page += 1) {
      const result = await airtable.select("Inventory Units", { formula, fields: ["Item ID"], pageSize: 100, offset });
      ids.push(...(result.records || []).map((r) => r.id));
      offset = result.offset || "";
      if (!offset) break;
    }

    // Every waiting unit is tried again, however old: the number may be in now.
    const waiting = await holds().catch(() => []);
    for (const row of waiting) if (!ids.includes(row.unit_record_id)) ids.push(row.unit_record_id);

    if (!ids.length) return { checked: 0, made: 0, failed: 0 };

    const have = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = await db.get(`self_billing_documents?select=unit_record_id&unit_record_id=in.(${chunk.join(",")})`);
      for (const row of rows || []) have.add(row.unit_record_id);
    }

    let made = 0;
    let bad = 0;
    for (const id of ids.filter((id) => !have.has(id)).slice(0, SWEEP_MAX)) {
      // A unit that cannot have a document (no seller yet, an unknown VAT
      // type) is tried again an hour later, not every five minutes.
      const last = failed.get(id);
      if (last && now() - last < 60 * 60_000 && !waiting.some((row) => row.unit_record_id === id)) continue;
      try {
        await ensure(id);
        made += 1;
      } catch (err) {
        failed.set(id, now());
        bad += 1;
        if (err.status !== 409) console.warn(`[self-billing] no document for ${id}: ${err.message}`);
      }
    }
    return { checked: ids.length, made, failed: bad };
  }

  return { configured, get, ensure, importOriginal, pdf, list, holds, sweep };
}

/*
 *   GET  /admin/self-billing                               the list (private/admin-self-billing.html)
 *   GET  /api/admin/self-billing/documents                 search, kind, limit, offset
 *   GET  /api/admin/self-billing/documents/:unit/pdf       the kept PDF (made now when missing)
 *   POST /api/admin/self-billing/sweep                     look for new units now
 *   POST /api/internal/self-billing/document               the Kickz Caviar portal, for a seller's own
 *                                                          unit: { inventory_unit_record_id, seller_record_id }
 */
export function mountSelfBillingDocuments(router, { store, pageFile = "", internalSecret = "" }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof SelfBillingError ? err.status : 500;
    if (status >= 500) console.error("[self-billing documents]", err.message);
    res.status(status).json({ error: err instanceof SelfBillingError ? err.message : `Self-billing failed: ${err.message}` });
  };

  const sendPdf = (res, { filename, pdf }) => {
    res.type("application/pdf").set("Content-Disposition", `inline; filename="${filename}"`).set("Cache-Control", "no-store").send(pdf);
  };

  router.get(["/admin/self-billing", "/admin/self-billing/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/self-billing/documents", async (req, res) => {
    try {
      res.json({ documents: await store.list({ search: req.query.search, kind: text(req.query.kind), limit: req.query.limit, offset: req.query.offset }) });
    } catch (err) {
      send(res, err);
    }
  });

  // Units waiting for something, such as the seller's VAT number.
  router.get("/api/admin/self-billing/holds", async (req, res) => {
    try {
      res.json({ holds: await store.holds() });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/self-billing/documents/:unit/pdf", async (req, res) => {
    try {
      sendPdf(res, await store.pdf(req.params.unit));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/self-billing/sweep", async (req, res) => {
    try {
      res.json(await store.sweep());
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/internal/self-billing/document", express.json({ limit: "5kb" }), async (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) return res.status(401).json({ error: "Unauthorized" });

    try {
      const doc = await store.pdf(req.body?.inventory_unit_record_id);
      // The portal checked the unit is his; this checks it again on our side.
      if (text(req.body?.seller_record_id) && doc.row.seller_record_id !== text(req.body.seller_record_id)) {
        return res.status(404).json({ error: "Not found" });
      }
      sendPdf(res, doc);
    } catch (err) {
      send(res, err);
    }
  });
}

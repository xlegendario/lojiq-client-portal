// admin/externalSalesTracking.js
//
// Where the parcels are (block 6 of the plan, 22-09-2026).
//
// Aftership already watches store orders and Member WTBs from the Lojiq
// Automation Engine. External Sales ship in parcels of their own, in
// Supabase, so the engine gets a third pass: it asks this service which
// parcels still need watching, asks Aftership about each tracking number and
// posts back what it found. Everything that follows from that - the parcel's
// status, the deal that is delivered once its last parcel is, and the check
// that says delivered but not paid - is decided here, where the rest of the
// External Sales rules live.
//
// Aftership's own words, kept as they are so a status here means what it
// means there:
//
//   Pending, InfoReceived  label made, nothing moving yet
//   InTransit, OutForDelivery, AvailableForPickup  on its way
//   Delivered              handed over
//   Exception, AttemptFail, Expired  something is wrong; someone has to look

import { ExternalSalesError, dealId } from "./externalSalesSync.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const UUID = /^[0-9a-f-]{36}$/i;

// Aftership's tag to what a parcel is doing here.
export const PARCEL_STATUS_BY_TAG = {
  Pending: "pending",
  InfoReceived: "pending",
  InTransit: "in_transit",
  OutForDelivery: "in_transit",
  AvailableForPickup: "in_transit",
  Delivered: "delivered",
  AttemptFail: "exception",
  Exception: "exception",
  Expired: "exception"
};

export const PARCEL_STATUSES = ["pending", "in_transit", "delivered", "exception"];

// A number a carrier could actually have given out. Parcels from before this
// (22-09-2026) sometimes carry a dash or a note where the tracking number
// should be; asking AfterShip about those only earns a 400 every hour.
export function plausibleTracking(value) {
  return /^[A-Za-z0-9]{8,35}$/.test(String(value || "").replace(/\s/g, ""));
}

// Stop watching a parcel that never moved and is older than this: a label
// made months ago is history, and carriers drop those from their systems.
const GIVE_UP_DAYS = 60;

/*
 * What to write on a parcel for what Aftership says.
 *
 * Only forward: a parcel that was delivered stays delivered, whatever a
 * later read says - carriers do rewrite history and a deal that went back to
 * "on its way" would send Dario looking for a parcel that is long gone.
 * The moment of shipping and of delivery are kept the first time they are
 * seen, so they stay true even when this is read again days later.
 */
export function parcelUpdate(parcel, update = {}, now = new Date()) {
  const status = PARCEL_STATUSES.includes(text(update.status)) ? text(update.status) : "";
  if (!status) return null;
  if (parcel.status === "delivered" && status !== "delivered") return { tracking_checked_at: now.toISOString() };

  const fields = { tracking_checked_at: now.toISOString() };
  if (text(update.carrier) && text(update.carrier) !== text(parcel.carrier)) fields.carrier = text(update.carrier);
  if (text(update.detail) !== text(parcel.tracking_detail)) fields.tracking_detail = text(update.detail) || null;
  if (text(update.aftership_id) && !text(parcel.aftership_id)) fields.aftership_id = text(update.aftership_id);

  if (status !== parcel.status) fields.status = status;

  if (["in_transit", "delivered"].includes(status) && !parcel.shipped_at) {
    fields.shipped_at = update.shipped_at || now.toISOString();
  }

  if (status === "delivered" && !parcel.delivered_at) {
    fields.delivered_at = update.delivered_at || now.toISOString();
  }

  return fields;
}

/*
 * A deal is delivered when every parcel is, and not before: a buyer who got
 * one of three boxes has not had his order. The date is the last parcel's.
 */
export function dealDelivery(sale, parcels) {
  const withTracking = parcels.filter((p) => text(p.tracking_number));
  if (!withTracking.length || !withTracking.every((p) => p.status === "delivered")) return null;
  if (sale.shipping_status === "delivered") return null;
  if (["cancelled", "pending", "ready_to_ship"].includes(text(sale.shipping_status))) return null;

  const dates = withTracking.map((p) => new Date(p.delivered_at || Date.now()).getTime());
  return { shipping_status: "delivered", delivered_at: new Date(Math.max(...dates)).toISOString() };
}

/*
 * deps:
 *   db  createSupabaseRest
 */
export function createExternalSalesTracking({ db }) {
  /*
   * The parcels the engine has to look at: a tracking number, not delivered,
   * on a deal that is still live. Longest unchecked first, so one run that
   * cannot do everything still gets round to all of them.
   */
  async function openParcels({ limit = 100 } = {}) {
    const rows = await db.get(
      "shipments?select=id,tracking_number,status,carrier,tracking_checked_at,created_at,external_sale_id," +
      "external_sales!inner(deal_number,shipping_status,payment_status,shipped_at)" +
      "&tracking_number=not.is.null&status=neq.delivered" +
      "&external_sales.shipping_status=in.(shipped,delivered)" +
      `&order=tracking_checked_at.asc.nullsfirst&limit=${Math.min(Number(limit) || 100, 500)}`
    );

    const tooOld = Date.now() - GIVE_UP_DAYS * 86_400_000;

    return rows.filter((row) => {
      if (!plausibleTracking(row.tracking_number)) return false;
      // Never moved and long past: leave it alone.
      const since = new Date(row.external_sales?.shipped_at || row.created_at || Date.now()).getTime();
      return !(row.status === "pending" && since < tooOld);
    }).map((row) => ({
      id: row.id,
      deal: dealId({ deal_number: row.external_sales?.deal_number }),
      tracking_number: text(row.tracking_number),
      carrier: text(row.carrier),
      status: text(row.status) || "pending",
      checked_at: row.tracking_checked_at
    }));
  }

  /*
   * What the engine found, written back: every parcel it could place, then
   * the deals whose last parcel arrived.
   */
  async function applyUpdates(updates = [], { now = new Date() } = {}) {
    const list = (Array.isArray(updates) ? updates : []).filter((u) => UUID.test(text(u?.id)));
    if (!list.length) return { updated: 0, delivered: [], unknown: [] };

    const parcels = await db.get(`shipments?select=*&id=in.(${list.map((u) => `"${text(u.id)}"`).join(",")})`);
    const byId = new Map(parcels.map((parcel) => [parcel.id, parcel]));

    const unknown = [];
    const touchedSales = new Set();
    let updated = 0;

    for (const update of list) {
      const parcel = byId.get(text(update.id));
      if (!parcel) {
        unknown.push(text(update.id));
        continue;
      }

      const fields = parcelUpdate(parcel, update, now);
      if (!fields) continue;

      await db.patch(`shipments?id=eq.${parcel.id}`, fields);
      if (fields.status) updated += 1;
      if (parcel.external_sale_id) touchedSales.add(parcel.external_sale_id);
    }

    const delivered = [];

    for (const saleId of touchedSales) {
      const [sale] = await db.get(`external_sales?select=*&id=eq.${saleId}`);
      if (!sale) continue;

      const after = await db.get(`shipments?select=*&external_sale_id=eq.${saleId}`);
      const change = dealDelivery(sale, after);
      if (!change) continue;

      await db.patch(`external_sales?id=eq.${sale.id}`, change);
      delivered.push(dealId(sale));
    }

    return { updated, delivered, unknown };
  }

  /*
   * A parcel whose tracking number Aftership does not know yet. The engine
   * registers it there and says so, so the next run reads a real status
   * instead of asking for a number that is not being watched.
   */
  async function markRegistered(id, aftershipId = "", note = "") {
    if (!UUID.test(text(id))) throw new ExternalSalesError("Unknown parcel.");

    const [saved] = await db.patch(`shipments?id=eq.${text(id)}`, {
      tracking_checked_at: new Date().toISOString(),
      ...(text(aftershipId) ? { aftership_id: text(aftershipId) } : {}),
      ...(text(note) ? { tracking_detail: text(note).slice(0, 300) } : {})
    });

    return saved || null;
  }

  return { openParcels, applyUpdates, markRegistered };
}

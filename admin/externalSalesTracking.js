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
 * A deal is on its way as soon as one of its parcels is.
 *
 * NEW - the Unfulfilled Orders Log has done this all along: AfterShip sees
 * InTransit and the order goes to Shipped. External Sales never had it,
 * because our own parcels are set to shipped by the WMS when we pack them.
 * A consignor posts his own box, so nobody here packs it and nothing ever
 * moved the deal off Ready to Ship - which also kept its parcel out of the
 * tracking run, since that only looked at deals already shipped. Seven deals
 * sat that way on 09-10-2026, none of them followed.
 *
 * One moving parcel is enough: the buyer's order is out of the door even if
 * a second box follows tomorrow. Delivered is the other way round - every
 * box has to arrive - and that is dealDelivery below.
 */
export function dealShipped(sale, parcels, now = new Date()) {
  const moving = parcels.filter(
    (p) => text(p.tracking_number) && ["in_transit", "delivered"].includes(text(p.status))
  );

  if (!moving.length) return null;
  if (["shipped", "delivered", "cancelled"].includes(text(sale.shipping_status))) return null;

  const dates = moving
    .map((p) => new Date(p.shipped_at || now).getTime())
    .filter((time) => Number.isFinite(time));

  return {
    shipping_status: "shipped",
    shipped_at: new Date(dates.length ? Math.min(...dates) : now.getTime()).toISOString()
  };
}

/*
 * A deal is delivered when every parcel is, and not before: a buyer who got
 * one of three boxes has not had his order. The date is the last parcel's.
 */
export function dealDelivery(sale, parcels) {
  const withTracking = parcels.filter((p) => text(p.tracking_number));
  if (!withTracking.length || !withTracking.every((p) => p.status === "delivered")) return null;
  if (sale.shipping_status === "delivered") return null;
  // "ready_to_ship" is no longer refused here: dealShipped moves the deal on
  // first, and a parcel that reports Delivered without ever reporting
  // InTransit must not strand the deal one step short.
  if (["cancelled", "pending"].includes(text(sale.shipping_status))) return null;

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
      /*
        ready_to_ship belongs here too. A consignor posts his own box, so the
        deal is never packed by us and never reaches "shipped" on its own -
        and leaving it out meant the one parcel that could have said so was
        never looked at. Now the parcel is followed from the moment it has a
        number, and dealShipped moves the deal when it starts moving.
      */
      "&external_sales.shipping_status=in.(ready_to_ship,shipped,delivered)" +
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
    const shipped = [];

    for (const saleId of touchedSales) {
      const [sale] = await db.get(`external_sales?select=*&id=eq.${saleId}`);
      if (!sale) continue;

      const after = await db.get(`shipments?select=*&external_sale_id=eq.${saleId}`);

      /*
        On its way first, then arrived. Both in one pass, because a parcel
        that is already Delivered when we first see it has to carry the deal
        the whole way rather than stop halfway.
      */
      let current = sale;
      const onItsWay = dealShipped(current, after, now);

      if (onItsWay) {
        await db.patch(`external_sales?id=eq.${current.id}`, onItsWay);
        current = { ...current, ...onItsWay };
        shipped.push(dealId(current));
      }

      /*
        Delivered only once everything is actually out.

        A deal can be half ours and half a consignor's. His box is a parcel
        from the moment he hands over the number, ours only exists once the
        WMS packs it - so "every parcel delivered" can be true while our half
        is still on the shelf. A pair that is in no box and is not his says
        the deal is not finished, whatever the parcels say.
      */
      const pairs = await db.get(
        `external_sale_pairs?select=shipment_id,consignor_fulfillment_status&sale_id=eq.${saleId}&cancelled_at=is.null`
      );

      const stillHere = pairs.some(
        (pair) => !text(pair.shipment_id) && !text(pair.consignor_fulfillment_status)
      );

      if (stillHere) continue;

      const change = dealDelivery(current, after);
      if (!change) continue;

      await db.patch(`external_sales?id=eq.${current.id}`, change);
      delivered.push(dealId(current));
    }

    return { updated, shipped, delivered, unknown };
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

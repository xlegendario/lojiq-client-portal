import test from "node:test";
import assert from "node:assert/strict";

import { createExternalSalesTracking, dealDelivery, dealShipped, parcelUpdate } from "../admin/externalSalesTracking.js";
import { fakeDb } from "./fakeSupabase.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");

// Parcels are rows in Supabase, so their ids look like it.
const P1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

test("a parcel takes over what AfterShip says, and keeps the first moment it said it", () => {
  const fresh = { id: "p1", status: "pending", carrier: null, shipped_at: null, delivered_at: null };

  const moving = parcelUpdate(fresh, { status: "in_transit", carrier: "ups", shipped_at: "2026-09-24T08:00:00.000Z" }, NOW);
  assert.equal(moving.status, "in_transit");
  assert.equal(moving.carrier, "ups");
  assert.equal(moving.shipped_at, "2026-09-24T08:00:00.000Z");
  assert.equal(moving.delivered_at, undefined);

  const shipped = { ...fresh, status: "in_transit", carrier: "ups", shipped_at: "2026-09-24T08:00:00.000Z" };
  const arrived = parcelUpdate(shipped, { status: "delivered", delivered_at: "2026-09-25T09:12:00.000Z" }, NOW);
  assert.equal(arrived.status, "delivered");
  assert.equal(arrived.delivered_at, "2026-09-25T09:12:00.000Z");
  // The moment of shipping is not rewritten by a later read.
  assert.equal(arrived.shipped_at, undefined);
});

test("delivered is never taken back, and a problem is written down", () => {
  const delivered = { id: "p1", status: "delivered", delivered_at: "2026-09-25T09:12:00.000Z" };
  assert.deepEqual(parcelUpdate(delivered, { status: "in_transit" }, NOW), { tracking_checked_at: NOW.toISOString() });

  const stuck = parcelUpdate({ id: "p2", status: "in_transit" }, { status: "exception", detail: "Returned to sender" }, NOW);
  assert.equal(stuck.status, "exception");
  assert.equal(stuck.tracking_detail, "Returned to sender");

  assert.equal(parcelUpdate({ id: "p3", status: "pending" }, { status: "nonsense" }, NOW), null);
});

test("a deal is delivered when its last parcel is, dated by that parcel", () => {
  const sale = { shipping_status: "shipped" };
  const first = { tracking_number: "1ZAAA1111111111111", status: "delivered", delivered_at: "2026-09-24T10:00:00.000Z" };
  const second = { tracking_number: "1Z2", status: "in_transit", delivered_at: null };

  assert.equal(dealDelivery(sale, [first, second]), null);

  const both = dealDelivery(sale, [first, { ...second, status: "delivered", delivered_at: "2026-09-25T08:00:00.000Z" }]);
  assert.deepEqual(both, { shipping_status: "delivered", delivered_at: "2026-09-25T08:00:00.000Z" });

  // Nothing to say about a deal that is already delivered or was cancelled.
  assert.equal(dealDelivery({ shipping_status: "delivered" }, [first]), null);
  assert.equal(dealDelivery({ shipping_status: "cancelled" }, [first]), null);
  assert.equal(dealDelivery(sale, []), null);

  /*
    A deal still on Ready to Ship is no longer refused here. A consignor's
    box is delivered without anyone here ever packing it, and refusing it
    left those deals one step short for good. dealShipped moves the deal on
    first, and applyUpdates holds the delivery back while a pair of ours is
    still waiting for a box.
  */
  assert.deepEqual(
    dealDelivery({ shipping_status: "ready_to_ship" }, [first]),
    { shipping_status: "delivered", delivered_at: "2026-09-24T10:00:00.000Z" }
  );
});

test("what the engine found is written to the parcels and rolls up to the deal", async () => {
  const db = fakeDb({
    external_sales: [
      { id: "s1", deal_number: 81, shipping_status: "shipped", payment_status: "pending", delivered_at: null }
    ],
    shipments: [
      { id: P1, external_sale_id: "s1", tracking_number: "1ZAAA1111111111111", status: "in_transit", delivered_at: null, shipped_at: "2026-09-24T08:00:00.000Z" },
      { id: P2, external_sale_id: "s1", tracking_number: "1Z2", status: "in_transit", delivered_at: null, shipped_at: "2026-09-24T08:00:00.000Z" }
    ]
  });

  const tracking = createExternalSalesTracking({ db });

  const half = await tracking.applyUpdates([{ id: P1, status: "delivered", delivered_at: "2026-09-25T09:00:00.000Z" }]);
  assert.equal(half.updated, 1);
  assert.deepEqual(half.delivered, []);
  assert.equal(db.tables.external_sales[0].shipping_status, "shipped");

  const rest = await tracking.applyUpdates([{ id: P2, status: "delivered", delivered_at: "2026-09-25T11:30:00.000Z" }]);
  assert.deepEqual(rest.delivered, ["EXTD-000081"]);
  assert.equal(db.tables.external_sales[0].shipping_status, "delivered");
  assert.equal(db.tables.external_sales[0].delivered_at, "2026-09-25T11:30:00.000Z");
});

test("a parcel the portal does not know is reported back, not written", async () => {
  const db = fakeDb({ external_sales: [], shipments: [] });
  const tracking = createExternalSalesTracking({ db });

  const out = await tracking.applyUpdates([
    { id: "11111111-1111-4111-8111-111111111111", status: "delivered" },
    { id: "not-a-uuid", status: "delivered" }
  ]);

  assert.deepEqual(out.unknown, ["11111111-1111-4111-8111-111111111111"]);
  assert.equal(out.updated, 0);
});

test("the engine is handed parcels with their deal number and nothing else", async () => {
  const asked = [];
  const db = {
    async get(query) {
      asked.push(query);
      return [{
        id: "p1",
        tracking_number: "1ZAAA1111111111111",
        status: "in_transit",
        carrier: "ups",
        tracking_checked_at: null,
        external_sale_id: "s1",
        external_sales: { deal_number: 81, shipping_status: "shipped", payment_status: "pending" }
      }];
    }
  };

  const [parcel] = await createExternalSalesTracking({ db }).openParcels({ limit: 5 });
  assert.deepEqual(parcel, { id: "p1", deal: "EXTD-000081", tracking_number: "1ZAAA1111111111111", carrier: "ups", status: "in_transit", checked_at: null });

  // Only parcels that can still move, on deals that are not finished.
  // Ready to Ship is in there: a consignor's box leaves without us packing
  // it, so that deal only ever learns it has gone from the parcel itself.
  assert.match(asked[0], /status=neq\.delivered/);
  assert.match(asked[0], /external_sales\.shipping_status=in\.\(ready_to_ship,shipped,delivered\)/);
  assert.match(asked[0], /limit=5/);
});

/* ---------------- a box nobody here packed ---------------- */

test("one moving parcel puts the deal on its way, whatever we packed", () => {
  const moving = { tracking_number: "1ZAAA1111111111111", status: "in_transit", shipped_at: "2026-10-06T09:00:00.000Z" };
  const later = { tracking_number: "1Z2", status: "in_transit", shipped_at: "2026-10-07T09:00:00.000Z" };

  // A consignor's deal never leaves Ready to Ship on its own; his parcel says it.
  assert.deepEqual(
    dealShipped({ shipping_status: "ready_to_ship" }, [moving]),
    { shipping_status: "shipped", shipped_at: "2026-10-06T09:00:00.000Z" }
  );

  // Two boxes: the first one out is when the order left.
  assert.deepEqual(
    dealShipped({ shipping_status: "ready_to_ship" }, [later, moving]).shipped_at,
    "2026-10-06T09:00:00.000Z"
  );

  // Nothing has moved yet, so neither has the deal.
  assert.equal(dealShipped({ shipping_status: "ready_to_ship" }, [{ tracking_number: "1Z2", status: "pending" }]), null);
  assert.equal(dealShipped({ shipping_status: "ready_to_ship" }, []), null);

  // And a deal that is already past this, or dead, is left alone.
  assert.equal(dealShipped({ shipping_status: "shipped" }, [moving]), null);
  assert.equal(dealShipped({ shipping_status: "delivered" }, [moving]), null);
  assert.equal(dealShipped({ shipping_status: "cancelled" }, [moving]), null);
});

test("a consignor's parcel carries its deal from Ready to Ship all the way to delivered", async () => {
  const db = fakeDb({
    external_sales: [{ id: "s1", deal_number: 97, shipping_status: "ready_to_ship", payment_status: "paid", shipped_at: null, delivered_at: null }],
    external_sale_pairs: [{ id: "pa", sale_id: "s1", shipment_id: null, consignor_fulfillment_status: "Ready to Ship", cancelled_at: null }],
    shipments: [{ id: "11111111-1111-4111-8111-111111111111", external_sale_id: "s1", tracking_number: "1ZAAA1111111111111", status: "pending", shipped_at: null, delivered_at: null }]
  });

  const out = await createExternalSalesTracking({ db }).applyUpdates([
    { id: "11111111-1111-4111-8111-111111111111", status: "delivered", delivered_at: "2026-10-08T11:00:00.000Z" }
  ]);

  const sale = db.tables.external_sales[0];

  assert.deepEqual(out.shipped, ["EXTD-000097"], "it left");
  assert.deepEqual(out.delivered, ["EXTD-000097"], "and it arrived");
  assert.equal(sale.shipping_status, "delivered");
  assert.ok(sale.shipped_at, "with a date for when it went out");
});

test("our own half still on the shelf holds the delivery back", async () => {
  const db = fakeDb({
    external_sales: [{ id: "s1", deal_number: 98, shipping_status: "ready_to_ship", payment_status: "paid", shipped_at: null, delivered_at: null }],
    external_sale_pairs: [
      // His, and already out.
      { id: "pa", sale_id: "s1", shipment_id: "11111111-1111-4111-8111-111111111111", consignor_fulfillment_status: "Ready to Ship", cancelled_at: null },
      // Ours, in no box at all: the deal is not finished.
      { id: "pb", sale_id: "s1", shipment_id: null, consignor_fulfillment_status: null, cancelled_at: null }
    ],
    shipments: [{ id: "11111111-1111-4111-8111-111111111111", external_sale_id: "s1", tracking_number: "1ZAAA1111111111111", status: "pending", shipped_at: null, delivered_at: null }]
  });

  const out = await createExternalSalesTracking({ db }).applyUpdates([
    { id: "11111111-1111-4111-8111-111111111111", status: "delivered", delivered_at: "2026-10-08T11:00:00.000Z" }
  ]);

  const sale = db.tables.external_sales[0];

  assert.deepEqual(out.shipped, ["EXTD-000098"], "his box did leave");
  assert.deepEqual(out.delivered, [], "but the order is not delivered");
  assert.equal(sale.shipping_status, "shipped");
});

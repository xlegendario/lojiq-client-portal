import test from "node:test";
import assert from "node:assert/strict";

import { createExternalSalesTracking, dealDelivery, parcelUpdate } from "../admin/externalSalesTracking.js";
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

  // Nothing to say about a deal that is already delivered, was cancelled, or
  // has not been packed yet.
  assert.equal(dealDelivery({ shipping_status: "delivered" }, [first]), null);
  assert.equal(dealDelivery({ shipping_status: "cancelled" }, [first]), null);
  assert.equal(dealDelivery({ shipping_status: "ready_to_ship" }, [first]), null);
  assert.equal(dealDelivery(sale, []), null);
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

  // Only parcels that can still move, on deals that have left.
  assert.match(asked[0], /status=neq\.delivered/);
  assert.match(asked[0], /external_sales\.shipping_status=in\.\(shipped,delivered\)/);
  assert.match(asked[0], /limit=5/);
});

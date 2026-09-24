// admin/adminInboundScans.js
//
// Inbound Scans: what was in the box, per tracking number (24-09-2026).
//
// A parcel that is scanned in the warehouse ends up in one of two places. A
// partner's parcel becomes pairs on his shelf in Supabase (partner_stock);
// everything else becomes rows in Airtable's Incoming Stock. Neither of them
// shows a parcel as a parcel, so checking a delivery against its packing
// slip meant opening two screens and counting by hand.
//
// This groups both by tracking number and says, per parcel: who sent it,
// when it was scanned, how many pairs came out of it and which ones.

import express from "express";
import fs from "fs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Newest first, and a parcel without a date last rather than first.
const byNewest = (a, b) => text(b.received_at).localeCompare(text(a.received_at));

export class InboundScansError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// How the intake called it, as the screen says it.
export const PARTNER_MODES = {
  consignment: "Consignment",
  forwarding: "Forwarding",
  both: "Consignment & Forwarding"
};

/*
 * A partner's parcel: one row per pair, so a parcel of twenty pairs is
 * twenty rows. They are folded back into the lines they were scanned as -
 * one SKU in one size - with what became of each pair.
 */
export function parcelsFromPartnerStock(rows = []) {
  const parcels = new Map();

  for (const row of rows) {
    const tracking = text(row.tracking_number);
    if (!tracking) continue;

    if (!parcels.has(tracking)) {
      parcels.set(tracking, {
        tracking,
        source: "partner",
        received_at: text(row.received_at),
        type: PARTNER_MODES[text(row.mode)] || text(row.mode) || "Partner stock",
        seller_id: text(row.seller_id),
        seller_record_id: text(row.seller_record_id),
        party: "",
        pairs: 0,
        value: 0,
        in_stock: 0,
        sold: 0,
        forwarded: 0,
        lines: new Map()
      });
    }

    const parcel = parcels.get(tracking);
    const key = `${text(row.sku)}|${text(row.size)}|${round2(row.partner_price)}`;

    if (!parcel.lines.has(key)) {
      parcel.lines.set(key, {
        sku: text(row.sku),
        size: text(row.size),
        product_name: text(row.product_name),
        barcode: text(row.barcode),
        partner_price: row.partner_price === null || row.partner_price === undefined ? null : round2(row.partner_price),
        markup: row.markup === null || row.markup === undefined ? null : round2(row.markup),
        quantity: 0,
        in_stock: 0,
        sold: 0,
        forwarded: 0,
        refs: []
      });
    }

    const line = parcel.lines.get(key);
    const status = text(row.status) || "in_stock";

    line.quantity += 1;
    parcel.pairs += 1;
    parcel.value = round2(parcel.value + round2(row.partner_price));

    if (status === "sold") {
      line.sold += 1;
      parcel.sold += 1;
      if (text(row.sold_ref) && !line.refs.includes(text(row.sold_ref))) line.refs.push(text(row.sold_ref));
    } else if (status === "forwarded") {
      line.forwarded += 1;
      parcel.forwarded += 1;
    } else {
      line.in_stock += 1;
      parcel.in_stock += 1;
    }

    // The earliest scan on the parcel is when the parcel was done.
    if (!parcel.received_at || (text(row.received_at) && text(row.received_at) < parcel.received_at)) {
      parcel.received_at = text(row.received_at);
    }
  }

  return parcels;
}

/*
 * Everything else: Incoming Stock in Airtable, one row per SKU in the parcel.
 * The parcel also has a row without a SKU - the placeholder written when it
 * was received - which is what tells us a parcel arrived but was never
 * verified.
 */
export function parcelsFromIncoming(records = []) {
  const parcels = new Map();

  for (const record of records) {
    const fields = record.fields || record || {};
    const tracking = text(fields["Tracking Number"]);
    if (!tracking) continue;

    if (!parcels.has(tracking)) {
      parcels.set(tracking, {
        tracking,
        source: "warehouse",
        received_at: text(fields["Received At"]),
        type: text(fields["Type"]) || "",
        status: text(fields["Status"]),
        seller_record_id: text(first(fields["Supplier"])),
        client_record_id: text(first(fields["Client"])),
        party: "",
        pairs: 0,
        value: 0,
        lines: new Map()
      });
    }

    const parcel = parcels.get(tracking);

    if (!parcel.type && text(fields["Type"])) parcel.type = text(fields["Type"]);
    if (!parcel.seller_record_id) parcel.seller_record_id = text(first(fields["Supplier"]));
    if (!parcel.client_record_id) parcel.client_record_id = text(first(fields["Client"]));
    if (text(fields["Received At"]) && (!parcel.received_at || text(fields["Received At"]) < parcel.received_at)) {
      parcel.received_at = text(fields["Received At"]);
    }

    // The placeholder carries no SKU: it is the parcel, not a line on it.
    const sku = text(fields["SKU"]);
    const gtin = text(fields["Product GTIN"]);
    if (!sku && !gtin) {
      parcel.status = text(fields["Status"]) || parcel.status;
      continue;
    }

    const key = `${sku}|${text(fields["Size"])}|${gtin}`;
    const quantity = Number(fields["Quantity"]) || 0;

    if (!parcel.lines.has(key)) {
      parcel.lines.set(key, {
        sku,
        size: text(fields["Size"]),
        barcode: gtin,
        quantity: 0,
        status: text(fields["Status"])
      });
    }

    parcel.lines.get(key).quantity += quantity;
    parcel.pairs += quantity;
  }

  return parcels;
}

/*
 * A partner parcel leaves a trail in both places: its pairs in Supabase and
 * its placeholder in Incoming Stock, marked Verified. The pairs are the
 * truth, so they win; the placeholder only fills in what it knows.
 */
export function mergeParcels(partner, warehouse) {
  const merged = new Map();

  for (const [tracking, parcel] of warehouse) merged.set(tracking, parcel);

  for (const [tracking, parcel] of partner) {
    const other = merged.get(tracking);
    merged.set(tracking, other
      ? {
        ...parcel,
        status: other.status || "",
        client_record_id: other.client_record_id || "",
        seller_record_id: parcel.seller_record_id || other.seller_record_id || "",
        received_at: parcel.received_at || other.received_at
      }
      : parcel);
  }

  return merged;
}

// The parcel as the list shows it: the lines stay behind for the detail.
export function listRow(parcel) {
  const lines = [...parcel.lines.values()];

  return {
    tracking: parcel.tracking,
    source: parcel.source,
    received_at: parcel.received_at || null,
    type: parcel.type || "",
    status: parcel.status || "",
    party: parcel.party || "",
    seller_id: parcel.seller_id || "",
    pairs: parcel.pairs,
    skus: lines.length,
    value: round2(parcel.value),
    in_stock: parcel.in_stock ?? null,
    sold: parcel.sold ?? null,
    forwarded: parcel.forwarded ?? null
  };
}

/*
 * deps:
 *   airtable  select, byIds (main base) - Incoming Stock, Sellers Database, Merchants
 *   db        createSupabaseRest - partner_stock
 */
export function createInboundScansStore({ airtable, db }) {
  const INCOMING_FIELDS = [
    "Tracking Number", "Product GTIN", "SKU", "Size", "Quantity",
    "Type", "Status", "Received At", "Supplier", "Client"
  ];

  /*
   * Enough pages of Incoming Stock to fill the list. Sorted by the day they
   * came in, so the first page already holds this week's parcels; a parcel
   * spreads over several rows, so pages are read until there are enough
   * parcels rather than enough rows.
   */
  async function incoming({ wanted = 60, formula = "" } = {}) {
    const records = [];
    let offset = "";

    for (let page = 0; page < 8; page += 1) {
      const result = await airtable.select("Incoming Stock", {
        fields: INCOMING_FIELDS,
        sort: "Received At",
        formula,
        pageSize: 100,
        offset
      });

      records.push(...result.records);
      offset = result.offset;

      const parcels = new Set(records.map((r) => text(r.fields?.["Tracking Number"])).filter(Boolean));
      if (!offset || parcels.size >= wanted * 2) break;
    }

    return records;
  }

  async function partnerRows(tracking = "") {
    const where = tracking
      ? `tracking_number=eq.${encodeURIComponent(tracking)}`
      : "tracking_number=not.is.null&order=received_at.desc&limit=5000";

    return db.get(
      "partner_stock?select=tracking_number,seller_id,seller_record_id,sku,size,product_name,barcode," +
      `mode,partner_price,markup,status,sold_ref,received_at&${where}`
    );
  }

  // Who sent it. A partner parcel knows its seller, a warehouse parcel links
  // to a seller or to a merchant.
  async function withNames(parcels) {
    const sellerIds = [...new Set(parcels.map((p) => text(p.seller_record_id)).filter(Boolean))];
    const clientIds = [...new Set(parcels.map((p) => text(p.client_record_id)).filter(Boolean))];

    const [sellers, clients] = await Promise.all([
      sellerIds.length ? airtable.byIds("Sellers Database", sellerIds, ["Seller ID", "Full Name", "Company Name"]).catch(() => new Map()) : new Map(),
      clientIds.length ? airtable.byIds("Merchants", clientIds, ["Company Name", "Name"]).catch(() => new Map()) : new Map()
    ]);

    for (const parcel of parcels) {
      const seller = sellers.get(text(parcel.seller_record_id));
      const client = clients.get(text(parcel.client_record_id));

      parcel.party = seller
        ? text(seller["Company Name"]) || text(seller["Full Name"]) || text(seller["Seller ID"])
        : client
          ? text(client["Company Name"]) || text(client["Name"])
          : "";

      if (!parcel.seller_id && seller) parcel.seller_id = text(seller["Seller ID"]);
    }

    return parcels;
  }

  async function list({ q = "", limit = 60 } = {}) {
    const search = text(q);
    const wanted = Math.min(Math.max(Number(limit) || 60, 10), 200);

    /*
     * A search looks for the parcel itself, so Airtable is asked for the
     * tracking number and the SKU; the partner's shelf is small enough to
     * sift through here.
     */
    const escaped = search.replace(/'/g, "\\'");
    const formula = search
      ? `OR(FIND(UPPER('${escaped}'), UPPER({Tracking Number} & '')) > 0, FIND(UPPER('${escaped}'), UPPER({SKU} & '')) > 0)`
      : "";

    const [records, rows] = await Promise.all([
      incoming({ wanted, formula }).catch((err) => {
        console.error("[inbound scans] Incoming Stock:", err.message);
        return [];
      }),
      partnerRows().catch((err) => {
        console.error("[inbound scans] partner_stock:", err.message);
        return [];
      })
    ]);

    const merged = mergeParcels(parcelsFromPartnerStock(rows), parcelsFromIncoming(records));
    let parcels = [...merged.values()];

    if (search) {
      const needle = search.toUpperCase();
      parcels = parcels.filter((parcel) =>
        parcel.tracking.toUpperCase().includes(needle) ||
        text(parcel.seller_id).toUpperCase().includes(needle) ||
        [...parcel.lines.values()].some((line) => text(line.sku).toUpperCase().includes(needle)));
    }

    parcels.sort(byNewest);
    parcels = parcels.slice(0, wanted);

    await withNames(parcels);

    return {
      parcels: parcels.map(listRow),
      totals: {
        parcels: parcels.length,
        pairs: parcels.reduce((sum, parcel) => sum + parcel.pairs, 0),
        value: round2(parcels.reduce((sum, parcel) => sum + parcel.value, 0))
      }
    };
  }

  async function detail(tracking) {
    const number = text(tracking);
    if (!number) throw new InboundScansError("Which parcel?");

    const escaped = number.replace(/'/g, "\\'");

    const [records, rows] = await Promise.all([
      airtable.select("Incoming Stock", {
        fields: INCOMING_FIELDS,
        formula: `TRIM({Tracking Number} & '') = '${escaped}'`,
        pageSize: 100
      }).then((out) => out.records).catch(() => []),
      partnerRows(number).catch(() => [])
    ]);

    const merged = mergeParcels(parcelsFromPartnerStock(rows), parcelsFromIncoming(records));
    const parcel = merged.get(number);

    if (!parcel) throw new InboundScansError(`Nothing was scanned on ${number}.`, 404);

    await withNames([parcel]);

    return { ...listRow(parcel), lines: [...parcel.lines.values()] };
  }

  return { list, detail };
}

export function mountInboundScans(router, { store, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof InboundScansError ? err.status : 500;
    if (status >= 500) console.error("[admin inbound scans]", err.message);
    res.status(status).json({ error: err instanceof InboundScansError ? err.message : `Inbound Scans failed: ${err.message}` });
  };

  router.get(["/admin/inbound-scans", "/admin/inbound-scans/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/inbound-scans", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      res.json(await store.list({ q: text(req.query.q), limit: req.query.limit }));
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/inbound-scans/get", async (req, res) => {
    try {
      res.json({ parcel: await store.detail(text(req.query.tracking)) });
    } catch (err) {
      send(res, err);
    }
  });
}

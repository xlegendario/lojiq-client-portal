// admin/adminExternalSales.js
//
// External Sales: sales of our own stock to outside buyers, made as an
// outbound in the WMS (External Sales Log in the main base). The WMS takes
// tracking and labels only at the moment the outbound is made; here they can
// be added afterwards, the same way Forward Service does it for forwards.
//
// Shipping Status follows what is on the sale: a tracking number or a label
// makes it Ready to Ship - which is what puts it in the WMS Pack & Ship list -
// and taking them all off puts it back on Pending. Shipped is never undone.
//
// Every change goes through the action log, like the other buttons.

import express from "express";
import fs from "fs";
import { LABEL_TYPES, labelUpload, trackingList } from "./adminForwarding.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

export const EXTERNAL_SALES_LOG = "External Sales Log";
export const SALE_STATUSES = ["Pending", "Label(s) Generated", "Ready to Ship", "Shipped"];

const LIST_FIELDS = [
  "External Deal ID", "Buyer Name", "Buyer ID (Lookup)", "Buyer Country", "Sale Date", "Created",
  "Quantity", "SKUs", "Total Selling Price", "Selling VAT Type", "Shipping Costs", "Payment Status",
  "Amount of Labels", "Tracking Numbers", "Shipping Labels", "Shipping Status", "Items per Parcel",
  "Linked Inventory Units"
];

export class ExternalSalesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/*
 * What the status becomes after the tracking or labels changed.
 *
 * Label(s) Generated is kept when nothing is on the sale yet: someone set it
 * by hand to say a label is being made, and an empty edit should not undo
 * that. Pending and Label(s) Generated both leave for Ready to Ship the
 * moment there is something to ship with.
 */
export function nextSaleStatus(current, trackingNumbers, labels) {
  if (current === "Shipped") return "Shipped";
  if (trackingNumbers.length || labels.length) return "Ready to Ship";
  return current === "Label(s) Generated" ? current : "Pending";
}

export function saleRow(record) {
  const f = record.fields || {};
  const labels = (f["Shipping Labels"] || []).map((file) => ({ id: file.id, url: file.url, filename: file.filename }));

  return {
    id: record.id,
    display_id: text(f["External Deal ID"]) || record.id,
    buyer_name: text(first(f["Buyer Name"])),
    buyer_id: text(first(f["Buyer ID (Lookup)"])),
    buyer_country: text(first(f["Buyer Country"])),
    sale_date: text(f["Sale Date"]),
    created: text(f["Created"]),
    quantity: Number(first(f["Quantity"])) || (f["Linked Inventory Units"] || []).length,
    skus: text(f["SKUs"]),
    selling_price: Number(f["Total Selling Price"]) || 0,
    vat_type: text(f["Selling VAT Type"]),
    shipping_costs: Number(f["Shipping Costs"]) || 0,
    payment_status: text(f["Payment Status"]),
    amount_of_labels: Number(f["Amount of Labels"]) || 0,
    tracking_numbers: trackingList(f["Tracking Numbers"]),
    labels,
    shipping_status: text(f["Shipping Status"]) || "Pending",
    items_per_parcel: text(f["Items per Parcel"]),
    unit_ids: f["Linked Inventory Units"] || []
  };
}

export function createExternalSalesStore({ airtable }) {
  async function list({ status = "open" } = {}) {
    const formula =
      status === "open" ? `NOT({Shipping Status} = 'Shipped')`
        : SALE_STATUSES.includes(status) ? `{Shipping Status} = '${status}'`
          : status === "pending" ? `OR({Shipping Status} = 'Pending', {Shipping Status} = 'Label(s) Generated', {Shipping Status} = '')`
            : "";

    const rows = [];
    let offset = "";
    let pages = 0;

    // Shipped grows for ever; the newest five hundred are what anyone looks for.
    do {
      const page = await airtable.select(EXTERNAL_SALES_LOG, { formula, fields: LIST_FIELDS, sort: "Created", pageSize: 100, offset });
      rows.push(...page.records.map(saleRow));
      offset = page.offset;
      pages += 1;
    } while (offset && pages < 5);

    return rows;
  }

  async function get(id) {
    if (!/^rec[a-zA-Z0-9]{14}$/.test(text(id))) throw new ExternalSalesError("Unknown sale.");

    const { records } = await airtable.select(EXTERNAL_SALES_LOG, {
      formula: `RECORD_ID() = '${text(id)}'`,
      fields: LIST_FIELDS,
      pageSize: 1,
      maxRecords: 1
    });

    if (!records[0]) throw new ExternalSalesError("That sale no longer exists.", 404);
    return saleRow(records[0]);
  }

  async function units(ids) {
    if (!ids.length) return [];

    // A Map of id -> fields.
    const found = await airtable.byIds("Inventory Units", ids, ["Item ID", "Product Name", "Size", "SKU", "Picture"]);

    return [...found].map(([id, f]) => ({
      id,
      item_id: text(f["Item ID"]),
      product: text(f["Product Name"]),
      size: text(f["Size"]),
      sku: text(f["SKU"]),
      image: text(first(f["Picture"])?.thumbnails?.small?.url || first(f["Picture"])?.url)
    }));
  }

  async function update(id, fields) {
    const record = await airtable.update(EXTERNAL_SALES_LOG, id, fields);
    return saleRow(record);
  }

  async function counts() {
    const { records } = await airtable.select(EXTERNAL_SALES_LOG, {
      formula: `NOT({Shipping Status} = 'Shipped')`,
      fields: ["Shipping Status"],
      pageSize: 100
    });

    const result = { pending: 0, ready: 0 };
    for (const record of records) {
      if (text(record.fields?.["Shipping Status"]) === "Ready to Ship") result.ready += 1;
      else result.pending += 1;
    }
    return result;
  }

  return { list, get, units, update, counts };
}

// Airtable keeps an attachment only when it is sent back by id.
const keepLabels = (labels) => labels.map((label) => (label.id ? { id: label.id } : { url: label.url, filename: label.filename }));

export function mountExternalSales(router, { store, audit, callWms, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof ExternalSalesError ? err.status : 500;
    if (status >= 500) console.error("[admin external sales]", err.message);
    res.status(status).json({ error: err instanceof ExternalSalesError ? err.message : "External Sales failed." });
  };

  const log = (req, action, row, details) =>
    audit.record({ actor: req.admin, action, source: "external_sales", recordId: row.id, label: row.display_id, details });

  router.get(["/admin/external-sales", "/admin/external-sales/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/external-sales", async (req, res) => {
    try {
      res.json({ sales: await store.list({ status: text(req.query.status) || "open" }) });
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/external-sales/get", async (req, res) => {
    try {
      const sale = await store.get(req.query.id);
      const [units, history] = await Promise.all([store.units(sale.unit_ids), audit.forRecord(sale.id).catch(() => [])]);
      res.json({ sale, units, history });
    } catch (err) {
      send(res, err);
    }
  });

  // Tracking numbers, a label taken off, or a status by hand.
  router.post("/api/admin/external-sales/update", express.json({ limit: "50kb" }), async (req, res) => {
    try {
      const before = await store.get(req.body?.id);
      const fields = {};
      const changed = {};

      let tracking = before.tracking_numbers;
      let labels = before.labels;

      if (req.body?.tracking_numbers !== undefined) {
        tracking = trackingList(req.body.tracking_numbers);
        fields["Tracking Numbers"] = tracking.join(", ");
        changed.tracking_numbers = { from: before.tracking_numbers, to: tracking };
      }

      if (text(req.body?.remove_label_url)) {
        labels = labels.filter((label) => label.url !== text(req.body.remove_label_url));
        fields["Shipping Labels"] = keepLabels(labels);
        changed.label_removed = text(req.body.remove_label_url);
      }

      if (req.body?.shipping_costs !== undefined) {
        const costs = Number(String(req.body.shipping_costs).replace(",", "."));
        if (!Number.isFinite(costs) || costs < 0) throw new ExternalSalesError("Shipping costs cannot be negative.");
        fields["Shipping Costs"] = Math.round(costs * 100) / 100;
        changed.shipping_costs = { from: before.shipping_costs, to: fields["Shipping Costs"] };
      }

      if (fields["Tracking Numbers"] !== undefined || fields["Shipping Labels"]) {
        fields["Shipping Status"] = nextSaleStatus(before.shipping_status, tracking, labels);
      }

      if (text(req.body?.shipping_status)) {
        const wanted = text(req.body.shipping_status);
        if (!SALE_STATUSES.includes(wanted)) throw new ExternalSalesError("Unknown shipping status.");
        if (before.shipping_status === "Shipped" && wanted !== "Shipped") {
          throw new ExternalSalesError("This sale is already shipped.");
        }
        fields["Shipping Status"] = wanted;
      }

      if (fields["Shipping Status"] && fields["Shipping Status"] !== before.shipping_status) {
        changed.shipping_status = { from: before.shipping_status, to: fields["Shipping Status"] };
      }

      if (!Object.keys(fields).length) return res.json({ sale: before });

      const sale = await store.update(before.id, fields);
      await log(req, "external_sale_update", sale, { changed });
      res.json({ sale });
    } catch (err) {
      send(res, err);
    }
  });

  // One label PDF, with the tracking number printed on it if there is one.
  router.post(
    "/api/admin/external-sales/label",
    express.raw({ type: LABEL_TYPES, limit: "10mb" }),
    async (req, res) => {
      try {
        const before = await store.get(req.query.id);
        const tracking = text(req.query.tracking).replace(/\s+/g, "");
        const kind = labelUpload(req.body);

        if (!kind) throw new ExternalSalesError("The label must be a PDF, JPEG or PNG file.");

        if (tracking && !/^[A-Za-z0-9-]{6,40}$/.test(tracking)) {
          throw new ExternalSalesError("Enter the tracking number from the label.");
        }

        const stored = await callWms("/api/upload-label-file", {
          folder: "external-sales",
          file_name: `${before.display_id}${tracking ? `-${tracking}` : ""}.${kind.ext}`,
          file_data_url: `data:${kind.mime};base64,${req.body.toString("base64")}`,
          tracking
        });

        const labels = [...before.labels, { url: stored.url, filename: stored.filename }];
        // (The WMS stored it as a PDF, whatever came in.)
        const trackingNumbers = trackingList([...before.tracking_numbers, tracking]);

        const sale = await store.update(before.id, {
          "Shipping Labels": keepLabels(labels),
          "Tracking Numbers": trackingNumbers.join(", "),
          "Shipping Status": nextSaleStatus(before.shipping_status, trackingNumbers, labels)
        });

        await log(req, "external_sale_label", sale, { tracking, label: stored.url });
        res.json({ sale });
      } catch (err) {
        send(res, err);
      }
    }
  );
}

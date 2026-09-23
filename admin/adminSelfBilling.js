// admin/adminSelfBilling.js
//
// The self-billing purchase invoice as a service (block 10, 23-09-2026).
//
// Every flow that buys a pair makes an Inventory Unit for it, and every one
// of those purchases needs its self-billing document: External Sales from a
// partner's shelf, a store order, a Member WTB, a consignment sale. So the
// document is not built inside any of them - it is asked for here, by the
// unit it belongs to.
//
//   POST /api/internal/self-billing/pdf   { inventory_unit_record_id }
//
// Everything on the document comes from the unit and its seller, so a caller
// only has to say which unit; anything it does send (a different order
// number, a price) wins over what was read.

import express from "express";

import { VAT_NOTES, selfBillingPdf } from "./selfBillingPdf.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);

const UNIT_FIELDS = [
  "Item ID", "Product Name", "SKU", "Size", "VAT Type", "Purchase Price", "Final Purchase Price",
  "Ticket Number", "Purchase Date", "Seller ID"
];

const SELLER_FIELDS = ["Seller ID", "Full Name", "Company Name", "VAT ID", "Email", "Address", "Zipcode", "City", "Country", "Payout Info"];

export class SelfBillingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The seller as the document names him: the company when there is one, the
// person otherwise, with the address on one line and the IBAN he is paid on.
export function sellerFrom(fields = {}) {
  return {
    seller_id: text(fields["Seller ID"]),
    name: text(fields["Company Name"]) || text(fields["Full Name"]),
    address: text(fields["Address"]),
    zipcode: text(fields["Zipcode"]),
    city: text(fields["City"]),
    country: text(fields["Country"]),
    email: text(fields["Email"]),
    vat_id: text(fields["VAT ID"]),
    iban: text(fields["Payout Info"])
  };
}

/*
 * What the document says, from the unit and its seller. The price is what we
 * pay him: Final Purchase Price, which is the purchase minus any deduction.
 */
export function documentFrom({ unit = {}, seller = {}, overrides = {} }) {
  const vatType = text(overrides.vat_type) || text(unit["VAT Type"]);

  if (!VAT_NOTES[vatType]) {
    throw new SelfBillingError(`No self-billing document for VAT type "${vatType || "unknown"}": add it to selfBillingPdf.js first.`);
  }

  const price = overrides.price !== undefined ? Number(overrides.price) : Number(unit["Final Purchase Price"] ?? unit["Purchase Price"]);

  if (!(price > 0)) throw new SelfBillingError("The unit has no purchase price, so there is nothing to invoice.");

  return {
    document_number: text(overrides.document_number) || text(unit["Item ID"]),
    order_number: text(overrides.order_number) || text(unit["Ticket Number"]),
    date: text(overrides.date) || text(unit["Purchase Date"]) || new Date().toISOString().slice(0, 10),
    vat_type: vatType,
    seller: { ...sellerFrom(seller), ...(overrides.seller || {}) },
    product: {
      name: text(overrides.product_name) || text(unit["Product Name"]),
      size: text(overrides.size) || text(unit["Size"]),
      sku: text(overrides.sku) || text(unit["SKU"]),
      price
    }
  };
}

/*
 * deps:
 *   airtable  byIds (main base) - Inventory Units, Sellers Database
 */
export function createSelfBilling({ airtable }) {
  async function forUnit(unitId, overrides = {}) {
    const id = text(unitId);
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new SelfBillingError("That is not an Inventory Unit id.");

    const units = await airtable.byIds("Inventory Units", [id], UNIT_FIELDS);
    const unit = units.get(id);
    if (!unit) throw new SelfBillingError("That Inventory Unit no longer exists.", 404);

    const sellerId = text(first(unit["Seller ID"]));
    const sellers = sellerId ? await airtable.byIds("Sellers Database", [sellerId], SELLER_FIELDS) : new Map();
    const seller = sellers.get(sellerId) || {};

    if (!text(seller["Seller ID"])) throw new SelfBillingError("The unit has no seller, so there is no one to invoice on behalf of.");

    return selfBillingPdf(documentFrom({ unit, seller, overrides }));
  }

  return { forUnit, render: (input) => selfBillingPdf(input) };
}

export function mountSelfBilling(router, { store, internalSecret = "" }) {
  const guard = (req, res) => {
    if (!text(internalSecret) || text(req.headers["x-kc-secret"]) !== text(internalSecret)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

  const send = (res, err) => {
    const status = err instanceof SelfBillingError ? err.status : 500;
    if (status >= 500) console.error("[self-billing]", err.message);
    res.status(status).json({ error: err instanceof SelfBillingError ? err.message : `The document could not be made: ${err.message}` });
  };

  // The document for one unit, as a PDF. Any flow that makes a unit for a
  // purchase can ask for it the moment it has the unit.
  router.post("/api/internal/self-billing/pdf", express.json({ limit: "20kb" }), async (req, res) => {
    if (!guard(req, res)) return;

    try {
      const { filename, pdf } = await store.forUnit(req.body?.inventory_unit_record_id, req.body || {});

      if (req.body?.as === "base64") {
        res.json({ ok: true, filename, pdf: pdf.toString("base64") });
        return;
      }

      res.type("application/pdf").set("Content-Disposition", `inline; filename="${filename}"`).send(pdf);
    } catch (err) {
      send(res, err);
    }
  });
}

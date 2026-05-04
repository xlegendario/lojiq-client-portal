import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Airtable from "airtable";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const {
  PORT = 3000,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_MERCHANTS_TABLE = "Merchants",
  AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE = "Unfulfilled Orders Log"
} = process.env;

if (!AIRTABLE_TOKEN) throw new Error("Missing AIRTABLE_TOKEN");
if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

const airtable = new Airtable({ apiKey: AIRTABLE_TOKEN }).base(AIRTABLE_BASE_ID);

function asText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeFormulaValue(value) {
  return asText(value).replace(/'/g, "\\'");
}

function getFirstAttachmentUrl(value) {
  if (!Array.isArray(value) || !value[0]?.url) return "";
  return value[0].url;
}

function normalizeMerchant(record) {
  return {
    id: record.id,
    store_name: asText(record.fields["Store Name"]),
    portal_email: asText(record.fields["Portal Email"]),
    portal_password: asText(record.fields["Portal Password"]),
    portal_enabled: record.fields["Portal Enabled"] === true
  };
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/login", async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase();
    const password = asText(req.body.password);

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const records = await airtable(AIRTABLE_MERCHANTS_TABLE)
      .select({
        filterByFormula: `LOWER(TRIM({Portal Email} & '')) = '${escapeFormulaValue(email)}'`,
        maxRecords: 1
      })
      .firstPage();

    if (!records.length) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const merchant = normalizeMerchant(records[0]);

    if (!merchant.portal_enabled) {
      return res.status(403).json({ error: "Portal access disabled" });
    }

    if (merchant.portal_password !== password) {
      return res.status(401).json({ error: "Invalid login" });
    }

    res.json({
      merchant: {
        id: merchant.id,
        store_name: merchant.store_name,
        portal_email: merchant.portal_email
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed", details: err.message });
  }
});

function displayValue(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asText(v)).filter(Boolean).join(", ");
  }

  return asText(value);
}

function moneyValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);

  if (!Number.isFinite(n)) return displayValue(value) || "";

  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR"
  }).format(n);
}

function dateValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return displayValue(value);

  return d.toLocaleDateString("nl-NL");
}

function getPortalStatus(fields, view) {
  const fulfillment = displayValue(fields["Fulfillment Status"]);
  const shipping = displayValue(fields["Shipping Status"]);

  if (view === "allocated") {
    if (fulfillment === "StockX Processing" || fulfillment === "Claim Processing") {
      return "Processing";
    }

    return fulfillment;
  }

  if (view === "shipped" || view === "fulfilled") {
    return shipping;
  }

  return fulfillment;
}

function buildOrderViewFormula(view) {
  if (view === "open") {
    return `OR(
      {Fulfillment Status} = 'Pending',
      {Fulfillment Status} = 'Outsource',
      {Fulfillment Status} = 'Confirmed'
    )`;
  }

  if (view === "offers") {
    return `OR(
      {Fulfillment Status} = 'Pending',
      {Fulfillment Status} = 'Outsource'
    )`;
  }

  if (view === "allocated") {
    return `OR(
      {Fulfillment Status} = 'Allocated',
      {Fulfillment Status} = 'Found',
      {Fulfillment Status} = 'Awaiting Label',
      {Fulfillment Status} = 'StockX Processing',
      {Fulfillment Status} = 'Claim Processing'
    )`;
  }

  if (view === "label_requests") {
    return `{Fulfillment Status} = 'Requested Label'`;
  }

  if (view === "ready_to_ship") {
    return `{Fulfillment Status} = 'Ready to Ship'`;
  }

  if (view === "shipped") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Ready to Ship',
        {Fulfillment Status} = 'Fulfilled'
      ),
      {Shipping Status} = 'Shipped'
    )`;
  }

  if (view === "fulfilled") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Ready to Ship',
        {Fulfillment Status} = 'Fulfilled'
      ),
      {Shipping Status} = 'Delivered'
    )`;
  }

  return "";
}

app.get("/api/orders", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);
    const view = asText(req.query.view) || "open";
    const search = asText(req.query.search).toLowerCase();

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchantRecord = await airtable(AIRTABLE_MERCHANTS_TABLE).find(merchantId);
    const merchant = normalizeMerchant(merchantRecord);

    const safeStoreName = escapeFormulaValue(merchant.store_name);
    const viewFormula = buildOrderViewFormula(view);

    const formulaParts = [
      `TRIM({Store Name} & '') = '${safeStoreName}'`
    ];

    if (viewFormula) formulaParts.push(viewFormula);

    const records = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE)
      .select({
        filterByFormula: `AND(${formulaParts.join(",")})`,
        sort: [{ field: "Order Date", direction: "desc" }]
      })
      .all();

    let orders = records.map((record) => {
      const f = record.fields;

      return {
        id: record.id,

        order_number: displayValue(f["Shopify Order Number"]),
        product: displayValue(f["Shopify Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        selling_price: moneyValue(f["Shopify Selling Price"]),
        date: dateValue(f["Order Date"]),

        offer: moneyValue(f["Offer To Store"]),
        offer_vat_type: displayValue(f["Offer VAT Type"]),
        eta: displayValue(f["Estimated Time"]),

        allocated_price: moneyValue(f["Final Buying Price"]),
        vat: moneyValue(f["Buying VAT Amount"]),
        invoice_price: moneyValue(f["Invoice Price (VAT Included)"]),
        vat_type: displayValue(f["VAT Type"]),

        fulfillment_status: displayValue(f["Fulfillment Status"]),
        shipping_status: displayValue(f["Shipping Status"]),
        status: getPortalStatus(f, view),

        warehouse_tracking: displayValue(f["GOAT Tracking Number"]),
        tracking_number: displayValue(f["Tracking Number"]),
        tracking_url: displayValue(f["Tracking URL"])
      };
    });

    if (search) {
      orders = orders.filter((order) =>
        Object.values(order).join(" ").toLowerCase().includes(search)
      );
    }

    res.json({
      merchant: {
        id: merchant.id,
        store_name: merchant.store_name
      },
      view,
      count: orders.length,
      orders
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load orders",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Lojiq Merchant Portal running on port ${PORT}`);
});

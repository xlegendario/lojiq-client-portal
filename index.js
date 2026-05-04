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

    let statusFormula = "";

    if (view === "open") {
      statusFormula = `OR({Fulfillment Status} = BLANK(), {Fulfillment Status} = 'Open', {Fulfillment Status} = 'Pending')`;
    }

    if (view === "allocated") {
      statusFormula = `{Fulfillment Status} = 'Allocated'`;
    }

    if (view === "label_requests") {
      statusFormula = `{Fulfillment Status} = 'Label Request'`;
    }

    if (view === "shipped") {
      statusFormula = `{Shipping Status} = 'Shipped'`;
    }

    if (view === "fulfilled") {
      statusFormula = `{Fulfillment Status} = 'Fulfilled'`;
    }

    const formulaParts = [
      `TRIM({Store Name} & '') = '${safeStoreName}'`
    ];

    if (statusFormula) formulaParts.push(statusFormula);

    const records = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE)
      .select({
        filterByFormula: `AND(${formulaParts.join(",")})`,
        sort: [{ field: "Created", direction: "desc" }]
      })
      .all();

    let orders = records.map((record) => {
      const f = record.fields;

      return {
        id: record.id,
        order_number: asText(f["Shopify Order Number"]),
        store_name: asText(f["Store Name"]),
        product_name: asText(f["Product Name"]),
        sku: asText(f["SKU"]),
        size: asText(f["Size"]),
        fulfillment_status: asText(f["Fulfillment Status"]),
        shipping_status: asText(f["Shipping Status"]),
        tracking_number: asText(f["Tracking Number"]),
        shipping_label_url: getFirstAttachmentUrl(f["Shipping Label"]),
        created: asText(f["Created"])
      };
    });

    if (search) {
      orders = orders.filter((order) => {
        return [
          order.order_number,
          order.store_name,
          order.product_name,
          order.sku,
          order.size,
          order.fulfillment_status,
          order.shipping_status,
          order.tracking_number
        ].join(" ").toLowerCase().includes(search);
      });
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
    res.status(500).json({ error: "Failed to load orders", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lojiq Merchant Portal running on port ${PORT}`);
});

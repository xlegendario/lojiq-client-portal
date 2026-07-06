import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import path from "path";
import { fileURLToPath } from "url";
import Airtable from "airtable";
import compression from "compression";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/portal", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "portal.html"));
});

app.get("/reset-password", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reset-password.html"));
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(compression());

const {
  PORT = 3000,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_MERCHANTS_TABLE = "Merchants",
  AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE = "Unfulfilled Orders Log",
  AIRTABLE_RETURNS_TABLE = "Incoming Returns",
  AIRTABLE_INVENTORY_TABLE = "Inventory Units",
  AIRTABLE_SELLERS_TABLE = "Sellers Database",
  AIRTABLE_LABEL_REQUEST_ROUTING_TABLE = "Label Request Routing",
  RETURN_SERVICE_BASE_URL = "https://lojiq-wms.onrender.com",
  SENDGRID_API_KEY,
  APP_PUBLIC_BASE_URL = "https://lojiq-client-portal.onrender.com",
  RESET_EMAIL_FROM,
  KICKZ_PORTAL_BASE_URL = "https://kickzcaviar.com",
  COUNTER_OFFERS_SECRET,
  MOLLIE_API_KEY,
  MOLLIE_MODE = "test",
  MOLLIE_REDIRECT_URL = "https://portal.lojiq.io/portal",
  MOLLIE_WEBHOOK_URL = "https://portal.lojiq.io/api/mollie/webhook",
  AIRTABLE_PAYMENT_BATCHES_TABLE = "Payment Batches"
} = process.env;

if (!AIRTABLE_TOKEN) throw new Error("Missing AIRTABLE_TOKEN");
if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");
if (!SENDGRID_API_KEY) throw new Error("Missing SENDGRID_API_KEY");
if (!RESET_EMAIL_FROM) throw new Error("Missing RESET_EMAIL_FROM");

sgMail.setApiKey(SENDGRID_API_KEY);

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
    portal_enabled: record.fields["Portal Enabled"] === true,
    seller_ids: Array.isArray(record.fields["Seller ID"])
      ? record.fields["Seller ID"]
      : [],
    stockx_account_mode: asText(record.fields["StockX Account Mode"]),
    goat_account_mode: asText(record.fields["GOAT Account Mode"])
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
        portal_email: merchant.portal_email,
        stockx_account_mode: merchant.stockx_account_mode
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

function eurNumber(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function mollieAmount(value) {
  return eurNumber(value).toFixed(2);
}

async function mollieRequest(pathname, options = {}) {
  if (!MOLLIE_API_KEY) {
    throw new Error("Missing MOLLIE_API_KEY");
  }

  const response = await fetch(`https://api.mollie.com/v2${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MOLLIE_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.detail ||
      data.title ||
      data.message ||
      "Mollie request failed"
    );
  }

  return data;
}

function isoNow() {
  return new Date().toISOString();
}

function dateValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return displayValue(value);

  return d.toLocaleDateString("nl-NL");
}

function getAllocatedSupplierShippingStatus(f) {
  const supplierStatus = displayValue(f["Supplier Shipping Status"]);
  if (supplierStatus) return supplierStatus;

  const stockxStatus = displayValue(f["StockX Order Status"]);
  const stockxTrackingUrl = displayValue(f["StockX Tracking URL"]);
  const goatStatus = displayValue(f["GOAT Order Status"]);
  const goatTracking = displayValue(f["GOAT Tracking Number"]);

  const stockxMap = {
    "Order Confirmed": "Order is being prepaired",
    "Seller Preparing Shipment": "Order is being prepaired",
    "Order On Its Way to StockX": "Order is being prepaired",
    "Order Received at StockX for Verification": "Order is being prepaired",
    "Order StockX Verified": stockxTrackingUrl
      ? "Order shipped to Lojiq"
      : "Order is being prepaired",
    "Order Picked Up By Carrier": "Order shipped to Lojiq",
    "Your tracking link will be available after it has shipped.": "Order shipped to Lojiq",
    "Order Delivered!": "Order received by Lojiq"
  };

  const goatMap = {
    "Purchased": "Order is being prepaired",
    "Order Confirmed": "Order is being prepaired",
    "Shipped to GOAT": "Order is packed, waiting shipment to Lojiq",
    "Delivered to GOAT": "Order is packed, waiting shipment to Lojiq",
    "Order Packaged": "Order is packed, waiting shipment to Lojiq",
    "Shipped to You": "Order shipped to Lojiq"
  };

  if (stockxStatus) return stockxMap[stockxStatus] || stockxStatus;

  if (goatStatus === "Verified") {
    return goatTracking
      ? "Order shipped to Lojiq"
      : "Order is packed, waiting shipment to Lojiq";
  }

  if (goatStatus) return goatMap[goatStatus] || goatStatus;

  return "";
}

function getAllocatedTrackingNumber(f) {
  return (
    displayValue(f["StockX Tracking Number"]) ||
    displayValue(f["GOAT Tracking Number"])
  );
}

function linkedRecordIncludes(value, recordId) {
  return Array.isArray(value) && value.includes(recordId);
}

function looksLikeAirtableRecordId(value) {
  return /^rec[a-zA-Z0-9]{14}$/.test(asText(value));
}

async function findSellerRecordBySellerId(sellerIdValue) {
  const safeSellerId = escapeFormulaValue(sellerIdValue);

  const records = await airtable(AIRTABLE_SELLERS_TABLE)
    .select({
      fields: ["Seller ID", "Country Code"],
      filterByFormula: `TRIM({Seller ID} & '') = '${safeSellerId}'`,
      maxRecords: 1
    })
    .firstPage();

  return records[0] || null;
}

async function getSellerRecordFromValue(value) {
  const sellerValue = asText(value);
  if (!sellerValue) return null;

  if (looksLikeAirtableRecordId(sellerValue)) {
    return await airtable(AIRTABLE_SELLERS_TABLE).find(sellerValue);
  }

  return await findSellerRecordBySellerId(sellerValue);
}

async function getPreferredCourierFromOrderFields(fields) {
  const linkedSellerValues = Array.isArray(fields["Linked Seller ID"])
    ? fields["Linked Seller ID"]
    : [];

  const claimedSellerValues = Array.isArray(fields["Claimed Seller ID"])
    ? fields["Claimed Seller ID"]
    : [];

  const sellerValue = linkedSellerValues[0] || claimedSellerValues[0];

  if (!sellerValue) return "";

  const sellerRecord = await getSellerRecordFromValue(sellerValue);
  if (!sellerRecord) return "";
  
  const sellerId = asText(sellerRecord.fields["Seller ID"]);
  
  const forcedNlSellerIds = [
    "SE-00455",
    "SE-00781",
    "SE-00309",
    "SE-00537"
  ];
  
  const countryCode = forcedNlSellerIds.includes(sellerId)
    ? "NL"
    : asText(sellerRecord.fields["Country Code"]);
  
  if (!countryCode) return "";

  const routingRecords = await airtable(AIRTABLE_LABEL_REQUEST_ROUTING_TABLE)
    .select({
      fields: ["Country Code", "Preferred Courier"],
      filterByFormula: `TRIM({Country Code} & '') = '${escapeFormulaValue(countryCode)}'`,
      maxRecords: 1
    })
    .firstPage();

  return routingRecords.length
    ? asText(routingRecords[0].fields["Preferred Courier"])
    : "";
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

function buildOrderViewFormula(view, merchant = {}) {
  if (view === "open") {
    return `OR(
      {Fulfillment Status} = 'Pending',
      {Fulfillment Status} = 'Outsource',
      {Fulfillment Status} = 'Confirmed'
    )`;
  }

  if (view === "offers") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Pending',
        {Fulfillment Status} = 'Outsource'
      ),
      {Offer To Store} != BLANK(),
      OR(
        {Offer Denied?} = 0,
        {Offer Denied?} = BLANK()
      )
    )`;
  }

  if (view === "allocated") {
    const statuses = [
      "Allocated",
      "Awaiting Label",
      "Claim Processing"
    ];
  
    if (merchant.stockx_account_mode !== "DEDICATED_ACCOUNT") {
      statuses.push("StockX Processing");
    }
  
    if (merchant.goat_account_mode !== "DEDICATED_ACCOUNT") {
      statuses.push("GOAT Processing");
    }
  
    return `OR(${statuses
      .map((status) => `{Fulfillment Status} = '${status}'`)
      .join(",")})`;
  }

  if (view === "label_requests") {
    return `{Fulfillment Status} = 'Requested Label'`;
  }

  if (view === "open_payments") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Requested Label',
        {Fulfillment Status} = 'Ready to Ship',
        {Fulfillment Status} = 'Fulfilled'
      ),
      OR(
        {Invoice Status} = 'Pending',
        {Invoice Status} = 'Awaiting Payment'
      )
    )`;
  }
  
  if (view === "payment_history") {
    return `OR(
      {Invoice Status} = 'Paid',
      {Invoice Status} = 'Expired',
      {Invoice Status} = 'Cancelled'
    )`;
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

  if (view === "issues") {
    return `NOT({Issue Status} = BLANK())`;
  }

  if (view === "stockx_active_bids") {
    return `AND(
      {Fulfillment Status} = 'Outsource',
      OR(
        {LastAction} = 'BID_IN_PROGRESS',
        {LastAction} = 'BID_CREATED',
        {LastAction} = 'BID_VERIFIED_STILL_LIVE',
        {LastAction} = 'BID_UPDATED'
      )
    )`;
  }

  if (view === "stockx_active_second_bids") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Found',
        {Fulfillment Status} = 'StockX Processing'
      ),
      {Second Bid Flow Status} = 'SECOND_BID_PLACED'
    )`;
  }

  if (view === "stockx_orders") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Found',
        {Fulfillment Status} = 'StockX Processing'
      ),
      OR(
        {LastAction} = 'ORDER_PLACED',
        {LastAction} = 'FIRST_ORDER_PLACED'
      )
    )`;
  }

  if (view === "stockx_second_orders") {
    return `AND(
      OR(
        {Fulfillment Status} = 'Found',
        {Fulfillment Status} = 'StockX Processing'
      ),
      {SecondLastAction} = 'SECOND_ORDER_PLACED'
    )`;
  }

  return "";
}

const ORDER_FIELDS = [
  "Shopify Order Number",
  "Shopify Product Name",
  "SKU",
  "Size",
  "Brand",
  "Selling Price",
  "Order Date",
  "Offer To Store",
  "Offer Sent At",
  "Offer VAT Type",
  "Estimated Time",
  "Final Buying Price",
  "Buying VAT Amount",
  "Invoice Price (VAT Included)",
  "VAT Type",
  "Client Country",
  "Fulfillment Status",
  "Shipping Status",
  "GOAT Tracking Number",
  "Tracking Number",
  "Tracking URL"
];

const merchantCache = new Map();
const countsCache = new Map();
const ordersCache = new Map();

const CACHE_TTL_MS = 60 * 1000;
const ORDERS_CACHE_TTL_MS = 15 * 1000;

async function getCachedMerchant(merchantId) {
  const cached = merchantCache.get(merchantId);

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.merchant;
  }

  const merchantRecord = await airtable(AIRTABLE_MERCHANTS_TABLE).find(merchantId);
  const merchant = normalizeMerchant(merchantRecord);

  merchantCache.set(merchantId, {
    createdAt: Date.now(),
    merchant
  });

  return merchant;
}

app.get("/api/orders", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);
    const view = asText(req.query.view) || "open";
    const search = asText(req.query.search).toLowerCase();
    const pageSize = Math.min(Number(req.query.page_size || 20), 50);
    const offset = asText(req.query.offset);

    const cacheKey = [
      merchantId,
      view,
      search,
      pageSize,
      offset
    ].join("::");
    
    const cachedOrders = ordersCache.get(cacheKey);
    
    if (cachedOrders && Date.now() - cachedOrders.createdAt < ORDERS_CACHE_TTL_MS) {
      return res.json(cachedOrders.data);
    }

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    const safeStoreName = escapeFormulaValue(merchant.store_name);
    const viewFormula = buildOrderViewFormula(view, merchant);

    const formulaParts = [
      `TRIM({Store Name} & '') = '${safeStoreName}'`
    ];

    if (viewFormula) formulaParts.push(viewFormula);

    const airtableUrl = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE)}`
    );
    
    airtableUrl.searchParams.set("filterByFormula", `AND(${formulaParts.join(",")})`);
    airtableUrl.searchParams.set("pageSize", String(pageSize));
    airtableUrl.searchParams.set("sort[0][field]", "Order Date");
    airtableUrl.searchParams.set("sort[0][direction]", "desc");
    
    if (offset) {
      airtableUrl.searchParams.set("offset", offset);
    }

    // Disabled because Airtable rejects Issue Status in fields[].
    // We fetch all fields and still map only what we need below.
    // ORDER_FIELDS.forEach((field, index) => {
    //   airtableUrl.searchParams.set(`fields[${index}]`, field);
    // });
        
    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });
    
    const airtableData = await airtableResponse.json();
    
    if (!airtableResponse.ok) {
      console.error("Airtable status:", airtableResponse.status);
      console.error("Airtable request URL:", airtableUrl.toString());
      console.error("Airtable error body:", JSON.stringify(airtableData, null, 2));
    
      throw new Error(
        airtableData?.error?.message ||
        airtableData?.error?.type ||
        "Airtable request failed"
      );
    }
    
    const records = airtableData.records || [];
    const nextOffset = airtableData.offset || "";

    let orders = await Promise.all(records.map(async (record) => {
      const f = record.fields;
    
      const preferredCourier =
        view === "label_requests"
          ? await getPreferredCourierFromOrderFields(f)
          : "";
    
      return {
        id: record.id,

        order_number: displayValue(f["Shopify Order Number"]),
        product: displayValue(f["Shopify Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        selling_price: moneyValue(f["Selling Price"]),
        active_bid: moneyValue(f["CurrentBid"]),
        second_active_bid: moneyValue(f["SecondCurrentBid"]),
        buying_price: moneyValue(f["Final StockX Price"]),
        order_status: displayValue(f["StockX Order Status"]),
        second_buying_price: moneyValue(f["Second Final StockX Price"]),
        second_extra_profit: moneyValue(f["Second Extra Profit"]),
        second_stockx_order_number: displayValue(f["Second StockX Order Number"]),
        second_order_status: displayValue(f["Second StockX Order Status"]),
        date: dateValue(f["Order Date"]),

        offer: moneyValue(f["Offer To Store"]),
        offer_date: dateValue(f["Offer Sent At"]),
        offer_vat_type: displayValue(f["Offer VAT Type"]),
        eta: displayValue(f["Estimated Time"]),

        allocated_price: moneyValue(f["Final Buying Price"]),
        vat: moneyValue(f["Buying VAT Amount"]),
        invoice_price: moneyValue(f["Invoice Price (VAT Included)"]),
        invoice_status: displayValue(f["Invoice Status"]),
        payment_link: displayValue(f["Payment Link"]),
        mollie_payment_id: displayValue(f["Mollie Payment ID"]),
        paid_at: dateValue(f["Paid At"]),
        vat_type: (() => {
          const originalVat = displayValue(f["VAT Type"]);
          const country = displayValue(f["Client Country"]).toLowerCase();
        
          if (originalVat === "Margin") {
            return "Margin";
          }
        
          return country === "netherlands"
            ? "VAT21"
            : "VAT0";
        })(),

        fulfillment_status: displayValue(f["Fulfillment Status"]),
        shipping_status: displayValue(f["Shipping Status"]),
        status: getPortalStatus(f, view),
        preferred_courier: preferredCourier,

        supplier_shipping_status: getAllocatedSupplierShippingStatus(f),
        warehouse_tracking: getAllocatedTrackingNumber(f),
        tracking_number:
          view === "stockx_orders"
            ? displayValue(f["StockX Tracking Number"])
            : view === "stockx_second_orders"
              ? displayValue(f["Second StockX Tracking Number"])
              : displayValue(f["Tracking Number"]),
        
        tracking_url:
          view === "stockx_orders"
            ? displayValue(f["StockX Tracking URL"])
            : view === "stockx_second_orders"
              ? displayValue(f["Second StockX Tracking URL"])
              : displayValue(f["Tracking URL"]),
        issue_status: displayValue(f["Issue Status"]),
        issue_notes: displayValue(f["Issue Notes"])
      };
    }));

    if (search) {
      orders = orders.filter((order) =>
        Object.values(order).join(" ").toLowerCase().includes(search)
      );
    }

    const responseData = {
      merchant: {
        id: merchant.id,
        store_name: merchant.store_name
      },
      view,
      count: orders.length,
      next_offset: nextOffset,
      has_more: !!nextOffset,
      orders
    };
    
    ordersCache.set(cacheKey, {
      createdAt: Date.now(),
      data: responseData
    });
    
    res.json(responseData);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load orders",
      details: err.message
    });
  }
});

app.get("/api/orders/counts", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const cacheKey = `counts:${merchantId}`;
    const cached = countsCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const merchant = await getCachedMerchant(merchantId);
    const safeStoreName = escapeFormulaValue(merchant.store_name);

    const views = [
      "open",
      "offers",
      "allocated",
      "label_requests",
      "open_payments",
      "payment_history",
      "ready_to_ship",
      "shipped",
      "fulfilled",
      "issues",
      "returns",
      "inventory",
      "stockx_active_bids",
      "stockx_active_second_bids",
      "stockx_orders",
      "stockx_second_orders"
    ];

    const counts = {};

    await Promise.all(
      views.map(async (view) => {
    
        if (view === "returns") {
          const records = await airtable(AIRTABLE_RETURNS_TABLE)
            .select({
              fields: ["Shopify Order Number", "Client"]
            })
            .all();
    
          counts[view] = records.filter((record) =>
            linkedRecordIncludes(record.fields["Client"], merchantId)
          ).length;
    
          return;
        }
    
        if (view === "inventory") {
          const sellerIds = merchant.seller_ids || [];
        
          if (!sellerIds.length) {
            counts[view] = 0;
            return;
          }
        
          const sellerFormula = `OR(${sellerIds
            .map((sellerId) => `FIND('${escapeFormulaValue(sellerId)}', ARRAYJOIN({Seller Record ID}))`)
            .join(",")})`;
        
          const records = await airtable(AIRTABLE_INVENTORY_TABLE)
            .select({
              fields: ["Product Name"],
              filterByFormula: sellerFormula
            })
            .all();
        
          counts[view] = records.length;
        
          return;
        }
        
        const viewFormula = buildOrderViewFormula(view, merchant);
        
        const formulaParts = [
          `TRIM({Store Name} & '') = '${safeStoreName}'`
        ];
        
        if (viewFormula) formulaParts.push(viewFormula);
        
        const records = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE)
          .select({
            fields: ["Shopify Order Number"],
            filterByFormula: `AND(${formulaParts.join(",")})`
          })
          .all();
        
        counts[view] = records.length;
      })
    );

    const data = { counts };

    countsCache.set(cacheKey, {
      createdAt: Date.now(),
      data
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load counts",
      details: err.message
    });
  }
});

app.get("/api/returns", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);
    const search = asText(req.query.search).toLowerCase();
    const pageSize = Math.min(Number(req.query.page_size || 20), 50);
    const offset = asText(req.query.offset);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const safeStoreName = escapeFormulaValue(merchant.store_name);

    const airtableUrl = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_RETURNS_TABLE)}`
    );

    airtableUrl.searchParams.set(
      "filterByFormula",
      `TRIM({Store Name} & '') = '${safeStoreName}'`
    );
    airtableUrl.searchParams.set("pageSize", String(pageSize));
    airtableUrl.searchParams.set("sort[0][field]", "Created At");
    airtableUrl.searchParams.set("sort[0][direction]", "desc");

    if (offset) {
      airtableUrl.searchParams.set("offset", offset);
    }

    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    const airtableData = await airtableResponse.json();

    if (!airtableResponse.ok) {
      throw new Error(
        airtableData?.error?.message ||
        airtableData?.error?.type ||
        "Airtable request failed"
      );
    }

    const records = airtableData.records || [];
    const nextOffset = airtableData.offset || "";

    let returns = records
      .filter((record) => linkedRecordIncludes(record.fields["Client"], merchantId))
      .map((record) => {
        const f = record.fields || {};

        return {
          id: record.id,
          order_number: displayValue(f["Shopify Order Number"]),
          product: displayValue(f["Product Name"]),
          sku: displayValue(f["SKU"]),
          size: displayValue(f["Size"]),
          return_created: dateValue(f["Created At"]),
          status: displayValue(f["Return Status"]),
          verified_at: dateValue(f["Verified At"]),
          packing_slip_url: displayValue(f["Packing Slip URL"]),
          tracking_number: displayValue(f["Tracking Number"]),
          tracking_url: displayValue(f["Tracking URL"]),
          condition: displayValue(f["Condition"]),
          qc_notes: displayValue(f["QC Notes"])
        };
      });

    if (search) {
      returns = returns.filter((item) =>
        Object.values(item).join(" ").toLowerCase().includes(search)
      );
    }

    res.json({
      merchant: {
        id: merchant.id,
        store_name: merchant.store_name
      },
      view: "returns",
      count: returns.length,
      next_offset: nextOffset,
      has_more: !!nextOffset,
      orders: returns
    });
  } catch (err) {
    console.error("Failed to load returns:", err);

    res.status(500).json({
      error: "Failed to load returns",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/cancel", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);

    if (!recordId) {
      return res.status(400).json({ error: "Missing recordId" });
    }

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    const orderStoreName = displayValue(order.fields["Store Name"]);
    const currentStatus = displayValue(order.fields["Fulfillment Status"]);

    if (orderStoreName !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    const lockedStatuses = new Set([
      "Allocated",
      "Awaiting Label",
      "Requested Label",
      "Ready To Ship",
      "Ready to Ship",
      "Fulfilled",
      "GOAT Processing",
      "StockX Processing",
      "Claim Processing"
    ]);

    if (lockedStatuses.has(currentStatus)) {
      return res.status(409).json({
        error: "This order can no longer be cancelled",
        current_status: currentStatus
      });
    }

    await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
      "Fulfillment Status": "Store Fulfilled"
    });

    countsCache.delete(`counts:${merchantId}`);
    ordersCache.clear();

    res.json({
      ok: true,
      record_id: recordId,
      fulfillment_status: "Store Fulfilled"
    });
  } catch (err) {
    console.error("Cancel order failed:", err);

    res.status(500).json({
      error: "Failed to cancel order",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/remove-second-bid", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);

    if (!recordId) {
      return res.status(400).json({ error: "Missing recordId" });
    }

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    const orderStoreName = displayValue(order.fields["Store Name"]);

    if (orderStoreName !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
      "Remove Second Bid?": true
    });

    countsCache.delete(`counts:${merchantId}`);
    ordersCache.clear();

    res.json({
      ok: true,
      record_id: recordId
    });
  } catch (err) {
    console.error("Remove second bid failed:", err);

    res.status(500).json({
      error: "Failed to remove second bid",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/offer", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const action = asText(req.body.action).toLowerCase();

    if (!recordId) {
      return res.status(400).json({ error: "Missing recordId" });
    }

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    if (!["accept", "deny"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    const orderStoreName = displayValue(order.fields["Store Name"]);

    if (orderStoreName !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    if (action === "accept") {
      await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
        "Offer Accepted?": true,
        "Offer Denied?": false,
        "Fulfillment Status": "Confirmed"
      });
    }

    if (action === "deny") {
      const offerText = displayValue(order.fields["Offer To Store"]);

      await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
        "Offer Denied?": true,
        "Offer Notes": offerText
          ? `❌ Store Denied offer ${offerText}`
          : "❌ Store Denied offer"
      });
    }

    countsCache.delete(`counts:${merchantId}`);
    ordersCache.clear();

    res.json({
      ok: true,
      record_id: recordId,
      action
    });
  } catch (err) {
    console.error("Offer action failed:", err);

    res.status(500).json({
      error: "Failed to process offer action",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/counter-offer", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const storeCounterPrice = Number(req.body.store_counter_price);

    if (!recordId) return res.status(400).json({ error: "Missing recordId" });
    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });

    if (!Number.isFinite(storeCounterPrice) || storeCounterPrice <= 0) {
      return res.status(400).json({ error: "Invalid counter offer price" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    if (displayValue(order.fields["Store Name"]) !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    if (!COUNTER_OFFERS_SECRET) {
      return res.status(500).json({ error: "Missing COUNTER_OFFERS_SECRET" });
    }

    const response = await fetch(`${KICKZ_PORTAL_BASE_URL}/api/counter-offers/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": COUNTER_OFFERS_SECRET
      },
      body: JSON.stringify({
        order_record_id: recordId,
        store_counter_price: storeCounterPrice
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to create counter offers");
    }

    ordersCache.clear();
    countsCache.delete(`counts:${merchantId}`);

    res.json({
      ok: true,
      ...data
    });
  } catch (err) {
    console.error("Counter offer failed:", err);
    res.status(500).json({
      error: "Failed to submit counter offer",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/return", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    if (displayValue(order.fields["Store Name"]) !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    const response = await fetch(`${RETURN_SERVICE_BASE_URL}/create-return`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_record_id: recordId,
        vat_type: displayValue(order.fields["VAT Type"]) || undefined
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Return creation failed");
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create return", details: err.message });
  }
});

app.get("/api/inventory", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);
    const search = asText(req.query.search).toLowerCase();
    const pageSize = Math.min(Number(req.query.page_size || 20), 50);
    const offset = asText(req.query.offset);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const sellerIds = merchant.seller_ids || [];

    if (!sellerIds.length) {
      return res.json({
        merchant: { id: merchant.id, store_name: merchant.store_name },
        view: "inventory",
        count: 0,
        next_offset: "",
        has_more: false,
        orders: []
      });
    }

    const sellerFormula = `OR(${sellerIds
      .map((sellerId) => `FIND('${escapeFormulaValue(sellerId)}', ARRAYJOIN({Seller Record ID}))`)
      .join(",")})`;

    const airtableUrl = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_INVENTORY_TABLE)}`
    );

    airtableUrl.searchParams.set("filterByFormula", sellerFormula);
    airtableUrl.searchParams.set("pageSize", String(pageSize));

    if (offset) {
      airtableUrl.searchParams.set("offset", offset);
    }

    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    const airtableData = await airtableResponse.json();

    if (!airtableResponse.ok) {
      throw new Error(
        airtableData?.error?.message ||
        airtableData?.error?.type ||
        "Airtable request failed"
      );
    }

    const records = airtableData.records || [];
    const nextOffset = airtableData.offset || "";

    let inventory = records.map((record) => {
      const f = record.fields || {};

      return {
        id: record.id,
        product: displayValue(f["Product Name"]),
        sku: displayValue(f["SKU"]),
        size: displayValue(f["Size"]),
        brand: displayValue(f["Brand"]),
        listed_at: dateValue(f["Created Time"]),
        selling_price: moneyValue(f["Purchase Price"]),
        vat_type: displayValue(f["VAT Type"]),
        status: displayValue(f["Availability Status"])
      };
    });

    if (search) {
      inventory = inventory.filter((item) =>
        Object.values(item).join(" ").toLowerCase().includes(search)
      );
    }

    res.json({
      merchant: { id: merchant.id, store_name: merchant.store_name },
      view: "inventory",
      count: inventory.length,
      next_offset: nextOffset,
      has_more: !!nextOffset,
      orders: inventory
    });
  } catch (err) {
    console.error("Failed to load inventory:", err);

    res.status(500).json({
      error: "Failed to load inventory",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/issue", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const issueNotes = asText(req.body.issue_notes);

    if (!issueNotes) {
      return res.status(400).json({ error: "Issue notes are required" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    if (displayValue(order.fields["Store Name"]) !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
      "Issue Status": "Troubled",
      "Issue Notes": issueNotes
    });

    countsCache.delete(`counts:${merchantId}`);
    ordersCache.clear();

    res.json({ ok: true });
  } catch (err) {
    console.error("Report issue failed:", err);
  
    res.status(500).json({
      error: "Failed to report issue",
      details: err.message
    });
  }
});

app.post("/api/orders/:recordId/solve-issue", async (req, res) => {
  try {
    const recordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);

    const merchant = await getCachedMerchant(merchantId);
    const order = await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(recordId);

    if (displayValue(order.fields["Store Name"]) !== merchant.store_name) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    await airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(recordId, {
      "Issue Status": "Solved"
    });

    countsCache.delete(`counts:${merchantId}`);
    ordersCache.clear();

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to solve issue", details: err.message });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    const email = asText(req.body.email).toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const records = await airtable(AIRTABLE_MERCHANTS_TABLE)
      .select({
        filterByFormula: `LOWER(TRIM({Portal Email} & '')) = '${escapeFormulaValue(email)}'`,
        maxRecords: 1
      })
      .firstPage();

    // Altijd ok teruggeven, zodat niemand emails kan raden.
    if (!records.length) {
      return res.json({ ok: true });
    }

    const merchant = records[0];

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await airtable(AIRTABLE_MERCHANTS_TABLE).update(merchant.id, {
      "Password Reset Token": token,
      "Password Reset Expires At": expiresAt
    });

    const resetUrl = `${APP_PUBLIC_BASE_URL}/reset-password?token=${token}`;

    await sgMail.send({
      to: email,
      from: RESET_EMAIL_FROM,
      subject: "Reset your Lojiq Merchant Portal password",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
          <h2>Reset your password</h2>

          <p>Click the button below to reset your Lojiq Merchant Portal password.</p>

          <p>
            <a href="${resetUrl}"
               style="
                 background:#2F80ED;
                 color:white;
                 padding:12px 18px;
                 border-radius:8px;
                 text-decoration:none;
                 font-weight:bold;
                 display:inline-block;
               ">
              Reset password
            </a>
          </p>

          <p>This link expires in 1 hour.</p>

          <p style="color:#6B7280;font-size:13px;">
            If you did not request this, you can ignore this email.
          </p>
        </div>
      `
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Forgot password failed:", err);

    res.status(500).json({
      error: "Failed to send reset email",
      details: err.message
    });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const token = asText(req.body.token);
    const password = asText(req.body.password);
    const passwordConfirm = asText(req.body.password_confirm);

    if (!token) {
      return res.status(400).json({ error: "Missing reset token" });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters"
      });
    }

    if (password !== passwordConfirm) {
      return res.status(400).json({
        error: "Passwords do not match"
      });
    }

    const records = await airtable(AIRTABLE_MERCHANTS_TABLE)
      .select({
        filterByFormula: `{Password Reset Token} = '${escapeFormulaValue(token)}'`,
        maxRecords: 1
      })
      .firstPage();

    if (!records.length) {
      return res.status(400).json({
        error: "Invalid or expired reset link"
      });
    }

    const merchant = records[0];
    const expiresAtRaw = merchant.fields["Password Reset Expires At"];

    if (!expiresAtRaw) {
      return res.status(400).json({
        error: "Invalid or expired reset link"
      });
    }

    const expiresAt = new Date(expiresAtRaw);

    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        error: "Reset link expired"
      });
    }

    await airtable(AIRTABLE_MERCHANTS_TABLE).update(merchant.id, {
      "Portal Password": password,
      "Password Reset Token": "",
      "Password Reset Expires At": null
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Reset password failed:", err);

    res.status(500).json({
      error: "Failed to reset password",
      details: err.message
    });
  }
});

app.post("/api/payments/create-link", async (req, res) => {
  try {
    const merchantId = asText(req.body.merchant_id);
    const orderIds = Array.isArray(req.body.order_ids)
      ? req.body.order_ids.map(asText).filter(Boolean)
      : [];

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    if (!orderIds.length) {
      return res.status(400).json({ error: "Select at least one order" });
    }

    const merchant = await getCachedMerchant(merchantId);

    const orders = await Promise.all(
      orderIds.map((orderId) =>
        airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).find(orderId)
      )
    );

    for (const order of orders) {
      const orderStoreName = displayValue(order.fields["Store Name"]);
      const fulfillmentStatus = displayValue(order.fields["Fulfillment Status"]);
      const invoiceStatus = displayValue(order.fields["Invoice Status"]);

      if (orderStoreName !== merchant.store_name) {
        return res.status(403).json({ error: "Not allowed for this merchant" });
      }

      const payableStatuses = new Set([
        "Requested Label",
        "Ready to Ship",
        "Fulfilled"
      ]);
      
      if (!payableStatuses.has(fulfillmentStatus)) {
        return res.status(400).json({
          error: "Only orders from Requested Label onward can be paid"
        });
      }

      if (invoiceStatus === "Paid") {
        return res.status(400).json({
          error: "One of the selected orders is already paid"
        });
      }

      if (invoiceStatus === "Awaiting Payment") {
        return res.status(400).json({
          error: "One of the selected orders already has a payment link"
        });
      }

      if (invoiceStatus === "Expired" || invoiceStatus === "Cancelled") {
        return res.status(400).json({
          error: "One of the selected orders cannot be paid from the portal"
        });
      }
    }

    const total = orders.reduce((sum, order) => {
      return sum + eurNumber(order.fields["Invoice Price (VAT Included)"]);
    }, 0);

    if (total <= 0) {
      return res.status(400).json({ error: "Total amount is invalid" });
    }

    const orderNumbers = orders
      .map((order) => displayValue(order.fields["Shopify Order Number"]))
      .filter(Boolean);

    const batchId = `PB-${Date.now()}`;

    const batch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).create({
      "Store": [merchantId],
      "Linked Orders": orderIds,
      "Order Numbers": orderNumbers.join(", "),
      "Amount": total,
      "Payment Status": "Pending",
      "Payment Provider": "Mollie"
    });

    const payment = await mollieRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: {
          currency: "EUR",
          value: mollieAmount(total)
        },
        description: `Lojiq orders ${orderNumbers.join(", ")}`,
        redirectUrl: MOLLIE_REDIRECT_URL,
        webhookUrl: MOLLIE_WEBHOOK_URL,
        metadata: {
          batch_record_id: batch.id,
          batch_id: batchId,
          merchant_id: merchantId,
          order_ids: orderIds,
          order_numbers: orderNumbers
        }
      })
    });

    const paymentUrl = payment?._links?.checkout?.href || "";

    if (!paymentUrl) {
      throw new Error("Mollie did not return a checkout URL");
    }

    await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).update(batch.id, {
      "Payment Status": "Awaiting Payment",
      "Payment Link": paymentUrl,
      "Mollie Payment ID": payment.id
    });

    await Promise.all(
      orderIds.map((orderId) =>
        airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(orderId, {
          "Invoice Status": "Awaiting Payment",
          "Payment Link": paymentUrl,
          "Mollie Payment ID": payment.id,
          "Payment Batches": [batch.id]
        })
      )
    );

    ordersCache.clear();
    countsCache.delete(`counts:${merchantId}`);

    res.json({
      ok: true,
      payment_url: paymentUrl,
      mollie_payment_id: payment.id,
      batch_id: batchId,
      batch_record_id: batch.id,
      total
    });
  } catch (err) {
    console.error("Create Mollie payment failed:", err);

    res.status(500).json({
      error: "Failed to create payment link",
      details: err.message
    });
  }
});

app.post("/api/mollie/webhook", async (req, res) => {
  try {
    const paymentId = asText(req.body.id);

    if (!paymentId) {
      return res.status(400).send("Missing payment id");
    }

    const payment = await mollieRequest(`/payments/${encodeURIComponent(paymentId)}`);

    const metadata = payment.metadata || {};
    const batchRecordId = asText(metadata.batch_record_id);
    const orderIds = Array.isArray(metadata.order_ids) ? metadata.order_ids : [];

    if (!batchRecordId || !orderIds.length) {
      console.error("Mollie webhook missing metadata:", paymentId, metadata);
      return res.status(200).send("ok");
    }

    if (payment.status !== "paid") {
      return res.status(200).send("ok");
    }

    const paidAt = isoNow();

    await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).update(batchRecordId, {
      "Payment Status": "Paid",
      "Paid At": paidAt,
      "Mollie Payment ID": payment.id
    });

    await Promise.all(
      orderIds.map((orderId) =>
        airtable(AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE).update(orderId, {
          "Invoice Status": "Paid",
          "Paid At": paidAt,
          "Mollie Payment ID": payment.id
        })
      )
    );

    ordersCache.clear();
    countsCache.clear();

    res.status(200).send("ok");
  } catch (err) {
    console.error("Mollie webhook failed:", err);
    res.status(500).send("webhook failed");
  }
});

app.listen(PORT, () => {
  console.log(`Lojiq Merchant Portal running on port ${PORT}`);
});

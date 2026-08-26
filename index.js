import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import path from "path";
import { fileURLToPath } from "url";
import Airtable from "airtable";
import compression from "compression";
import cron from "node-cron";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/portal", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "portal.html"));
});

app.get("/shop", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "shop.html"));
});

app.get("/payment-summary", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "payment-summary.html"));
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
  MOLLIE_REPORTING_TOKEN,
  MOLLIE_PROFILE_ID,
  ADMIN_SYNC_SECRET,
  MOLLIE_MODE = "test",
  MOLLIE_REDIRECT_URL = "https://portal.lojiq.io/portal",
  MOLLIE_WEBHOOK_URL = "https://portal.lojiq.io/api/mollie/webhook",
  AIRTABLE_PAYMENT_BATCHES_TABLE = "Payment Batches",
  AIRTABLE_MEMBER_WTBS_TABLE = "Member WTBs"
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
    goat_account_mode: asText(record.fields["GOAT Account Mode"]),

    // NEW - where this store's demand comes from. Blank means API,
    // which is every merchant that exists today, so nothing changes
    // for them until the field is set.
    // NEW - "both" joins "api" and "manual": a store on the integration can
    // still have orders that never touch it, and posting those by hand is
    // the whole point of the manual side. Blank stays "api", which is every
    // merchant that existed before this field.
    order_intake: (() => {
      const raw = asText(record.fields["Order Intake"]).trim().toLowerCase();

      if (raw === "manual") return "manual";
      if (raw === "both") return "both";

      return "api";
    })()
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
        stockx_account_mode: merchant.stockx_account_mode,

        // NEW - the sidebar hides what a manual store has no data for.
        order_intake: merchant.order_intake
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

async function mollieReportingRequest(pathname, options = {}) {
  if (!MOLLIE_REPORTING_TOKEN) {
    throw new Error("Missing MOLLIE_REPORTING_TOKEN");
  }

  const response = await fetch(`https://api.mollie.com/v2${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MOLLIE_REPORTING_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.detail ||
      data.title ||
      data.message ||
      `Mollie reporting request failed with status ${response.status}`
    );

    error.statusCode = response.status;
    error.mollieResponse = data;

    throw error;
  }

  return data;
}

function requireAdminSyncSecret(req, res, next) {
  if (!ADMIN_SYNC_SECRET) {
    return res.status(500).json({
      error: "Missing ADMIN_SYNC_SECRET"
    });
  }

  const authorization = asText(req.headers.authorization);
  const expected = `Bearer ${ADMIN_SYNC_SECRET}`;

  if (authorization !== expected) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function mollieEmbeddedItems(data, key) {
  const items = data?._embedded?.[key];
  return Array.isArray(items) ? items : [];
}

function amountNumber(amountObject) {
  const value =
    amountObject && typeof amountObject === "object"
      ? amountObject.value
      : amountObject;

  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function rawAmountNumber(amountObject) {
  const value =
    amountObject && typeof amountObject === "object"
      ? amountObject.value
      : amountObject;

  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function firstMollieDate(...values) {
  for (const value of values) {
    if (!value) continue;

    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return "";
}

async function listAllSettlementPayments(settlementId) {
  const payments = [];
  let from = "";

  do {
    const params = new URLSearchParams({
      limit: "250",
      sort: "asc"
    });

    if (from) {
      params.set("from", from);
    }

    if (MOLLIE_PROFILE_ID) {
      params.set("profileId", MOLLIE_PROFILE_ID);
    }

    const data = await mollieReportingRequest(
      `/settlements/${encodeURIComponent(settlementId)}/payments?${params.toString()}`
    );

    const pagePayments = mollieEmbeddedItems(data, "payments");
    payments.push(...pagePayments);

    const nextHref = data?._links?.next?.href || "";

    if (!nextHref || pagePayments.length === 0) {
      from = "";
      continue;
    }

    const nextUrl = new URL(nextHref);
    const nextFrom = nextUrl.searchParams.get("from") || "";

    from = nextFrom && nextFrom !== from ? nextFrom : "";
  } while (from);

  return payments;
}

async function loadPaymentBatchIndex() {
  const records = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE)
    .select({
      fields: [
        "Batch ID",
        "Amount",
        "Mollie Payment ID",
        "Payment Status",
        "Order Numbers",
        "Settlement ID",
        "Settlement Status",
        "Settlement Reference",
        "Mollie Settlement Synced At"
      ]
    })
    .all();

  const byMolliePaymentId = new Map();

  for (const record of records) {
    const molliePaymentId = displayValue(
      record.fields["Mollie Payment ID"]
    );

    if (!molliePaymentId) continue;

    byMolliePaymentId.set(molliePaymentId, {
      record_id: record.id,
      batch_id:
        displayValue(record.fields["Batch ID"]) ||
        record.id,
      amount: eurNumber(record.fields["Amount"]),
      payment_status: displayValue(
        record.fields["Payment Status"]
      ),
      order_numbers: displayValue(
        record.fields["Order Numbers"]
      ),
      current_settlement_id: displayValue(
        record.fields["Settlement ID"]
      ),
      current_settlement_status: displayValue(
        record.fields["Settlement Status"]
      ),
      current_settlement_reference: displayValue(
        record.fields["Settlement Reference"]
      ),
      settlement_synced_at: displayValue(
        record.fields["Mollie Settlement Synced At"]
      )
    });
  }

  return byMolliePaymentId;
}

function normalizeSettlementPreview(settlement) {
  const status = asText(settlement?.status);

  const settlementStatus =
    status === "paidout" || status === "paid"
      ? "Paid"
      : "Pending";

  const netAmount = amountNumber(settlement?.amount);

  return {
    id: asText(settlement?.id),
    reference: asText(settlement?.reference),
    mollie_status: status,
    airtable_status: settlementStatus,
    currency:
      asText(settlement?.amount?.currency) ||
      "EUR",
    net_amount: netAmount,
    created_at: firstMollieDate(
      settlement?.createdAt
    ),
    settled_at: firstMollieDate(
      settlement?.settledAt,
      settlement?.paidOutAt
    ),
    payout_date: firstMollieDate(
      settlement?.paidOutAt,
      settlement?.settledAt
    )
  };
}

function getSettlementFinancialSummary(settlement) {
  let grossAmount = 0;
  let feeAmount = 0;
  let invoiceReference = "";

  const periods = settlement?.periods;

  if (!periods || typeof periods !== "object" || Array.isArray(periods)) {
    return {
      grossAmount: 0,
      feeAmount: 0,
      netAmount: amountNumber(settlement?.amount),
      invoiceReference: ""
    };
  }

  for (const yearData of Object.values(periods)) {
    if (!yearData || typeof yearData !== "object") continue;

    for (const monthData of Object.values(yearData)) {
      if (!monthData || typeof monthData !== "object") continue;

      const revenueRows = Array.isArray(monthData.revenue)
        ? monthData.revenue
        : [];

      const costRows = Array.isArray(monthData.costs)
        ? monthData.costs
        : [];

      for (const revenue of revenueRows) {
        grossAmount += rawAmountNumber(
          revenue?.amountGross || revenue?.amountNet
        );
      }

      for (const cost of costRows) {
        feeAmount += rawAmountNumber(
          cost?.amountGross || cost?.amountNet
        );
      }

      if (!invoiceReference && monthData.invoiceReference) {
        invoiceReference = asText(monthData.invoiceReference);
      }
    }
  }

  return {
    grossAmount: Math.round(grossAmount * 100) / 100,
    feeAmount: Math.round(feeAmount * 100) / 100,
    netAmount: amountNumber(settlement?.amount),
    invoiceReference
  };
}

function mapSettlementStatus(statusValue) {
  const status = asText(statusValue).toLowerCase();

  if (status === "paidout" || status === "paid") {
    return "Paid";
  }

  if (
    status === "failed" ||
    status === "failure"
  ) {
    return "Failed";
  }

  if (
    status === "cancelled" ||
    status === "canceled"
  ) {
    return "Cancelled";
  }

  return "Pending";
}

function chunkArray(items, size = 10) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function isoNow() {
  return new Date().toISOString();
}

function normalizePaymentBatch(record) {
  const f = record.fields || {};

  return {
    id: record.id,
    batch_id: displayValue(f["Batch ID"]) || record.id,
    store: displayValue(f["Store"]),
    linked_orders: Array.isArray(f["Linked Orders"]) ? f["Linked Orders"] : [],
    order_numbers: displayValue(f["Order Numbers"]),
    amount: moneyValue(f["Amount"]),
    payment_link: displayValue(f["Payment Link"]),
    mollie_payment_id: displayValue(f["Mollie Payment ID"]),
    payment_status: displayValue(f["Payment Status"]),
    payment_provider: displayValue(f["Payment Provider"]),
    created_at: dateValue(f["Created At"]),
    paid_at: dateValue(f["Paid At"])
  };
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

  // NEW - the Processing tab holds four different statuses, and which one
  // an order carries says nothing useful to a store: Confirmed, Claim
  // Processing, StockX Processing and GOAT Processing all mean the same
  // thing from their side - we are getting it. One word beats four that
  // need explaining.
  if (view === "processing") {
    return "Deal Processing";
  }

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

// =====================================================================
// Manual order intake - Member WTBs as a second source
//
// A store with an API gets its demand into Unfulfilled Orders Log. A store
// without one puts it there by hand, through a WTB or a Buy/Offer, and that
// same demand lands in Member WTBs instead.
//
// It is the same trade either way: we source it, we make an offer, it gets
// allocated, it ships. So the portal should not grow a second set of tabs -
// it should read a different table and hand the front-end the same rows.
//
// The two tables already speak the same language. Fulfillment Status,
// Shipping Status and Payment Status carry the same values, and where the
// order log has "Offer To Store", Member WTBs has "Offer To Buyer". The
// mapper below is therefore mostly a rename, not a translation.
//
// Member WTBs has no StockX or GOAT statuses and no Issue Status, so the
// views that depend on those return nothing rather than erroring.
// =====================================================================

const MEMBER_WTB_VIEW_FORMULAS = {
  open: `OR(
    {Fulfillment Status} = 'Pending',
    {Fulfillment Status} = 'Outsource'
  )`,

  // Member WTBs has no StockX or GOAT statuses, so this side of the
  // Processing tab is smaller - the tab is a list of statuses and each
  // source contributes the ones it has.
  processing: `OR(
    {Fulfillment Status} = 'Confirmed',
    {Fulfillment Status} = 'Claim Processing'
  )`,

  // "Offer To Buyer" is the Member WTBs counterpart of "Offer To Store":
  // the price we are asking the buyer, once the network has come back.
  //
  // CHANGED - "Current Lowest Offer" counts too. The Offers tab lists a
  // want-to-buy the moment a seller has offered on it; "Offer To Buyer" is
  // only filled in once the offer has actually been sent out, so counting
  // on that alone put a 0 over a table with rows in it.
  offers: `AND(
    OR(
      {Fulfillment Status} = 'Pending',
      {Fulfillment Status} = 'Outsource'
    ),
    OR(
      {Offer To Buyer} > 0,
      {Current Lowest Offer} > 0
    )
  )`,

  allocated: `{Fulfillment Status} = 'Allocated'`,

  label_requests: `{Fulfillment Status} = 'Requested Label'`,

  ready_to_ship: `{Fulfillment Status} = 'Ready to Ship'`,

  shipped: `AND(
    OR(
      {Fulfillment Status} = 'Ready to Ship',
      {Fulfillment Status} = 'Fulfilled'
    ),
    {Shipping Status} = 'Shipped'
  )`,

  fulfilled: `AND(
    OR(
      {Fulfillment Status} = 'Ready to Ship',
      {Fulfillment Status} = 'Fulfilled'
    ),
    {Shipping Status} = 'Delivered'
  )`,

  // Payment Status here plays the part Invoice Status plays in the order
  // log. "Trusted" counts as settled: the deal proceeds unpaid on purpose.
  open_payments: `AND(
    OR(
      {Fulfillment Status} = 'Requested Label',
      {Fulfillment Status} = 'Ready to Ship',
      {Fulfillment Status} = 'Fulfilled'
    ),
    OR(
      {Payment Status} = 'Pending',
      {Payment Status} = 'Requested',
      {Payment Status} = 'Awaiting Payment',
      {Payment Status} = 'Pending Payment'
    )
  )`,

  payment_history: `OR(
    {Payment Status} = 'Paid',
    {Payment Status} = 'Trusted',
    {Payment Status} = 'Expired',
    {Payment Status} = 'Cancelled'
  )`
};

// Views that only exist on the API side. A manual store has no StockX
// account, no inventory with us and no issue log, so these stay empty
// rather than throwing on a field that is not there.
const MEMBER_WTB_EMPTY_VIEWS = new Set([
  "issues",
  "inventory",
  "returns",
  "stockx_active_bids",
  "stockx_active_second_bids",
  "stockx_orders",
  "stockx_second_orders"
]);

// Which of the two order sources a store has, asked separately because a
// store can have both.
//
// This used to be one either/or, which decided what /api/orders returned.
// That works right up to the moment a merchant has both kinds, and then one
// list has to mean two things - so the source moved into the request and
// these only decide what a store is offered.
function merchantHasManualOrders(merchant = {}) {
  return merchant.order_intake === "manual" || merchant.order_intake === "both";
}

function merchantHasStoreOrders(merchant = {}) {
  return merchant.order_intake === "api" || merchant.order_intake === "both";
}

// The shop is where a store without an API integration puts its demand in by
// hand. A store that IS on the integration receives its orders through it, so
// a buy or an offer placed here would be demand nobody asked for - and these
// endpoints create it for real, by way of KC's /api/buying/requests.
//
// Hiding the nav link in the portal was never enforcement. The page and all
// four endpoints behind it were reachable by URL for every logged-in store.
function refuseShopForApiStore(merchant, res) {
  if (merchantHasManualOrders(merchant)) return false;

  res.status(403).json({ error: "The shop is not available for this store." });
  return true;
}

// The buyer on a Member WTB is a seller record, and Merchants already links
// to one through "Seller ID". No new field needed on either side.
function memberWtbBuyerFormula(merchant = {}) {
  const sellerIds = merchant.seller_ids || [];

  if (!sellerIds.length) return "";

  return `OR(${sellerIds
    .map((sellerId) => `FIND('${escapeFormulaValue(sellerId)}', ARRAYJOIN({Buyer Seller Record ID}))`)
    .join(",")})`;
}

function mapMemberWtbRecord(record, view) {
  const f = record.fields || {};

  return {
    id: record.id,

    order_number: displayValue(f["Member WTB ID"]),
    product: displayValue(f["Product Name"]),
    sku: displayValue(f["SKU"]),
    size: displayValue(f["Size"]),
    brand: displayValue(f["Brand"]),
    selling_price: moneyValue(f["Max Price"]),
    date: dateValue(f["Date"]),

    offer: moneyValue(f["Offer To Buyer"]),
    offer_vat_type: displayValue(f["Lowest Offer VAT Type"]),
    eta: "",

    allocated_price: moneyValue(f["Final Buying Price"]),
    vat: moneyValue(f["Buying VAT Amount"]),
    invoice_price: moneyValue(f["Invoice Price"]),
    invoice_status: displayValue(f["Payment Status"]),
    payment_link: displayValue(f["Payment Link"]),
    mollie_payment_id: displayValue(f["Mollie Payment ID"]),
    paid_at: dateValue(f["Payment Confirmed At"]),
    // CHANGED - "VAT Type" here is the VAT of the offer we buy at, not what
    // the store is invoiced. On MWTB-000388 it says VAT0 because the
    // supplying seller sells VAT0, while the buyer is Dutch and the invoice
    // is computed at 21% - the column contradicted the money next to it.
    //
    // Same rule as the API side, deliberately: margin goods cannot be sold
    // on with VAT, everything else follows the buyer's country. One rule for
    // both intakes matters more than a cleverer rule per intake; two rules
    // is how they drift apart.
    vat_type: (() => {
      const origineel = displayValue(f["VAT Type"]);
      const land = displayValue(f["Buyer Country"]).toLowerCase();

      if (origineel === "Margin") return "Margin";

      return land === "netherlands" ? "VAT21" : "VAT0";
    })(),

    fulfillment_status: displayValue(f["Fulfillment Status"]),
    shipping_status: displayValue(f["Shipping Status"]),

    // Same rule as the API side, through the same function - a status the
    // store sees should not depend on which table it came out of.
    status: getPortalStatus(f, view),

    tracking_number: displayValue(f["Tracking Number"]),
    tracking_url: displayValue(f["Tracking URL"]),

    // Present so the front-end finds the keys it looks for; Member WTBs
    // simply has no equivalent. Leaving them undefined would make every
    // reader guard for it.
    active_bid: "",
    second_active_bid: "",
    buying_price: "",
    order_status: "",
    second_buying_price: "",
    second_extra_profit: "",
    second_stockx_order_number: "",
    second_order_status: "",
    offer_date: "",
    preferred_courier: "",
    supplier_shipping_status: "",
    warehouse_tracking: "",
    issue_status: "",
    issue_notes: ""
  };
}

async function fetchMemberWtbOrders({ merchant, view, pageSize, offset }) {
  const buyerFormula = memberWtbBuyerFormula(merchant);

  // No linked seller record means no way to tell which WTBs are theirs.
  // Returning nothing is right; guessing would show them someone else's.
  if (!buyerFormula || MEMBER_WTB_EMPTY_VIEWS.has(view)) {
    return { records: [], offset: "" };
  }

  const parts = [buyerFormula];
  const viewFormula = MEMBER_WTB_VIEW_FORMULAS[view];

  if (viewFormula) parts.push(viewFormula);

  const url = new URL(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_MEMBER_WTBS_TABLE)}`
  );

  url.searchParams.set("filterByFormula", `AND(${parts.join(",")})`);
  url.searchParams.set("sort[0][field]", "Date");
  url.searchParams.set("sort[0][direction]", "desc");

  if (pageSize) url.searchParams.set("pageSize", String(pageSize));
  if (offset) url.searchParams.set("offset", offset);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Airtable request failed");
  }

  return { records: data.records || [], offset: data.offset || "" };
}

async function countMemberWtbView({ merchant, view }) {
  if (MEMBER_WTB_EMPTY_VIEWS.has(view)) return 0;

  const buyerFormula = memberWtbBuyerFormula(merchant);

  if (!buyerFormula) return 0;

  const parts = [buyerFormula];
  const viewFormula = MEMBER_WTB_VIEW_FORMULAS[view];

  if (viewFormula) parts.push(viewFormula);

  const records = await airtable(AIRTABLE_MEMBER_WTBS_TABLE)
    .select({
      fields: ["Member WTB ID"],
      filterByFormula: `AND(${parts.join(",")})`
    })
    .all();

  return records.length;
}

function buildOrderViewFormula(view, merchant = {}) {
  // CHANGED - "Confirmed" moved to the new Processing view. It sat here
  // because there was no tab between Open Orders and Allocated, not
  // because an accepted deal is still an open order.
  if (view === "open") {
    return `OR(
      {Fulfillment Status} = 'Pending',
      {Fulfillment Status} = 'Outsource'
    )`;
  }

  // NEW - everything between "we agreed the deal" and "a unit is ours".
  // getPortalStatus already labelled these statuses "Processing" inside
  // the Allocated tab, so the name is not new to the interface - it now
  // has a tab of its own instead of hiding inside another one.
  if (view === "processing") {
    const statuses = [
      "Confirmed",
      "Claim Processing"
    ];

    // Same condition these carried in Allocated: a store with its own
    // dedicated account follows those orders in the StockX section.
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

  // CHANGED - the three Processing statuses moved to their own view.
  // What is left is what the name says: a unit is assigned to this
  // order.
  if (view === "allocated") {
    return `OR(
      {Fulfillment Status} = 'Allocated',
      {Fulfillment Status} = 'Awaiting Label'
    )`;
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
        {Invoice Status} = 'Awaiting Payment',
        {Invoice Status} = 'Pending Payment'
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

// One merchant now has a counts entry per section, so clearing "the" entry
// is no longer a single delete. Everything that changes something goes
// through here instead of guessing the key.
function clearCountsForMerchant(merchantId) {
  const prefix = `counts:${merchantId}`;

  for (const key of countsCache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) countsCache.delete(key);
  }
}
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

    // FIXED - the source belongs in the key. Without it the two sections
    // share one cache entry: whichever list is asked for first is the one
    // the other gets back, which showed as a count of 1 above an empty
    // table. The counts cache had the same hole and was fixed with it.
    const cacheKey = [
      merchantId,
      view,
      asText(req.query.source).toLowerCase(),
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

    // CHANGED - the caller says which of the two lists it wants.
    //
    // This used to read the merchant: manual intake meant Member WTBs, and
    // everything else meant store orders. A store with both then had one
    // list that had to mean two things - and one price column that had to
    // be a selling price and a maximum at the same time. The portal now
    // shows them as two sections and asks for one at a time.
    //
    // Defaults to whichever the store actually has, so a caller that sends
    // nothing keeps the old behaviour exactly.
    const requestedSource = asText(req.query.source).toLowerCase();

    // "all" asks for both lists at once. Money is money: on the Finance
    // views a store should see everything it owes in one place, or it
    // cannot put several of them into one payment. It falls through to the
    // store path below, which appends the manual rows once it has its own.
    const wantsRequests = requestedSource && requestedSource !== "all"
      ? requestedSource === "requests"
      : merchantHasManualOrders(merchant) && !merchantHasStoreOrders(merchant);

    if (wantsRequests) {
      const { records, offset: nextOffset } = await fetchMemberWtbOrders({
        merchant,
        view,
        pageSize,
        offset
      });

      let orders = records.map((record) => mapMemberWtbRecord(record, view));

      if (search) {
        orders = orders.filter((order) =>
          Object.values(order).join(" ").toLowerCase().includes(search)
        );
      }

      const responseData = {
        merchant: {
          id: merchant.id,
          store_name: merchant.store_name,

          // NEW - the whole snapshot, sent with every list rather than only
          // at login. The portal keeps its merchant in localStorage and
          // nothing ever logs a store out, so without this a change in
          // Airtable would not reach a store until they happened to sign in
          // again - which for some of them is never.
          portal_email: merchant.portal_email,
          stockx_account_mode: merchant.stockx_account_mode,
          goat_account_mode: merchant.goat_account_mode,
          order_intake: merchant.order_intake
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

      return res.json(responseData);
    }

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

    // The manual half of a "both" store, appended to the store orders it
    // already has. Only on the first page: the offset below belongs to the
    // order log, so repeating these on page two would list them twice.
    //
    // Fetched whole rather than paged. These are the money views, where a
    // list runs to tens of rows, not thousands - and a payment can only
    // bundle what is on the screen anyway.
    if (requestedSource === "all" && !offset && merchantHasManualOrders(merchant)) {
      const { records: manualRecords } = await fetchMemberWtbOrders({
        merchant,
        view,
        pageSize: 100,
        offset: ""
      });

      orders = [
        ...orders,
        ...manualRecords.map((record) => mapMemberWtbRecord(record, view))
      ];
    }

    if (search) {
      orders = orders.filter((order) =>
        Object.values(order).join(" ").toLowerCase().includes(search)
      );
    }

    const responseData = {
      merchant: {
        id: merchant.id,
        store_name: merchant.store_name,
        portal_email: merchant.portal_email,
        stockx_account_mode: merchant.stockx_account_mode,
        goat_account_mode: merchant.goat_account_mode,
        order_intake: merchant.order_intake
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

    // Counts belong to one section, so the key carries it too - otherwise a
    // store with both sections sees the first one's numbers on the second.
    const requestedSource = asText(req.query.source).toLowerCase();

    const cacheKey = `counts:${merchantId}:${requestedSource || "default"}`;
    const cached = countsCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const merchant = await getCachedMerchant(merchantId);
    const safeStoreName = escapeFormulaValue(merchant.store_name);

    const wantsRequests = requestedSource
      ? requestedSource === "requests"
      : merchantHasManualOrders(merchant) && !merchantHasStoreOrders(merchant);

    const views = [
      "open",
      "offers",
      "processing",
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
        
        if (wantsRequests) {
          counts[view] = await countMemberWtbView({ merchant, view });
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

    clearCountsForMerchant(merchantId);
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

    clearCountsForMerchant(merchantId);
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

    clearCountsForMerchant(merchantId);
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

// ---------------------------------------------------------------------
// NEW — additive only: Open pill for the Lojiq Portal's Offers tab.
// Combines both halves built on kickz-caviar-portal-main (fresh,
// never-countered offers + genuine seller counter-back rounds) into
// one response, same thin-proxy pattern as the existing
// /counter-offer endpoint below (resolve merchant → store_name, call
// kickz-caviar-portal with the shared secret, never expose that
// secret to the browser).
// ---------------------------------------------------------------------
// NEW — additive only: Fase 2, the Countered pill — the store's own
// pending counter, awaiting the seller. Single fetch, no fresh-items
// merge needed (Countered has no "fresh" equivalent — every item here
// already has an active round).
app.get("/api/orders/offers-countered", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (!COUNTER_OFFERS_SECRET) {
      return res.status(500).json({ error: "Missing COUNTER_OFFERS_SECRET" });
    }

    const storeNameParam = encodeURIComponent(merchant.store_name);

    const response = await fetch(`${KICKZ_PORTAL_BASE_URL}/api/dashboard/store-counter-offers?store_name=${storeNameParam}&filter=countered`, {
      headers: { "x-kc-secret": COUNTER_OFFERS_SECRET }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to load countered offers");
    }

    const items = (data.items || []).map((item) => ({ ...item, round_type: "countered" }));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load countered offers:", err);
    res.status(500).json({
      error: "Failed to load countered offers",
      details: err.message
    });
  }
});

// NEW — additive only: Denied pill data, mirroring the Kickz Caviar
// Portal Buying section's Denied pill. Same shape as offers-countered
// but asks the already-existing kickz backend for filter=denied. No
// negotiation logic here — pure proxy.
app.get("/api/orders/offers-denied", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (!COUNTER_OFFERS_SECRET) {
      return res.status(500).json({ error: "Missing COUNTER_OFFERS_SECRET" });
    }

    const storeNameParam = encodeURIComponent(merchant.store_name);

    const response = await fetch(`${KICKZ_PORTAL_BASE_URL}/api/dashboard/store-counter-offers?store_name=${storeNameParam}&filter=denied`, {
      headers: { "x-kc-secret": COUNTER_OFFERS_SECRET }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to load denied offers");
    }

    const items = (data.items || []).map((item) => ({ ...item, round_type: "denied" }));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load denied offers:", err);
    res.status(500).json({
      error: "Failed to load denied offers",
      details: err.message
    });
  }
});

app.get("/api/orders/offers-open", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (!COUNTER_OFFERS_SECRET) {
      return res.status(500).json({ error: "Missing COUNTER_OFFERS_SECRET" });
    }

    const storeNameParam = encodeURIComponent(merchant.store_name);

    const [freshResponse, counteredResponse] = await Promise.all([
      fetch(`${KICKZ_PORTAL_BASE_URL}/api/dashboard/store-offers?store_name=${storeNameParam}`, {
        headers: { "x-kc-secret": COUNTER_OFFERS_SECRET }
      }),
      fetch(`${KICKZ_PORTAL_BASE_URL}/api/dashboard/store-counter-offers?store_name=${storeNameParam}&filter=open`, {
        headers: { "x-kc-secret": COUNTER_OFFERS_SECRET }
      })
    ]);

    const [freshData, counteredData] = await Promise.all([
      freshResponse.json(),
      counteredResponse.json()
    ]);

    if (!freshResponse.ok) {
      throw new Error(freshData.error || freshData.details || "Failed to load fresh offers");
    }

    if (!counteredResponse.ok) {
      throw new Error(counteredData.error || counteredData.details || "Failed to load countered offers");
    }

    const items = [
      ...(freshData.items || []).map((item) => ({ ...item, round_type: item.round_type || "fresh" })),
      ...(counteredData.items || []).map((item) => ({ ...item, round_type: item.round_type || "counter" }))
    ];

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load open offers:", err);
    res.status(500).json({
      error: "Failed to load open offers",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// The same three pills for the Manual Orders section.
//
// Store Orders reads the Unfulfilled Orders Log through KC's
// /api/dashboard/store-* endpoints above. Manual Orders is the same
// negotiation on a different table - and KC already exposes that side as
// /api/dashboard/buying-*, because the buyer on a Member WTB is a seller
// record, which is exactly what merchant.seller_ids holds.
//
// So these are the same thin proxies pointed at the buying half, with the
// handful of field names that differ renamed into the shape the orders
// table already reads. Nothing on the store path is touched.
//
// Before this, the Offers tab ignored the section you were standing in and
// always asked the store endpoints: a manual store saw an empty table
// under a sidebar badge that said there was an offer waiting, and a store
// with both sections saw its store offers listed under Manual as well.
// ---------------------------------------------------------------------

// The order log names things after a store order and Member WTBs after a
// want-to-buy. Two names for one column, so they are renamed once, here,
// rather than in every reader.
function mapMemberOfferItem(item, roundType) {
  return {
    ...item,

    // A denied round that never had a counter comes back tagged
    // "fresh_denied" by KC and the table keys its buttons off that, so the
    // tag is left alone and only the round type is filled in.
    round_type: item.round_type || roundType,

    order_record_id: item.member_wtb_record_id || "",
    order_number: item.order_id || "",
    selling_price: item.max_price ?? "-",

    // The store side reads this from the order's "Offer Sent At"; on this
    // side it comes off the Seller Offer behind the round. A round that is
    // already under way sends nothing, exactly as the store side does.
    offer_date: item.offer_date || "",

    // Member WTBs has no delivery estimate. Present so the column reads
    // "-" instead of "undefined".
    eta: ""
  };
}

// A merchant can have more than one seller record, and the buying
// endpoints answer for one at a time. Asking for each and joining the
// answers keeps that an implementation detail of this function.
async function fetchBuyingItems(merchant, path, extraParams = {}) {
  const sellerIds = merchant.seller_ids || [];

  if (!sellerIds.length) return [];

  const pages = await Promise.all(
    sellerIds.map(async (sellerRecordId) => {
      const params = new URLSearchParams({
        seller_record_id: sellerRecordId,
        ...extraParams
      });

      const response = await fetch(
        `${KICKZ_PORTAL_BASE_URL}${path}?${params.toString()}`,
        { headers: { "x-kc-secret": COUNTER_OFFERS_SECRET } }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details || "Failed to load offers");
      }

      return data.items || [];
    })
  );

  return pages.flat();
}

app.get("/api/orders/member-offers-open", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    // Same two halves as the store side: offers nobody has answered yet,
    // and rounds where the seller has just moved and it is our turn.
    const [fresh, countered] = await Promise.all([
      fetchBuyingItems(merchant, "/api/dashboard/buying-offers"),
      fetchBuyingItems(merchant, "/api/dashboard/buying-counter-offers", { filter: "open" })
    ]);

    const items = [
      ...fresh.map((item) => mapMemberOfferItem(item, "fresh")),
      ...countered.map((item) => mapMemberOfferItem(item, "counter"))
    ];

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load open member offers:", err);
    res.status(500).json({
      error: "Failed to load open offers",
      details: err.message
    });
  }
});

app.get("/api/orders/member-offers-countered", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    const items = (
      await fetchBuyingItems(merchant, "/api/dashboard/buying-counter-offers", {
        filter: "countered"
      })
    ).map((item) => mapMemberOfferItem(item, "countered"));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load countered member offers:", err);
    res.status(500).json({
      error: "Failed to load countered offers",
      details: err.message
    });
  }
});

app.get("/api/orders/member-offers-denied", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    const items = (
      await fetchBuyingItems(merchant, "/api/dashboard/buying-counter-offers", {
        filter: "denied"
      })
    ).map((item) => mapMemberOfferItem(item, "denied"));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error("Failed to load denied member offers:", err);
    res.status(500).json({
      error: "Failed to load denied offers",
      details: err.message
    });
  }
});

// Which KC endpoint each button on a Member WTB offer belongs to, and what
// it needs sent with it. One table rather than nine near-identical proxies:
// they differ only in the path and which ids travel along.
const MEMBER_OFFER_ACTIONS = {
  accept: (ids) => ({
    path: "/api/dashboard/buying/accept-offer",
    body: {
      member_wtb_record_id: ids.memberWtbRecordId,
      ...(ids.counterOfferRecordId ? { counter_offer_record_id: ids.counterOfferRecordId } : {}),
      ...(ids.sellerOfferRecordId ? { seller_offer_record_id: ids.sellerOfferRecordId } : {}),
      // The amount on the button is the negotiated one, not the seller's
      // original ask, so it travels with the accept. A never-countered
      // offer has nothing to override and sends neither.
      ...(Number.isFinite(ids.overridePrice)
        ? { override_price: ids.overridePrice, override_vat_type: ids.overrideVatType }
        : {})
    }
  }),

  deny_fresh: (ids) => ({
    path: `/api/dashboard/buying-offers/${encodeURIComponent(ids.memberWtbRecordId)}/deny`,
    body: { seller_offer_record_id: ids.sellerOfferRecordId }
  }),

  deny_round: (ids) => ({
    path: `/api/dashboard/buying-counter-offers/${encodeURIComponent(ids.counterOfferRecordId)}/buyer-deny`,
    body: {}
  }),

  counter_fresh: (ids) => ({
    path: "/api/dashboard/buying-counter-offers/create-from-fresh",
    body: {
      member_wtb_record_id: ids.memberWtbRecordId,
      seller_offer_record_id: ids.sellerOfferRecordId,
      price: ids.price
    }
  }),

  counter_round: (ids) => ({
    path: `/api/dashboard/buying-counter-offers/${encodeURIComponent(ids.counterOfferRecordId)}/buyer-counter`,
    body: { price: ids.price }
  }),

  edit_round: (ids) => ({
    path: `/api/dashboard/buying-counter-offers/${encodeURIComponent(ids.counterOfferRecordId)}/buyer-edit`,
    body: { price: ids.price }
  }),

  retry_round: (ids) => ({
    path: `/api/dashboard/buying-counter-offers/${encodeURIComponent(ids.counterOfferRecordId)}/retry-counter`,
    body: { price: ids.price }
  }),

  cancel_round: (ids) => ({
    path: `/api/dashboard/buying-counter-offers/${encodeURIComponent(ids.counterOfferRecordId)}/buyer-cancel`,
    body: {}
  }),

  delete_denied: (ids) => ({
    path: `/api/dashboard/buying-offers/${encodeURIComponent(ids.sellerOfferRecordId)}/buyer-delete-denied`,
    body: {}
  })
};

// Which of this merchant's seller records is the buyer on this WTB, or ""
// if none of them is.
//
// Every buying endpoint but one checks this itself; buying/accept-offer
// does not, and that is the one that creates the deal. So it is checked
// here for all of them - a store may only act on its own demand, and the
// answer doubles as the seller_record_id the KC side wants.
async function resolveMemberWtbBuyer(memberWtbRecordId, merchant) {
  const sellerIds = merchant.seller_ids || [];

  if (!memberWtbRecordId || !sellerIds.length) return "";

  const record = await airtable(AIRTABLE_MEMBER_WTBS_TABLE)
    .find(memberWtbRecordId)
    .catch(() => null);

  if (!record) return "";

  const raw = record.fields?.["Buyer Seller Record ID"];
  const buyerIds = (Array.isArray(raw) ? raw : [raw]).map((value) => asText(value));

  return sellerIds.find((sellerId) => buyerIds.includes(sellerId)) || "";
}

app.post("/api/orders/member-offers/action", async (req, res) => {
  try {
    const merchantId = asText(req.body?.merchant_id);
    const action = asText(req.body?.action);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const buildRequest = MEMBER_OFFER_ACTIONS[action];

    if (!buildRequest) {
      return res.status(400).json({ error: "Invalid action" });
    }

    if (!COUNTER_OFFERS_SECRET) {
      return res.status(500).json({ error: "Missing COUNTER_OFFERS_SECRET" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const memberWtbRecordId = asText(req.body?.member_wtb_record_id);
    const sellerRecordId = await resolveMemberWtbBuyer(memberWtbRecordId, merchant);

    if (!sellerRecordId) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    const price = Number(req.body?.price);
    const overridePrice = Number(req.body?.override_price);

    const { path, body } = buildRequest({
      memberWtbRecordId,
      counterOfferRecordId: asText(req.body?.counter_offer_record_id),
      sellerOfferRecordId: asText(req.body?.seller_offer_record_id),
      price: Number.isFinite(price) ? price : undefined,
      overridePrice: Number.isFinite(overridePrice) && overridePrice > 0 ? overridePrice : undefined,
      overrideVatType: asText(req.body?.override_vat_type)
    });

    const response = await fetch(`${KICKZ_PORTAL_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": COUNTER_OFFERS_SECRET
      },
      body: JSON.stringify({ ...body, seller_record_id: sellerRecordId })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Passed through rather than flattened to a 500: the buying side
      // answers 409 with a sentence worth reading ("This offer is no
      // longer available.") and the table shows whatever comes back.
      return res.status(response.status).json(data);
    }

    clearCountsForMerchant(merchantId);
    ordersCache.clear();

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Member offer action failed:", err);
    res.status(500).json({
      error: "Failed to process offer",
      details: err.message
    });
  }
});

// ---------------------------------------------------------------------
// NEW — additive only: Open pill actions. Thin proxies, same pattern as
// /counter-offer above — resolve merchant → store_name, forward to the
// already-proven kickz-caviar-portal endpoints with the shared secret.
// No negotiation logic lives here.
// ---------------------------------------------------------------------

// =====================================================================
// The shop - browsing Kickz Caviar stock from the Lojiq portal
//
// Everything about what is for sale lives on the Kickz Caviar side: the live
// sources, which source wins for a given SKU and size, and the markup on the
// price. These endpoints hand the question over rather than answering it
// again here. A second copy of that logic would drift from the first, and
// the drift would be in prices.
//
// One thing is deliberately different. On the Kickz Caviar page the browser
// sends its own seller_record_id along; here the buyer is resolved on the
// server from the logged-in merchant. A store therefore cannot place a want
// to buy in someone else's name, however the request is edited on the way
// out.
// =====================================================================

const buyerCache = new Map();
const KOPER_CACHE_TTL_MS = 5 * 60 * 1000;

// A merchant buys as the seller record it is linked to through "Seller ID".
// Member WTBs points at that same record, which is what makes the orders
// list and the shop agree about who someone is.
async function getMerchantBuyer(merchant) {
  const sellerIds = merchant.seller_ids || [];

  if (!sellerIds.length) {
    throw new Error("This store has no linked seller record");
  }

  const recordId = sellerIds[0];
  const cached = buyerCache.get(recordId);

  if (cached && Date.now() - cached.createdAt < KOPER_CACHE_TTL_MS) {
    return cached.buyer;
  }

  const record = await airtable(AIRTABLE_SELLERS_TABLE).find(recordId);

  const rawVatRate = Number(record.fields["Sellers VAT Rate"]);
  const country = asText(record.fields["Country"]);
  const hasVatId = !!asText(record.fields["VAT ID"]);

  const dutch = ["netherlands", "nederland", "nl"].includes(country.trim().toLowerCase());

  const buyer = {
    record_id: record.id,
    seller_id: asText(record.fields["Seller ID"]),
    trusted: record.fields["Trusted Buyer?"] === true,

    // The store's own VAT rate, so the shop can price a pair the way it
    // costs in THEIR country. Null when absent, which leaves the portal on
    // the Dutch 21% it used for everyone before.
    vat_rate: Number.isFinite(rawVatRate) && rawVatRate > 0 ? rawVatRate : null,

    country,

    // Mirrors memberWtbIsReverseCharge in the portal: a VAT number and a
    // country outside the Netherlands means we invoice without VAT. The
    // shop needs to know so it can tell a store what it will actually be
    // billed before it commits to an amount.
    reverse_charge: hasVatId && !dutch
  };

  if (!buyer.seller_id) {
    throw new Error("The linked seller record has no Seller ID");
  }

  buyerCache.set(recordId, { createdAt: Date.now(), buyer });

  return buyer;
}

async function kickzGet(path, params) {
  const url = new URL(`${KICKZ_PORTAL_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.details || "Request to kickz-caviar-portal failed");
  }

  return data;
}

async function kickzPost(path, body) {
  // Every shop action carries a seller_record_id, and the portal challenges
  // any request that does - a browser proves itself with its session cookie,
  // a service with this header. Without it the answer is always 401 "Not
  // signed in", which is what Buy and Offer got: the GET endpoints above
  // need no proof, so only the two buttons that write were affected.
  if (!COUNTER_OFFERS_SECRET) {
    throw new Error("Missing COUNTER_OFFERS_SECRET");
  }

  const response = await fetch(`${KICKZ_PORTAL_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kc-secret": COUNTER_OFFERS_SECRET
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // The out-of-stock answer is a normal outcome, not a failure: between
    // loading the page and pressing the button someone else can have taken
    // the last pair.
    const failure = new Error(data.error || data.details || "Request to kickz-caviar-portal failed");
    failure.status = response.status;
    failure.payload = data;
    throw failure;
  }

  return data;
}

app.get("/api/shop/products", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    // Reading the merchant is what makes this endpoint refuse a stranger; the
    // catalogue itself is the same for everyone.
    const merchant = await getCachedMerchant(merchantId);

    if (refuseShopForApiStore(merchant, res)) return;

    // A store must see the price it will actually pay, VAT and all. Read
    // from their own buyer record; a store without a linked seller keeps
    // the generic catalogue rather than an error, exactly as before.
    const buyer = await getMerchantBuyer(merchant).catch(() => null);

    const data = await kickzGet("/api/buying/products", {
      search: asText(req.query.search),
      brand: asText(req.query.brand),
      sort: asText(req.query.sort),
      inventory_type: asText(req.query.inventory_type) || "all",
      buyer_vat_rate: buyer?.vat_rate ?? ""
    });

    res.json(data);
  } catch (err) {
    console.error("Shop products failed:", err);
    res.status(500).json({ error: "Failed to load products", details: err.message });
  }
});

app.get("/api/shop/brands", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (refuseShopForApiStore(merchant, res)) return;

    res.json(await kickzGet("/api/brands", {}));
  } catch (err) {
    console.error("Shop brands failed:", err);
    res.status(500).json({ error: "Failed to load brands", details: err.message });
  }
});

// Buy now and Make an offer differ only in whether a price rides along, so
// they share everything up to the last line.
async function handleShopAction(req, res, { path, extra }) {
  const merchantId = asText(req.body?.merchant_id);
  const sku = asText(req.body?.sku);
  const size = asText(req.body?.size);
  const inventoryType = asText(req.body?.inventory_type) || "all";

  if (!merchantId || !sku || !size) {
    return res.status(400).json({ error: "Missing merchant, SKU or size" });
  }

  const merchant = await getCachedMerchant(merchantId);

  // Buy and Offer both land here, so this one line covers them both.
  if (refuseShopForApiStore(merchant, res)) return;

  const buyer = await getMerchantBuyer(merchant);

  const data = await kickzPost(path, {
    seller_record_id: buyer.record_id,
    seller_id: buyer.seller_id,
    sku,
    size,
    inventory_type: inventoryType,
    ...extra
  });

  // The new want to buy has to show up in the orders list straight away,
  // otherwise the store presses the button and nothing appears to happen.
  clearCountsForMerchant(merchantId);
  ordersCache.clear();

  res.json(data);
}

app.post("/api/shop/buy", async (req, res) => {
  try {
    await handleShopAction(req, res, { path: "/api/buying/requests", extra: {} });
  } catch (err) {
    console.error("Shop buy failed:", err);

    // Out of stock is the buyer's answer, not our error.
    if (err.status === 409) {
      return res.status(409).json(err.payload || { error: "Out Of Stock" });
    }

    res.status(500).json({ error: "Failed to place request", details: err.message });
  }
});

// A size, tidied but not narrowed.
//
// Sneaker scales are not the whole catalogue: apparel runs S / M / L / XL
// and a cap can be L/XL. A first version of this allowed digits only and
// would have refused a want-to-buy for a size M tee - 97 stock lines carry
// a letter size today, so that was not an edge case.
//
// A comma becomes a dot because 35,5 and 35.5 are the same size written
// two ways, and a shop should not have to guess which one we want.
function normalizeWtbSize(value) {
  return asText(value)
    .trim()
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function isValidWtbSize(size) {
  return /^[A-Z0-9./ -]+$/.test(size) && /[A-Z0-9]/.test(size);
}

// The VAT profile of the store that is looking, so the shop can tell them
// what an amount they type actually means before they commit to it. No
// prices here - just which scale they are working in.
app.get("/api/shop/buyer", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (refuseShopForApiStore(merchant, res)) return;

    const buyer = await getMerchantBuyer(merchant);

    res.json({
      vat_rate: buyer.vat_rate,
      country: buyer.country,
      reverse_charge: buyer.reverse_charge
    });
  } catch (err) {
    console.error("Shop buyer context failed:", err);
    res.status(500).json({ error: "Failed to load buyer details", details: err.message });
  }
});

// A whole file of want-to-buys, queued rather than posted one at a time.
//
// The rows go to the portal in a single request and a background worker
// posts them. A store can close the tab: the import carries on, resumes
// where it stopped if anything interrupts it, and cannot half-finish
// silently - which is what row-by-row posting from the browser did.
app.post("/api/shop/wtb-csv", async (req, res) => {
  try {
    const merchantId = asText(req.body?.merchant_id);
    const inventoryType = asText(req.body?.inventory_type) || "all";
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant" });
    }

    if (!rows.length) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (refuseShopForApiStore(merchant, res)) return;

    const buyer = await getMerchantBuyer(merchant);

    const data = await kickzPost("/api/member-wtb/csv-import", {
      seller_record_id: buyer.record_id,
      seller_id: buyer.seller_id,
      inventory_type: inventoryType,
      created_from: "Lojiq Portal CSV",
      rows
    });

    clearCountsForMerchant(merchantId);
    ordersCache.clear();

    res.json(data);
  } catch (err) {
    console.error("Shop want-to-buy import failed:", err);
    res.status(err.status || 500).json(
      err.payload || { error: "Failed to queue import", details: err.message }
    );
  }
});

// A store that cannot find what it needs says so here, instead of leaving.
// This is the other half of a manual store's intake: Buy and Offer answer
// what we already hold, this one records demand we do not.
app.post("/api/shop/wtb", async (req, res) => {
  try {
    const merchantId = asText(req.body?.merchant_id);
    const inventoryType = asText(req.body?.inventory_type) || "all";

    // Trimmed and squeezed before anything is judged: "37  1/3 " and
    // "37 1/3" are the same size, and a stray space either end is a typo,
    // not a different shoe.
    const sku = asText(req.body?.sku).trim().toUpperCase();
    const size = normalizeWtbSize(req.body?.size);
    const maxPrice = Number(req.body?.max_price);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant" });
    }

    if (!/^[A-Z0-9-]+$/.test(sku)) {
      return res.status(400).json({
        error: "A SKU can only contain letters, numbers and hyphens."
      });
    }

    if (!isValidWtbSize(size)) {
      return res.status(400).json({
        error: "A size can only contain letters, numbers, a dot, a slash or a hyphen."
      });
    }

    if (!Number.isInteger(maxPrice) || maxPrice <= 0) {
      return res.status(400).json({ error: "Enter a whole number above 0." });
    }

    const merchant = await getCachedMerchant(merchantId);

    if (refuseShopForApiStore(merchant, res)) return;

    const buyer = await getMerchantBuyer(merchant);

    const data = await kickzPost("/api/member-wtb/open", {
      seller_record_id: buyer.record_id,
      seller_id: buyer.seller_id,
      sku,
      size,
      max_price: maxPrice,
      inventory_type: inventoryType,
      created_from: "Lojiq Portal"
    });

    // The new want to buy has to show up in the orders list straight away,
    // same reason as the Buy and Offer buttons.
    clearCountsForMerchant(merchantId);
    ordersCache.clear();

    res.json(data);
  } catch (err) {
    console.error("Shop want-to-buy failed:", err);
    res.status(err.status || 500).json(
      err.payload || { error: "Failed to place want to buy", details: err.message }
    );
  }
});

app.post("/api/shop/offer", async (req, res) => {
  try {
    const offerPrice = Number(req.body?.offer_price);

    if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
      return res.status(400).json({ error: "Invalid offer price" });
    }

    await handleShopAction(req, res, {
      path: "/api/buying/offers",
      extra: { offer_price: offerPrice }
    });
  } catch (err) {
    console.error("Shop offer failed:", err);

    if (err.status === 409) {
      return res.status(409).json(err.payload || { error: "Out Of Stock" });
    }

    res.status(500).json({ error: "Failed to place offer", details: err.message });
  }
});

async function proxyToKickzPortal(path, body) {
  if (!COUNTER_OFFERS_SECRET) {
    throw new Error("Missing COUNTER_OFFERS_SECRET");
  }

  const response = await fetch(`${KICKZ_PORTAL_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kc-secret": COUNTER_OFFERS_SECRET
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.details || "Request to kickz-caviar-portal failed");
  }

  return data;
}

// Genuine open counter round — seller already moved, store responding.

app.post("/api/orders/counter-offers/:id/accept", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/store-accept`, {
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Accept (counter round) failed:", err);
    res.status(500).json({ error: err.message || "Failed to accept offer", details: err.message });
  }
});

app.post("/api/orders/counter-offers/:id/deny", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/store-deny`, {
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Deny (counter round) failed:", err);
    res.status(500).json({ error: err.message || "Failed to deny offer", details: err.message });
  }
});

app.post("/api/orders/counter-offers/:id/counter", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);
    const price = Number(req.body.price);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!Number.isInteger(price) || price <= 0) {
      return res.status(400).json({ error: "Invalid counter price" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/store-counter`, {
      store_name: merchant.store_name,
      price
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Counter (counter round) failed:", err);
    res.status(500).json({ error: err.message || "Failed to submit counter offer", details: err.message });
  }
});

// NEW — additive only: withdraw the store's own pending counter (a
// Countered-pill item), same thin-proxy pattern as the other actions.
app.post("/api/orders/counter-offers/:id/cancel", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/store-cancel`, {
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Cancel (counter round) failed:", err);
    res.status(500).json({ error: err.message || "Failed to cancel offer", details: err.message });
  }
});

// NEW — additive only: store retries a NEW counter from the Denied
// pill (case B — a seller denied the store's counter). Thin proxy to
// the store-retry-counter endpoint, which validates the new price in
// the store's own visible scale (same band rules as a normal counter).
app.post("/api/orders/counter-offers/:id/retry-counter", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);
    const price = Number(req.body.price);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "Invalid counter price" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/store-retry-counter`, {
      store_name: merchant.store_name,
      price
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Retry counter failed:", err);
    res.status(500).json({ error: err.message || "Failed to retry counter", details: err.message });
  }
});

// NEW — additive only: store hides a denied FRESH seller offer (case A)
// from the Denied pill. Thin proxy to the fresh-denied hide endpoint.
app.post("/api/orders/fresh-denied/:sellerOfferId/hide", async (req, res) => {
  try {
    const sellerOfferId = asText(req.params.sellerOfferId);
    const merchantId = asText(req.body.merchant_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/fresh-denied/${sellerOfferId}/hide`, {
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Hide fresh-denied offer failed:", err);
    res.status(500).json({ error: err.message || "Failed to hide offer", details: err.message });
  }
});

// NEW — additive only: edit the store's own pending counter (a
// Countered-pill item), while the seller hasn't responded yet.
app.post("/api/orders/counter-offers/:id/edit", async (req, res) => {
  try {
    const counterOfferRecordId = asText(req.params.id);
    const merchantId = asText(req.body.merchant_id);
    const price = Number(req.body.price);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!Number.isInteger(price) || price <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/${counterOfferRecordId}/edit`, {
      store_name: merchant.store_name,
      actor: "store",
      price
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Edit (counter round) failed:", err);
    res.status(500).json({ error: err.message || "Failed to edit offer", details: err.message });
  }
});

// NEW — additive only: edit a round-1 (never-yet-answered broadcast)
// counter — keyed by the ORDER, not one specific round, since round 1
// is several sibling rows (one per matching seller) that all need
// updating together. Calls the EXISTING, already-proven
// /api/counter-offers/edit-broadcast — the same endpoint the store-
// side Discord bot's "Edit" button already uses — rather than a
// separate implementation.
app.post("/api/orders/:recordId/edit-round-one", async (req, res) => {
  try {
    const orderRecordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const price = Number(req.body.price);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!Number.isInteger(price) || price <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const data = await proxyToKickzPortal(`/api/counter-offers/edit-broadcast`, {
      store_name: merchant.store_name,
      order_record_id: orderRecordId,
      price
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Edit (round 1) failed:", err);
    res.status(500).json({ error: err.message || "Failed to edit offer", details: err.message });
  }
});

// Fresh, never-countered offer — no round exists yet.

app.post("/api/orders/:recordId/accept-fresh", async (req, res) => {
  try {
    const orderRecordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const sellerOfferRecordId = asText(req.body.seller_offer_record_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!sellerOfferRecordId) return res.status(400).json({ error: "Missing seller_offer_record_id" });

    const merchant = await getCachedMerchant(merchantId);

    const created = await proxyToKickzPortal("/api/counter-offers/create-fresh-round", {
      order_record_id: orderRecordId,
      seller_offer_record_id: sellerOfferRecordId,
      store_name: merchant.store_name
    });

    const accepted = await proxyToKickzPortal(`/api/counter-offers/${created.counter_offer_record_id}/store-accept`, {
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...accepted });
  } catch (err) {
    console.error("Accept (fresh offer) failed:", err);
    res.status(500).json({ error: err.message || "Failed to accept offer", details: err.message });
  }
});

app.post("/api/orders/:recordId/deny-fresh", async (req, res) => {
  try {
    const orderRecordId = asText(req.params.recordId);
    const merchantId = asText(req.body.merchant_id);
    const sellerOfferRecordId = asText(req.body.seller_offer_record_id);

    if (!merchantId) return res.status(400).json({ error: "Missing merchant_id" });
    if (!sellerOfferRecordId) return res.status(400).json({ error: "Missing seller_offer_record_id" });

    const merchant = await getCachedMerchant(merchantId);

    const data = await proxyToKickzPortal("/api/counter-offers/deny-fresh", {
      order_record_id: orderRecordId,
      seller_offer_record_id: sellerOfferRecordId,
      store_name: merchant.store_name
    });

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Deny (fresh offer) failed:", err);
    res.status(500).json({ error: err.message || "Failed to deny offer", details: err.message });
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
    clearCountsForMerchant(merchantId);

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

    clearCountsForMerchant(merchantId);
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

    clearCountsForMerchant(merchantId);
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

// =====================================================================
// Paying for two kinds of order in one go
//
// A store's demand reaches us two ways - through its integration, into the
// Unfulfilled Orders Log, or by hand, into Member WTBs - but the money side
// is the same either way: an amount is owed, one Mollie payment settles it,
// and several of them can share that payment.
//
// The two tables carry that idea under different names. Writing the
// differences down once, here, is deliberate: every drift bug this portal
// has had came from the same decision living in two places.
// =====================================================================

const PAYMENT_SOURCES = {
  orders: {
    table: AIRTABLE_UNFULFILLED_ORDERS_LOG_TABLE,
    statusField: "Invoice Status",
    amountFields: ["Invoice Price (VAT Included)"],
    batchLinkField: "Linked Orders",
    numberField: "Shopify Order Number"
  },

  requests: {
    table: AIRTABLE_MEMBER_WTBS_TABLE,
    statusField: "Payment Status",
    // Two, in this order, because KC's own checkout reads them the same
    // way. Invoice Price is a formula and was filled on all eight payable
    // want-to-buys in the base, so the second is insurance rather than a
    // regular case - but a batch that silently totals zero is worse than
    // one that reads a field further down the list.
    amountFields: ["Invoice Price", "Final Buying Price"],
    batchLinkField: "Linked Member WTBs",
    numberField: "Member WTB ID"
  }
};

// From Requested Label onward there is something to pay for: a unit is ours
// and on its way. The same three statuses on both sides.
const PAYABLE_FULFILLMENT_STATUSES = new Set([
  "Requested Label",
  "Ready to Ship",
  "Fulfilled"
]);

// A status that means "not yours to start a payment on", with the sentence
// the store gets to read. Keyed by status so both tables share the wording.
const UNPAYABLE_STATUS_REASONS = {
  "Paid": "One of the selected orders is already paid",
  "Awaiting Payment": "One of the selected orders already has a payment link",
  "Pending Payment": "One of the selected orders already has a payment link",
  "Expired": "One of the selected orders cannot be paid from the portal",
  "Cancelled": "One of the selected orders cannot be paid from the portal"
};

function merchantOwnsPaymentRecord(source, fields, merchant) {
  if (source === "orders") {
    return displayValue(fields["Store Name"]) === merchant.store_name;
  }

  const sellerIds = merchant.seller_ids || [];
  const raw = fields["Buyer Seller Record ID"];
  const buyerIds = (Array.isArray(raw) ? raw : [raw]).map((value) => asText(value));

  return sellerIds.some((sellerId) => buyerIds.includes(sellerId));
}

// Which of the two tables a record id lives in.
//
// The browser sends plain record ids and this asks the tables rather than
// taking the browser's word for it - a page that could name its own table
// could point a payment at someone else's record.
async function resolvePaymentRecord(recordId, merchant) {
  for (const source of Object.keys(PAYMENT_SOURCES)) {
    const record = await airtable(PAYMENT_SOURCES[source].table)
      .find(recordId)
      .catch(() => null);

    if (!record) continue;

    return {
      source,
      record,
      owned: merchantOwnsPaymentRecord(source, record.fields || {}, merchant)
    };
  }

  return null;
}

// What a batch is paying for, as {id, source} pairs. The batch already kept
// the two apart in its own fields, so nothing has to be guessed back.
function batchPaymentTargets(batchFields = {}) {
  return Object.entries(PAYMENT_SOURCES).flatMap(([source, spec]) => {
    const linked = batchFields[spec.batchLinkField];

    return (Array.isArray(linked) ? linked : []).map((id) => ({ id, source }));
  });
}

// One status change, written to whichever field that table calls it. Every
// step of the payment goes through here.
async function setPaymentStatus(targets, status, extraFields = {}) {
  await Promise.all(
    targets.map(({ id, source }) =>
      airtable(PAYMENT_SOURCES[source].table).update(id, {
        [PAYMENT_SOURCES[source].statusField]: status,
        ...extraFields
      })
    )
  );
}

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

    const selected = await Promise.all(
      orderIds.map((orderId) => resolvePaymentRecord(orderId, merchant))
    );

    for (const item of selected) {
      if (!item) {
        return res.status(404).json({
          error: "One of the selected orders no longer exists"
        });
      }

      if (!item.owned) {
        return res.status(403).json({ error: "Not allowed for this merchant" });
      }

      const fields = item.record.fields || {};
      const spec = PAYMENT_SOURCES[item.source];

      if (!PAYABLE_FULFILLMENT_STATUSES.has(displayValue(fields["Fulfillment Status"]))) {
        return res.status(400).json({
          error: "Only orders from Requested Label onward can be paid"
        });
      }

      const reason = UNPAYABLE_STATUS_REASONS[displayValue(fields[spec.statusField])];

      if (reason) {
        return res.status(400).json({ error: reason });
      }
    }

    const total = selected.reduce((sum, item) => {
      const fields = item.record.fields || {};

      const amount = PAYMENT_SOURCES[item.source].amountFields
        .map((field) => eurNumber(fields[field]))
        .find((value) => value > 0) || 0;

      return sum + amount;
    }, 0);

    if (total <= 0) {
      return res.status(400).json({ error: "Total amount is invalid" });
    }

    const orderNumbers = selected
      .map((item) => displayValue(item.record.fields[PAYMENT_SOURCES[item.source].numberField]))
      .filter(Boolean);

    const targets = selected.map((item) => ({
      id: item.record.id,
      source: item.source
    }));

    const batchId = `PB-${Date.now()}`;

    const batchFields = {
      "Store": [merchantId],
      "Order Numbers": orderNumbers.join(", "),
      "Amount": total,
      "Payment Status": "Pending",
      "Payment Provider": "Mollie"
    };

    // Each table has its own link field on the batch, so a payment that
    // covers both kinds stays readable from either side.
    for (const [source, spec] of Object.entries(PAYMENT_SOURCES)) {
      const ids = targets.filter((t) => t.source === source).map((t) => t.id);

      if (ids.length) batchFields[spec.batchLinkField] = ids;
    }

    // A want-to-buy is bought by the store's seller record, and the batch
    // keeps that alongside the store so KC's side can read it too.
    const buyerIds = [
      ...new Set(
        selected
          .filter((item) => item.source === "requests")
          .flatMap((item) => item.record.fields["Buyer Seller ID"] || [])
      )
    ];

    if (buyerIds.length) batchFields["Buyer"] = buyerIds;

    const batch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).create(batchFields);

    const payment = await mollieRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: {
          currency: "EUR",
          value: mollieAmount(total)
        },
        description: `Lojiq ${batchId}`,
        redirectUrl: `${MOLLIE_REDIRECT_URL}?batch=${encodeURIComponent(batch.id)}`,
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

    await setPaymentStatus(targets, "Awaiting Payment", {
      "Payment Link": paymentUrl,
      "Mollie Payment ID": payment.id,
      "Payment Batches": [batch.id]
    });

    ordersCache.clear();
    clearCountsForMerchant(merchantId);

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

app.get("/api/payment-batches/open", async (req, res) => {
  try {
    const merchantId = asText(req.query.merchant_id);

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const records = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE)
      .select({
        filterByFormula: `OR(
          {Payment Status} = 'Awaiting Payment',
          {Payment Status} = 'Pending Payment'
        )`,
        sort: [{ field: "Created At", direction: "desc" }],
        maxRecords: 50
      })
      .firstPage();

    const batches = records
      .filter((record) => linkedRecordIncludes(record.fields["Store"], merchantId))
      .map(normalizePaymentBatch);

    res.json({
      ok: true,
      batches
    });
  } catch (err) {
    console.error("Failed to load open payment batches:", err);

    res.status(500).json({
      error: "Failed to load open payment batches",
      details: err.message
    });
  }
});

app.post("/api/payment-batches/:batchId/mark-pending", async (req, res) => {
  try {
    const batchId = asText(req.params.batchId);

    if (!batchId) {
      return res.status(400).json({ error: "Missing batchId" });
    }

    const batch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).find(batchId);
    const f = batch.fields || {};
    const status = displayValue(f["Payment Status"]);

    if (status === "Paid" || status === "Pending Payment") {
      return res.json({
        ok: true,
        batch: normalizePaymentBatch(batch)
      });
    }

    if (status !== "Awaiting Payment") {
      return res.json({
        ok: true,
        batch: normalizePaymentBatch(batch)
      });
    }

    const updatedBatch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).update(batch.id, {
      "Payment Status": "Pending Payment"
    });

    await setPaymentStatus(batchPaymentTargets(f), "Pending Payment");

    ordersCache.clear();
    countsCache.clear();

    res.json({
      ok: true,
      batch: normalizePaymentBatch(updatedBatch)
    });
  } catch (err) {
    console.error("Mark payment pending failed:", err);

    res.status(500).json({
      error: "Failed to mark payment pending",
      details: err.message
    });
  }
});

app.get("/api/payment-batches/:batchId", async (req, res) => {
  try {
    const batchId = asText(req.params.batchId);

    if (!batchId) {
      return res.status(400).json({ error: "Missing batchId" });
    }

    const batch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).find(batchId);

    res.json({
      ok: true,
      batch: normalizePaymentBatch(batch)
    });
  } catch (err) {
    console.error("Failed to load payment batch:", err);

    res.status(500).json({
      error: "Failed to load payment batch",
      details: err.message
    });
  }
});

app.post("/api/payment-batches/:batchId/cancel", async (req, res) => {
  try {
    const batchId = asText(req.params.batchId);
    const merchantId = asText(req.body.merchant_id);

    if (!batchId) {
      return res.status(400).json({ error: "Missing batchId" });
    }

    if (!merchantId) {
      return res.status(400).json({ error: "Missing merchant_id" });
    }

    const merchant = await getCachedMerchant(merchantId);
    const batch = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).find(batchId);
    const f = batch.fields || {};

    const paymentStatus = displayValue(f["Payment Status"]);
    if (!linkedRecordIncludes(f["Store"], merchantId)) {
      return res.status(403).json({ error: "Not allowed for this merchant" });
    }

    if (paymentStatus !== "Awaiting Payment") {
      return res.status(400).json({
        error: "Only Awaiting Payment batches can be cancelled"
      });
    }

    await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).update(batch.id, {
      "Payment Status": "Cancelled"
    });

    await setPaymentStatus(batchPaymentTargets(f), "Pending");

    ordersCache.clear();
    countsCache.clear();

    res.json({
      ok: true,
      batch_id: batch.id
    });
  } catch (err) {
    console.error("Cancel payment batch failed:", err);

    res.status(500).json({
      error: "Failed to cancel payment batch",
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

    if (!batchRecordId) {
      console.error("Mollie webhook missing metadata:", paymentId, metadata);
      return res.status(200).send("ok");
    }

    // CHANGED - what a payment covers is read from the batch rather than
    // from the metadata, because the batch keeps the two kinds of order
    // apart in its own link fields and the metadata never could.
    //
    // The fallback is for payments that were already in flight when this
    // changed: those carry only order ids, and all of them were orders.
    const batchRecord = await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE)
      .find(batchRecordId)
      .catch(() => null);

    const targets = batchRecord
      ? batchPaymentTargets(batchRecord.fields || {})
      : (Array.isArray(metadata.order_ids) ? metadata.order_ids : []).map((id) => ({
          id,
          source: "orders"
        }));

    if (!targets.length) {
      console.error("Mollie webhook found nothing to settle:", paymentId, batchRecordId);
      return res.status(200).send("ok");
    }

    if (payment.status === "pending") {
      await airtable(AIRTABLE_PAYMENT_BATCHES_TABLE).update(batchRecordId, {
        "Payment Status": "Pending Payment",
        "Mollie Payment ID": payment.id
      });
    
      await setPaymentStatus(targets, "Pending Payment", {
        "Mollie Payment ID": payment.id
      });
    
      ordersCache.clear();
      countsCache.clear();
    
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
    
    await setPaymentStatus(targets, "Paid", {
      "Paid At": paidAt,
      "Mollie Payment ID": payment.id
    });

    ordersCache.clear();
    countsCache.clear();

    res.status(200).send("ok");
  } catch (err) {
    console.error("Mollie webhook failed:", err);
    res.status(500).send("webhook failed");
  }
});

// --------------------------------------------------
// MOLLIE SETTLEMENT PREVIEW
// Read-only: this endpoint does not update Airtable.
// --------------------------------------------------

app.get(
  "/api/admin/mollie/settlements/preview",
  requireAdminSyncSecret,
  async (_req, res) => {
    try {
      const batchIndex = await loadPaymentBatchIndex();

      const settlementsData = await mollieReportingRequest(
        "/settlements?limit=50"
      );

      const completedSettlements = mollieEmbeddedItems(
        settlementsData,
        "settlements"
      );

      let nextSettlement = null;
      let nextSettlementError = "";

      try {
        nextSettlement = await mollieReportingRequest(
          "/settlements/next"
        );
      } catch (err) {
        if (err.statusCode === 404) {
          nextSettlement = null;
        } else {
          nextSettlementError = err.message;
        }
      }

      const uniqueSettlements = new Map();

      for (const settlement of completedSettlements) {
        if (settlement?.id) {
          uniqueSettlements.set(settlement.id, settlement);
        }
      }

      if (nextSettlement?.id) {
        uniqueSettlements.set(
          nextSettlement.id,
          nextSettlement
        );
      }

      const previewSettlements = [];

      for (const settlement of uniqueSettlements.values()) {
        const normalized =
          normalizeSettlementPreview(settlement);

        let payments = [];
        let paymentsError = "";

        try {
          payments = await listAllSettlementPayments(
            normalized.id
          );
        } catch (err) {
          paymentsError = err.message;
        }

        const paymentRows = payments.map((payment) => {
          const paymentId = asText(payment?.id);
          const matchedBatch =
            batchIndex.get(paymentId) || null;

          return {
            mollie_payment_id: paymentId,
            description: asText(payment?.description),
            payment_status: asText(payment?.status),
            method: asText(payment?.method),
            amount: amountNumber(payment?.amount),
            settlement_amount: amountNumber(
              payment?.settlementAmount
            ),
            paid_at: firstMollieDate(
              payment?.paidAt,
              payment?.createdAt
            ),
            matched: !!matchedBatch,
            matched_batch: matchedBatch
          };
        });

        const grossPaymentsAmount = paymentRows.reduce(
          (sum, payment) => sum + payment.amount,
          0
        );

        const settlementPaymentsAmount = paymentRows.reduce(
          (sum, payment) =>
            sum +
            (
              payment.settlement_amount ||
              payment.amount
            ),
          0
        );

        previewSettlements.push({
          ...normalized,
          payment_count: paymentRows.length,
          matched_payment_count: paymentRows.filter(
            (payment) => payment.matched
          ).length,
          unmatched_payment_count: paymentRows.filter(
            (payment) => !payment.matched
          ).length,
          gross_payments_amount:
            Math.round(grossPaymentsAmount * 100) / 100,
          settlement_payments_amount:
            Math.round(settlementPaymentsAmount * 100) / 100,
          payments_error: paymentsError,
          payments: paymentRows,
          raw_settlement: settlement
        });
      }

      previewSettlements.sort((a, b) => {
        const aDate = new Date(
          a.payout_date ||
          a.settled_at ||
          a.created_at ||
          0
        ).getTime();

        const bDate = new Date(
          b.payout_date ||
          b.settled_at ||
          b.created_at ||
          0
        ).getTime();

        return bDate - aDate;
      });

      const unmatchedPayments =
        previewSettlements.flatMap((settlement) =>
          settlement.payments
            .filter((payment) => !payment.matched)
            .map((payment) => ({
              settlement_id: settlement.id,
              ...payment
            }))
        );

      res.json({
        ok: true,
        read_only: true,
        generated_at: isoNow(),
        completed_settlement_count:
          completedSettlements.length,
        next_settlement_found: !!nextSettlement,
        next_settlement_error: nextSettlementError,
        total_unique_settlements:
          previewSettlements.length,
        matched_payment_count:
          previewSettlements.reduce(
            (sum, settlement) =>
              sum + settlement.matched_payment_count,
            0
          ),
        unmatched_payment_count:
          unmatchedPayments.length,
        unmatched_payments: unmatchedPayments,
        settlements: previewSettlements
      });
    } catch (err) {
      console.error(
        "Mollie settlement preview failed:",
        err
      );

      res.status(500).json({
        error: "Failed to preview Mollie settlements",
        details: err.message,
        mollie_response: err.mollieResponse || null
      });
    }
  }
);

// --------------------------------------------------
// MOLLIE SETTLEMENT SYNC
// Writes settlement information to Payment Batches.
// --------------------------------------------------

async function performMollieSettlementSync() {
  const settlementsData = await mollieReportingRequest(
    "/settlements?limit=250"
  );

  const settlements = mollieEmbeddedItems(
    settlementsData,
    "settlements"
  ).filter((settlement) => {
    const settlementId = asText(settlement?.id);

    return settlementId && settlementId !== "next";
  });

  const batchIndex = await loadPaymentBatchIndex();
  const updatesByBatchRecordId = new Map();

  const settlementResults = [];
  const unmatchedPayments = [];
  const amountWarnings = [];
  const settlementErrors = [];
  let skippedBatchCount = 0;

  for (const settlement of settlements) {
    const settlementId = asText(settlement?.id);

    try {
      const payments = await listAllSettlementPayments(
        settlementId
      );

      const financials =
        getSettlementFinancialSummary(settlement);

      const settlementStatus = mapSettlementStatus(
        settlement?.status
      );

      const settlementDate = firstMollieDate(
        settlement?.settledAt,
        settlement?.createdAt
      );

      const payoutDate =
        settlementStatus === "Paid"
          ? firstMollieDate(
              settlement?.paidOutAt,
              settlement?.settledAt
            )
          : "";

      const syncedAt = isoNow();
      let matchedCount = 0;

      for (const payment of payments) {
        const paymentId = asText(payment?.id);
        const matchedBatch =
          batchIndex.get(paymentId) || null;

        if (!matchedBatch) {
          unmatchedPayments.push({
            settlement_id: settlementId,
            mollie_payment_id: paymentId,
            description: asText(payment?.description),
            amount: amountNumber(payment?.amount)
          });

          continue;
        }

        const alreadyFullySynced =
          matchedBatch.current_settlement_id ===
            settlementId &&
          matchedBatch.current_settlement_status ===
            settlementStatus &&
          matchedBatch.current_settlement_reference ===
            asText(settlement?.reference) &&
          !!matchedBatch.settlement_synced_at;

        if (
          alreadyFullySynced &&
          settlementStatus === "Paid"
        ) {
          skippedBatchCount += 1;
          continue;
        }

        matchedCount += 1;

        const paymentAmount = amountNumber(
          payment?.amount
        );

        const batchAmount = Number(
          matchedBatch.amount || 0
        );

        if (
          Math.abs(paymentAmount - batchAmount) > 0.01
        ) {
          amountWarnings.push({
            settlement_id: settlementId,
            mollie_payment_id: paymentId,
            batch_record_id: matchedBatch.record_id,
            batch_id: matchedBatch.batch_id,
            payment_amount: paymentAmount,
            batch_amount: batchAmount
          });
        }

        const fields = {
          "Settlement ID": settlementId,
          "Settlement Reference":
            asText(settlement?.reference),
          "Settlement Status": settlementStatus,
          "Settlement Gross Amount":
            financials.grossAmount,
          "Settlement Fee":
            financials.feeAmount,
          "Settlement Net Amount":
            financials.netAmount,
          "Settlement Invoice Reference":
            financials.invoiceReference,
          "Mollie Settlement Synced At":
            syncedAt
        };

        if (settlementDate) {
          fields["Settlement Date"] = settlementDate;
        }

        if (payoutDate) {
          fields["Settlement Payout Date"] =
            payoutDate;
        }

        updatesByBatchRecordId.set(
          matchedBatch.record_id,
          {
            id: matchedBatch.record_id,
            fields
          }
        );
      }

      settlementResults.push({
        settlement_id: settlementId,
        settlement_reference:
          asText(settlement?.reference),
        mollie_status:
          asText(settlement?.status),
        airtable_status: settlementStatus,
        payment_count: payments.length,
        matched_payment_count: matchedCount,
        unmatched_payment_count:
          payments.length -
          matchedCount -
          payments.filter((payment) => {
            const matchedBatch = batchIndex.get(
              asText(payment?.id)
            );

            return (
              matchedBatch &&
              matchedBatch.current_settlement_id ===
                settlementId &&
              matchedBatch.current_settlement_status ===
                settlementStatus &&
              matchedBatch.current_settlement_reference ===
                asText(settlement?.reference) &&
              !!matchedBatch.settlement_synced_at &&
              settlementStatus === "Paid"
            );
          }).length,
        gross_amount: financials.grossAmount,
        fee_amount: financials.feeAmount,
        net_amount: financials.netAmount,
        invoice_reference:
          financials.invoiceReference,
        settlement_date: settlementDate,
        payout_date: payoutDate
      });
    } catch (err) {
      settlementErrors.push({
        settlement_id: settlementId,
        error: err.message
      });
    }
  }

  const updates = Array.from(
    updatesByBatchRecordId.values()
  );

  const updateChunks = chunkArray(updates, 10);

  for (const chunk of updateChunks) {
    await airtable(
      AIRTABLE_PAYMENT_BATCHES_TABLE
    ).update(chunk);
  }

  return {
    ok: true,
    written: true,
    synced_at: isoNow(),
    settlement_count: settlements.length,
    processed_settlement_count:
      settlementResults.length,
    failed_settlement_count:
      settlementErrors.length,
    updated_batch_count: updates.length,
    skipped_batch_count: skippedBatchCount,
    unmatched_payment_count:
      unmatchedPayments.length,
    amount_warning_count:
      amountWarnings.length,
    settlements: settlementResults,
    unmatched_payments: unmatchedPayments,
    amount_warnings: amountWarnings,
    settlement_errors: settlementErrors
  };
}

app.post(
  "/api/admin/mollie/settlements/sync",
  requireAdminSyncSecret,
  async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: "Confirmation required",
          details:
            "Send JSON body: { \"confirm\": true }"
        });
      }

      const result =
        await performMollieSettlementSync();

      res.json(result);
    } catch (err) {
      console.error(
        "Mollie settlement sync failed:",
        err
      );

      res.status(500).json({
        error:
          "Failed to sync Mollie settlements",
        details: err.message,
        mollie_response:
          err.mollieResponse || null
      });
    }
  }
);

cron.schedule(
  "0 15 * * *",
  async () => {
    console.log(
      "Starting scheduled Mollie settlement sync..."
    );

    try {
      const result =
        await performMollieSettlementSync();

      console.log(
        "Scheduled Mollie settlement sync completed:",
        JSON.stringify({
          updated_batch_count:
            result.updated_batch_count,
          skipped_batch_count:
            result.skipped_batch_count,
          unmatched_payment_count:
            result.unmatched_payment_count,
          amount_warning_count:
            result.amount_warning_count,
          failed_settlement_count:
            result.failed_settlement_count
        })
      );
    } catch (err) {
      console.error(
        "Scheduled Mollie settlement sync failed:",
        err
      );
    }
  },
  {
    timezone: "Europe/Amsterdam",
    noOverlap: true
  }
);

app.listen(PORT, () => {
  console.log(`Lojiq Merchant Portal running on port ${PORT}`);
});

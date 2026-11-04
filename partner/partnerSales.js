// partner/partnerSales.js
//
// The Sales tab: the partner's pairs that WE sold, and what we paid him for
// them (Dario, 04-11-2026).
//
// It reads like an account, never pair by pair:
//   per model   Sold · Paid · To pay, counted, with the sales underneath
//   payments    per bank payment: its total, and per model how many of his
//               pairs and how much
// It never says which pair a payment paid. A pair that comes back already
// paid is swapped for an unpaid pair of the same model and price
// (admin/returns.js partnerSwap): its Payment Note moves to the other unit.
// Counted per model and summed per payment, nothing he sees moves; only a
// "cancelled" line appears, on the day the pair is really back on his shelf.
//
// The data is Airtable's Inventory Units of his Seller ID: a pair we sell
// becomes a unit there, and Payment Status / Payment Note say whether and
// with which bank payment it was paid.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Reserved: sold, not shipped yet (already To Pay in Airtable).
const SOLD = new Set(["Sold", "Returning", "Reserved"]);

/*
 * His pairs came in as partner consignment from 15 Sep 2026. Units made
 * before then are the old deals we bought from him outright, paid off as a
 * separate debt he knows about: never in this tab (Dario, 04-11-2026).
 */
export const PARTNER_SINCE = "2026-09-15";
const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/*
 * What one unit is for him:
 *   sale        sold by us (a pair on its way back still counts: he only sees
 *               it once it is really back)
 *   cancelled   sold, then back on his shelf (Void, with a sales date)
 *   null        not a sale of ours (in stock, forwarded, never sold)
 * A pair that came back paid and became OURS (nothing to swap it with) stays
 * a paid sale for him: Available again, but still Paid with Cancel Status Return.
 */
export function saleKind(fields = {}) {
  const status = text(fields["Availability Status"]);
  if (SOLD.has(status)) return "sale";
  if (status === "Void") return text(fields["Sales Date"]) ? "cancelled" : null;
  if (text(fields["Payment Status"]) === "Paid" && text(first(fields["Cancel Status"])) === "Return") return "sale";
  return null;
}

/*
 * A Payment Note is the bank payment's own code: "1560 (MO20260710)" is a
 * payment of €1,560 with code MO20260710, whose digits are the date as
 * yyyy dd mm (7 Oct 2026). "100" is just an amount; "Myy80-12" has no date.
 */
export function readPaymentNote(note) {
  const raw = text(note);
  const amount = raw.match(/^€?\s*([\d.,]+)/);
  const code = raw.match(/\(([^)]+)\)/)?.[1] || (amount ? "" : raw);
  const total = amount ? Number(amount[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".")) : null;
  const digits = text(code).match(/(20\d{2})(\d{2})(\d{2})/);
  let date = null;
  if (digits) {
    const [, year, day, month] = digits;
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) date = `${year}-${month}-${day}`;
  }
  return { note: raw, total: Number.isFinite(total) ? total : null, code: text(code), date };
}

const amsDay = (stamp) => {
  const date = new Date(stamp);
  if (!stamp || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
};
const saleDay = (unit) => text(first(unit.fields?.["Sales Date"])) || text(unit.createdTime).slice(0, 10);

/*
 * Which shipment (the day his pairs were scanned in) each sale came from, so
 * he can check a payment against his own list per shipment (Dario,
 * 04-11-2026). Airtable's unit does not say; his shelf (partner_stock) does:
 * a sold row there has its size, the day it sold and the day it came in.
 *   1. same model, size and sales day as a sold row: that row's shipment
 *   2. otherwise (a returned pair sold again, a day off): of the shipments
 *      already in on the sales day, the oldest that still has sold rows
 *      nobody matched, else the oldest; sold before any intake: the first.
 * Returns unit id -> shipment day (yyyy-mm-dd).
 */
export function assignShipments(units = [], stockRows = []) {
  const shipments = new Map();
  const pool = new Map();
  const left = new Map();
  for (const row of stockRows) {
    const sku = text(row.sku).toUpperCase();
    const came = amsDay(row.received_at);
    if (!came) continue;
    if (!shipments.has(sku)) shipments.set(sku, new Set());
    shipments.get(sku).add(came);
    if (row.status !== "sold" && row.status !== "reserved") continue;
    const key = `${sku}|${text(row.size)}|${amsDay(row.sold_at)}`;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(came);
  }

  const result = new Map();
  const ordered = [...units].sort((a, b) => saleDay(a).localeCompare(saleDay(b)));
  const rest = [];
  for (const unit of ordered) {
    const sku = text(first(unit.fields?.SKU)).toUpperCase();
    const hit = pool.get(`${sku}|${text(unit.fields?.Size)}|${saleDay(unit)}`);
    if (hit?.length) result.set(unit.id, hit.shift());
    else rest.push(unit);
  }
  for (const [key, list] of pool) for (const came of list) {
    const k = `${key.split("|")[0]}|${came}`;
    left.set(k, (left.get(k) || 0) + 1);
  }
  for (const unit of rest) {
    const sku = text(first(unit.fields?.SKU)).toUpperCase();
    const all = [...(shipments.get(sku) || [])].sort();
    if (!all.length) continue;
    const before = all.filter((day) => day <= saleDay(unit));
    if (!before.length) { result.set(unit.id, all[0]); continue; }
    const open = before.find((day) => (left.get(`${sku}|${day}`) || 0) > 0);
    const pick = open || before[0];
    if (open) left.set(`${sku}|${open}`, left.get(`${sku}|${open}`) - 1);
    result.set(unit.id, pick);
  }
  return result;
}

export function summarizeSales(units = [], images = new Map(), { since = PARTNER_SINCE, shipments = new Map() } = {}) {
  const models = new Map();
  const payments = new Map();

  const modelOf = (fields) => {
    const sku = text(first(fields.SKU)).toUpperCase();
    if (!models.has(sku)) {
      models.set(sku, { sku, name: text(first(fields["Product Name"])) || sku, image: images.get(sku) || "", sold: 0, paid: 0, sold_amount: 0, paid_amount: 0, sales: [], cancelled: [], last: "", byShipment: new Map() });
    }
    return models.get(sku);
  };

  for (const unit of units) {
    const fields = unit.fields || {};
    if (since && text(unit.createdTime) && text(unit.createdTime).slice(0, 10) < since) continue;
    const kind = saleKind(fields);
    if (!kind) continue;

    const model = modelOf(fields);
    const price = round2(fields["Purchase Price"]);
    const day = saleDay(unit);
    const paid = text(fields["Payment Status"]) === "Paid";
    const shipment = shipments.get(unit.id) || "";

    if (kind === "cancelled") {
      model.cancelled.push({ date: day, size: text(fields.Size), shipment });
      continue;
    }

    model.sold += 1;
    model.sold_amount = round2(model.sold_amount + price);
    model.sales.push({ date: day, size: text(fields.Size), price, shipment });
    const perShipment = model.byShipment.get(shipment) || { date: shipment, sold: 0, paid: 0, to_pay: 0, to_pay_amount: 0 };
    perShipment.sold += 1;
    if (paid) perShipment.paid += 1;
    else { perShipment.to_pay += 1; perShipment.to_pay_amount = round2(perShipment.to_pay_amount + price); }
    model.byShipment.set(shipment, perShipment);
    if (day > model.last) model.last = day;

    if (paid) {
      model.paid += 1;
      model.paid_amount = round2(model.paid_amount + price);

      // The payment it is in, counted per model: never which pair. A note
      // without a bank code ("100") is one pair paid on its own: each its
      // own payment, not one big one.
      const note = text(fields["Payment Note"]) || "—";
      const key = readPaymentNote(note).code ? note : `${note}#${text(unit.id) || payments.size}`;
      if (!payments.has(key)) payments.set(key, { ...readPaymentNote(note), pairs: 0, amount: 0, models: new Map(), last: "" });
      const payment = payments.get(key);
      payment.pairs += 1;
      payment.amount = round2(payment.amount + price);
      if (day > payment.last) payment.last = day;
      const line = payment.models.get(model.sku) || { sku: model.sku, name: model.name, pairs: 0, amount: 0, byShipment: new Map() };
      line.pairs += 1;
      line.amount = round2(line.amount + price);
      line.byShipment.set(shipment, (line.byShipment.get(shipment) || 0) + 1);
      payment.models.set(model.sku, line);
    }
  }

  const modelList = [...models.values()]
    .map(({ byShipment, ...model }) => ({
      ...model,
      shipments: [...byShipment.values()].sort((a, b) => a.date.localeCompare(b.date)),
      to_pay: model.sold - model.paid,
      to_pay_amount: round2(model.sold_amount - model.paid_amount),
      sales: model.sales.sort((a, b) => b.date.localeCompare(a.date)),
      cancelled: model.cancelled.sort((a, b) => b.date.localeCompare(a.date))
    }))
    .sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name));

  // Newest first: by the payment's own date, else by its newest sale.
  const paymentList = [...payments.values()]
    .map(({ models: perModel, last, ...payment }) => ({ ...payment, sort: payment.date || last, models: [...perModel.values()].sort((a, b) => b.pairs - a.pairs).map(({ byShipment, ...line }) => ({ ...line, shipments: [...byShipment].map(([date, pairs]) => ({ date, pairs })).sort((a, b) => a.date.localeCompare(b.date)) })) }))
    .sort((a, b) => text(b.sort).localeCompare(text(a.sort)))
    .map(({ sort, ...payment }) => payment);

  return {
    to_pay: modelList.reduce((sum, model) => sum + model.to_pay, 0),
    to_pay_amount: round2(modelList.reduce((sum, model) => sum + model.to_pay_amount, 0)),
    sold: modelList.reduce((sum, model) => sum + model.sold, 0),
    paid: modelList.reduce((sum, model) => sum + model.paid, 0),
    models: modelList,
    payments: paymentList
  };
}

const UNIT_FIELDS = ["SKU", "Product Name", "Size", "Purchase Price", "Availability Status", "Payment Status", "Payment Note", "Sales Date", "Cancel Status"];

/*
 * deps: airtable (base, as services.airtable), db (for the pictures his
 * shelf already has). Cached a minute per partner: Airtable is slow and he
 * opens the tab often.
 */
export function createPartnerSales({ airtable, db, table = "Inventory Units", cacheMs = 60_000, now = Date.now }) {
  const cache = new Map();

  async function images(sellerId) {
    const map = new Map();
    for (let offset = 0; ; offset += 1000) {
      const page = (await db.get(`partner_stock?select=sku,image_url&seller_id=eq.${encodeURIComponent(sellerId)}&image_url=not.is.null&order=id.asc&limit=1000&offset=${offset}`)) || [];
      for (const row of page) if (!map.has(text(row.sku).toUpperCase())) map.set(text(row.sku).toUpperCase(), text(row.image_url));
      if (page.length < 1000) return map;
    }
  }

  // His whole shelf, for the shipment each sale came from.
  async function shelf(sellerId) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = (await db.get(`partner_stock?select=sku,size,status,sold_at,received_at&seller_id=eq.${encodeURIComponent(sellerId)}&order=id.asc&limit=1000&offset=${offset}`)) || [];
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  async function load(sellerId) {
    const hit = cache.get(sellerId);
    if (hit && now() - hit.at < cacheMs) return hit.value;

    const safe = text(sellerId).replace(/"/g, "");
    const units = await airtable(table).select({
      filterByFormula: `AND(FIND("${safe}", ARRAYJOIN({Seller ID})), IS_AFTER(CREATED_TIME(), "${dayBefore(PARTNER_SINCE)}"), OR({Availability Status} = "Sold", {Availability Status} = "Returning", {Availability Status} = "Reserved", {Availability Status} = "Void", {Payment Status} = "Paid"))`,
      fields: UNIT_FIELDS
    }).all();

    const list = units.map((u) => ({ id: u.id, fields: u.fields, createdTime: u._rawJson?.createdTime || u.createdTime }));
    const [pictures, rows] = await Promise.all([images(sellerId).catch(() => new Map()), shelf(sellerId).catch(() => [])]);
    const value = summarizeSales(list, pictures, { shipments: assignShipments(list, rows) });
    cache.set(sellerId, { at: now(), value });
    return value;
  }

  return { load };
}

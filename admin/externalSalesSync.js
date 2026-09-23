// admin/externalSalesSync.js
//
// What every External Sales module shares: the rules (which VAT a pair is
// sold under, what a deal is worth, what its shipping status is), the way to
// talk to Supabase, and the queue that keeps two edits to one deal apart.
//
// Supabase holds everything since block 9 (23-09-2026). The Airtable External
// Sales Log is read-only history: the deals from before still carry their
// airtable_record_id, and their Inventory Units still link to that row, but
// nothing reads it or writes to it any more.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
export const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;




export const dealId = (sale) => `EXTD-${String(sale?.deal_number ?? "").padStart(6, "0")}`;

/* ---------------- rules ---------------- */

/*
 * The VAT a pair is sold under, from how it was bought.
 *
 * A margin pair is always sold under the margin scheme. Anything else is 21%,
 * unless the buyer is a business abroad with a VAT id: then it is 0% (VAT
 * reverse-charged). A private buyer abroad pays 21%.
 */
export function sellingVatType(purchaseVatType, buyer = {}) {
  if (purchaseVatType === "Margin") return "Margin";
  if (!purchaseVatType) return null;

  const abroad = text(buyer.buyer_country_code) && text(buyer.buyer_country_code).toUpperCase() !== "NL";
  return abroad && text(buyer.buyer_vat_id) ? "VAT0" : "VAT21";
}

/*
 * The money on one deal. Same formula as the external_sales_money view.
 *
 * Selling excl. VAT per pair when every pair has its own price, otherwise from
 * the deal total and the one VAT type all its pairs share. A deal with mixed
 * VAT types and no prices per pair cannot be split: it gets no profit rather
 * than a wrong one.
 */
// Margin VAT is over the margin only; the tile says so.
function vatLabel(types) {
  const set = new Set(types.filter(Boolean));
  if (set.size === 1 && set.has("Margin")) return "VAT on the margin";
  if (set.size === 1 && set.has("VAT0")) return "VAT (0%, reverse-charged)";
  if (set.size === 1 && set.has("VAT21")) return "VAT 21%";
  return "VAT";
}

export function saleMoney(sale, pairs) {
  const purchase = round2(pairs.reduce((sum, pair) => sum + Number(pair.purchase_price_ex_vat || 0), 0));
  const shipping = round2(sale.shipping_costs);
  const pricedPerPair = pairs.length > 0 && pairs.every((pair) => pair.selling_price !== null && pair.selling_price !== undefined && pair.selling_vat_type);

  const exVat = (amount, vat, cost) =>
    vat === "VAT21" ? amount / 1.21
      // No VAT on a negative margin: a loss stays the whole loss.
      : vat === "Margin" ? amount - (Math.max(0, amount - cost) * 21) / 121
        : vat === "VAT0" ? amount
          : null;

  let sellingExVat = null;

  if (pricedPerPair) {
    sellingExVat = pairs.reduce((sum, pair) => sum + exVat(Number(pair.selling_price), pair.selling_vat_type, Number(pair.purchase_price_ex_vat || 0)), 0);
  } else if (sale.legacy_selling_vat_type) {
    sellingExVat = exVat(Number(sale.total_selling_price || 0), sale.legacy_selling_vat_type, purchase);
  }

  return {
    pairs: pairs.length,
    selling: round2(sale.total_selling_price),
    selling_ex_vat: sellingExVat === null ? null : round2(sellingExVat),
    purchase,
    shipping,
    profit: sellingExVat === null ? null : round2(sellingExVat - shipping - purchase),
    priced_per_pair: pricedPerPair,
    vat_label: vatLabel(pricedPerPair ? pairs.map((p) => p.selling_vat_type) : [sale.legacy_selling_vat_type])
  };
}

/*
 * A label file name reduced to what survives being copied: no deal number
 * prefix, no extension, letters and digits only. "label_astro (5).pdf" and
 * "EXTD-000069-label_astro__5_.pdf" are the same label.
 */
export function labelKey(name) {
  let base = text(name).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  let previous = null;

  while (previous !== base) {
    previous = base;
    base = base.replace(/^extd-?\d{6}[-_ ]*/, "");
  }

  return base.replace(/[^a-z0-9]/g, "");
}

// What the sale's shipping status is from its parcels. Shipped, delivered
// and cancelled are never undone by an edit: a parcel removed after the
// fact does not make a deal unshipped.
export function shippingStatusFor({ current, cancelled, parcels }) {
  if (cancelled) return "cancelled";
  if (current === "shipped" || current === "delivered") return current;
  return parcels > 0 ? "ready_to_ship" : "pending";
}

/* ---------------- Supabase ---------------- */

export class ExternalSalesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createSupabaseRest({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  async function request(pathAndQuery, { method = "GET", body, prefer = "" } = {}) {
    if (!configured) throw new ExternalSalesError("External Sales needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this service.", 503);

    const response = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });

    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;

    if (!response.ok) throw new ExternalSalesError(text(data?.message) || `Supabase answered ${response.status}.`, 502);
    return data;
  }

  return {
    configured,
    get: (path) => request(path),
    insert: (table, rows, prefer = "return=representation") => request(table, { method: "POST", body: rows, prefer }),
    patch: (path, fields) => request(path, { method: "PATCH", body: fields, prefer: "return=representation" }),
    remove: (path) => request(path, { method: "DELETE" })
  };
}


/* ---------------- one edit at a time ---------------- */

/*
 * Every change to a deal runs on its own, one after another: two edits at
 * once could each read the parcels, each write, and leave the deal's shipping
 * status decided by whichever finished last.
 *
 * deps:
 *   db  createSupabaseRest
 */
export function createExternalSalesEdits({ db }) {
  let chain = Promise.resolve();

  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  }

  /*
   * change(sale, parcels) changes what it has to; afterwards the deal's
   * shipping status is worked out again from the parcels it now has, so a
   * first label makes it Ready to Ship and removing the last one takes that
   * back.
   */
  function edit(sale, change) {
    return exclusive(async () => {
      const parcels = await db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`);
      await change(sale, parcels);

      const after = await db.get(`shipments?select=*&external_sale_id=eq.${sale.id}&order=created_at.asc`);
      const [fresh] = await db.get(`external_sales?select=*&id=eq.${sale.id}`);
      const status = shippingStatusFor({ current: fresh.shipping_status, cancelled: fresh.payment_status === "cancelled", parcels: after.length });

      if (status === fresh.shipping_status) return fresh;

      const [saved] = await db.patch(`external_sales?id=eq.${fresh.id}`, {
        shipping_status: status,
        ...(status === "shipped" && !fresh.shipped_at ? { shipped_at: new Date().toISOString() } : {})
      });

      return saved;
    });
  }

  return { edit };
}

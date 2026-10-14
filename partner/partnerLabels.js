// partner/partnerLabels.js
//
// Labels we make on Sendcloud for a partner's own parcels: parcels he sends
// himself, not forwards from our shelf. He asks for one (or we enter it for
// him), we make the labels from our own sender address with the carrier he
// chose, he downloads them, and he pays us afterwards - the price is filled
// in later and counts with his forwarding fees.
//
// The addresses he ships to are kept apart from his buyers: a delivery
// address has no VAT number and is often not where the invoice goes.
//
// The labels themselves are made by the WMS (/api/partner-labels/create),
// which holds the Sendcloud keys and the courier rules; this keeps the
// request, the result and the money.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

export const CARRIERS = ["UPS", "DPD"];
export const MAX_BOXES = 20;
export const MAX_PAIRS = 500;

/*
 * The countries we invoice and ship to, the same 31 the Kickz Caviar portal
 * keeps (lib/countries.js), with the two-letter code Sendcloud wants.
 */
export const COUNTRIES = [
  ["Austria", "AT"], ["Belgium", "BE"], ["Bulgaria", "BG"], ["Croatia", "HR"], ["Cyprus", "CY"],
  ["Czech Republic", "CZ"], ["Denmark", "DK"], ["Estonia", "EE"], ["Finland", "FI"], ["France", "FR"],
  ["Germany", "DE"], ["Greece", "GR"], ["Hungary", "HU"], ["Ireland", "IE"], ["Italy", "IT"],
  ["Latvia", "LV"], ["Lithuania", "LT"], ["Luxembourg", "LU"], ["Malta", "MT"], ["Netherlands", "NL"],
  ["Poland", "PL"], ["Portugal", "PT"], ["Romania", "RO"], ["Slovakia", "SK"], ["Slovenia", "SI"],
  ["Spain", "ES"], ["Sweden", "SE"], ["Norway", "NO"], ["Switzerland", "CH"], ["United Kingdom", "GB"],
  ["Iceland", "IS"]
].map(([name, code]) => ({ name, code }));

const CODES = new Set(COUNTRIES.map((c) => c.code));

export class LabelError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const labelId = (row) => `LBL-${String(row?.label_number ?? "").padStart(6, "0")}`;

// Street and number as a carrier wants them. "Teubnerstrasse 14" with number
// 14 would print the number twice, and a whole street typed as the number
// ("Teubnerstrasse 14" twice) is no number at all: the number is taken from
// the end of the street then.
const NUMBER = /^\d+\s*[a-z]?(?:\s*[-/]\s*\d+\s*[a-z]?)?$/i;

export function splitStreet(street, number) {
  let s = text(street);
  let n = text(number);

  if (!NUMBER.test(n)) {
    const tail = s.match(/^(.*?)[\s,]+(\d+\s*[a-z]?(?:\s*[-/]\s*\d+\s*[a-z]?)?)$/i);
    if (tail && (!n || n.toLowerCase() === s.toLowerCase())) return { street: tail[1], house_number: tail[2] };
    return { street: s, house_number: n };
  }

  if (s.toLowerCase().endsWith(n.toLowerCase())) {
    const before = s.slice(0, s.length - n.length);
    if (before && /[\s,]$/.test(before)) s = before.replace(/[\s,]+$/, "");
  }
  return { street: s, house_number: n };
}

export const streetOnly = (street, number) => splitStreet(street, number).street;

// An address as typed, checked for what a label needs.
export function cleanAddress(input = {}) {
  const row = {
    name: text(input.name),
    company: text(input.company),
    ...splitStreet(input.street, input.house_number),
    address2: text(input.address2),
    postal_code: text(input.postal_code),
    city: text(input.city),
    country: text(input.country).toUpperCase(),
    phone: text(input.phone),
    email: text(input.email).toLowerCase()
  };

  const missing = [];
  if (!row.name && !row.company) missing.push("name", "company");
  if (!row.street) missing.push("street");
  if (!row.house_number) missing.push("house_number");
  if (!row.postal_code) missing.push("postal_code");
  if (!row.city) missing.push("city");
  if (!CODES.has(row.country)) missing.push("country");
  if (!row.phone) missing.push("phone");
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) missing.push("email");

  return { row, missing };
}

// The same address twice is the same street, number, postcode and country.
const plain = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
export const addressKey = (a) => [a.street, a.house_number, a.postal_code, a.country].map(plain).join("|");

export function cleanBoxes(input) {
  const boxes = (Array.isArray(input) ? input : [])
    .map((box) => ({ weight_kg: Math.round(Number(String(box?.weight_kg ?? "").replace(",", ".")) * 100) / 100 }));

  if (!boxes.length) throw new LabelError("no_boxes");
  if (boxes.length > MAX_BOXES) throw new LabelError("too_many_boxes");
  if (boxes.some((box) => !(box.weight_kg > 0) || box.weight_kg > 70)) throw new LabelError("bad_weight");

  return boxes;
}

/*
 * What the partner asks for: how many labels and how many pairs in total
 * (Dario, 13-10-2026). He does not weigh boxes; we fill in the weight per
 * box when we approve it, and may change the number of labels then.
 */
export function cleanPartnerAsk(input = {}) {
  const count = Number(input.labels_count);
  const pairs = Number(input.pairs);
  if (!Number.isInteger(count) || count < 1) throw new LabelError("no_boxes");
  if (count > MAX_BOXES) throw new LabelError("too_many_boxes");
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > MAX_PAIRS) throw new LabelError("bad_pairs");
  return { boxes: Array.from({ length: count }, () => ({ weight_kg: null })), pairs };
}

// A box still without a weight cannot go to Sendcloud.
export const boxesReady = (boxes) => (boxes || []).length > 0 && boxes.every((b) => Number(b?.weight_kg) > 0);

// A label as the partner may see it: no internal notes, no errors.
export function partnerView(row) {
  return {
    id: row.id,
    number: labelId(row),
    created_at: row.created_at,
    status: row.status === "failed" ? "requested" : row.status,
    carrier: row.carrier,
    boxes: (row.boxes || []).length,
    pairs: row.pairs ?? null,
    ship_to: [text(row.address?.company) || text(row.address?.name), text(row.address?.city), text(row.address?.country)].filter(Boolean).join(", "),
    labels: (row.labels || []).map((l) => ({ box: l.box, tracking: l.tracking })),
    reject_reason: row.reject_reason || "",
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    paid: row.payment_status === "paid"
  };
}

/*
 * deps:
 *   db        createSupabaseRest
 *   callWms   (path, body) -> WMS answer, with the internal secret; resolves
 *             even on a refusal, as { status, data }
 */
export function createPartnerLabels({ db, callWms, now = () => new Date() }) {
  async function load(id) {
    if (!text(id)) throw new LabelError("not_found", 404);
    const [row] = await db.get(`partner_labels?select=*&id=eq.${encodeURIComponent(text(id))}`);
    if (!row) throw new LabelError("not_found", 404);
    return row;
  }

  const save = async (id, fields) => {
    const [row] = await db.patch(`partner_labels?id=eq.${encodeURIComponent(text(id))}`, { ...fields, updated_at: now().toISOString() });
    return row;
  };

  async function addresses(sellerRecordId) {
    return db.get(`partner_addresses?select=*&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&order=created_at.desc&limit=500`);
  }

  // A new address, or the one he already has at that street and number.
  async function addAddress(sellerRecordId, input) {
    const { row, missing } = cleanAddress(input);
    if (missing.length) throw new LabelError("address_missing", 400, { fields: missing });

    const same = (await addresses(sellerRecordId)).find((a) => addressKey(a) === addressKey(row));
    if (same) return same;

    const [made] = await db.insert("partner_addresses", [{ seller_record_id: sellerRecordId, ...row }]);
    return made;
  }

  /*
   * A request for labels: an address he has (address_id) or a new one
   * (address), a carrier, and the boxes with their weights.
   */
  async function request({ sellerRecordId, sellerId, requestedBy, input }) {
    if (!CARRIERS.includes(text(input?.carrier).toUpperCase())) throw new LabelError("no_carrier");

    // The partner gives a count of labels and pairs; we give weights.
    let boxes;
    let pairs = null;
    if (input?.labels_count !== undefined) ({ boxes, pairs } = cleanPartnerAsk(input));
    else {
      boxes = cleanBoxes(input?.boxes);
      const given = Number(input?.pairs);
      if (Number.isInteger(given) && given > 0 && given <= MAX_PAIRS) pairs = given;
    }

    let address;
    if (text(input?.address_id)) {
      [address] = await db.get(`partner_addresses?select=*&id=eq.${encodeURIComponent(text(input.address_id))}&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}`);
      if (!address) throw new LabelError("address_unknown");
    } else {
      address = await addAddress(sellerRecordId, input?.address || {});
    }

    const snapshot = { ...address };
    delete snapshot.id;
    delete snapshot.seller_record_id;
    delete snapshot.created_at;

    const [row] = await db.insert("partner_labels", [{
      seller_record_id: sellerRecordId,
      seller_id: sellerId,
      address_id: address.id,
      address: snapshot,
      carrier: text(input.carrier).toUpperCase(),
      boxes,
      pairs,
      status: "requested",
      requested_by: requestedBy,
      note: text(input?.note) || null,
      payment_status: "pending"
    }]);

    console.log(`[partner-labels] ${labelId(row)} for ${sellerId}: ${row.carrier}, ${boxes.length} box(es) to ${snapshot.country}, by ${requestedBy}`);
    return row;
  }

  const wmsBody = (row, dry) => ({ reference: labelId(row), carrier: row.carrier, address: { ...row.address, ...splitStreet(row.address?.street, row.address?.house_number) }, boxes: row.boxes, dry });

  // What Sendcloud would do with it - method per box and its quoted price -
  // without making anything.
  async function check(id) {
    const row = await load(id);
    const { status, data } = await callWms("/api/partner-labels/create", wmsBody(row, true));
    if (status >= 400 || !data?.ok) throw new LabelError("sendcloud_refused", 502, { reason: data?.error || `WMS answered ${status}` });
    return data;
  }

  /*
   * Makes the labels. Labels made before a box failed are kept on the row
   * (they exist, and are paid for); running it again makes only the boxes
   * that have none yet.
   */
  async function create(id) {
    const row = await load(id);
    if (!["requested", "failed"].includes(row.status)) throw new LabelError("not_open");
    if (!boxesReady(row.boxes)) throw new LabelError("no_weights");

    const done = row.labels || [];
    const left = (row.boxes || []).map((box, i) => ({ ...box, box: i + 1 })).filter((box) => !done.some((l) => l.box === box.box));

    const { status, data } = await callWms("/api/partner-labels/create", { ...wmsBody(row, false), boxes: left });
    const made = (data?.labels || []).map((l, i) => ({ ...l, box: left[i]?.box ?? l.box }));
    const labels = [...done, ...made].sort((a, b) => a.box - b.box);

    if (status >= 400 || !data?.ok) {
      const saved = await save(id, {
        status: "failed",
        labels,
        tracking_numbers: labels.map((l) => l.tracking),
        error: text(data?.error) || `WMS answered ${status}`
      });
      throw new LabelError("sendcloud_refused", 502, { reason: saved.error, row: saved });
    }

    return save(id, {
      status: "created",
      labels,
      tracking_numbers: labels.map((l) => l.tracking),
      error: null,
      created_label_at: now().toISOString()
    });
  }

  /*
   * The boxes as we approve them: how many labels, and the weight of each.
   * Boxes that already have a label (a run that failed halfway) keep theirs.
   */
  async function setBoxes(id, input) {
    const row = await load(id);
    if (!["requested", "failed"].includes(row.status)) throw new LabelError("not_open");

    const boxes = cleanBoxes(input);
    const made = (row.labels || []).length;
    if (boxes.length < made) throw new LabelError("fewer_than_made");

    return save(id, { boxes });
  }

  async function reject(id, reason) {
    const row = await load(id);
    if (row.status !== "requested") throw new LabelError("not_open");
    if (!text(reason)) throw new LabelError("no_reason");
    return save(id, { status: "rejected", reject_reason: text(reason) });
  }

  async function setPrice(id, value) {
    await load(id);
    const price = value === "" || value === null || value === undefined ? null : round2(String(value).replace(",", "."));
    if (price !== null && (!(price >= 0) || price > 10000)) throw new LabelError("bad_price");
    return save(id, { price });
  }

  async function setPaid(id, paid) {
    const row = await load(id);
    if (paid && (row.price === null || row.price === undefined)) throw new LabelError("no_price");
    return save(id, paid ? { payment_status: "paid", paid_at: now().toISOString() } : { payment_status: "pending", paid_at: null });
  }

  async function list({ sellerRecordId = "" } = {}) {
    const seller = sellerRecordId ? `&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}` : "";
    return db.get(`partner_labels?select=*${seller}&order=created_at.desc&limit=1000`);
  }

  // The partners there are, for the admin's "new label" form.
  async function partners() {
    const rows = await db.get("partner_users?select=seller_record_id,seller_id,name&active=eq.true");
    const seen = new Map();
    for (const r of rows || []) if (!seen.has(r.seller_record_id)) seen.set(r.seller_record_id, { seller_record_id: r.seller_record_id, seller_id: r.seller_id, name: r.name });
    return [...seen.values()];
  }

  return { load, list, addresses, addAddress, request, check, create, setBoxes, reject, setPrice, setPaid, partners };
}

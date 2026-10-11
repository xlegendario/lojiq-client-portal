// partner/partnerBuyers.js
//
// The partner's own buyers, for the invoice on a forward.
//
// There is one list of buyers (public.buyers, owned by the Kickz Caviar
// portal); a partner sees only the ones linked to him in partner_buyers, so
// he never sees our customers. A new buyer is made through the Kickz Caviar
// portal's own create, which refuses a second buyer with the same VAT number
// or email; when it does, that existing buyer is linked to the partner
// instead, silently, so no duplicate is made in the list or in Rompslomp.
//
// Two more checks catch what VAT and email cannot:
//   - among his own buyers, a name or postcode that looks the same asks him
//     "Is this the same buyer?" before anything is made
//   - against everyone else's buyers, the first invoice to a new buyer that
//     looks like one we have waits until Dario says same or different
//     (similarBuyer, used by the invoicing).

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const COUNTRIES_CACHE_MS = 60 * 60_000;

export class BuyerError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// Letters and digits only, so "Sneaker-Shop B.V." and "sneakershop bv" meet.
const plain = (value) => text(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

// Legal forms say nothing about who a buyer is.
const LEGAL = /(bv|nv|vof|gmbh|ltd|limited|llc|inc|sarl|srl|spa|sl|ab|oy|as|aps|kft|sro|spzoo|ug|ek|co)$/;
const nameKey = (value) => plain(value).replace(LEGAL, "");

export function buyerLabel(buyer) {
  const company = text(buyer?.company_name);
  const person = text(buyer?.full_name);
  return company && person ? `${company} (${person})` : company || person;
}

// What the page gets: enough to recognise and check the buyer.
export function buyerOption(buyer) {
  return {
    id: text(buyer.id),
    label: buyerLabel(buyer),
    email: text(buyer.email),
    city: text(buyer.city),
    country: text(buyer.country)
  };
}

/*
 * A buyer in `others` that is probably the same business as `buyer`: the
 * same name (legal form aside), or the same postcode in the same country
 * with a name that starts the same. Never the buyer itself.
 */
export function similarBuyer(others, buyer) {
  const names = [nameKey(buyer.company_name), nameKey(buyer.full_name)].filter((n) => n.length >= 3);
  const zip = plain(buyer.zipcode);
  const country = text(buyer.country_code).toUpperCase() || plain(buyer.country);

  for (const other of others || []) {
    if (text(other.id) && text(other.id) === text(buyer.id)) continue;

    const otherNames = [nameKey(other.company_name), nameKey(other.full_name)].filter((n) => n.length >= 3);
    if (names.some((n) => otherNames.includes(n))) return other;

    const otherCountry = text(other.country_code).toUpperCase() || plain(other.country);
    const sameStart = names.some((n) => otherNames.some((o) => n.slice(0, 4) === o.slice(0, 4)));
    if (zip && zip === plain(other.zipcode) && country && country === otherCountry && sameStart) return other;
  }

  return null;
}

// What the form sent, trimmed. The Kickz Caviar portal validates it in full.
export function cleanBuyerInput(input = {}) {
  const row = {
    company_name: text(input.company_name),
    full_name: text(input.full_name),
    email: text(input.email).toLowerCase(),
    vat_id: text(input.vat_id),
    address: text(input.address),
    address_line_2: text(input.address_line_2),
    zipcode: text(input.zipcode),
    city: text(input.city),
    country: text(input.country)
  };

  const missing = [];
  if (!row.company_name && !row.full_name) missing.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) missing.push("email");
  // A company is invoiced with its VAT number (Dario, 11-10-2026).
  if (row.company_name && !row.vat_id) missing.push("vat_id");
  if (!row.address) missing.push("address");
  if (!row.zipcode) missing.push("zipcode");
  if (!row.city) missing.push("city");
  if (!row.country) missing.push("country");

  return { row, missing };
}

/*
 * deps:
 *   db       createSupabaseRest
 *   callKc   (path, body) -> Kickz Caviar portal, internal secret; rejects
 *            with { status, data } on a refusal
 */
export function createPartnerBuyers({ db, callKc, now = Date.now }) {
  let countries = { at: 0, list: [] };

  async function own(sellerRecordId) {
    const links = await db.get(`partner_buyers?select=buyer_id,duplicate_checked_at&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}`);
    if (!links?.length) return [];

    const ids = links.map((l) => `"${l.buyer_id}"`).join(",");
    const buyers = await db.get(`buyers?select=*&id=in.(${ids})`);
    return (buyers || []).sort((a, b) => buyerLabel(a).localeCompare(buyerLabel(b), "en", { sensitivity: "base" }));
  }

  async function link(sellerRecordId, buyerId) {
    const [existing] = await db.get(
      `partner_buyers?select=buyer_id&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&buyer_id=eq.${buyerId}`
    );
    if (!existing) await db.insert("partner_buyers", [{ seller_record_id: sellerRecordId, buyer_id: buyerId }], "return=minimal");
  }

  // The countries an invoice can go to, as the Kickz Caviar portal knows them.
  async function countryList() {
    if (countries.list.length && now() - countries.at < COUNTRIES_CACHE_MS) return countries.list;

    const data = await callKc("/api/internal/buyers/list", {});
    countries = { at: now(), list: Array.isArray(data.countries) ? data.countries : [] };
    return countries.list;
  }

  async function list(sellerRecordId) {
    const [buyers, names] = await Promise.all([own(sellerRecordId), countryList().catch(() => countries.list)]);
    return { buyers: buyers.map(buyerOption), countries: names };
  }

  /*
   * A new buyer for the partner. Returns { buyer } when made or linked, or
   * { same } when one of his own buyers looks like it - the page then asks,
   * and sends again with confirm_new when he says it is someone else.
   */
  async function create(sellerRecordId, input) {
    const { row, missing } = cleanBuyerInput(input);
    if (missing.length) throw new BuyerError("buyer_missing", 400, { fields: missing });

    if (!input.confirm_new) {
      const same = similarBuyer(await own(sellerRecordId), { ...row, country_code: "" });
      if (same) return { same: buyerOption(same) };
    }

    let made;

    try {
      made = await callKc("/api/internal/buyers/create", row);
    } catch (err) {
      // The same VAT number or email is a buyer already: link that one.
      if (err.status === 409 && err.data?.existing?.id) {
        await link(sellerRecordId, err.data.existing.id);
        const [buyer] = await db.get(`buyers?select=*&id=eq.${err.data.existing.id}`);
        console.log(`[partner] ${sellerRecordId} linked to existing buyer ${err.data.existing.buyer_id}`);
        return { buyer: buyerOption(buyer || { id: err.data.existing.id, company_name: row.company_name, full_name: row.full_name }) };
      }

      if (err.status === 400) throw new BuyerError("buyer_refused", 400, { reasons: err.data?.errors || [] });
      throw err;
    }

    await link(sellerRecordId, made.option.id);
    const [buyer] = await db.get(`buyers?select=*&id=eq.${made.option.id}`);
    return { buyer: buyerOption(buyer) };
  }

  /*
   * Whether an invoice to this buyer must wait for Dario: only the first time,
   * and only when the buyer looks like one of ours that is not linked to the
   * partner. Returns the look-alike, or null (and remembers it checked).
   */
  async function duplicateCheck(sellerRecordId, buyerId) {
    const seller = encodeURIComponent(sellerRecordId);
    const [linkRow] = await db.get(`partner_buyers?select=duplicate_checked_at&seller_record_id=eq.${seller}&buyer_id=eq.${buyerId}`);
    if (!linkRow) throw new BuyerError("buyer_unknown", 400);
    if (linkRow.duplicate_checked_at) return null;

    const [buyer] = await db.get(`buyers?select=*&id=eq.${buyerId}`);
    const everyone = await db.get("buyers?select=id,company_name,full_name,zipcode,country,country_code&limit=5000");
    const ownIds = new Set((await own(sellerRecordId)).map((b) => b.id));
    const lookAlike = similarBuyer(everyone.filter((b) => !ownIds.has(b.id)), buyer);

    if (!lookAlike) await markChecked(sellerRecordId, buyerId);
    return lookAlike;
  }

  async function markChecked(sellerRecordId, buyerId) {
    await db.patch(
      `partner_buyers?seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&buyer_id=eq.${buyerId}`,
      { duplicate_checked_at: new Date(now()).toISOString() }
    );
  }

  async function owns(sellerRecordId, buyerId) {
    if (!/^[0-9a-f-]{36}$/i.test(text(buyerId))) return false;
    const [row] = await db.get(`partner_buyers?select=buyer_id&seller_record_id=eq.${encodeURIComponent(sellerRecordId)}&buyer_id=eq.${buyerId}`);
    return Boolean(row);
  }

  return { list, create, link, owns, duplicateCheck, markChecked };
}

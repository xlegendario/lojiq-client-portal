// admin/adminBrokerDeals.js
//
// Broker deals: one buyer, several pairs, bought from consignors as the
// deal is made (02-10-2026).
//
// A broker stands between two people who do not work here. He agrees a
// price with a buyer and a price with whoever is holding the pair, and
// neither number is ever worked out from the other - that is the whole
// job. So both are his to type, and nothing in here computes one from the
// other.
//
// The deal IS an External Sale. While pairs are still being agreed it sits
// on stage "negotiating" and stays out of every existing screen; the
// moment the first pair is confirmed it becomes an ordinary sale and the
// invoicing, payment and shipping that already exist take it from there.
//
// The consignor round itself belongs to the Kickz Caviar portal, which
// owns public.consignment_offers and the Discord side of it. Offering,
// answering and closing all go back there, so a broker's round travels
// exactly the road every other consignment offer travels.

import express from "express";

import { pairFromUnit } from "./externalSalesCreate.js";
import { dealId, sellingVatType, shippingStatusFor } from "./externalSalesSync.js";
import { CLOCK_HOURS, dealDeadline } from "./adminPartnerDeals.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const first = (value) => (Array.isArray(value) ? value[0] : value);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

export class BrokerDealsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/*
 * What a line is waiting on, in the broker's words.
 *
 * The line's own status says where it is before an offer exists; after
 * that the round decides, because the consignor's answer is what moves it.
 */
export const LINE_STATES = {
  draft: { say: "Not offered yet", yours: true, offerable: true },
  open: { say: "Waiting for him", yours: false, stoppable: true },
  store_pending: { say: "He countered", yours: true, stoppable: true },
  partner_agreed: { say: "Agreed, not closed", yours: true, closable: true, stoppable: true },
  /*
   * Taken out of the market, not bought.
   *
   * Nobody else can sell it and nothing is owed yet. It asks nothing of
   * the broker either - the next move is confirming the deal, which is
   * about all of them at once, not about this pair.
   */
  locked: { say: "Locked", yours: false, stoppable: true },
  processing: { say: "Closing…", yours: false },
  accepted: { say: "Bought", yours: false, done: true },
  denied: { say: "He declined", yours: true, offerable: true },
  store_denied: { say: "You declined", yours: true, offerable: true },
  closed: { say: "Closed", yours: false },
  cancelled: { say: "Dropped", yours: false },
  expired: { say: "Expired", yours: true, offerable: true }
};

export const UNIT_FIELDS = [
  "Item ID", "SKU", "Size", "Product Name", "Picture", "VAT Type",
  "Final Purchase Price", "Final Purchase Price (ex. VAT)"
];

/*
 * One line of a deal, with its round folded in.
 *
 * The round leads once it exists: a line that was offered is wherever the
 * consignor left it, and only a line without a live round falls back on
 * its own status.
 */
export function lineRow(line, offer = null, previous = null) {
  // The round decides while there is one. A line whose round ended goes
  // back to draft with its offer cleared, so there is nothing to prefer.
  //
  // Except once the pair is locked: the haggling is over, the round is
  // only history, and what the line says is what is true.
  const locked = text(line.status) === "locked";
  const key = locked ? "locked" : offer ? text(offer.status) : text(line.status);

  const state = LINE_STATES[key] || { say: key || "—", yours: false };

  // What we would pay if it goes through: his counter when he made one,
  // otherwise what we put to him.
  const payout = offer
    ? round2(offer.consignor_counter_price || offer.offer_price)
    : round2(line.payout);

  const buyerPrice = round2(line.buyer_price);

  return {
    id: text(line.id),
    sale_id: text(line.sale_id),
    sku: text(line.sku).toUpperCase(),
    size: text(line.size),
    product_name: text(line.product_name) || text(offer?.product_name),
    brand: text(line.brand) || text(offer?.brand),
    image_url: text(line.image_url),
    vat_filter: text(line.vat_filter) || "all",

    offer_id: text(line.offer_id),
    seller_id: text(offer?.seller_id),
    seller_record_id: text(offer?.seller_record_id),
    party: "",
    vat_type: text(offer?.vat_type),

    /*
     * What he last asked for, from before we countered under it.
     *
     * Only while our counter is still out: once he has answered it there
     * is a live number again, and falling back on a dead one would be
     * taking a price he has moved on from.
     */
    fallback: offer && text(offer.status) === "open" && round2(previous?.consignor_counter_price) > 0
      ? round2(previous.consignor_counter_price)
      : null,

    asks: offer ? round2(offer.seller_price) : null,
    offered: offer ? round2(offer.offer_price) : round2(line.payout),
    countered: offer?.consignor_counter_price ? round2(offer.consignor_counter_price) : null,
    payout,
    buyer_price: buyerPrice,
    margin: buyerPrice > 0 && payout > 0 ? round2(buyerPrice - payout) : null,

    status: key,
    state: state.say,
    // Off the consignor's stock, not yet bought.
    locked,
    // Whether the broker is the one holding this up, and what he owes it.
    yours: state.yours === true,
    offerable: state.offerable === true,
    closable: state.closable === true,
    stoppable: state.stoppable === true,
    done: state.done === true,

    inventory_unit_record_id: text(line.inventory_unit_record_id),
    due_at: offer ? dealDeadline(offer) : null,
    extended: Boolean(text(offer?.extended_until)),
    created_at: text(line.created_at) || null
  };
}

/*
 * The deal as one line in the list.
 *
 * Counted rather than listed, because the list answers one question: which
 * of my deals needs me right now.
 */
export function dealRow(sale, lines = []) {
  /*
   * Locked counts as in.
   *
   * It is what the broker means when he says he has three of the five: the
   * pair is his, nobody else can sell it, and the only thing left is
   * saying the deal is done. Whether the purchase is already booked is a
   * question about bookkeeping, not about the deal.
   */
  const bought = lines.filter((line) => line.done || line.locked);
  const live = lines.filter((line) => !line.done && !line.locked && line.status !== "cancelled");

  return {
    id: text(sale.id),
    deal_id: dealId(sale),
    deal_number: Number(sale.deal_number) || 0,
    stage: text(sale.stage) || "open",
    buyer: text(sale.buyer_company) || text(sale.buyer_name) || "—",
    buyer_uuid: text(sale.buyer_uuid),
    // A deal running on a name alone. Everything works except the invoice,
    // which needs an address to be made out to.
    needs_buyer: !text(sale.buyer_uuid),
    pairs: lines.length,
    bought: bought.length,
    waiting: live.length,
    yours: lines.filter((line) => line.yours).length,
    // Only what is really bought counts as money: a pair still being
    // haggled over is not revenue and must not read as any.
    selling: round2(bought.reduce((sum, line) => sum + (line.buyer_price || 0), 0)),
    paying: round2(bought.reduce((sum, line) => sum + (line.payout || 0), 0)),
    /*
     * Whether the broker can draw the line now: something has to be bought,
     * and nothing may be halfway through being bought.
     */
    confirmable: text(sale.stage) !== "open" &&
      bought.length > 0 &&
      Boolean(text(sale.buyer_uuid)) &&
      !lines.some((line) => line.status === "processing"),
    payment_status: text(sale.payment_status),
    shipping_status: text(sale.shipping_status),
    bookkeeping_status: text(sale.bookkeeping_status),
    note: text(sale.notes),
    created_at: text(sale.created_at) || null
  };
}

export const VIEWS = {
  yours: (row) => row.yours > 0,
  running: (row) => row.waiting > 0,
  done: (row) => row.waiting === 0 && row.pairs > 0,
  all: () => true
};

/*
 * deps:
 *   db        createSupabaseRest - external_sales, deal_lines, consignment_offers
 *   airtable  byIds - Sellers Database, Inventory Units
 *   tellKickz  posts to the KC portal's broker endpoints
 *   signupUrl  where a buyer signs up, so he can do this himself next time.
 *              A function, because the services it is built from are wired
 *              up after this store is made.
 */
export function createBrokerDealsStore({ db, airtable, tellKickz = null, signupUrl = null }) {
  const whereToSignUp = () => text(typeof signupUrl === "function" ? signupUrl() : signupUrl);

  const kickz = (path, body) => {
    if (!tellKickz) throw new BrokerDealsError("Kickz Caviar is not reachable from this service.", 503);
    return tellKickz(path, body);
  };

  async function loadSale(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id))) throw new BrokerDealsError("Which deal?", 400);

    const [sale] = await db.get(`external_sales?select=*&id=eq.${text(id)}`);

    if (!sale) throw new BrokerDealsError("That deal does not exist.", 404);
    if (text(sale.kind) !== "broker") throw new BrokerDealsError("That deal is not a broker deal.", 409);

    return sale;
  }

  // A line plus the round it is in, which is what every action needs.
  async function loadLine(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id))) throw new BrokerDealsError("Which pair?", 400);

    const [line] = await db.get(`deal_lines?select=*&id=eq.${text(id)}`);

    if (!line) throw new BrokerDealsError("That pair is not part of a deal.", 404);

    const [offer] = line.offer_id
      ? await db.get(`consignment_offers?select=*&id=eq.${line.offer_id}`)
      : [];

    const [previous] = offer?.previous_offer_id
      ? await db.get(`consignment_offers?select=*&id=eq.${offer.previous_offer_id}`)
      : [];

    return { line, offer: offer || null, row: lineRow(line, offer || null, previous || null) };
  }

  async function linesOf(saleIds) {
    if (!saleIds.length) return new Map();

    const inList = saleIds.map((id) => `"${id}"`).join(",");
    const lines = await db.get(`deal_lines?select=*&sale_id=in.(${inList})&order=created_at.asc`);

    const offerIds = [...new Set(lines.map((line) => text(line.offer_id)).filter(Boolean))];

    const offers = offerIds.length
      ? await db.get(`consignment_offers?select=*&id=in.(${offerIds.map((id) => `"${id}"`).join(",")})`)
      : [];

    /*
     * And the round before it, where there is one: a counter of ours
     * replaced his, and his number is the one we may still want.
     */
    const earlierIds = [...new Set(offers.map((offer) => text(offer.previous_offer_id)).filter(Boolean))];

    const earlier = earlierIds.length
      ? await db.get(`consignment_offers?select=*&id=in.(${earlierIds.map((id) => `"${id}"`).join(",")})`)
      : [];

    const byId = new Map(offers.map((offer) => [text(offer.id), offer]));
    const earlierById = new Map(earlier.map((offer) => [text(offer.id), offer]));
    const out = new Map();

    for (const line of lines) {
      const key = text(line.sale_id);
      const offer = byId.get(text(line.offer_id)) || null;

      if (!out.has(key)) out.set(key, []);
      out.get(key).push(lineRow(line, offer, earlierById.get(text(offer?.previous_offer_id)) || null));
    }

    return out;
  }

  // Who the consignors actually are, for the few rows on screen.
  async function withNames(rows) {
    const ids = [...new Set(rows.map((row) => row.seller_record_id).filter((id) => /^rec[A-Za-z0-9]{14}$/.test(id)))];

    const sellers = ids.length
      ? await airtable.byIds("Sellers Database", ids, ["Seller ID", "Full Name", "Company Name"]).catch(() => new Map())
      : new Map();

    for (const row of rows) {
      const seller = sellers.get(row.seller_record_id);
      row.party = seller
        ? text(seller["Company Name"]) || text(seller["Full Name"]) || text(seller["Seller ID"])
        : row.seller_id;
    }

    return rows;
  }

  async function list({ view = "yours", q = "", limit = 200 } = {}) {
    const wanted = Math.min(Math.max(Number(limit) || 200, 10), 1000);
    const needle = text(q).toUpperCase();

    const sales = await db.get(
      `external_sales?select=*&kind=eq.broker&order=deal_number.desc&limit=${wanted}`
    );

    const byDeal = await linesOf(sales.map((sale) => text(sale.id)));
    const all = sales.map((sale) => dealRow(sale, byDeal.get(text(sale.id)) || []));

    const counts = { all: all.length };
    for (const [name, pick] of Object.entries(VIEWS)) counts[name] = all.filter(pick).length;

    let chosen = all.filter(VIEWS[text(view)] || VIEWS.all);

    if (needle) {
      chosen = chosen.filter((row) => {
        const lines = byDeal.get(row.id) || [];

        return row.buyer.toUpperCase().includes(needle) ||
          row.deal_id.includes(needle) ||
          lines.some((line) => line.sku.includes(needle) || line.product_name.toUpperCase().includes(needle));
      });
    }

    // The ones holding him up first, newest within that.
    chosen.sort((a, b) => Number(b.yours > 0) - Number(a.yours > 0) || b.deal_number - a.deal_number);

    return { deals: chosen, counts, totals: { deals: chosen.length } };
  }

  async function count() {
    const { counts } = await list({ view: "all", limit: 1000 });
    return { yours: counts.yours };
  }

  async function get(id) {
    const sale = await loadSale(id);
    const lines = (await linesOf([text(sale.id)])).get(text(sale.id)) || [];

    return {
      deal: dealRow(sale, lines),
      lines: await withNames(lines),
      clock_hours: CLOCK_HOURS,
      /*
       * The whole point of brokering a deal: the buyer who liked it should
       * be buying for himself next time. The link is the one that already
       * works; matching his new account back to this buyer is still done
       * by hand, and belongs with the buyer sign-up when that is built.
       */
      signup_url: whereToSignUp(),
      buyer_email: text(sale.buyer_email)
    };
  }

  /* ---------------- making one ---------------- */

  /*
   * An empty deal, on a buyer.
   *
   * Deliberately not through the External Sales maker: that one makes a
   * finished sale out of pairs we already own, and a broker has none yet.
   * This is the other order - the buyer first, the pairs as they are won.
   */
  /*
   * A buyer as the sale holds him.
   *
   * Asked for WITH his Airtable row, which is what makes one if he has none
   * yet. It is not the invoice that needs it - that reads the buyer by uuid
   * - but invoicePlanFor refuses a deal whose buyer_record_id is empty, so
   * a deal made without it could never be invoiced. Rather than loosen a
   * guard the whole of External Sales runs on, the row is made here, the
   * same way a forward asks for one.
   */
  async function buyerFields(buyerId) {
    const answer = await kickz("/api/internal/buyers/get", { id: text(buyerId), with_airtable: true })
      .catch(() => null);

    const buyer = answer?.buyer;

    /*
     * His id, not just an answer. A reply that comes back shaped right but
     * empty would otherwise be written onto the sale as a buyer with no
     * id - and the deal would read as having one while nothing could be
     * invoiced to it.
     */
    if (!buyer || !/^[0-9a-f-]{36}$/i.test(text(buyer.id))) {
      throw new BrokerDealsError("That buyer does not exist.", 404);
    }

    return {
      buyer_record_id: buyer.airtable_record_id || null,
      buyer_uuid: buyer.id,
      buyer_id: `BU-${String(buyer.buyer_number).padStart(5, "0")}`,
      buyer_name: text(buyer.full_name) || text(buyer.company_name) || null,
      buyer_company: text(buyer.company_name) || null,
      buyer_email: text(buyer.email) || null,
      buyer_country: text(buyer.country) || null,
      buyer_country_code: text(buyer.country_code) || null,
      buyer_vat_id: text(buyer.vat_id) || null
    };
  }

  /*
   * A deal can begin on a name alone.
   *
   * The invoice address of someone new only arrives once the deal is
   * struck - that is simply when people hand it over - and demanding it up
   * front would mean no deal could be started with a buyer we have not
   * sold to before. So the name stands in until there is a real buyer, and
   * the one place that cannot do without one refuses on its own:
   * invoicePlanFor. Offering, buying and being paid all work meanwhile.
   */
  async function create({ buyerId, buyerName = "", note = "" } = {}) {
    const known = /^[0-9a-f-]{36}$/i.test(text(buyerId));
    const named = text(buyerName);

    if (!known && !named) throw new BrokerDealsError("Who is the buyer?");

    const buyer = known
      ? await buyerFields(buyerId)
      : { buyer_name: named, buyer_uuid: null, buyer_record_id: null, buyer_id: null };

    const [sale] = await db.insert("external_sales", [{
      kind: "broker",
      stage: "negotiating",

      ...buyer,

      sale_date: new Date().toISOString().slice(0, 10),
      total_selling_price: 0,
      shipping_costs: 0,

      payment_status: "pending",
      payment_method: "bank_transfer",
      shipping_status: "pending",
      // Nothing to invoice until a pair is actually bought, and a deal that
      // nags for an invoice it cannot have is noise in Checks.
      bookkeeping_status: "not_invoiced",

      notes: text(note) || null
    }]);

    return { id: sale.id, deal_id: dealId(sale) };
  }

  /*
   * The buyer, once he is known.
   *
   * Everything on the sale that names him is rewritten, because the
   * invoice, the VAT route and the reminder all read it from there.
   */
  async function attachBuyer({ saleId, buyerId } = {}) {
    const sale = await loadSale(saleId);

    if (!/^[0-9a-f-]{36}$/i.test(text(buyerId))) throw new BrokerDealsError("Choose the buyer.");

    if (text(sale.bookkeeping_status) === "invoiced") {
      throw new BrokerDealsError("This deal is already invoiced; the buyer cannot be swapped.", 409);
    }

    const fields = await buyerFields(buyerId);

    await db.patch(`external_sales?id=eq.${sale.id}`, { ...fields, updated_at: new Date().toISOString() });

    return { ok: true, buyer: fields.buyer_company || fields.buyer_name };
  }

  /*
   * A buyer who is not in the list yet.
   *
   * Made through the portal that owns the table, so it is the same
   * validation and the same duplicate check - on VAT number and on email -
   * that the outbound in the WMS runs. A second row for one business is
   * how the six duplicates of 22-09 came about.
   */
  async function createBuyer(input = {}) {
    const out = await kickz("/api/internal/buyers/create", input || {});

    if (out?.ok === false) {
      throw new BrokerDealsError((out.errors || ["That buyer could not be saved."]).join(" "), 400);
    }

    // The list is a buyer longer now.
    return { ok: true, option: out?.option || null };
  }

  /*
   * A pair the buyer wants.
   *
   * Both prices are typed, and the only rule between them is the one that
   * is always true: we cannot pay more than we are paid. The payout is
   * checked against the holder's asking price when the offer goes out, not
   * here - the stock moves, and a line may sit for an hour.
   */
  async function addLine({ saleId, sku, size, buyerPrice, payout, vatFilter = "all", productName = "", brand = "", imageUrl = "" } = {}) {
    const sale = await loadSale(saleId);

    if (text(sale.stage) !== "negotiating" && text(sale.payment_status) === "paid") {
      throw new BrokerDealsError("This deal is paid; start a new one for anything extra.", 409);
    }

    const style = text(sku).toUpperCase();
    const which = text(size);

    if (!style || !which) throw new BrokerDealsError("Which pair, and which size?");

    const buyer = Number(buyerPrice);
    const owed = Number(payout);

    if (!(owed > 0)) throw new BrokerDealsError("What are we paying for it?");

    if (buyer > 0 && !(buyer > owed)) {
      throw new BrokerDealsError(
        `${round2(buyer)} does not cover the ${round2(owed)} we would pay for it.`
      );
    }

    if (!["all", "margin", "b2b"].includes(text(vatFilter))) {
      throw new BrokerDealsError("Margin only, B2B only, or all stock.");
    }

    /*
     * What the pair is, from the stock itself.
     *
     * A broker types a SKU and a size; the name, the brand and the picture
     * are already known by whoever is holding it. Looked up now so the
     * line reads as a shoe from the moment it is added, instead of as a
     * code until somebody answers.
     */
    const holders = await db.get(
      `consignment_inventory?select=product_name,brand,image_url&sku=eq.${encodeURIComponent(style)}` +
      `&size=eq.${encodeURIComponent(which)}&quantity=gt.0&limit=1`
    ).catch(() => []);

    const [line] = await db.insert("deal_lines", [{
      sale_id: sale.id,
      sku: style,
      size: which,
      product_name: text(productName) || text(holders[0]?.product_name) || null,
      brand: text(brand) || text(holders[0]?.brand) || null,
      image_url: text(imageUrl) || text(holders[0]?.image_url) || null,
      vat_filter: text(vatFilter),
      buyer_price: buyer > 0 ? round2(buyer) : null,
      payout: round2(owed),
      status: "draft"
    }]);

    return lineRow(line, null);
  }

  // Only before anything was asked of a consignor. Once a round is out it
  // is dropped, not deleted - somebody is holding a pair on our word.
  async function removeLine(lineId) {
    const { line, row } = await loadLine(lineId);

    if (row.status !== "draft") {
      throw new BrokerDealsError(`That pair is already out with ${row.party || "a consignor"}. Drop it instead.`, 409);
    }

    await db.remove(`deal_lines?id=eq.${line.id}`);

    return { ok: true };
  }

  /*
   * What the buyer pays, and what we are willing to pay.
   *
   * Changeable up to the moment the pair is bought, because that is how
   * this job works: the buyer comes back with a better offer elsewhere and
   * the broker has to be able to follow it without the consignor's side
   * moving at all.
   */
  async function priceLine({ lineId, buyerPrice, payout } = {}) {
    const { line, row } = await loadLine(lineId);

    const fields = { updated_at: new Date().toISOString() };

    if (buyerPrice !== undefined && buyerPrice !== null && buyerPrice !== "") {
      const buyer = Number(buyerPrice);

      if (!(buyer > 0)) throw new BrokerDealsError("What does the buyer pay?");

      // Against what this pair will really cost: his counter if he made
      // one, otherwise what he was offered.
      if (!(buyer > row.payout)) {
        throw new BrokerDealsError(
          `${round2(buyer)} does not cover the ${round2(row.payout)} going to ${row.party || row.seller_id || "the consignor"}.`
        );
      }

      fields.buyer_price = round2(buyer);
    }

    if (payout !== undefined && payout !== null && payout !== "") {
      if (row.status !== "draft") {
        throw new BrokerDealsError("A pair that is already out can only be countered, not re-priced.", 409);
      }

      const owed = Number(payout);

      if (!(owed > 0)) throw new BrokerDealsError("What are we paying for it?");

      fields.payout = round2(owed);
    }

    await db.patch(`deal_lines?id=eq.${line.id}`, fields);

    // A bought pair carries its price on the sale as well, where the
    // invoice reads it.
    if (row.done && fields.buyer_price) await syncSale(line.sale_id);

    return { ok: true, ...fields };
  }

  /* ---------------- the consignor round ---------------- */

  /*
   * Everything that is waiting to go out, out.
   *
   * One call per line rather than one for the deal, because each line goes
   * to whoever is cheapest on that pair - which is rarely the same person.
   */
  async function submit(saleId) {
    const sale = await loadSale(saleId);
    const lines = await db.get(`deal_lines?select=*&sale_id=eq.${sale.id}&status=eq.draft&order=created_at.asc`);

    if (!lines.length) throw new BrokerDealsError("Nothing here is waiting to be offered.", 409);

    const out = [];

    for (const line of lines) {
      const result = await kickz("/api/internal/broker/offer", { deal_line_id: line.id })
        .catch((err) => ({ ok: false, error: err.message }));

      out.push({
        line_id: line.id,
        sku: text(line.sku),
        size: text(line.size),
        ok: result?.ok !== false,
        seller_id: text(result?.seller_id),
        offered: result?.offered ?? null,
        error: result?.ok === false ? text(result.error) : ""
      });
    }

    return { sent: out.filter((row) => row.ok).length, lines: out };
  }

  /*
   * Answering the consignor, through the portal that owns the round.
   *
   * Nothing about the round is written here: that portal closes it, tells
   * him, and moves the line on. Doing any of it from this side would be a
   * second set of rules that drifts from the first.
   */
  async function answer({ lineId, action, price, buyerPrice } = {}) {
    const { line, offer, row } = await loadLine(lineId);

    if (action === "price") {
      return { ...(await priceLine({ lineId, buyerPrice })), did: "priced", seller_id: row.seller_id };
    }

    if (action === "offer") {
      if (!row.offerable) throw new BrokerDealsError(`Nothing to offer: ${row.state.toLowerCase()}.`, 409);

      const result = await kickz("/api/internal/broker/offer", { deal_line_id: line.id });

      return { ok: true, did: "offered", seller_id: text(result.seller_id), payout: result.offered };
    }

    if (!offer) throw new BrokerDealsError("Nothing has been offered on this pair yet.", 409);

    const offerId = encodeURIComponent(text(offer.id));

    if (action === "extend") {
      if (!row.due_at) throw new BrokerDealsError(`Nothing is running out: ${row.state.toLowerCase()}.`, 409);

      const until = new Date(Date.now() + CLOCK_HOURS * 3_600_000).toISOString();

      await db.patch(`consignment_offers?id=eq.${text(offer.id)}`, {
        extended_until: until,
        updated_at: new Date().toISOString()
      });

      return { ok: true, did: "extended", until, seller_id: row.seller_id };
    }

    /*
     * Settling for what he last asked.
     *
     * Our counter is still out with him and he is not answering. The ten
     * euros between us are worth less than the pair, so the earlier round
     * is taken at his own number - and our counter closes with it.
     */
    if (action === "fallback") {
      if (!(row.fallback > 0)) {
        throw new BrokerDealsError("There is no earlier price of his to fall back on.", 409);
      }

      const result = await kickz("/api/internal/broker/accept-previous", { deal_line_id: line.id });

      return { ok: true, did: "fellback", payout: Number(result?.payout) || row.fallback, seller_id: row.seller_id };
    }

    if (action === "discard") {
      if (!row.stoppable) throw new BrokerDealsError(`Nothing to drop: ${row.state.toLowerCase()}.`, 409);

      // A locked pair goes back on his stock first: dropping it without
      // that would leave him holding something he can no longer sell.
      if (row.locked) await kickz("/api/internal/broker/unlock", { deal_line_id: line.id });

      const result = await kickz("/api/internal/partner-deal/discard", { offer_id: text(offer.id) });

      return { ok: true, did: "discarded", told: result?.told_consignor === true, seller_id: row.seller_id };
    }

    /*
     * Taking the pair out of the market.
     *
     * The consignor said yes a while ago; this is the broker saying he
     * wants it. The pair comes off the consignment stock so nowhere else
     * can sell it, and nothing is bought - that waits for the deal to be
     * confirmed, which is the moment there is a sale to buy it for.
     *
     * The buyer price is not optional even so: it is what the margin is
     * checked against, and locking a pair that cannot be sold at a profit
     * is how a deal quietly loses money.
     */
    if (action === "finalize") {
      if (!row.closable) throw new BrokerDealsError(`Nothing to close: ${row.state.toLowerCase()}.`, 409);

      const buyer = buyerPrice === undefined || buyerPrice === null || buyerPrice === ""
        ? row.buyer_price
        : Number(buyerPrice);

      if (!(buyer > 0)) throw new BrokerDealsError("What does the buyer pay?");

      if (!(buyer > row.payout)) {
        throw new BrokerDealsError(
          `${round2(buyer)} does not cover the ${round2(row.payout)} going to ${row.party || row.seller_id}.`
        );
      }

      await kickz("/api/internal/broker/lock", {
        deal_line_id: line.id,
        buyer_price: round2(buyer)
      });

      return {
        ok: true,
        did: "locked",
        payout: row.payout,
        buyer_price: round2(buyer),
        seller_id: row.seller_id
      };
    }

    if (!row.yours) throw new BrokerDealsError(`Nothing to answer: ${row.state.toLowerCase()}.`, 409);

    if (action === "accept") {
      await kickz(`/api/consignment/offers/${offerId}/store-accept`, {});
      return { ok: true, did: "agreed", payout: row.payout, seller_id: row.seller_id };
    }

    if (action === "deny") {
      await kickz(`/api/consignment/offers/${offerId}/store-deny`, {});
      return { ok: true, did: "declined", seller_id: row.seller_id };
    }

    if (action === "counter") {
      const whole = Number(price);

      // The portal takes whole euros only. Caught here so the broker is
      // told before the round is touched.
      if (!Number.isInteger(whole) || whole <= 0) {
        throw new BrokerDealsError("A counter is a whole number of euros.");
      }

      await kickz(`/api/consignment/offers/${offerId}/store-counter`, { price: whole });
      return { ok: true, did: "countered", payout: whole, seller_id: row.seller_id };
    }

    throw new BrokerDealsError("Accept, counter or decline.");
  }

  /* ---------------- getting the pairs off the consignors' shelves ---------------- */

  /*
   * What is still to come in, per consignor.
   *
   * A broker's pairs are bought from whoever was holding each one, so a deal
   * of four pairs can be four people - and one of them may be holding three
   * of them. Those three are one parcel on one label, and that is the whole
   * reason this is grouped rather than listed: a consignor who is sent three
   * identical labels will put three boxes in the post.
   *
   * The consignor behind a pair is known through its line's round, because
   * external_sale_pairs has no seller of its own - by the time a pair is on
   * a sale it is ours, and who we bought it from is the purchase's business.
   */
  async function shipments(saleId) {
    const sale = await loadSale(saleId);
    const lines = (await linesOf([text(sale.id)])).get(text(sale.id)) || [];
    const bought = await withNames(lines.filter((line) => line.done && line.inventory_unit_record_id));

    if (!bought.length) return { deal: dealRow(sale, lines), groups: [] };

    const pairs = await db.get(
      `external_sale_pairs?select=*&sale_id=eq.${sale.id}&cancelled_at=is.null`
    );

    /*
     * And what the carrier says about each box.
     *
     * His parcel goes straight to the buyer, so it is a shipment of this
     * sale like any other and Aftership follows it. Matched on the
     * tracking number, which is the only thing the two sides share.
     */
    const parcels = await db.get(
      `shipments?select=tracking_number,status,shipped_at,delivered_at,tracking_detail&external_sale_id=eq.${sale.id}`
    ).catch(() => []);

    const byTracking = new Map((parcels || []).map((parcel) => [text(parcel.tracking_number), parcel]));

    const pairByUnit = new Map(pairs.map((pair) => [text(pair.inventory_unit_record_id), pair]));
    const groups = new Map();

    /*
     * One entry per parcel, not per consignor.
     *
     * Everything he still has to be given a label for is one entry with no
     * shipment group yet; each label already sent is its own. Usually that
     * means one of each at most - but a buyer can want two pairs at two
     * addresses, and then the same man sends two parcels.
     */
    for (const line of bought) {
      const pair = pairByUnit.get(line.inventory_unit_record_id);
      const parcel = text(pair?.shipment_group);
      const key = `${line.seller_record_id || line.seller_id || "unknown"}|${parcel}`;

      if (!groups.has(key)) {
        groups.set(key, {
          seller_record_id: line.seller_record_id,
          seller_id: line.seller_id,
          party: line.party,
          pairs: [],
          // Filled from the first pair that has them: a parcel shares one
          // label, one tracking number and one step.
          step: "",
          label_url: "",
          tracking_url: "",
          shipment_group: ""
        });
      }

      const group = groups.get(key);

      group.pairs.push({
        line_id: line.id,
        pair_id: text(pair?.id),
        sku: line.sku,
        size: line.size,
        product_name: line.product_name,
        payout: line.payout,
        item_id: text(pair?.item_id)
      });

      if (pair) {
        group.step = group.step || text(pair.consignor_fulfillment_status);
        group.label_url = group.label_url || text(pair.consignor_label_url);
        group.tracking_url = group.tracking_url || text(pair.consignor_tracking_url);
        group.shipment_group = group.shipment_group || text(pair.shipment_group);
        group.shipped = text(pair.consignor_shipping_status) === "Shipped";
      }
    }

    for (const group of groups.values()) {
      const parcel = byTracking.get(text(group.tracking_url));

      group.parcel_status = text(parcel?.status);
      group.delivered_at = text(parcel?.delivered_at) || null;
      group.tracking_detail = text(parcel?.tracking_detail) || "";

      // The carrier knows better than we do: a scan means it is really
      // gone, whatever the broker did or did not tick.
      if (group.parcel_status === "delivered" || group.parcel_status === "shipped") group.shipped = true;
    }

    return { deal: dealRow(sale, lines), groups: [...groups.values()] };
  }

  /*
   * One label for everything this consignor is sending.
   *
   * The label and the tracking go on every pair in the group, and so does
   * the group's own number - which is what his dashboard collapses the rows
   * on, so he sees "3 pairs, one parcel" instead of the same label three
   * times.
   *
   * He is told on Discord as well. The portal owns that conversation, so
   * the message goes out through it.
   */
  async function shipConsignor({ saleId, sellerRecordId, pairIds = null, label = null, labelUrl = "", tracking = "" } = {}) {
    const { deal, groups } = await shipments(saleId);
    const his = groups.filter((row) => row.seller_record_id === text(sellerRecordId));

    if (!his.length) throw new BrokerDealsError("Nothing on this deal is coming from that consignor.", 404);

    const waiting = his.find((row) => !row.shipment_group);

    if (!waiting) throw new BrokerDealsError("Everything of his on this deal already has a label.", 409);

    /*
     * Which of his pairs go in this one.
     *
     * All of them unless the broker picked some, which is how two pairs
     * end up at two addresses: he sends one label for the first, and the
     * second stays behind waiting for its own.
     */
    const wanted = Array.isArray(pairIds) && pairIds.length
      ? pairIds.map((id) => text(id)).filter(Boolean)
      : null;

    const group = wanted
      ? { ...waiting, pairs: waiting.pairs.filter((pair) => wanted.includes(text(pair.pair_id))) }
      : waiting;

    if (!group.pairs.length) throw new BrokerDealsError("None of those pairs is his to send.", 404);

    const url = label?.data ? await storeLabel({ deal, group, file: label }) : text(labelUrl);

    if (!/^https?:\/\//i.test(url)) throw new BrokerDealsError("Upload the label, or paste a link to it.");

    const number = text(tracking);

    if (!number) throw new BrokerDealsError("What is the tracking number?");

    // Numbered when he is sending more than one: two parcels from the
    // same man on the same deal must not share a name, or his dashboard
    // folds them back into one.
    const sent = groups.filter((row) => row.seller_record_id === text(sellerRecordId) && row.shipment_group).length;
    const base = `SHIP-${String(deal.deal_number).padStart(6, "0")}-${text(sellerRecordId).slice(-4)}`;
    const name = sent ? `${base}-${sent + 1}` : base;
    const now = new Date().toISOString();

    for (const pair of group.pairs) {
      if (!pair.pair_id) continue;

      await db.patch(`external_sale_pairs?id=eq.${pair.pair_id}`, {
        consignor_fulfillment_status: "Ready to Ship",
        consignor_label_url: url,
        consignor_tracking_url: number,
        shipment_group: name
      });
    }

    /*
     * And the parcel itself, as a shipment of this sale.
     *
     * He posts it straight to the buyer, so his box IS the sale's box: one
     * row per parcel, which is what Aftership follows and what the deal
     * reads its own shipping status from. Without it the pairs would carry
     * a tracking number nothing ever looks at, and a deal with two boxes
     * out would sit on Pending for good.
     *
     * Several parcels is nothing new here - an ordinary sale has had one
     * row per box all along, each with its own delivered moment.
     */
    await db.insert("shipments", [{
      external_sale_id: deal.id,
      tracking_number: number,
      label_url: url,
      label_filename: text(label?.name) || null,
      airtable_attachment_id: null
    }]).catch((err) => {
      console.error(`[admin broker deals] ${name} was not added as a shipment:`, err.message);
    });

    /*
     * And the deal follows its boxes, by the rule External Sales already
     * has: a first parcel makes it Ready to Ship. Borrowed rather than
     * rewritten - two places deciding what "shipped" means is how they end
     * up disagreeing.
     */
    const parcels = await db.get(`shipments?select=id&external_sale_id=eq.${deal.id}`).catch(() => []);
    const [fresh] = await db.get(`external_sales?select=*&id=eq.${deal.id}`);

    if (fresh) {
      const status = shippingStatusFor({
        current: text(fresh.shipping_status),
        cancelled: text(fresh.payment_status) === "cancelled",
        parcels: parcels.length
      });

      if (status !== text(fresh.shipping_status)) {
        await db.patch(`external_sales?id=eq.${fresh.id}`, { shipping_status: status, updated_at: new Date().toISOString() });
      }
    }

    /*
     * Non-blocking: the label is on the pairs by now and he can see it in
     * his dashboard. A message that will not send must not undo that, but
     * it does have to be findable.
     */
    const told = await kickz("/api/internal/broker/label-ready", {
      sale_id: deal.id,
      seller_record_id: text(sellerRecordId),
      deal_id: deal.deal_id,
      label_url: url,
      tracking: number,
      pairs: group.pairs.map((pair) => ({ sku: pair.sku, size: pair.size, product_name: pair.product_name }))
    }).then((out) => out?.ok === true).catch((err) => {
      console.error(`[admin broker deals] ${group.seller_id} was not told about his label:`, err.message);
      return false;
    });

    return { ok: true, shipment_group: name, pairs: group.pairs.length, told, at: now };
  }

  /*
   * The label itself, in the same bucket the want-to-buy labels live in.
   *
   * A consignor downloads it from his dashboard, so it has to be reachable
   * without a login - which is what that bucket already is.
   */
  async function storeLabel({ deal, group, file }) {
    const name = text(file.name) || "label.pdf";
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-80);
    const path = `broker-labels/${deal.deal_id}/${Date.now()}-${safe}`;

    const answer = await db.upload(path, file.data, file.type || "application/pdf");

    if (!answer) throw new BrokerDealsError("The label could not be stored.", 502);

    return answer;
  }

  /*
   * Taking a label back.
   *
   * The buyer changed his mind about the addresses, or two boxes turn out
   * to be one. Everything that made this a parcel is undone - the label
   * and the tracking off the pairs, the shipment off the sale - so they
   * are waiting again and can be put in a box with the others.
   *
   * Not once he has posted it: then there is a parcel in the world, and
   * pretending otherwise is how a pair goes missing on paper.
   */
  async function unship({ saleId, sellerRecordId, shipmentGroup = "" } = {}) {
    const { deal, groups } = await shipments(saleId);
    const parcel = text(shipmentGroup);

    const group = groups.find((row) =>
      row.seller_record_id === text(sellerRecordId) &&
      (parcel ? row.shipment_group === parcel : Boolean(row.shipment_group)));

    if (!group) throw new BrokerDealsError("That parcel is not on this deal.", 404);
    if (!group.shipment_group) throw new BrokerDealsError("There is no label to take back.", 409);

    if (group.shipped || group.delivered_at) {
      throw new BrokerDealsError("That parcel is already on its way; it cannot be taken back.", 409);
    }

    for (const pair of group.pairs) {
      if (!pair.pair_id) continue;

      await db.patch(`external_sale_pairs?id=eq.${pair.pair_id}`, {
        consignor_fulfillment_status: "Allocated",
        consignor_label_url: null,
        consignor_tracking_url: null,
        shipment_group: null
      });
    }

    // And the box itself, which Aftership would otherwise keep following.
    if (text(group.tracking_url)) {
      await db.remove(
        `shipments?external_sale_id=eq.${deal.id}&tracking_number=eq.${encodeURIComponent(text(group.tracking_url))}`
      ).catch((err) => console.error(`[admin broker deals] parcel ${group.tracking_url} not removed:`, err.message));
    }

    const left = await db.get(`shipments?select=id&external_sale_id=eq.${deal.id}`).catch(() => []);
    const [fresh] = await db.get(`external_sales?select=*&id=eq.${deal.id}`);

    if (fresh) {
      const status = shippingStatusFor({
        current: text(fresh.shipping_status),
        cancelled: text(fresh.payment_status) === "cancelled",
        parcels: left.length
      });

      if (status !== text(fresh.shipping_status)) {
        await db.patch(`external_sales?id=eq.${fresh.id}`, { shipping_status: status, updated_at: new Date().toISOString() });
      }
    }

    /*
     * And he is told, because he has a label in his hand that must not go
     * in the post. Non-blocking for the same reason the label notice is:
     * the undo already happened.
     */
    const told = await kickz("/api/internal/broker/label-void", {
      sale_id: deal.id,
      seller_record_id: text(sellerRecordId),
      deal_id: deal.deal_id,
      tracking: text(group.tracking_url),
      pairs: group.pairs.map((pair) => ({ sku: pair.sku, size: pair.size, product_name: pair.product_name }))
    }).then((out) => out?.ok === true).catch((err) => {
      console.error(`[admin broker deals] ${group.seller_id} was not told the label is void:`, err.message);
      return false;
    });

    return { ok: true, pairs: group.pairs.length, told };
  }

  // He has put it in the post. Nothing else in this system will ever know
  // that, so the broker is the one who says so.
  async function markShipped({ saleId, sellerRecordId, shipmentGroup = "" } = {}) {
    const { groups } = await shipments(saleId);
    const parcel = text(shipmentGroup);

    const his = groups.filter((row) => row.seller_record_id === text(sellerRecordId));

    if (!his.length) throw new BrokerDealsError("Nothing on this deal is coming from that consignor.", 404);

    // Named when he has more than one parcel; otherwise the one that has a
    // label, so a single-parcel deal needs no name at all.
    const group = parcel
      ? his.find((row) => row.shipment_group === parcel)
      : his.find((row) => row.step === "Ready to Ship") || his[0];

    if (!group) throw new BrokerDealsError("That parcel is not on this deal.", 404);
    if (group.step !== "Ready to Ship") throw new BrokerDealsError("He has no label yet.", 409);

    for (const pair of group.pairs) {
      if (!pair.pair_id) continue;

      await db.patch(`external_sale_pairs?id=eq.${pair.pair_id}`, {
        consignor_shipping_status: "Shipped"
      });
    }

    return { ok: true, pairs: group.pairs.length };
  }

  /* ---------------- a bought pair becomes a sale pair ---------------- */

  /*
   * The pair, onto the sale.
   *
   * This is the seam: on the other side of it a broker's pair is an
   * ordinary External Sale pair, and the invoicing, payment and shipping
   * that already exist can read it without knowing where it came from.
   *
   * The purchase side is taken from the Inventory Unit the portal just
   * made, so the price on the invoice is the one that was actually agreed
   * rather than one computed here a second time.
   */
  async function attachPair({ line, unitRecordId, buyerPrice }) {
    if (!/^rec[A-Za-z0-9]{14}$/.test(text(unitRecordId))) {
      throw new BrokerDealsError("The portal bought the pair but returned no Inventory Unit.", 502);
    }

    const sale = await loadSale(line.sale_id);
    const units = await airtable.byIds("Inventory Units", [text(unitRecordId)], UNIT_FIELDS);
    const fields = units.get(text(unitRecordId));

    if (!fields) throw new BrokerDealsError("That Inventory Unit cannot be read back.", 502);

    const pair = pairFromUnit(text(unitRecordId), fields);

    const [created] = await db.insert("external_sale_pairs", [{
      ...pair,
      sale_id: sale.id,
      selling_price: round2(buyerPrice),
      selling_vat_type: sellingVatType(pair.purchase_vat_type, {
        buyer_country_code: sale.buyer_country_code,
        buyer_vat_id: sale.buyer_vat_id
      }),
      /*
       * Where the consignor sees it: "Allocated" is the step a freshly
       * booked consignment pair stands on, and his Confirmed tab filters
       * on exactly that word. Written on the pair because his dashboard
       * reads it from a lookup the unit of a broker deal cannot have.
       */
      consignor_fulfillment_status: "Allocated",
      consignor_shipping_status: "Pending"
    }]);

    await db.patch(`deal_lines?id=eq.${line.id}`, {
      external_sale_pair_id: created.id,
      updated_at: new Date().toISOString()
    });

    await syncSale(sale.id);

    return created;
  }

  /*
   * The sale's own total, after anything changed underneath it.
   *
   * Only the total. What turns a negotiation into a sale is the broker
   * saying so - see confirmDeal - and not the first pair happening to come
   * in: a deal with one of five pairs bought is not a deal yet, and a sale
   * that counts as open can be invoiced and paid while four pairs are
   * still being haggled over.
   */
  async function syncSale(saleId) {
    const [sale] = await db.get(`external_sales?select=*&id=eq.${text(saleId)}`);

    if (!sale) return null;

    const pairs = await db.get(`external_sale_pairs?select=selling_price,cancelled_at&sale_id=eq.${sale.id}`);
    const live = pairs.filter((pair) => !pair.cancelled_at);

    const [updated] = await db.patch(`external_sales?id=eq.${sale.id}`, {
      total_selling_price: round2(live.reduce((sum, pair) => sum + Number(pair.selling_price || 0), 0)),
      updated_at: new Date().toISOString()
    });

    return updated;
  }

  /*
   * "This is the deal."
   *
   * Three of the five came in, the other two never will or are taking too
   * long - so the broker draws the line and what he has becomes the sale.
   * Everything still running is dropped here rather than left hanging,
   * because a consignor who agreed to a pair we are not going to buy has to
   * be told, and this is the moment we know.
   *
   * From here on it is an ordinary External Sale: it shows up in Pending,
   * it can be invoiced, paid and shipped by the machinery that was already
   * there.
   */
  async function confirmDeal(saleId) {
    const sale = await loadSale(saleId);

    if (text(sale.stage) === "open") {
      throw new BrokerDealsError("This deal is already confirmed.", 409);
    }

    /*
     * And here the buyer has to be real.
     *
     * A name was enough to haggle under - the invoice address of someone
     * new only arrives once the deal is struck. This is that moment: from
     * here it is a sale that gets invoiced, paid and shipped, and all three
     * read the buyer off this row.
     */
    if (!text(sale.buyer_uuid)) {
      throw new BrokerDealsError(
        `This deal is still running on the name "${text(sale.buyer_name) || "?"}". Pick the buyer, or add him, before confirming it.`,
        409
      );
    }

    const lines = (await linesOf([text(sale.id)])).get(text(sale.id)) || [];
    const locked = lines.filter((line) => line.locked);
    const already = lines.filter((line) => line.done);

    if (!locked.length && !already.length) {
      throw new BrokerDealsError("Nothing has been confirmed on this deal yet.", 409);
    }

    if (lines.some((line) => line.status === "processing")) {
      throw new BrokerDealsError("A pair is being bought right now. Try again in a moment.", 409);
    }

    /*
     * And here everything that was locked is actually bought.
     *
     * One at a time, because each is its own purchase with its own margin
     * check, and a pair that cannot go through must not take the others
     * with it. A pair that did go through comes back as bought, so
     * confirming again after a fix picks up where this left off.
     */
    const failed = [];

    for (const line of locked) {
      try {
        const got = await kickz("/api/internal/broker/finalize", {
          deal_line_id: line.id,
          buyer_price: round2(line.buyer_price)
        });

        await attachPair({
          line,
          unitRecordId: text(got.inventory_unit_record_id),
          buyerPrice: round2(line.buyer_price)
        });
      } catch (err) {
        failed.push(`${line.sku} ${line.size}: ${err.message}`);
      }
    }

    if (failed.length) {
      throw new BrokerDealsError(
        `${failed.length} pair${failed.length === 1 ? "" : "s"} could not be bought, so the deal is not confirmed: ${failed[0]}`,
        409
      );
    }

    const bought = [...already, ...locked];

    // What is still out there, dropped the same way a single pair is - so a
    // consignor hears about it on exactly the same terms.
    // Read before the buying above, so the pairs that were locked still
    // look locked here - and must not be dropped as leftovers.
    const dropping = lines.filter((line) => !line.done && !line.locked && line.status !== "cancelled");
    let told = 0;

    for (const line of dropping) {
      if (line.offer_id) {
        const out = await kickz("/api/internal/partner-deal/discard", { offer_id: line.offer_id })
          .catch((err) => {
            console.error(`[admin broker deals] could not drop ${line.sku} ${line.size}:`, err.message);
            return null;
          });

        if (out?.told_consignor === true) told += 1;
      }

      await db.patch(`deal_lines?id=eq.${line.id}`, {
        status: "cancelled",
        updated_at: new Date().toISOString()
      });
    }

    /*
     * And everyone who sold into it hears that it closed.
     *
     * His own message said he would get the deal update once it was
     * finalized; without this the next thing he actually gets is a
     * shipping label, which can be hours away. Not fatal if it fails -
     * the pair is bought either way - so it does not hold the deal.
     */
    const spoke = await kickz("/api/internal/broker/deal-confirmed", {
      sale_id: sale.id,
      deal_id: dealId(sale)
    }).catch((err) => {
      console.error("[admin broker deals] consignors not told the deal closed:", err.message);
      return null;
    });

    const pairs = await db.get(`external_sale_pairs?select=selling_price,cancelled_at&sale_id=eq.${sale.id}`);
    const live = pairs.filter((pair) => !pair.cancelled_at);

    await db.patch(`external_sales?id=eq.${sale.id}`, {
      stage: "open",
      bookkeeping_status: "to_invoice",
      // The sale happened today, not on the day the haggling started - and
      // that date is what the invoice carries.
      sale_date: new Date().toISOString().slice(0, 10),
      total_selling_price: round2(live.reduce((sum, pair) => sum + Number(pair.selling_price || 0), 0)),
      updated_at: new Date().toISOString()
    });

    return {
      ok: true,
      deal_id: dealId(sale),
      pairs: bought.length,
      dropped: dropping.length,
      told,
      // How many consignors heard that the deal closed.
      closed_told: Number(spoke?.told) || 0
    };
  }

  /*
   * The buyers External Sales already knows.
   *
   * Read through the portal that owns the table rather than queried here:
   * the same list, the same labels and the same duplicate rules as the
   * outbound in the WMS, so a buyer means one thing everywhere.
   */
  async function buyers() {
    const out = await kickz("/api/internal/buyers/list", {});

    return { options: out?.options || [] };
  }

  return {
    list, count, get, create, attachBuyer, createBuyer, addLine, removeLine, priceLine, submit, answer, confirmDeal, buyers,
    shipments, shipConsignor, unship, markShipped
  };
}

export function mountBrokerDeals(router, { store, audit = null }) {
  const send = (res, err) => {
    const status = err instanceof BrokerDealsError ? err.status : 500;
    if (status >= 500) console.error("[admin broker deals]", err.message);
    res.status(status).json({ error: err instanceof BrokerDealsError ? err.message : `Broker Deals failed: ${err.message}` });
  };

  const json = express.json({ limit: "40kb" });

  router.get("/api/admin/broker-deals", json, async (req, res) => {
    try {
      res.json(await store.list({ view: text(req.query.view) || "yours", q: text(req.query.q), limit: req.query.limit }));
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/buyers", json, async (req, res) => {
    try {
      res.json(await store.buyers());
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/broker-deals/:id", json, async (req, res) => {
    try {
      res.json(await store.get(req.params.id));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals", json, async (req, res) => {
    try {
      const out = await store.create({
        buyerId: req.body?.buyer_id,
        buyerName: req.body?.buyer_name,
        note: req.body?.note
      });

      audit?.record({
        actor: req.admin,
        action: "broker_deal_created",
        source: "broker_deals",
        recordId: out.id,
        label: out.deal_id
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/lines", json, async (req, res) => {
    try {
      res.json(await store.addLine({
        saleId: req.params.id,
        sku: req.body?.sku,
        size: req.body?.size,
        buyerPrice: req.body?.buyer_price,
        payout: req.body?.payout,
        vatFilter: req.body?.vat_filter,
        productName: req.body?.product_name,
        brand: req.body?.brand,
        imageUrl: req.body?.image_url
      }));
    } catch (err) {
      send(res, err);
    }
  });

  router.delete("/api/admin/broker-deals/lines/:lineId", json, async (req, res) => {
    try {
      res.json(await store.removeLine(req.params.lineId));
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/api/admin/broker-deals/:id/shipments", json, async (req, res) => {
    try {
      res.json(await store.shipments(req.params.id));
    } catch (err) {
      send(res, err);
    }
  });

  // A label can be a few hundred kilobytes of PDF, so this one route takes
  // more than the rest.
  /*
   * The label travels as the body, not inside JSON.
   *
   * This service parses every JSON body at the default 100kb, long before
   * a route's own limit is consulted, so a base64 label came back 413 -
   * and base64 makes it a third bigger on the way. Raw with the facts in
   * the query is what the parcel labels on this page already do.
   */
  const LABEL_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

  router.post("/api/admin/broker-deals/:id/ship",
    express.raw({ type: [...LABEL_TYPES, "application/octet-stream"], limit: "10mb" }),
    async (req, res) => {
    try {
      const file = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
      const picked = text(req.query?.pairs);

      const out = await store.shipConsignor({
        saleId: req.params.id,
        sellerRecordId: req.query?.seller,
        pairIds: picked ? picked.split(",").filter(Boolean) : null,
        label: file
          ? {
              name: text(req.query?.name) || "label.pdf",
              type: text(req.headers["content-type"]) || "application/pdf",
              data: file.toString("base64")
            }
          : null,
        labelUrl: req.query?.label_url,
        tracking: req.query?.tracking
      });

      audit?.record({
        actor: req.admin,
        action: "broker_deal_label",
        source: "broker_deals",
        recordId: text(req.params.id),
        label: out.shipment_group,
        details: { pairs: out.pairs, told: out.told }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/unship", json, async (req, res) => {
    try {
      const out = await store.unship({
        saleId: req.params.id,
        sellerRecordId: req.body?.seller_record_id,
        shipmentGroup: req.body?.shipment_group
      });

      audit?.record({
        actor: req.admin,
        action: "broker_deal_label_void",
        source: "broker_deals",
        recordId: text(req.params.id),
        label: text(req.body?.shipment_group),
        details: { pairs: out.pairs, told: out.told }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/shipped", json, async (req, res) => {
    try {
      res.json(await store.markShipped({ saleId: req.params.id, sellerRecordId: req.body?.seller_record_id, shipmentGroup: req.body?.shipment_group }));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/buyers", json, async (req, res) => {
    try {
      res.json(await store.createBuyer(req.body || {}));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/buyer", json, async (req, res) => {
    try {
      const out = await store.attachBuyer({ saleId: req.params.id, buyerId: req.body?.buyer_id });

      audit?.record({
        actor: req.admin,
        action: "broker_deal_buyer",
        source: "broker_deals",
        recordId: text(req.params.id),
        label: out.buyer
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/confirm", json, async (req, res) => {
    try {
      const out = await store.confirmDeal(req.params.id);

      audit?.record({
        actor: req.admin,
        action: "broker_deal_confirmed",
        source: "broker_deals",
        recordId: text(req.params.id),
        label: out.deal_id,
        details: { pairs: out.pairs, dropped: out.dropped, told: out.told }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/:id/submit", json, async (req, res) => {
    try {
      const out = await store.submit(req.params.id);

      audit?.record({
        actor: req.admin,
        action: "broker_deal_submitted",
        source: "broker_deals",
        recordId: text(req.params.id),
        details: { sent: out.sent }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/api/admin/broker-deals/lines/:lineId/answer", json, async (req, res) => {
    try {
      const out = await store.answer({
        lineId: req.params.lineId,
        action: text(req.body?.action),
        price: req.body?.price,
        buyerPrice: req.body?.buyer_price
      });

      audit?.record({
        actor: req.admin,
        action: `broker_deal_${out.did}`,
        source: "broker_deals",
        recordId: text(req.params.lineId),
        label: out.seller_id,
        details: { payout: out.payout ?? null, buyer_price: out.buyer_price ?? null }
      })?.catch?.(() => {});

      res.json(out);
    } catch (err) {
      send(res, err);
    }
  });
}

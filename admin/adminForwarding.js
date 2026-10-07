// admin/adminForwarding.js
//
// Forward Service: every forward of partner pairs, from Supabase
// (forwarding_log, with the pairs in partner_stock). The WMS creates a forward
// when pairs leave for a buyer and ships it in Pack & Ship; here it is
// managed afterwards - labels and tracking added when they arrive, shipping
// costs corrected, and the partner's payment marked.
//
// Money on a forward:
//   fee      pairs x fee per pair (the partner's Forwarding Fee at the time)
//   payable  fee + shipping costs: what the partner owes us
//   profit   the fee; shipping costs are passed on at cost
//   ex VAT   the fee / 1.21
//
// Every change goes through the action log, like the other buttons.

import express from "express";
import fs from "fs";
import path from "path";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const SHIPPING_STATUSES = ["awaiting_label", "ready_to_ship", "shipped", "cancelled"];
export const PAYMENT_STATUSES = ["pending", "paid"];

export class ForwardingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export function displayId(row) {
  return `FWD-${String(row?.forwarding_number ?? "").padStart(6, "0")}`;
}

/*
 * What one pair costs to forward.
 *
 * The partner's standard fee unless that pair carries its own. Clothing was
 * agreed at EUR 1 and some shoes at EUR 3 while the standard stayed EUR 2,
 * and a parcel can hold both - so the number has to live on the pair, not on
 * the forward.
 *
 * A pair without one is every pair forwarded before this existed: it falls
 * back to the forward's standard fee, so nothing already sent changes.
 */
export function pairFee(pair, standardFee) {
  const raw = pair?.forwarding_fee;

  // An empty column is "no fee of its own", and Number(null) is 0 - which
  // would forward every older pair for nothing.
  if (raw === null || raw === undefined || raw === "") return Number(standardFee || 0);

  const own = Number(raw);

  return Number.isFinite(own) && own >= 0 ? own : Number(standardFee || 0);
}

/*
 * The fee per SKU, which is how it is agreed and how it is typed.
 *
 * One line per style code with what it costs and how many of them are in the
 * forward. `mixed` marks a SKU whose own pairs disagree - possible only if
 * someone changed a fee while the pairs were being split - so the screen can
 * say so instead of showing one of the two and hiding the other.
 */
export function feeLines(pairs, standardFee) {
  const lines = new Map();

  for (const pair of pairs || []) {
    const sku = text(pair?.sku) || "—";
    const fee = pairFee(pair, standardFee);

    if (!lines.has(sku)) {
      lines.set(sku, { sku, product_name: text(pair?.product_name), count: 0, fee, amount: 0, mixed: false });
    }

    const line = lines.get(sku);

    line.count += 1;
    line.amount = round2(line.amount + fee);
    if (fee !== line.fee) line.mixed = true;
    if (!line.product_name) line.product_name = text(pair?.product_name);
  }

  return [...lines.values()].sort((a, b) => b.count - a.count || a.sku.localeCompare(b.sku));
}

export function forwardMoney(row, pairs = null) {
  const standard = Number(row?.unit_forwarding_fee || 0);

  /*
   * Counted off the pairs when they are there, because only they know what
   * each one costs. Without them - a cancelled forward, whose pairs went back
   * on the shelf - the standard fee times the count is all there is left.
   */
  const fee = Array.isArray(pairs) && pairs.length
    ? round2(pairs.reduce((sum, pair) => sum + pairFee(pair, standard), 0))
    : round2(Number(row?.pair_count || 0) * standard);

  const shipping = round2(row?.shipping_costs);

  return {
    fee,
    shipping,
    payable: round2(fee + shipping),
    profit: fee,
    profit_ex_vat: round2(fee / 1.21)
  };
}

export function trackingList(value) {
  const raw = Array.isArray(value) ? value.join(",") : text(value);

  // One per line or separated by commas - never by spaces: a UPS number is
  // often typed with them ("1Z FV6 483 68 2567 1031") and must stay one
  // number. The spaces inside it are dropped.
  return [
    ...new Set(
      raw
        .split(/[,;\r\n]+/)
        .map((part) => part.replace(/\s+/g, ""))
        .filter(Boolean)
    )
  ];
}

// What a forward's shipping status becomes after its labels or tracking
// changed: something to ship with means Ready to Ship, nothing means waiting.
// Shipped and cancelled are never undone by an edit.
/*
 * What a label upload is, from its first bytes.
 *
 * PDF, or a JPEG or PNG - labels arrive as photos and screenshots as often as
 * PDFs. The WMS turns an image into a one-page PDF before storing it, so
 * everything after that still only ever sees PDFs.
 */
export const LABEL_TYPES = ["application/pdf", "image/jpeg", "image/png"];

export function labelUpload(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return null;
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.subarray(0, 4).toString("hex") === "89504e47") return { mime: "image/png", ext: "png" };
  return null;
}

export function nextShippingStatus(current, trackingNumbers, labels) {
  if (current === "shipped" || current === "cancelled") return current;

  return trackingNumbers.length || labels.length ? "ready_to_ship" : "awaiting_label";
}

export function createForwardingStore({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  async function request(pathAndQuery, options = {}) {
    if (!configured) throw new ForwardingError("Forward Service needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this service.", 503);

    const response = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: AbortSignal.timeout(20_000)
    });

    const body = await response.text();
    const data = body ? JSON.parse(body) : null;

    if (!response.ok) {
      throw new ForwardingError(text(data?.message) || `Supabase answered ${response.status}.`, 502);
    }

    return data;
  }

  async function list({ shipping = "all", payment = "all", seller = "" } = {}) {
    const params = new URLSearchParams({ select: "*", order: "created_at.desc", limit: "1000" });

    if (SHIPPING_STATUSES.includes(shipping)) params.set("shipping_status", `eq.${shipping}`);
    if (PAYMENT_STATUSES.includes(payment)) params.set("payment_status", `eq.${payment}`);
    if (/^rec[a-zA-Z0-9]{14}$/.test(text(seller))) params.set("seller_record_id", `eq.${text(seller)}`);

    const forwards = await request(`forwarding_log?${params}`);

    if (!forwards.length) return [];

    const ids = forwards.map((row) => row.id);
    const pairs = [];

    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const pairParams = new URLSearchParams({
        select: "id,forwarding_log_id,sku,size,product_name,image_url,barcode,forwarding_fee",
        forwarding_log_id: `in.(${chunk.join(",")})`,
        order: "sku.asc,size.asc"
      });

      pairs.push(...(await request(`partner_stock?${pairParams}`)));
    }

    const byForward = new Map();
    for (const pair of pairs) {
      if (!byForward.has(pair.forwarding_log_id)) byForward.set(pair.forwarding_log_id, []);
      byForward.get(pair.forwarding_log_id).push(pair);
    }

    return forwards.map((row) => {
      const own = byForward.get(row.id) || [];

      return {
        ...row,
        display_id: displayId(row),
        money: forwardMoney(row, own),
        fee_lines: feeLines(own, row.unit_forwarding_fee),
        pairs: own
      };
    });
  }

  // The pairs of one forward, for the fee sums after a change.
  async function pairsFor(forwardId) {
    const params = new URLSearchParams({
      select: "id,sku,size,product_name,forwarding_fee",
      forwarding_log_id: `eq.${text(forwardId)}`,
      order: "sku.asc,size.asc"
    });

    return (await request(`partner_stock?${params}`)) || [];
  }

  /*
   * What one SKU in this forward costs per pair.
   *
   * Written onto the pairs themselves, so the agreement stays with the pairs
   * it was made for. Changing the partner's standard fee later leaves this
   * forward exactly as it was invoiced.
   */
  async function setFee(forwardId, sku, fee) {
    const params = new URLSearchParams({ forwarding_log_id: `eq.${text(forwardId)}` });

    if (text(sku)) params.set("sku", `eq.${text(sku)}`);

    const updated = await request(`partner_stock?${params}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ forwarding_fee: fee })
    });

    return updated || [];
  }

  async function get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(text(id))) throw new ForwardingError("Unknown forward.", 404);

    const rows = await request(`forwarding_log?id=eq.${text(id)}&select=*`);

    if (!rows.length) throw new ForwardingError("Unknown forward.", 404);

    return rows[0];
  }

  async function update(id, fields) {
    const rows = await request(`forwarding_log?id=eq.${text(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(fields)
    });

    if (!rows?.length) throw new ForwardingError("Unknown forward.", 404);

    return decorate(rows[0]);
  }

  // One forward with its money worked out over its own pairs.
  async function decorate(row) {
    const own = await pairsFor(row.id).catch(() => []);

    return {
      ...row,
      display_id: displayId(row),
      money: forwardMoney(row, own),
      fee_lines: feeLines(own, row.unit_forwarding_fee)
    };
  }

  /*
   * A cancelled forward's pairs go back on the partner's shelf.
   *
   * Only pairs still marked forwarded by this forward: in stock again, no
   * longer linked. The Supabase trigger lists them again straight away if
   * they are on consignment, and the portal's five-minute job brings Stock
   * Levels along.
   */
  async function releasePairs(forwardId) {
    const params = new URLSearchParams({
      forwarding_log_id: `eq.${text(forwardId)}`,
      status: "eq.forwarded"
    });

    const released = await request(`partner_stock?${params}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "in_stock",
        forwarded_at: null,
        forwarded_ref: null,
        forwarding_log_id: null
      })
    });

    return released || [];
  }

  // Only the two status columns, for the sidebar counts.
  async function counts() {
    const rows = await request("forwarding_log?select=shipping_status,payment_status&limit=10000");
    const result = { awaiting_label: 0, ready_to_ship: 0, shipped: 0, unpaid: 0 };

    for (const row of rows || []) {
      if (row.shipping_status in result) result[row.shipping_status] += 1;
      if (row.shipping_status !== "cancelled" && row.payment_status !== "paid") result.unpaid += 1;
    }

    return result;
  }

  return { configured, list, get, update, decorate, pairsFor, setFee, releasePairs, counts };
}

/*
 * The routes, on the admin router after its sign-in check.
 *
 * deps: store (createForwardingStore), audit, callWms(path, body)
 */
export function mountForwarding(router, { store, audit, callWms, pageFile }) {
  const page = pageFile && fs.existsSync(pageFile) ? fs.readFileSync(pageFile, "utf8") : "";

  const send = (res, err) => {
    const status = err instanceof ForwardingError ? err.status : 500;
    if (status >= 500) console.error("[admin forwarding]", err.message);
    res.status(status).json({ error: err instanceof ForwardingError ? err.message : "Forward Service failed." });
  };

  const log = (req, action, row, details) =>
    audit.record({
      actor: req.admin,
      action,
      source: "forwarding",
      recordId: row.id,
      label: displayId(row),
      details
    });

  router.get(["/admin/forwarding", "/admin/forwarding/"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page);
  });

  router.get("/api/admin/forwarding", async (req, res) => {
    try {
      const forwards = await store.list({
        shipping: text(req.query.shipping) || "all",
        payment: text(req.query.payment) || "all",
        seller: text(req.query.seller)
      });

      const totals = forwards
        .filter((row) => row.shipping_status !== "cancelled")
        .reduce(
          (sum, row) => ({
            forwards: sum.forwards + 1,
            pairs: sum.pairs + Number(row.pair_count || 0),
            fee: round2(sum.fee + row.money.fee),
            shipping: round2(sum.shipping + row.money.shipping),
            payable: round2(sum.payable + row.money.payable),
            unpaid: round2(sum.unpaid + (row.payment_status === "paid" ? 0 : row.money.payable)),
            profit_ex_vat: round2(sum.profit_ex_vat + row.money.profit_ex_vat)
          }),
          { forwards: 0, pairs: 0, fee: 0, shipping: 0, payable: 0, unpaid: 0, profit_ex_vat: 0 }
        );

      res.json({ forwards, totals });
    } catch (err) {
      send(res, err);
    }
  });

  // What was done to one forward here, newest first, for the side panel.
  router.get("/api/admin/forwarding/history", async (req, res) => {
    try {
      const forward = await store.get(req.query.id);
      res.json({ history: await audit.forRecord(forward.id) });
    } catch (err) {
      send(res, err);
    }
  });

  // Shipping costs, tracking numbers, notes, or a status by hand.
  router.post("/api/admin/forwarding/update", express.json({ limit: "50kb" }), async (req, res) => {
    try {
      const before = await store.get(req.body?.id);
      const fields = {};
      const changed = {};

      if (req.body?.shipping_costs !== undefined) {
        const costs = Number(String(req.body.shipping_costs).replace(",", "."));
        if (!Number.isFinite(costs) || costs < 0) throw new ForwardingError("Shipping costs cannot be negative.");
        fields.shipping_costs = round2(costs);
        changed.shipping_costs = { from: Number(before.shipping_costs), to: fields.shipping_costs };
      }

      let tracking = before.tracking_numbers || [];
      let labels = before.labels || [];

      if (req.body?.tracking_numbers !== undefined) {
        tracking = trackingList(req.body.tracking_numbers);
        fields.tracking_numbers = tracking;
        changed.tracking_numbers = { from: before.tracking_numbers, to: tracking };
      }

      if (text(req.body?.remove_label_url)) {
        labels = labels.filter((label) => label.url !== text(req.body.remove_label_url));
        fields.labels = labels;
        changed.label_removed = text(req.body.remove_label_url);
      }

      if (req.body?.notes !== undefined) {
        fields.notes = text(req.body.notes) || null;
      }

      if (fields.tracking_numbers || fields.labels) {
        fields.shipping_status = nextShippingStatus(before.shipping_status, tracking, labels);
      }

      if (text(req.body?.shipping_status)) {
        const wanted = text(req.body.shipping_status);
        if (!SHIPPING_STATUSES.includes(wanted)) throw new ForwardingError("Unknown shipping status.");

        // Its pairs went back on the shelf when it was cancelled and may be
        // sold or forwarded again by now, so there is nothing to reopen.
        if (before.shipping_status === "cancelled" && wanted !== "cancelled") {
          throw new ForwardingError("A cancelled forward cannot be reopened. Create a new forward in the WMS.");
        }

        // Shipped pairs are gone; putting them back on the shelf would list
        // shoes we no longer have.
        if (wanted === "cancelled" && before.shipping_status === "shipped") {
          throw new ForwardingError("This forward is already shipped, so it cannot be cancelled.");
        }

        fields.shipping_status = wanted;
        if (wanted === "shipped" && !before.shipped_at) fields.shipped_at = new Date().toISOString();
      }

      if (before.shipping_status === "cancelled" && (fields.tracking_numbers || fields.labels)) {
        delete fields.shipping_status;
      }

      if (fields.shipping_status && fields.shipping_status !== before.shipping_status) {
        changed.shipping_status = { from: before.shipping_status, to: fields.shipping_status };
      }

      if (!Object.keys(fields).length) throw new ForwardingError("Nothing to change.");

      const cancelling = fields.shipping_status === "cancelled" && before.shipping_status !== "cancelled";
      let row = await store.update(before.id, fields);

      if (cancelling) {
        const released = await store.releasePairs(before.id);

        changed.pairs_back_on_shelf = released.map((pair) => `${pair.sku} / ${pair.size}`);

        const note = `Cancelled: ${released.length} pair(s) back on the shelf.`;
        row = await store.update(before.id, { notes: [row.notes, note].filter(Boolean).join("\n") });

        await log(req, "forwarding_cancel", row, changed);

        return res.json({ forward: row, released: released.length });
      }

      await log(req, "forwarding_update", row, changed);

      res.json({ forward: row });
    } catch (err) {
      send(res, err);
    }
  });

  /*
   * The fee for one SKU in this forward, or for all of its pairs at once.
   *
   * Typed per style code, because that is how it is agreed with the partner:
   * clothing at EUR 1, a pair of shoes at EUR 2 or EUR 3. Leave the SKU out
   * and every pair in the forward gets it.
   *
   * Not on a forward that is already paid - the partner has an invoice with a
   * number on it, and moving the number afterwards makes the two disagree
   * with nothing to show why. Mark it unpaid first if it really was wrong.
   */
  router.post("/api/admin/forwarding/fee", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const before = await store.get(req.body?.id);
      const sku = text(req.body?.sku);
      const fee = Number(String(req.body?.fee ?? "").replace(",", "."));

      if (!Number.isFinite(fee) || fee < 0) throw new ForwardingError("The fee cannot be negative.");
      if (fee > 1000) throw new ForwardingError("That fee looks like a typing mistake.");

      if (before.payment_status === "paid") {
        throw new ForwardingError("This forward is already paid. Mark it unpaid first if the fee was wrong.");
      }

      // Read before writing, so the log says what it actually cost before.
      const was = await store.decorate(before);

      const changed = await store.setFee(before.id, sku, round2(fee));

      if (!changed.length) throw new ForwardingError(sku ? `No pairs of ${sku} in this forward.` : "No pairs in this forward.");

      const row = await store.decorate(before);

      await log(req, "forwarding_fee", row, {
        sku: sku || "all pairs",
        pairs: changed.length,
        fee: round2(fee),
        payable: { from: was.money.payable, to: row.money.payable }
      });

      res.json({ forward: row });
    } catch (err) {
      send(res, err);
    }
  });

  // A label PDF for a forward, stored through the WMS.
  router.post(
    "/api/admin/forwarding/label",
    express.raw({ type: LABEL_TYPES, limit: "10mb" }),
    async (req, res) => {
      try {
        const before = await store.get(req.query.id);
        const tracking = text(req.query.tracking).replace(/\s+/g, "");
        const kind = labelUpload(req.body);

        if (!kind) throw new ForwardingError("The label must be a PDF, JPEG or PNG file.");

        if (tracking && !/^[A-Za-z0-9-]{6,40}$/.test(tracking)) {
          throw new ForwardingError("Enter the tracking number from the label.");
        }

        const stored = await callWms("/api/upload-label-file", {
          folder: "forwarding",
          file_name: `${displayId(before)}${tracking ? `-${tracking}` : ""}.${kind.ext}`,
          file_data_url: `data:${kind.mime};base64,${req.body.toString("base64")}`,
          tracking
        });

        const labels = [
          ...(before.labels || []),
          { url: stored.url, filename: stored.filename, tracking: tracking || null, uploaded_at: new Date().toISOString() }
        ];

        const trackingNumbers = trackingList([...(before.tracking_numbers || []), tracking]);

        const row = await store.update(before.id, {
          labels,
          tracking_numbers: trackingNumbers,
          shipping_status: nextShippingStatus(before.shipping_status, trackingNumbers, labels)
        });

        await log(req, "forwarding_label", row, { tracking, label: stored.url });

        res.json({ forward: row });
      } catch (err) {
        send(res, err);
      }
    }
  );

  // The partner paid, or it was marked paid by mistake.
  router.post("/api/admin/forwarding/payment", express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(text).filter(Boolean))];
      const paid = req.body?.paid !== false;

      if (!ids.length) throw new ForwardingError("Tick the forwards first.");

      const updated = [];

      for (const id of ids) {
        const before = await store.get(id);

        const row = await store.update(before.id, {
          payment_status: paid ? "paid" : "pending",
          paid_at: paid ? new Date().toISOString() : null,
          payment_note: text(req.body?.note) || before.payment_note || null
        });

        await log(req, paid ? "forwarding_paid" : "forwarding_unpaid", row, {
          payable: row.money.payable,
          note: text(req.body?.note)
        });

        updated.push(row);
      }

      res.json({ forwards: updated });
    } catch (err) {
      send(res, err);
    }
  });
}

export function forwardingPagePath(dirname) {
  return path.join(dirname, "..", "private", "admin-forwarding.html");
}

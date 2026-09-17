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

export function forwardMoney(row) {
  const fee = round2(Number(row?.pair_count || 0) * Number(row?.unit_forwarding_fee || 0));
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

  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((part) => part.trim())
        .filter(Boolean)
    )
  ];
}

// What a forward's shipping status becomes after its labels or tracking
// changed: something to ship with means Ready to Ship, nothing means waiting.
// Shipped and cancelled are never undone by an edit.
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
        select: "id,forwarding_log_id,sku,size,product_name,image_url,barcode",
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

    return forwards.map((row) => ({
      ...row,
      display_id: displayId(row),
      money: forwardMoney(row),
      pairs: byForward.get(row.id) || []
    }));
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

    return { ...rows[0], display_id: displayId(rows[0]), money: forwardMoney(rows[0]) };
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

  return { configured, list, get, update, releasePairs };
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

  // A label PDF for a forward, stored through the WMS.
  router.post(
    "/api/admin/forwarding/label",
    express.raw({ type: "application/pdf", limit: "10mb" }),
    async (req, res) => {
      try {
        const before = await store.get(req.query.id);
        const tracking = text(req.query.tracking).replace(/\s+/g, "");

        if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.subarray(0, 5).toString("latin1") !== "%PDF-") {
          throw new ForwardingError("The label must be a PDF file.");
        }

        if (tracking && !/^[A-Za-z0-9-]{6,40}$/.test(tracking)) {
          throw new ForwardingError("Enter the tracking number from the label.");
        }

        const stored = await callWms("/api/upload-label-file", {
          folder: "forwarding",
          file_name: `${displayId(before)}${tracking ? `-${tracking}` : ""}.pdf`,
          file_data_url: `data:application/pdf;base64,${req.body.toString("base64")}`,
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

/*
 * Your Shelf > Suggested (18-11-2026).
 *
 * Every Monday the trends job in shopify-active-product-sync lists, per
 * store, the shoes and clothing that sell across the Lojiq network (score 30
 * or more) and are not on the store's shelf yet: store_trend_suggestions.
 * This page shows that list with an Add button; adding is the ordinary
 * catalogue choice ('add'), carried out by the consignment push.
 *
 * A style the store has decided on in the meantime drops off the list,
 * except one that is queued to be added: that stays, marked, so it can be
 * cancelled from here. "Not for us" (dismissed_at) keeps a style off the
 * list, with the score it had then (dismissed_score); the weekly job brings
 * it back, marked as back in trend, once its score is 10 or more above that
 * (and 30 or more). It can also be put back by hand.
 */

const key = (sku) => String(sku || "").toUpperCase().replace(/\s+/g, "");

/*
 * suggestions: rows of store_trend_suggestions for one store
 * choices:     [{ sku, choice, status }] of the same store
 */
export function suggestedItems(suggestions, choices, search = "", { dismissed = false } = {}) {
  const decided = new Map((choices || []).map((c) => [key(c.sku), c]));
  const words = String(search || "").toLowerCase().split(/\s+/).filter(Boolean);

  return (suggestions || [])
    .map((s) => {
      const c = decided.get(key(s.sku));
      return { ...s, choice: c?.choice || null, choice_status: c?.status || null };
    })
    .filter((s) => Boolean(s.dismissed_at) === dismissed)
    .filter((s) => !s.choice || (s.choice === "add" && s.choice_status === "pending"))
    .filter((s) => {
      const text = `${s.name || ""} ${s.sku} ${s.brand || ""} ${s.model || ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Number(b.score) - Number(a.score) || Number(b.units) - Number(a.units) || key(a.sku).localeCompare(key(b.sku)))
    .map((s) => ({
      sku: s.sku,
      name: s.name || s.sku,
      brand: s.brand || "",
      model: s.model || "",
      score: Number(s.score) || 0,
      units: Number(s.units) || 0,
      wtb: Number(s.wtb) || 0,
      channels: s.channels || "",
      fast_sizes: s.fast_sizes || "",
      lojiq_price: s.lojiq_price === null || s.lojiq_price === undefined ? null : Number(s.lojiq_price),
      market_price: s.market_price === null || s.market_price === undefined ? null : Number(s.market_price),
      picture: s.picture_url || "",
      suggested_at: s.suggested_at || null,
      choice: s.choice,
      status: s.choice_status,
      dismissed_at: s.dismissed_at || null,
      dismissed_reason: s.dismissed_reason || null,
      dismissed_score: s.dismissed_score === null || s.dismissed_score === undefined ? null : Number(s.dismissed_score),
      returned_from_score: s.returned_from_score === null || s.returned_from_score === undefined ? null : Number(s.returned_from_score)
    }));
}

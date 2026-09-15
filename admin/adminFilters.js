// admin/adminFilters.js
//
// Saved filters: a set of list filters an admin stored under a name. Every
// admin sees every saved filter, shown with the owner's name after it
// ("No SneakerAsk - Emanuele"), so one can point the other to exactly what
// they are looking at. Only the owner can overwrite or delete their own.
//
// A filter belongs to a section (Store Orders or Member WTBs) and works on
// every tab in it. Kept in Supabase, table admin_saved_filters.

import { normalizeStores } from "./adminViews.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const SECTIONS = ["store", "mwtb"];
export const NAME_MAX = 60;

// Only the fields a list understands, cleaned, whatever the browser sent.
export function cleanFilters(section, raw = {}) {
  const filters = { q: text(raw.q).slice(0, 200) };

  if (section === "store") {
    filters.stores = normalizeStores(raw.stores);
    filters.storeMode = raw.storeMode === "exclude" ? "exclude" : "include";
  }

  if (section === "mwtb") {
    filters.buyer = text(raw.buyer).slice(0, 100);
  }

  return filters;
}

export function createSavedFilters({ supabaseUrl, serviceKey, table = "admin_saved_filters", fetchImpl = fetch } = {}) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  async function call(url, options = {}) {
    if (!configured) throw new Error("Saved filters need Supabase (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).");

    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(10_000) });
    const data = await response.json().catch(() => null);

    if (!response.ok) throw new Error(data?.message || `Supabase answered ${response.status}`);

    return data;
  }

  const shape = (row) => ({
    id: row.id,
    section: row.section,
    name: row.name,
    owner_name: row.owner_name,
    owner_email: row.owner_email,
    filters: row.filters || {}
  });

  async function list(section) {
    const url = new URL(`${base}/rest/v1/${table}`);
    url.searchParams.set("section", `eq.${section}`);
    url.searchParams.set("order", "name.asc");
    url.searchParams.set("select", "id,section,name,owner_name,owner_email,filters");

    return (await call(url)).map(shape);
  }

  // Saving under a name you already used replaces that filter.
  async function save({ owner, section, name, filters }) {
    const url = new URL(`${base}/rest/v1/${table}`);
    url.searchParams.set("on_conflict", "owner_email,section,name_key");

    const rows = await call(url, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        owner_email: owner.email,
        owner_name: owner.name,
        section,
        name,
        name_key: name.toLowerCase(),
        filters,
        updated_at: new Date().toISOString()
      })
    });

    return shape(rows[0]);
  }

  // Deletes only when the filter is the owner's; returns whether it did.
  async function remove({ owner, id }) {
    const url = new URL(`${base}/rest/v1/${table}`);
    url.searchParams.set("id", `eq.${id}`);
    url.searchParams.set("owner_email", `eq.${owner.email}`);

    const rows = await call(url, { method: "DELETE", headers: { Prefer: "return=representation" } });

    return rows.length > 0;
  }

  return { configured, list, save, remove };
}

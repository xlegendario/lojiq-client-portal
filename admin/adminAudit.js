// admin/adminAudit.js
//
// The action log: who did what, when, to which record. Kept in Supabase
// (table admin_audit_log) so it survives a deploy and can be read back as the
// timeline in a record's side panel.
//
// Writing to the log never blocks or fails the thing being logged. Without
// Supabase configured the entry goes to the server log instead, so nothing is
// lost silently either.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export function createAuditLog({ supabaseUrl, serviceKey, table = "admin_audit_log", fetchImpl = fetch } = {}) {
  const base = text(supabaseUrl).replace(/\/$/, "");
  const configured = Boolean(base && text(serviceKey));

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  async function record({ actor, action, source = "", recordId = "", label = "", details = null }) {
    const entry = {
      actor_email: text(actor?.email),
      actor_name: text(actor?.name),
      action: text(action),
      source: text(source),
      record_id: text(recordId),
      record_label: text(label),
      details
    };

    if (!configured) {
      console.log("[admin audit]", JSON.stringify(entry));
      return;
    }

    try {
      const response = await fetchImpl(`${base}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        console.error("[admin audit] write failed:", response.status, JSON.stringify(entry));
      }
    } catch (err) {
      console.error("[admin audit] write failed:", err.message, JSON.stringify(entry));
    }
  }

  // Newest first, for one record's timeline.
  async function forRecord(recordId, limit = 50) {
    if (!configured || !text(recordId)) return [];

    const url = new URL(`${base}/rest/v1/${table}`);
    url.searchParams.set("record_id", `eq.${text(recordId)}`);
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("select", "created_at,actor_name,action,details");

    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });

      return response.ok ? await response.json() : [];
    } catch {
      return [];
    }
  }

  return { configured, record, forRecord };
}

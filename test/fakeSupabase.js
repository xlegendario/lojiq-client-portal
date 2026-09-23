import assert from "node:assert/strict";

// Just enough PostgREST for the sync: eq / in filters, insert, patch, delete.
export function fakeDb(tables) {
  let next = 1;
  const parse = (path) => {
    const [table, query = ""] = path.split("?");
    const filters = [];
    for (const part of query.split("&")) {
      const [key, value = ""] = part.split("=");
      if (["select", "order", "limit"].includes(key) || !key) continue;
      if (value.startsWith("eq.")) filters.push((r) => String(r[key]) === value.slice(3));
      else if (value.startsWith("in.(")) {
        const list = value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
        filters.push((r) => list.includes(String(r[key])));
      } else if (value === "not.is.null") filters.push((r) => r[key] !== null && r[key] !== undefined);
      else if (value === "is.null") filters.push((r) => r[key] === null || r[key] === undefined);
    }
    return { rows: (tables[table] ||= []), match: (r) => filters.every((f) => f(r)) };
  };

  return {
    configured: true,
    tables,
    async get(path) {
      const { rows, match } = parse(path);
      return rows.filter(match).map((r) => ({ ...r }));
    },
    async insert(table, rows) {
      const keys = JSON.stringify(Object.keys(rows[0]).sort());
      for (const row of rows) assert.equal(JSON.stringify(Object.keys(row).sort()), keys, "Supabase needs the same keys on every row");
      const saved = rows.map((row) => ({ id: `id${next++}`, created_at: new Date(Date.now() + next).toISOString(), ...row }));
      (tables[table] ||= []).push(...saved);
      return saved.map((r) => ({ ...r }));
    },
    async patch(path, fields) {
      const { rows, match } = parse(path);
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, fields));
      return hit.map((r) => ({ ...r }));
    },
    async remove(path) {
      const { rows, match } = parse(path);
      tables[path.split("?")[0]] = rows.filter((r) => !match(r));
      return null;
    }
  };
}

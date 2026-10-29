// admin/readAllPages.js
//
// Supabase (PostgREST) hands back at most 1000 rows a call, whatever the
// limit asks for, and says nothing when it stops there. A list read in one
// go is quietly short once its table passes 1000 rows (29-10-2026: Earnings
// showed FWD-000050 at €10 of €48). This reads page after page instead.
//
// `path` must carry its own order, ending in something unique, or rows can
// slip between pages.

export const PAGE_SIZE = 1000;

export async function readAllPages(get, path, pageSize = PAGE_SIZE) {
  const rows = [];
  const join = path.includes("?") ? "&" : "?";

  for (let offset = 0; ; offset += pageSize) {
    const page = (await get(`${path}${join}limit=${pageSize}&offset=${offset}`)) || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

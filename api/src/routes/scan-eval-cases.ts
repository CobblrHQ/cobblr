import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";

interface ScanEvalCaseRow {
  id: string;
  inbox_item_id: string | null;
  surface: string;
  perceived_input: unknown;
  scan_menu: unknown;
  candidates: unknown;
  expected: unknown;
  note: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

export async function listScanEvalCases(limit: number, orgId?: string) {
  let selected = meta.selectFrom("orgs").select(["id", "name", "slug"]);
  if (orgId !== undefined) selected = selected.where("id", "=", orgId);
  const orgs = await selected.execute();
  const rows: Array<ScanEvalCaseRow & { org_id: string; org_name: string; org_slug: string }> = [];
  for (const org of orgs) {
    try {
      const tdb = await getTenantDb(org.id);
      const r = await sql<ScanEvalCaseRow>`
        select id, inbox_item_id, surface, perceived_input, scan_menu, candidates,
               expected, note, created_by_user_id, created_at
        from core_scan_eval_cases order by created_at desc limit ${limit}`.execute(tdb);
      for (const row of r.rows) rows.push({ ...row, org_id: org.id, org_name: org.name, org_slug: org.slug });
    } catch {
      // Tenant DB without core_scan_eval_cases (module never enabled) — skip it.
    }
  }
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return rows.slice(0, limit);
}

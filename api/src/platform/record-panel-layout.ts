// A workspace's arrangement of the panels on one kind of record (#6337):
// which are hidden and in what order. Bundles may ship a default per kind
// (`record_panels` in the manifest); the workspace's own choices sit over it.
// Edited through the platform:arrange-record-panels action, so the page, the
// API and the assistant change it the same way, with Undo.
import { sql } from "kysely";
import { z } from "zod";
import type { RecordPanelLayout as StoredLayout } from "@cobblr/platform-contract/record-panel-layout";
import { meta } from "../db/meta.js";

export const RecordPanelLayout = z.object({
  panels: z.record(z.string().min(1).max(160), z.object({ hidden: z.boolean().optional(), order: z.number().int().min(-1000).max(1000).optional() })).default({}),
});
export type RecordPanelLayout = z.infer<typeof RecordPanelLayout>;

// The validator and the stored shape are one shape, in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const agree: Same<RecordPanelLayout, StoredLayout> = true;
void agree;

export async function readRecordPanelLayout(orgId: string, kind: string): Promise<{ layout: RecordPanelLayout; revision: number }> {
  const [own, installed] = await Promise.all([
    meta.selectFrom("record_panel_layouts").select(["state", "revision"]).where("org_id", "=", orgId).where("entity_kind", "=", kind).executeTakeFirst(),
    meta.selectFrom("bundles").select(sql<unknown>`manifest -> 'record_panels' -> ${kind}`.as("layout")).where("org_id", "=", orgId).orderBy("installed_at").execute(),
  ]);
  const panels: RecordPanelLayout["panels"] = {};
  for (const b of installed) {
    const parsed = RecordPanelLayout.safeParse(b.layout);
    if (parsed.success) for (const [id, c] of Object.entries(parsed.data.panels)) panels[id] = { ...panels[id], ...c };
  }
  const chosen = RecordPanelLayout.safeParse(own?.state ?? {});
  if (chosen.success) for (const [id, c] of Object.entries(chosen.data.panels)) panels[id] = { ...panels[id], ...c };
  return { layout: { panels }, revision: own?.revision ?? 0 };
}

export const EditRecordPanelLayout = z.object({
  kind: z.string().min(1).max(160),
  /** Panels to hide or show. */
  panels: z.array(z.string().min(1).max(160)).max(100).optional(),
  hidden: z.boolean().optional(),
  /** The panels in the order they stand, top first. */
  order: z.array(z.string().min(1).max(160)).max(100).optional(),
  /** The whole arrangement, as Undo and the page send it. */
  layout: RecordPanelLayout.optional(),
  expected_revision: z.number().int().nonnegative().optional(),
});
export type EditRecordPanelLayout = z.infer<typeof EditRecordPanelLayout>;

export async function editRecordPanelLayout(orgId: string, input: EditRecordPanelLayout): Promise<{ before: RecordPanelLayout; revision: number }> {
  return meta.transaction().execute(async (trx) => {
    await sql`insert into record_panel_layouts(org_id, entity_kind) values (${orgId}::uuid, ${input.kind}) on conflict do nothing`.execute(trx);
    const { rows } = await sql<{ state: unknown; revision: number }>`select state, revision from record_panel_layouts where org_id = ${orgId}::uuid and entity_kind = ${input.kind} for update`.execute(trx);
    const row = rows[0]!;
    if (input.expected_revision !== undefined && input.expected_revision !== row.revision) throw new Error("The panels changed since you opened them. Refresh before saving.");
    const before = RecordPanelLayout.parse(row.state ?? {});
    const next: RecordPanelLayout = input.layout ?? structuredClone(before);
    if (!input.layout) {
      for (const id of input.panels ?? []) if (input.hidden !== undefined) next.panels[id] = { ...next.panels[id], hidden: input.hidden };
      (input.order ?? []).forEach((id, i) => {
        next.panels[id] = { ...next.panels[id], order: i };
      });
    }
    RecordPanelLayout.parse(next);
    const revision = row.revision + 1;
    await sql`update record_panel_layouts set state = ${JSON.stringify(next)}::jsonb, revision = ${revision} where org_id = ${orgId}::uuid and entity_kind = ${input.kind}`.execute(trx);
    return { before, revision };
  });
}

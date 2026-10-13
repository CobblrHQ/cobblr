// What a pattern needs, as the owner wrote it, travels with a shared pattern
// (#6252; coordinator, 2026-10-13: shared records carry their child rows).
// Only what a need IS: its kind, label, yarn, colour, weight, quantity and
// lengths, and how it was read. Never what the owner did with it (the stash
// part it matched, the list it went onto, when it was settled), nor the
// owner's file id: the friend's copy has its own file.
import type { Insertable, Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { PatternNeedKind, PatternNeedSource, ProjectsDB, ProjectsPatternNeedsTable } from "../db.js";

const TRAVELS = [
  "read_key", "kind", "position", "label", "brand", "product", "color", "color_code", "weight", "fiber",
  "quantity", "quantity_unit", "unit_length_m", "length_m", "length_choices", "size_mm", "size_label", "source", "edited",
] as const;

const dbOf = async (orgId: string) => (await platform().tenants.getDb(orgId)) as unknown as Kysely<ProjectsDB>;

export function registerPatternNeedsShare(): void {
  platform().entities.registerShareChildren({
    kind: "projects:project",
    name: "pattern-needs",
    table: "projects_pattern_needs",
    async read(orgId, parentId) {
      const rows = await (await dbOf(orgId)).selectFrom("projects_pattern_needs").select([...TRAVELS]).where("project_id", "=", parentId).orderBy("position").execute();
      return rows.map((r) => ({ ...r }));
    },
    async write(orgId, parentId, rows) {
      const db = await dbOf(orgId);
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom("projects_pattern_needs").where("project_id", "=", parentId).execute();
        if (!rows.length) return;
        const text = (v: unknown) => (typeof v === "string" ? v : null);
        const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
        const values: Insertable<ProjectsPatternNeedsTable>[] = rows.map((r) => ({
          project_id: parentId,
          kind: r.kind as PatternNeedKind,
          read_key: text(r.read_key),
          ...(typeof r.position === "number" ? { position: r.position } : {}),
          label: text(r.label),
          brand: text(r.brand),
          product: text(r.product),
          color: text(r.color),
          color_code: text(r.color_code),
          weight: text(r.weight),
          fiber: text(r.fiber),
          quantity: num(r.quantity),
          quantity_unit: text(r.quantity_unit),
          unit_length_m: num(r.unit_length_m),
          length_m: num(r.length_m),
          length_choices: Array.isArray(r.length_choices) ? (JSON.stringify(r.length_choices) as unknown as ProjectsPatternNeedsTable["length_choices"]) : null,
          size_mm: num(r.size_mm),
          size_label: text(r.size_label),
          ...(typeof r.source === "string" ? { source: r.source as PatternNeedSource } : {}),
          ...(typeof r.edited === "boolean" ? { edited: r.edited } : {}),
        }));
        await tx.insertInto("projects_pattern_needs").values(values).execute();
      });
    },
  });
}

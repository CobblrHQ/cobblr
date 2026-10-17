// The kind a person named for a template (its id or its name), and the
// template they named, shared by save-template and delete-template.
import { platform } from "@cobblr/platform-contract";
import type { Kysely, Selectable } from "kysely";
import type { CoreTemplatesDB, CoreTemplatesTable } from "../db.js";
import { createPathOf } from "./templates.js";

export type TemplateRow = Selectable<CoreTemplatesTable>;

export async function templateKind(orgId: string, named: string): Promise<{ id: string; words: string } | { error: string }> {
  const want = named.trim().toLowerCase();
  const kinds = (await platform().entities.listKindsForOrg(orgId)).filter((k) => createPathOf(k.id, k));
  const k =
    kinds.find((x) => x.id === want) ??
    kinds.find((x) => x.display_name.toLowerCase() === want || (x.display_name_plural ?? "").toLowerCase() === want);
  if (!k) return { error: `A template can be made for ${kinds.map((x) => x.display_name_plural ?? x.display_name).join(", ")}; "${named}" is not one of them.` };
  return { id: k.id, words: k.display_name };
}

export async function findTemplate(db: Kysely<CoreTemplatesDB>, name: string, kindId?: string): Promise<TemplateRow | { error: string } | null> {
  let q = db.selectFrom("core_templates_templates").selectAll();
  if (kindId) q = q.where("target_kind", "=", kindId);
  const rows = (await q.execute()).filter((r) => r.id === name.trim() || r.name.toLowerCase() === name.trim().toLowerCase());
  if (rows.length > 1) return { error: `More than one template is called "${name}". Say which kind of record it is for.` };
  return rows[0] ?? null;
}

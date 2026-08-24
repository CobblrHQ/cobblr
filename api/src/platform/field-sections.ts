// Grouping a kind's custom fields under a heading on its form, from a sentence.
//
// The form builder does this by dragging: it saves the section order and every
// field's section + position in one POST. What a person SAYS is "put purchase
// date and supplier under Buying", which is the same change with none of the
// ids in it — so this resolves the names, creates the heading if it is new, and
// moves the fields, refusing rather than guessing when a name fits two fields.
//
// Same shape as the nav grouping the assistant already does, deliberately: a
// heading is a heading, whether it is in the navbar or on a form.

import { matchByLabel } from "@cobblr/platform-contract/said-names";
import { meta } from "../db/meta.js";
import { clearComputedDefsCache } from "./computed-fields.js";
import { resolveFieldDefsForKind } from "./field-defs.js";

export type GroupFieldsResult =
  | { ok: true; section: string; moved: string[] }
  | { ok: false; message: string };

/** The defs a person can name on this kind: its own, never a trait-scoped one.
 *  A scoped def belongs to a class of kinds and its position is not this kind's
 *  to set. */
async function ownDefs(orgId: string, entityKind: string) {
  const defs = await resolveFieldDefsForKind(orgId, entityKind);
  return defs.filter((d) => !d.scope);
}

function resolveNames(
  said: readonly string[],
  defs: Array<{ id: string; name: string; display_label: string }>,
): { ids: Array<{ id: string; name: string; label: string }> } | { message: string } {
  const ids: Array<{ id: string; name: string; label: string }> = [];
  for (const raw of said) {
    const byName = defs.filter((d) => d.name === raw.trim().toLowerCase());
    const hit =
      byName.length === 1
        ? { label: byName[0]!.display_label, id: byName[0]!.id, name: byName[0]!.name }
        : matchByLabel(
            raw,
            defs.map((d) => ({ label: d.display_label, id: d.id, name: d.name })),
          );
    if (!hit) {
      return { message: `no field called "${raw}" here. There is: ${defs.map((d) => d.display_label).join(", ")}` };
    }
    if ("ambiguous" in hit) {
      return { message: `"${raw}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
    }
    ids.push({ id: hit.id, name: hit.name, label: hit.label });
  }
  return { ids };
}

/** Put the named fields under a heading, creating it if it is new. With
 *  `renameTo`, the heading a person named is renamed instead — same sentence
 *  shape ("that heading, this word"), so it belongs with this rather than as a
 *  third thing to find. */
export async function groupFields(
  orgId: string,
  entityKind: string,
  sectionName: string,
  fieldNames: readonly string[],
  renameTo?: string,
): Promise<GroupFieldsResult> {
  if (renameTo) {
    const rows = await meta
      .selectFrom("field_sections")
      .select(["id", "name"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", entityKind)
      .execute();
    const hit = matchByLabel(
      sectionName,
      rows.map((r) => ({ label: r.name, id: r.id })),
    );
    if (!hit) {
      return {
        ok: false,
        message: rows.length
          ? `no heading called "${sectionName}" here. There is: ${rows.map((r) => r.name).join(", ")}`
          : `"${entityKind}" has no headings on its form yet`,
      };
    }
    if ("ambiguous" in hit) {
      return { ok: false, message: `"${sectionName}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
    }
    await meta
      .updateTable("field_sections")
      .set({ name: renameTo, updated_at: new Date() })
      .where("id", "=", hit.id)
      .where("org_id", "=", orgId)
      .execute();
    clearComputedDefsCache();
    return { ok: true, section: renameTo, moved: [] };
  }
  const defs = await ownDefs(orgId, entityKind);
  if (defs.length === 0) return { ok: false, message: `"${entityKind}" has no custom fields to group` };
  const resolved = resolveNames(fieldNames, defs);
  if ("message" in resolved) return { ok: false, message: resolved.message };

  const existing = await meta
    .selectFrom("field_sections")
    .select(["id", "name", "position"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", entityKind)
    .execute();
  const match = matchByLabel(
    sectionName,
    existing.map((s) => ({ label: s.name, id: s.id })),
  );
  let sectionId: string;
  let label = sectionName;
  if (match && !("ambiguous" in match)) {
    sectionId = match.id;
    label = match.label;
  } else {
    const last = existing.reduce((n, s) => Math.max(n, s.position), -1);
    const row = await meta
      .insertInto("field_sections")
      .values({ org_id: orgId, entity_kind: entityKind, name: sectionName, position: last + 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    sectionId = row.id;
  }

  // Position within the section follows the order they were named, which is the
  // order they were said — the one thing the sentence does tell us about layout.
  let pos = 0;
  for (const f of resolved.ids) {
    await meta
      .updateTable("module_field_defs")
      .set({ section_id: sectionId, position: pos++ } as never)
      .where("id", "=", f.id)
      .where("org_id", "=", orgId)
      .execute();
  }
  clearComputedDefsCache();
  return { ok: true, section: label, moved: resolved.ids.map((f) => f.label) };
}

/** Take the named fields out of whatever heading they are under. A heading left
 *  with nothing in it goes too: an empty heading on a form is a line of nothing. */
export async function ungroupFields(
  orgId: string,
  entityKind: string,
  fieldNames: readonly string[],
): Promise<GroupFieldsResult> {
  const defs = await ownDefs(orgId, entityKind);
  const resolved = resolveNames(fieldNames, defs);
  if ("message" in resolved) return { ok: false, message: resolved.message };

  const touched = defs.filter((d) => resolved.ids.some((f) => f.id === d.id));
  const sections = [...new Set(touched.map((d) => d.section_id).filter((s): s is string => !!s))];
  await meta
    .updateTable("module_field_defs")
    .set({ section_id: null } as never)
    .where(
      "id",
      "in",
      resolved.ids.map((f) => f.id),
    )
    .where("org_id", "=", orgId)
    .execute();

  for (const s of sections) {
    const left = await meta
      .selectFrom("module_field_defs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("section_id", "=", s)
      .limit(1)
      .executeTakeFirst();
    if (!left) {
      await meta.deleteFrom("field_sections").where("id", "=", s).where("org_id", "=", orgId).execute();
    }
  }
  clearComputedDefsCache();
  return { ok: true, section: "", moved: resolved.ids.map((f) => f.label) };
}

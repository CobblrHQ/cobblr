// The kernel half of "edit a record from anywhere": platform:update-fields.
// It decides WHO may change WHICH fields and hands the rest to the kind's own
// updater (entity-updaters.ts), so an app form, the API and the assistant
// cannot be wider than the member's own screen: a member who cannot see
// `cost` cannot write `cost`.

import { platform, type EntityUpdateResult } from "@cobblr/platform-contract";
import { updaterFor } from "./entity-updaters.js";
import { baseKindOf } from "./entities.js";
import { commonBulkFields, type BulkField } from "./bulk-set-field.js";

export type UpdateFieldsOutcome =
  | { ok: true; summary: string; changed: string[]; withheld: string[] }
  | { ok: false; code: "kind_not_updatable" | "missing_capability" | "not_found" | "no_fields" | "nothing_visible" | "refused"; error: string };

export async function updateRecordFields(args: {
  orgId: string;
  userId: string | null;
  role: string;
  kind: string;
  id: string;
  fields: Record<string, unknown>;
}): Promise<UpdateFieldsOutcome> {
  const { orgId, userId, role, kind, id } = args;
  const updater = updaterFor(await baseKindOf(orgId, kind));
  if (!updater) return { ok: false, code: "kind_not_updatable", error: "This kind of record cannot be changed from here." };
  if (!userId) return { ok: false, code: "missing_capability", error: "Sign in to change a record." };
  const allowed = updater.capability
    ? await platform().auth.userHasCapability({ orgId, userId, role, actionId: updater.capability })
    : role !== "guest";
  if (!allowed) return { ok: false, code: "missing_capability", error: "You do not have permission to change this kind of record." };

  const viewer = { userId, role };
  const seen = await platform().entities.lookup(orgId, kind, id, viewer);
  if (!seen) return { ok: false, code: "not_found", error: "That record is not available to you." };
  if (seen.fields._source_workspace_slug) return { ok: false, code: "refused", error: "That record belongs to another workspace." };

  const asked = Object.keys(args.fields);
  if (!asked.length) return { ok: false, code: "no_fields", error: "Say which fields to change." };
  const hidden = await platform().entities.hiddenFields(orgId, kind, viewer);
  const withheld = asked.filter((k) => hidden.has(k));
  const fields = Object.fromEntries(Object.entries(args.fields).filter(([k]) => !hidden.has(k)));
  if (!Object.keys(fields).length) return { ok: false, code: "nothing_visible", error: "You cannot see those fields, so you cannot change them." };

  const result: EntityUpdateResult = await updater.update({ orgId, userId, role, kind, id, fields });
  if (!result.ok) return { ok: false, code: "refused", error: result.error };
  const changed = result.changed ?? Object.keys(fields);
  return { ok: true, summary: result.summary ?? "Saved the change.", changed, withheld };
}

/** What an edit form for `kind` may offer this member: nothing when the kind
 *  has no updater or the member lacks its grant, else the fields they can
 *  see that the kind's updater takes (its own columns by its list, custom
 *  fields as defined). The form and update-fields judge by the same rules,
 *  so the form offers no field the save would refuse. */
export async function editableFieldsOf(args: { orgId: string; userId: string; role: string; kind: string }): Promise<{ updatable: boolean; can_edit: boolean; fields: BulkField[] }> {
  const { orgId, userId, role, kind } = args;
  const updater = updaterFor(await baseKindOf(orgId, kind));
  if (!updater) return { updatable: false, can_edit: false, fields: [] };
  const can = updater.capability
    ? await platform().auth.userHasCapability({ orgId, userId, role, actionId: updater.capability })
    : role !== "guest";
  if (!can) return { updatable: true, can_edit: false, fields: [] };
  const hidden = await platform().entities.hiddenFields(orgId, kind, { userId, role });
  const fields = (await commonBulkFields(orgId, [kind])).filter(
    (f) => !hidden.has(f.name) && (!f.native || !updater.nativeFields || updater.nativeFields.has(f.name)),
  );
  return { updatable: true, can_edit: true, fields };
}

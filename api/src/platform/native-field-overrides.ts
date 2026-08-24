// The workspace's layer over a field the MODULE ships.
//
// A built-in field (a part's manufacturer, a machine's serial number) is not a def anyone can
// edit: it belongs to its module. What a workspace may say about it is smaller
// and lives here — call it something else, don't show it, offer these choices —
// and the same row also carries those three for a workspace's OWN fields, which
// is why hiding a custom field goes through here too.
//
// Shared by PUT /native-field-overrides and the platform:edit-field action, so
// the partial-merge rule (a write that only sets choices must not wipe a
// relabel) and the ownership rule (a user edit claims the row as user-owned so
// the next bundle push cannot clobber it) hold for both.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import type { FieldOverrideBlob, NativeFieldOverridesTable } from "../db/schema.js";
import type { Selectable } from "kysely";

export interface NativeOverridePatch {
  displayLabel?: string | null;
  hidden?: boolean;
  position?: number;
  /** null clears them, falling back to the field's own. */
  choices?: string[] | null;
}

export async function upsertNativeFieldOverride(
  orgId: string,
  entityKind: string,
  name: string,
  patch: NativeOverridePatch,
): Promise<Selectable<NativeFieldOverridesTable>> {
  const existing = await meta
    .selectFrom("native_field_overrides")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", entityKind)
    .where("name", "=", name)
    .executeTakeFirst();

  const blob: FieldOverrideBlob = { ...(existing?.overrides ?? {}) };
  if (patch.choices !== undefined) {
    if (patch.choices === null) delete blob.choices;
    else blob.choices = patch.choices;
  }
  const display_label = patch.displayLabel !== undefined ? patch.displayLabel : (existing?.display_label ?? null);
  const hidden = patch.hidden !== undefined ? patch.hidden : (existing?.hidden ?? false);
  const position = patch.position !== undefined ? patch.position : (existing?.position ?? 0);
  const blobSql = sql`${JSON.stringify(blob)}::jsonb` as unknown as FieldOverrideBlob;

  return meta
    .insertInto("native_field_overrides")
    .values({
      org_id: orgId,
      entity_kind: entityKind,
      name,
      display_label,
      hidden,
      position,
      overrides: blobSql,
      // A user edit CLAIMS the row as user-owned (bundle_id null) so a bundle
      // re-push can't clobber it: the install upsert only overwrites
      // bundle-owned rows. This is what makes the user layer win and survive.
      bundle_id: null,
    })
    .onConflict((c) =>
      c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
        display_label,
        hidden,
        position,
        overrides: blobSql,
        bundle_id: null,
        updated_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

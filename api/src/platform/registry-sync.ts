// Sync the entity_kinds + entity_actions tables from the loaded
// manifests at boot. Idempotent — re-running on every boot
// upserts any changes and removes entries for modules that went
// away. Safe because the tables are platform metadata, not user
// data.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { clearExposableFieldsCache } from "./entities.js";
import { PLATFORM_ACTIONS, PLATFORM_ACTION_OWNER } from "./platform-actions.js";
import { compileTemplate } from "@cobblr/platform-contract";

export async function syncManifestRegistries(): Promise<{
  kinds: number;
  actions: number;
}> {
  const moduleNames: string[] = [];
  const kindRows: Array<{
    id: string;
    module_name: string;
    display_name: string;
    display_name_plural: string | null;
    icon: string | null;
    fields: unknown;
    detail_route: string | null;
    endpoints: unknown | null;
    version: string;
    traits: unknown | null;
    profile: string | null;
    label_code_overlay_default: boolean | null;
    exposable_fields: string[] | null;
    duplicate_scope: string | null;
    field_read_scopes: Record<string, string> | null;
    is_primary: boolean;
  }> = [];
  const actionRows: Array<{
    id: string;
    module_name: string;
    label: string;
    description: string | null;
    icon: string | null;
    applies_to: unknown;
    scope: "entity" | "workspace";
    invoke_route: string | null;
    invoke_handler: string | null;
    user_invokable: boolean;
    args_schema: unknown;
    undoable: boolean;
    examples: string[];
    version: string;
  }> = [];

  for (const entry of listEntries()) {
    const m = entry.manifest;
    moduleNames.push(m.name);
    for (const k of m.provides?.entityKinds ?? []) {
      kindRows.push({
        id: k.id,
        module_name: m.name,
        display_name: k.displayName,
        display_name_plural: k.displayNamePlural ?? null,
        icon: k.icon ?? null,
        fields: k.fields,
        detail_route: k.detailRoute ?? null,
        endpoints:
          k.getEndpoint || k.createEndpoint || k.updateEndpoint || k.deleteEndpoint || k.listEndpoint
            ? {
                ...(k.getEndpoint ? { get: k.getEndpoint } : {}),
                ...(k.listEndpoint ? { list: k.listEndpoint } : {}),
                ...(k.createEndpoint ? { create: k.createEndpoint } : {}),
                ...(k.updateEndpoint ? { update: k.updateEndpoint } : {}),
                ...(k.deleteEndpoint ? { delete: k.deleteEndpoint } : {}),
              }
            : null,
        version: k.version ?? m.version,
        is_primary: k.primary === true,
        traits: k.traits ?? null,
        profile: k.profile ?? null,
        label_code_overlay_default: k.labelCodeOverlayDefault ?? null,
        exposable_fields: k.exposableFields ?? null,
        duplicate_scope: k.duplicateScope ?? null,
        field_read_scopes: k.fieldReadScopes ?? null,
      });
    }
    for (const a of m.exposes.actions ?? []) {
      // N1 from 2026-05-25-audit.md: warn when a user-invokable action
      // declares appliesTo: { any: true }. Universal is usually wrong
      // for clickable buttons — they end up surfacing on locations,
      // bundles, users, every entity kind in the system. Wire-driven
      // (userInvokable: false) actions can legitimately apply to any.
      const userInvokable = a.userInvokable ?? true;
      const scope = a.scope ?? "entity";
      const appliesAny =
        typeof a.appliesTo === "object" &&
        a.appliesTo !== null &&
        "any" in a.appliesTo &&
        a.appliesTo.any === true;
      // Workspace-scoped actions legitimately match no kind (appliesTo is
      // ignored for them), so the "shows on every kind" warning doesn't apply.
      if (userInvokable && appliesAny && scope !== "workspace") {
        console.warn(
          `[registry-sync] action ${a.id} declares appliesTo: { any: true } AND userInvokable: true. ` +
            `It will show as a button on every entity kind (locations, bundles, users, …). ` +
            `Narrow to specific kinds or set userInvokable: false. See 2026-05-25-audit.md N1.`,
        );
      }
      actionRows.push({
        id: a.id,
        module_name: m.name,
        label: a.label,
        description: a.description ?? null,
        icon: a.icon ?? null,
        applies_to: a.appliesTo,
        scope,
        invoke_route: a.invokeRoute ?? null,
        invoke_handler: a.invokeHandler ?? null,
        user_invokable: userInvokable,
        args_schema: a.argsSchema ?? null,
        undoable: a.undoable ?? false,
        examples: a.examples ?? [],
        version: a.version ?? m.version,
      });
    }
  }

  // The KERNEL's own actions ride the SAME array as module actions — same
  // upsert below, and the orphan-cleanup's "not in presentActionIds" naturally
  // keeps them. A side-channel insert here would be deleted on the next boot.
  for (const a of PLATFORM_ACTIONS) {
    actionRows.push({
      id: a.id,
      module_name: PLATFORM_ACTION_OWNER,
      label: a.label,
      description: a.description,
      icon: a.icon,
      // Workspace-scoped: appliesTo is ignored (matches no kind) — see the
      // registered-actions route, which forces matched_kinds to [] for them.
      applies_to: { any: true },
      scope: a.scope,
      invoke_route: null,
      invoke_handler: a.invoke_handler,
      user_invokable: a.user_invokable,
      args_schema: a.args_schema,
      undoable: a.undoable ?? false,
      examples: a.examples ?? [],
      version: a.version,
    });
  }

  // Commands a module ships, compiled here so an author never writes a regex.
  // A template that cannot compile is a manifest bug and is skipped loudly
  // rather than stored as something that will never match.
  const commandRows: Array<{
    id: string;
    module_name: string;
    template: string;
    description: string | null;
    pattern: string;
    slots: unknown;
    plan: unknown;
    repeat_field: string | null;
    repeat_shape: string | null;
    version: string;
  }> = [];
  for (const entry of listEntries()) {
    const m = entry.manifest;
    for (const c of m.exposes?.commands ?? []) {
      const compiled = compileTemplate(c.template);
      if (!compiled) {
        console.warn(`[registry-sync] ${m.name}: command ${c.id} has a template with no {blanks} or a repeated one — skipped`);
        continue;
      }
      commandRows.push({
        id: c.id,
        module_name: m.name,
        template: c.template,
        description: c.description ?? null,
        pattern: compiled.pattern,
        slots: compiled.slots,
        plan: c.plan.map((op) => ({
          tool: op.tool,
          entity_kind: op.entityKind ?? "",
          ...(op.actionId ? { action_id: op.actionId } : {}),
          payload: op.payload,
        })),
        repeat_field: c.repeatField ?? null,
        repeat_shape: c.repeatShape ?? null,
        version: m.version,
      });
    }
  }

  await meta.transaction().execute(async (trx) => {
    // Upsert every row from the loaded manifests. Previously this
    // delete-then-insert'd, which cascade-killed dependent rows like
    // entity_action_org_overrides and entity_action_bindings on every
    // boot. ON CONFLICT update preserves those dependents.
    for (const k of kindRows) {
      await trx
        .insertInto("entity_kinds")
        .values({
          id: k.id,
          module_name: k.module_name,
          display_name: k.display_name,
          display_name_plural: k.display_name_plural,
          icon: k.icon,
          fields: sql`${JSON.stringify(k.fields)}::jsonb`,
          detail_route: k.detail_route,
          endpoints: k.endpoints
            ? sql`${JSON.stringify(k.endpoints)}::jsonb`
            : null,
          version: k.version,
          is_primary: k.is_primary,
          traits: k.traits ? sql`${JSON.stringify(k.traits)}::jsonb` : null,
          profile: k.profile,
          label_code_overlay_default: k.label_code_overlay_default,
          duplicate_scope: k.duplicate_scope,
          exposable_fields: k.exposable_fields
            ? sql`${JSON.stringify(k.exposable_fields)}::jsonb`
            : null,
          field_read_scopes: k.field_read_scopes
            ? sql`${JSON.stringify(k.field_read_scopes)}::jsonb`
            : null,
        })
        .onConflict((b) =>
          b.column("id").doUpdateSet({
            module_name: k.module_name,
            display_name: k.display_name,
            display_name_plural: k.display_name_plural,
            icon: k.icon,
            fields: sql`${JSON.stringify(k.fields)}::jsonb`,
            detail_route: k.detail_route,
            endpoints: k.endpoints
              ? sql`${JSON.stringify(k.endpoints)}::jsonb`
              : null,
            version: k.version,
            is_primary: k.is_primary,
            traits: k.traits ? sql`${JSON.stringify(k.traits)}::jsonb` : null,
            profile: k.profile,
            label_code_overlay_default: k.label_code_overlay_default,
            duplicate_scope: k.duplicate_scope,
            exposable_fields: k.exposable_fields
              ? sql`${JSON.stringify(k.exposable_fields)}::jsonb`
              : null,
            field_read_scopes: k.field_read_scopes
              ? sql`${JSON.stringify(k.field_read_scopes)}::jsonb`
              : null,
          }),
        )
        .execute();
    }
    for (const a of actionRows) {
      await trx
        .insertInto("entity_actions")
        .values({
          id: a.id,
          module_name: a.module_name,
          label: a.label,
          description: a.description,
          icon: a.icon,
          applies_to: sql`${JSON.stringify(a.applies_to)}::jsonb`,
          scope: a.scope,
          invoke_route: a.invoke_route,
          invoke_handler: a.invoke_handler,
          user_invokable: a.user_invokable,
          args_schema: a.args_schema ? sql`${JSON.stringify(a.args_schema)}::jsonb` : null,
          undoable: a.undoable,
          examples: sql`${JSON.stringify(a.examples)}::jsonb`,
          version: a.version,
        })
        .onConflict((b) =>
          b.column("id").doUpdateSet({
            module_name: a.module_name,
            label: a.label,
            description: a.description,
            icon: a.icon,
            applies_to: sql`${JSON.stringify(a.applies_to)}::jsonb`,
            scope: a.scope,
            invoke_route: a.invoke_route,
            invoke_handler: a.invoke_handler,
            user_invokable: a.user_invokable,
            args_schema: a.args_schema ? sql`${JSON.stringify(a.args_schema)}::jsonb` : null,
            undoable: a.undoable,
            examples: sql`${JSON.stringify(a.examples)}::jsonb`,
            version: a.version,
          }),
        )
        .execute();
    }

    for (const c of commandRows) {
      await trx
        .insertInto("entity_commands")
        .values({
          id: c.id,
          module_name: c.module_name,
          template: c.template,
          description: c.description,
          pattern: c.pattern,
          slots: sql`${JSON.stringify(c.slots)}::jsonb`,
          plan: sql`${JSON.stringify(c.plan)}::jsonb`,
          repeat_field: c.repeat_field,
          repeat_shape: c.repeat_shape,
          version: c.version,
        })
        .onConflict((b) =>
          b.column("id").doUpdateSet({
            module_name: c.module_name,
            template: c.template,
            description: c.description,
            pattern: c.pattern,
            slots: sql`${JSON.stringify(c.slots)}::jsonb`,
            plan: sql`${JSON.stringify(c.plan)}::jsonb`,
            repeat_field: c.repeat_field,
            repeat_shape: c.repeat_shape,
            version: c.version,
            synced_at: new Date(),
          }),
        )
        .execute();
    }
    const presentCommandIds = commandRows.map((c) => c.id);
    if (presentCommandIds.length > 0) {
      await trx.deleteFrom("entity_commands").where("id", "not in", presentCommandIds).execute();
    } else {
      await trx.deleteFrom("entity_commands").execute();
    }

    // Delete rows for kinds/actions whose IDs aren't present in the
    // new manifest set (truly removed). Cascades to dependents, which
    // is the right behaviour when an action genuinely goes away.
    const presentKindIds = kindRows.map((k) => k.id);
    const presentActionIds = actionRows.map((a) => a.id);
    if (presentKindIds.length > 0) {
      await trx
        .deleteFrom("entity_kinds")
        .where("id", "not in", presentKindIds)
        .execute();
    }
    if (presentActionIds.length > 0) {
      await trx
        .deleteFrom("entity_actions")
        .where("id", "not in", presentActionIds)
        .execute();
    }
  });

  // Drop the per-process exposable-fields cache so the next lookup
  // reads the freshly-written whitelist (any kind whose declaration
  // changed gets picked up immediately rather than at next restart).
  clearExposableFieldsCache();

  console.log(
    `[registry-sync] ${kindRows.length} entity kind(s), ${actionRows.length} action(s) across ${moduleNames.length} module(s)`,
  );
  return { kinds: kindRows.length, actions: actionRows.length };
}

// Automations (wires, entity_action_bindings): set one up, change it, take it
// away. One implementation for every door, so the Automations screen
// (routes/platform.ts) and the assistant's actions (platform:add-wire,
// platform:edit-wire, platform:remove-wire) are held to the same checks: an
// event something sends, a filter that parses, a lifecycle trigger the kind
// can carry, an action the wire can run (#6528).

import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { BindingAsk, BindingLabel } from "@cobblr/platform-contract/binding-ask";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import * as activity from "./activity.js";
import { parseWireFilter } from "./wire-filter.js";
import { isLifecycleTrigger, lifecycleRefusal } from "./wire-lifecycle.js";
import { typedWireArgs, wireCheckRefusal } from "./actions.js";

// Q1 wire target — see docs/architecture/wires-and-bundles.md.
// Mirror of the WireTarget schema in @cobblr/platform-contract; kept
// inline here to keep the route's request validation independent of
// the manifest contract (different concerns, same shape).
export const BindingTarget = z.union([
  z.literal("self"),
  // No entity context — the action self-targets from its args (inbound-
  // webhook-style wires). See WireTarget in platform-contract.
  z.literal("none"),
  z.object({
    rel: z.string().min(1),
    dir: z.enum(["in", "out"]).optional(),
    kind: z.string().optional(),
  }),
]);

const clearableWireObjects = {
  filter: z.record(z.unknown()).nullish(),
  args: z.record(z.unknown()).nullish(),
};

export const BindingCreate = z
  .object({
    source_kind: z.string(),
    action_id: z.string(),
    trigger_type: z
      .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
      .default("user-invoked"),
    // .nullish() not .optional(): the web form sends `null` for an
    // unset field (not `undefined`), and `.optional()` rejected null —
    // which 400'd the default "user-invoked, no template" wire. The
    // superRefine checks below are truthiness-based, so null reads as
    // "absent" correctly, and the insert already coalesces `?? null`.
    trigger_event: z.string().nullish(),
    /** RRULE string for schedule-triggered wires (Q4). Null/absent for
     *  every other trigger type. See wires-and-bundles.md Q4. */
    trigger_schedule: z.string().nullish(),
    template: z.string().max(2000).nullish(),
    ...clearableWireObjects,
    /** A button's own label and what it asks before it runs (binding-ask.ts). */
    label: BindingLabel.nullish(),
    ask: BindingAsk.nullish(),
    /** What entity the action fires on. Default "self" (action runs on
     *  the source entity); object form opts into cross-module pairing
     *  traversal. See wires-and-bundles.md Q1. */
    target: BindingTarget.optional(),
    /** Off from the start: an undone removal sets a paused wire up paused. */
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field correctness: each trigger type has a required
    // companion field. A wire missing its companion would silently
    // never fire — fail loud at create time instead.
    if (data.trigger_type === "event" && !data.trigger_event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trigger_event is required when trigger_type is 'event'",
        path: ["trigger_event"],
      });
    }
    if (data.trigger_type === "schedule" && !data.trigger_schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_schedule (an RRULE) is required when trigger_type is 'schedule'",
        path: ["trigger_schedule"],
      });
    }
    if (data.trigger_type !== "event" && data.trigger_event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_event is only meaningful when trigger_type is 'event' — remove it or change trigger_type",
        path: ["trigger_event"],
      });
    }
    if ((data.label || data.ask?.length) && data.trigger_type !== "user-invoked") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "label and ask are for a button (trigger_type 'user-invoked'); a wire that fires on its own has nobody to ask",
        path: ["label"],
      });
    }
    if (data.trigger_type !== "schedule" && data.trigger_schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_schedule is only meaningful when trigger_type is 'schedule' — remove it or change trigger_type",
        path: ["trigger_schedule"],
      });
    }
  });

export const BindingPatch = z.object({
  source_kind: z.string().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  action_id: z.string().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  trigger_type: z
    .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
    .optional(),
  trigger_event: z.string().nullish(),
  trigger_schedule: z.string().nullish(),
  template: z.string().max(2000).nullable().optional(),
  ...clearableWireObjects,
  target: BindingTarget.optional(),
  enabled: z.boolean().optional(),
  label: BindingLabel.nullish(),
  ask: BindingAsk.nullish(),
});

/** Every event some module declares it emits (manifest `exposes.events`,
 *  held to having an emitter by lint:manifest-advertises-what-it-has). A wire
 *  on anything else never runs. */
export function declaredWireEvents(): Set<string> {
  const out = new Set<string>();
  for (const entry of listEntries()) for (const ev of entry.manifest.exposes?.events ?? []) out.add(ev);
  return out;
}

/** Why a wire on this event would never run, or null when something sends it. */
export function silentEventRefusal(triggerType: string | null | undefined, event: string | null | undefined): string | null {
  if (triggerType !== "event" || !event) return null;
  if (declaredWireEvents().has(event)) return null;
  return `Nothing sends "${event}", so a wire on it would never run. Pick an event from the list.`;
}

/** Why a wire on "a record is created / updated / deleted" of this kind could
 *  never run (wire-lifecycle.ts), or null. */
export async function lifecycleWireRefusal(orgId: string, sourceKind: string, triggerType: string): Promise<string | null> {
  if (!isLifecycleTrigger(triggerType)) return null;
  const { base, instance } = await platform().entities.resolveKind(orgId, sourceKind);
  return lifecycleRefusal(base, triggerType, !!instance);
}

type Refused = { ok: false; status: number; code: string; message: string };
type WireRow = NonNullable<Awaited<ReturnType<typeof readWire>>>;

export async function readWire(orgId: string, id: string) {
  return meta.selectFrom("entity_action_bindings").selectAll().where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst();
}

/** Set up an automation. */
export async function createWire(orgId: string, userId: string | null, data: z.infer<typeof BindingCreate>): Promise<{ ok: true; row: WireRow } | Refused> {
  const silent = silentEventRefusal(data.trigger_type, data.trigger_event);
  if (silent) {
    return { ok: false, status: 400, code: "unknown_event", message: silent };
  }
  if (data.filter != null) {
    const { error: ferr } = parseWireFilter(data.filter);
    if (ferr) {
      return { ok: false, status: 400, code: "invalid_wire_filter", message: ferr };
    }
  }
  const dead = await lifecycleWireRefusal(orgId, data.source_kind, data.trigger_type);
  if (dead) {
    return { ok: false, status: 400, code: "wire_never_runs", message: dead };
  }
  const cannot = await wireCheckRefusal(data.action_id, orgId, data.args ?? {});
  if (cannot) {
    return { ok: false, status: 400, code: "wire_cannot_run", message: cannot };
  }
  // Saved as the action reads it: a boolean as a boolean (#6130).
  data.args = (await typedWireArgs(data.action_id, data.args)) ?? undefined;
  const inserted = await meta
    .insertInto("entity_action_bindings")
    .values({
      org_id: orgId,
      // Who made it: an automation that reaches outside the workspace
      // names this person as having set it up (#6070).
      created_by: userId,
      source_kind: data.source_kind,
      action_id: data.action_id,
      trigger_type: data.trigger_type,
      trigger_event: data.trigger_event ?? null,
      trigger_schedule: data.trigger_schedule ?? null,
      template: data.template ?? null,
      filter: data.filter
        ? sql`${JSON.stringify(data.filter)}::jsonb`
        : null,
      args: data.args
        ? sql`${JSON.stringify(data.args)}::jsonb`
        : null,
      label: data.label ?? null,
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ask: data.ask?.length ? sql`${JSON.stringify(data.ask)}::jsonb` : null,
      // Default "self" (column default + explicit here so the
      // returning row carries it). Object form serialises to jsonb.
      target: data.target
        ? sql`${JSON.stringify(data.target)}::jsonb`
        : sql`'"self"'::jsonb`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await activity.log({
    orgId: orgId,
    action: "wire_created",
    ref: { module: null, entityType: "binding", entityId: inserted.id },
    diff: {
      source_kind: data.source_kind,
      action_id: data.action_id,
      trigger_type: data.trigger_type,
    },
  });
  return { ok: true, row: inserted as WireRow };
}

/** Change any part of an automation; only the fields given are written, and
 *  it keeps its id and its history. Returns the wire as it was. */
export async function updateWire(orgId: string, id: string, data: z.infer<typeof BindingPatch>): Promise<{ ok: true; row: WireRow; before: WireRow } | Refused> {
  if (data.trigger_event) {
    const silent = silentEventRefusal("event", data.trigger_event);
    if (silent) {
      return { ok: false, status: 400, code: "unknown_event", message: silent };
    }
  }
  if (data.filter != null) {
    const { error: ferr } = parseWireFilter(data.filter);
    if (ferr) {
      return { ok: false, status: 400, code: "invalid_wire_filter", message: ferr };
    }
  }
  if (data.source_kind !== undefined || data.trigger_type !== undefined) {
    const before = await meta
      .selectFrom("entity_action_bindings")
      .select(["source_kind", "trigger_type"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (before) {
      const dead = await lifecycleWireRefusal(orgId, data.source_kind ?? before.source_kind, data.trigger_type ?? before.trigger_type);
      if (dead) {
        return { ok: false, status: 400, code: "wire_never_runs", message: dead };
      }
    }
  }
  // A changed action or arguments is checked as a new wire is (#6070).
  if (data.action_id !== undefined || data.args !== undefined) {
    const was = await meta
      .selectFrom("entity_action_bindings")
      .select(["action_id", "args"])
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (was) {
      const cannot = await wireCheckRefusal(data.action_id ?? was.action_id, orgId, data.args !== undefined ? data.args ?? {} : was.args ?? {});
      if (cannot) {
        return { ok: false, status: 400, code: "wire_cannot_run", message: cannot };
      }
    }
  }
  // Build the SET only from supplied keys; jsonb columns (filter/args/target)
  // serialise the same way the create route does.
  const d = data;
  if (d.args) {
    // Saved as the action reads it: a boolean as a boolean (#6130).
    const actionId = d.action_id ?? (await meta.selectFrom("entity_action_bindings").select("action_id").where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst())?.action_id;
    if (actionId) d.args = (await typedWireArgs(actionId, d.args)) ?? d.args;
  }
  const setObj: Record<string, unknown> = { updated_at: new Date() };
  if (d.source_kind !== undefined) setObj.source_kind = d.source_kind;
  if (d.action_id !== undefined) setObj.action_id = d.action_id;
  if (d.trigger_type !== undefined) setObj.trigger_type = d.trigger_type;
  if (d.trigger_event !== undefined) setObj.trigger_event = d.trigger_event ?? null;
  if (d.trigger_schedule !== undefined) setObj.trigger_schedule = d.trigger_schedule ?? null;
  if (d.template !== undefined) setObj.template = d.template ?? null;
  if (d.enabled !== undefined) setObj.enabled = d.enabled;
  if (d.filter !== undefined) setObj.filter = d.filter ? sql`${JSON.stringify(d.filter)}::jsonb` : null;
  if (d.args !== undefined) setObj.args = d.args ? sql`${JSON.stringify(d.args)}::jsonb` : null;
  if (d.target !== undefined) setObj.target = sql`${JSON.stringify(d.target)}::jsonb`;
  if (d.label !== undefined) setObj.label = d.label ?? null;
  if (d.ask !== undefined) setObj.ask = d.ask?.length ? sql`${JSON.stringify(d.ask)}::jsonb` : null;
  // The wire as it was: the log says what this edit changed (#4517).
  const wasWire = await meta.selectFrom("entity_action_bindings").selectAll().where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst();
  const updated = await meta
    .updateTable("entity_action_bindings")
    .set(setObj)
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    return { ok: false, status: 404, code: "not_found", message: "binding not found" };
  }
  await activity.log({
    orgId: orgId,
    action: "wire_updated",
    ref: { module: null, entityType: "binding", entityId: updated.id },
    diff: data,
    before: wasWire,
  });
  return { ok: true, row: updated as WireRow, before: wasWire as WireRow };
}

/** Take an automation away. Returns it as it was, so an undo can set it up again. */
export async function deleteWire(orgId: string, id: string): Promise<{ ok: true; before: WireRow } | Refused> {
  const before = await readWire(orgId, id);
  if (!before) return { ok: false, status: 404, code: "not_found", message: "binding not found" };
  const deleted = await meta
    .deleteFrom("entity_action_bindings")
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .returning("id")
    .executeTakeFirst();
  if (!deleted) {
    return { ok: false, status: 404, code: "not_found", message: "binding not found" };
  }
  await activity.log({
    orgId: orgId,
    action: "wire_deleted",
    ref: { module: null, entityType: "binding", entityId: deleted.id },
  });
  return { ok: true, before };
}

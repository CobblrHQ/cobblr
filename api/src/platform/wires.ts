// Wires — the engine that fires user-configured bindings when
// events come in.
//
// At signup, bindings can be seeded with sensible defaults
// (inventory.stock.changed → projects.set_dependency_satisfied,
// etc.) so out-of-the-box behavior matches the old hardcoded flow.
//
// At runtime: emit() in api/src/platform/events.ts ALSO calls
// fireEvent here so any matching bindings fire. Modules' direct
// platform.events.on() handlers continue to work in parallel —
// the two routes coexist; wires are the user-configurable layer.
//
// Q1 from docs/architecture/wires-and-bundles.md: each binding
// has a `target` field describing what entity the action runs on.
//   - "self"  → action runs on the source entity (today's behaviour,
//                the default when target is unspecified).
//   - {rel,dir?,kind?} → walk entity_pairings from the source,
//                invoke the action once per discovered target.

import type { ActionInvokeActor } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { invoke } from "./actions.js";
import { lookup, walkPairings } from "./entities.js";
import { render } from "./templates.js";
import { log as logActivity } from "./activity.js";
import { currentActor } from "../lib/request-context.js";

type WireTargetDecl =
  | "self"
  | { rel: string; dir?: "in" | "out"; kind?: string };

interface ResolvedTarget {
  kind: string;
  id: string;
}

/** Build the `event.actor` block from the current request context
 *  (set by requireAuth's AsyncLocalStorage), looking up display name
 *  + token name lazily. Out-of-request callers (boot-time backfill,
 *  the recurrence-fired path, etc.) get a `system` actor with null
 *  identifiers. */
async function resolveActor(): Promise<ActionInvokeActor> {
  const actor = currentActor();
  if (!actor) {
    return {
      user_id: null,
      display_name: null,
      auth_method: "system",
      api_token_id: null,
      api_token_name: null,
    };
  }
  // One query: pull user display_name (and api token name if present).
  const userRow = await meta
    .selectFrom("users")
    .select("display_name")
    .where("id", "=", actor.userId)
    .executeTakeFirst();
  let api_token_name: string | null = null;
  if (actor.authMethod === "api_token" && actor.apiTokenId) {
    const tokRow = await meta
      .selectFrom("api_tokens")
      .select("name")
      .where("id", "=", actor.apiTokenId)
      .executeTakeFirst();
    api_token_name = tokRow?.name ?? null;
  }
  return {
    user_id: actor.userId,
    display_name: userRow?.display_name ?? null,
    auth_method: actor.authMethod,
    api_token_id: actor.apiTokenId,
    api_token_name,
  };
}

/** Decide which entities the action should fire on. For `target: "self"`
 *  (or null/missing — back-compat) the source is the target. For an
 *  object target, walk entity_pairings via the kernel's resolver
 *  primitive (entities.walkPairings) to find the discovered targets. */
async function resolveTargets(
  orgId: string,
  sourceKind: string,
  sourceId: string,
  target: unknown,
): Promise<ResolvedTarget[]> {
  // null/undefined/string → "self" semantics. Empty payload (no source
  // entity at all — e.g. an event without a typical *Id) gets handled
  // by the caller; here we just trust sourceId is present.
  if (target === null || target === undefined || target === "self") {
    return sourceId ? [{ kind: sourceKind, id: sourceId }] : [];
  }
  if (typeof target !== "object") return [];
  const decl = target as WireTargetDecl;
  if (typeof decl === "string") {
    return sourceId ? [{ kind: sourceKind, id: sourceId }] : [];
  }
  if (!sourceId) return [];

  // Delegate to the kernel resolver — same logic, one place. The
  // resolver returns ResolvedEntity (already projected); we only need
  // (kind, id) here since the wire engine will look up fields again
  // for template rendering.
  const resolved = await walkPairings(orgId, { kind: sourceKind, id: sourceId }, decl);
  return resolved.map((r) => ({ kind: r.kind, id: r.id }));
}

export async function fireEvent(
  eventName: string,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Pull the bindings whose trigger matches this event. Most of the
  // time it's zero — keep the query cheap.
  const bindings = await meta
    .selectFrom("entity_action_bindings")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("trigger_type", "=", "event")
    .where("trigger_event", "=", eventName)
    .where("enabled", "=", true)
    .execute();
  if (bindings.length === 0) return;

  // Resolve the request actor once per fire — every target of the
  // same firing shares the originating user/token (same audit identity).
  const actor = await resolveActor();
  const firedAt = new Date().toISOString();

  // Look up the source entity once if the payload carries an id.
  // Most events do: { orgId, partId, ... } / { orgId, taskId, ... }.
  for (const b of bindings) {
    try {
      // Identify the SOURCE entity ID from the event payload. By
      // convention, emitters put it under <camelCaseKindSuffix>Id
      // (partId, taskId, orderItemId, etc.) — derive that key from
      // the source_kind. Multi-word suffixes get camelCased so
      // 'purchases:order_item' → 'orderItemId' (the natural JS shape
      // emitters use), not 'order_itemId'.
      const rawSuffix = b.source_kind.split(":")[1] ?? "";
      const camelSuffix = rawSuffix.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      const idKey = `${camelSuffix}Id`;
      const sourceId =
        typeof payload[idKey] === "string" ? (payload[idKey] as string) : "";

      // Resolve the target set for this binding. "self" → just the source.
      // Object target → walk pairings.
      const targets = await resolveTargets(
        orgId,
        b.source_kind,
        sourceId,
        b.target,
      );

      // Fire the action once per discovered target. Each invocation is
      // independent; one failing doesn't skip the others.
      for (const t of targets) {
        let rendered: string | undefined;
        // Template variables come from the TARGET entity, not the
        // source — that's what the action operates on. Plus a namespaced
        // event.* block so templates can reference event-payload fields
        // ({{event.delta}}, {{event.reason}}, {{event.actor.display_name}}).
        const ent = await lookup(orgId, t.kind, t.id);
        const entityFields = ent?.fields ?? {};
        // Build the template-data view. Payload fields flatten onto
        // `event.*` so the spec's `{{event.delta}}` example works
        // directly; the system-added keys (name, actor, timestamp,
        // trigger_type) come last so they win on any collision with
        // a payload key of the same name.
        const templateData: Record<string, unknown> = {
          ...entityFields,
          _title: ent?.title ?? "",
          event: {
            ...payload,
            name: eventName,
            actor,
            timestamp: firedAt,
            trigger_type: "event" as const,
          },
        };
        if (b.template) {
          rendered = render(b.template, templateData);
        }
        // Render string args against the same data, so a structured arg like
        // {{event.delta}} (set in the wire composer) resolves. Non-strings pass
        // through; a token-free string is returned unchanged — so wires with
        // static args are unaffected (backward-compatible).
        const renderedArgs =
          b.args && typeof b.args === "object"
            ? Object.fromEntries(
                Object.entries(b.args as Record<string, unknown>).map(([k, v]) => [
                  k,
                  typeof v === "string" ? render(v, templateData) : v,
                ]),
              )
            : undefined;

        await invoke(b.action_id, {
          orgId,
          userId: actor.user_id,
          entity: { kind: t.kind, id: t.id, fields: entityFields },
          event: {
            name: eventName,
            payload,
            actor,
            timestamp: firedAt,
            trigger_type: "event",
          },
          rendered,
          args: renderedArgs,
          // Deprecated compat aliases — see ActionInvokeContext in
          // @cobblr/platform-contract.
          entityKind: t.kind,
          entityId: t.id,
        });
        // Log a successful firing so the /wires "recent firings" panel
        // can show what's running, not just what's failing. The user
        // can filter by action=wire_fired on /activity.
        try {
          await logActivity({
            orgId,
            userId: null,
            action: "wire_fired",
            ref: { module: null, entityType: "binding", entityId: b.id },
            diff: {
              event: eventName,
              action: b.action_id,
              source_kind: b.source_kind,
              source_id: sourceId,
              target_kind: t.kind,
              target_id: t.id,
            },
          });
        } catch {
          /* swallow — happy-path logging is best-effort */
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[wires] binding ${b.id} failed:`, message);
      // Wire failure is logged but never re-thrown — events stay
      // best-effort. The activity log surfaces it so the user can
      // see what went wrong.
      try {
        await logActivity({
          orgId,
          userId: null,
          action: "wire_failed",
          ref: { module: null, entityType: "binding", entityId: b.id },
          diff: { event: eventName, action: b.action_id, error: message },
        });
      } catch {
        /* swallow — already in error path */
      }
    }
  }
}

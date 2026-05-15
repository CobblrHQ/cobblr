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

import { meta } from "../db/meta.js";
import { invoke } from "./actions.js";
import { lookup } from "./entities.js";
import { render } from "./templates.js";
import { log as logActivity } from "./activity.js";

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

  // Look up the source entity once if the payload carries an id.
  // Most events do: { orgId, partId, ... } / { orgId, taskId, ... }.
  for (const b of bindings) {
    try {
      // Identify the entity ID from the event payload. By convention,
      // emitters put it under <kind-suffix>Id (partId, taskId, etc.)
      // — derive that key from the source_kind.
      const kindSuffix = b.source_kind.split(":")[1] ?? "";
      const idKey = `${kindSuffix}Id`;
      const entityId = typeof payload[idKey] === "string" ? (payload[idKey] as string) : null;

      let rendered: string | undefined;
      let templateData: Record<string, unknown> = { ...payload };
      if (entityId) {
        const ent = await lookup(orgId, b.source_kind, entityId);
        if (ent) {
          templateData = { ...templateData, ...ent.fields, _title: ent.title };
        }
      }
      if (b.template) {
        rendered = render(b.template, templateData);
      }

      await invoke(b.action_id, {
        orgId,
        userId: null,
        entityKind: b.source_kind,
        entityId: entityId ?? "",
        rendered,
        args: (b.args as Record<string, unknown> | null) ?? undefined,
        event: { name: eventName, payload },
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
            source_id: entityId,
          },
        });
      } catch {
        /* swallow — happy-path logging is best-effort */
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

// The resolution seam — turn a device event into an action on the LINKED entity.
//
// core-devices knows *which* entity a (connection, device) feeds (the link); the
// entity-owning module still owns *how* it changes — we invoke its action via the
// action bus, never write its tables (module isolation). So a scale reading sets a
// part's stock through `inventory:set-stock`; an RFID tap / counter extend the
// same dispatch as their target actions land. See
// docs/architecture/core-devices-extraction.md §4.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreDevicesDB } from "../db.js";

export interface DevicePayload {
  connection?: string;
  device?: string;
  value?: number | null;
  tag?: string | null;
  count?: number | null;
  delta?: number | null;
}

/** Resolve (connection, device) → entity link, then perform the link's `mode`
 *  by invoking the entity-owning module's action. Pure no-op (never throws to the
 *  caller's flow) when there's no link or the mode isn't supported yet. */
export async function applyToLinkedEntity(
  orgId: string,
  payload: DevicePayload,
  userId: string | null = null,
): Promise<{ ok: boolean; applied?: string; skipped?: boolean; reason?: string; [k: string]: unknown }> {
  const connection = typeof payload.connection === "string" ? payload.connection : "";
  const device = typeof payload.device === "string" ? payload.device : "";
  if (!connection || !device) return { ok: true, skipped: true, reason: "missing connection/device" };

  const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreDevicesDB>;
  const link = await db
    .selectFrom("core_devices_links")
    .select(["entity_kind", "entity_id", "mode"])
    .where("connection_id", "=", connection)
    .where("device", "=", device)
    .executeTakeFirst();
  if (!link) return { ok: true, skipped: true, reason: "no device link" };

  const invoke = (actionId: string, args: Record<string, unknown>) =>
    platform().actions.invoke(actionId, {
      orgId,
      userId,
      entity: { kind: link.entity_kind, id: link.entity_id },
      event: {
        name: "core-devices.device.applied",
        payload: {},
        actor: { user_id: userId, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "event",
      },
      args,
      entityKind: link.entity_kind,
      entityId: link.entity_id,
    });

  // PR 2 ships the flagship: inventory:part. Other (entity_kind, mode) pairs —
  // assets:asset loan from a scan, builds:build run from a count — slot in here
  // as their target actions land.
  if (link.entity_kind === "inventory:part") {
    const reason = `device:${device}`;
    if (link.mode === "set" && typeof payload.value === "number") {
      await invoke("inventory:set-stock", { partId: link.entity_id, qty: payload.value, reason });
      return { ok: true, applied: "inventory:set-stock", entityId: link.entity_id, qty: payload.value };
    }
    if (link.mode === "add" && typeof payload.value === "number") {
      await invoke("inventory:adjust-stock", { partId: link.entity_id, delta: payload.value, reason });
      return { ok: true, applied: "inventory:adjust-stock", entityId: link.entity_id, delta: payload.value };
    }
  }
  return { ok: true, skipped: true, reason: `mode '${link.mode}' on '${link.entity_kind}' not yet supported` };
}

let registered = false;

export function registerActionHandlers(): void {
  if (registered) return;
  registered = true;

  // The resolution seam (the ingest path calls applyToLinkedEntity directly for
  // the common case; this lets a power user wire ANY event to it).
  platform().actions.registerHandler("core-devices.apply-to-linked-entity", async (ctx) => {
    const ev = ((ctx.event?.payload as DevicePayload | null) ?? (ctx.args as DevicePayload | null) ?? {});
    return applyToLinkedEntity(ctx.orgId, ev, ctx.userId ?? null);
  });

  // The ACTUATOR — fire a command-and-forget at a connected controller (moved
  // here from digifab; it's general device I/O). Reaches the device through the
  // platform device seam, so it works for any connection kind regardless of which
  // module owns connections.
  platform().actions.registerHandler("core-devices.run-command", async (ctx) => {
    const args = (ctx.args as Record<string, unknown> | null) ?? {};
    const connection = typeof args.connection === "string" ? args.connection : "";
    const command = typeof args.command === "string" ? args.command : "";
    if (!connection || !command) {
      return { ok: false, skipped: true, reason: "missing `connection` or `command` arg" };
    }
    // Everything except the two control args is the command's params.
    const { connection: _c, command: _cmd, ...params } = args;

    const driver = await platform().devices.getDriver(ctx.orgId, connection);
    if (!driver) return { ok: false, error: "connection_not_found" };
    if (!driver.runCommand) return { ok: false, error: "driver_has_no_commands" };

    const result = await driver.runCommand(command, params);
    await platform().events.emit("core-devices.command.sent", {
      orgId: ctx.orgId,
      connection,
      command,
      params,
      ok: result.ok,
      ref: result.ref ?? null,
    });
    return { ok: result.ok, command, params, ref: result.ref ?? null, detail: result.detail ?? null };
  });
}

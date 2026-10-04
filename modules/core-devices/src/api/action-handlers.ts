// The resolution seam — turn a device event into an action on the LINKED entity.
//
// core-devices knows *which* entity a (connection, device) feeds (the link); the
// entity-owning module still owns *how* it changes — we invoke its action via the
// action bus, never write its tables (module isolation). So a scale reading sets a
// part's stock through `inventory:set-stock`; an RFID tap / counter extend the
// same dispatch as their target actions land. See
// docs/architecture/core-devices-extraction.md §4.

import { platform, sourceIdKey } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreDevicesDB } from "../db.js";

export interface DevicePayload {
  connection?: string;
  device?: string;
  value?: number | null;
  tag?: string | null;
  count?: number | null;
  delta?: number | null;
  unit?: string | null;
  at?: string;
}

/** The connection a record is linked to, or "" when it is linked to none.
 *  The mirror of applyToLinkedEntity's (connection, device) → entity read:
 *  one table, both directions. */
async function connectionFor(orgId: string, entity: { kind: string; id: string }): Promise<string> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreDevicesDB>;
  const link = await db
    .selectFrom("core_devices_links")
    .select(["connection_id"])
    .where("entity_kind", "=", entity.kind)
    .where("entity_id", "=", entity.id)
    .executeTakeFirst();
  return link?.connection_id ?? "";
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
  const links = await db
    .selectFrom("core_devices_links")
    .select(["id", "entity_kind", "entity_id", "mode"])
    .where("connection_id", "=", connection)
    .where("device", "=", device)
    .execute();
  const link = links[0];
  if (!link) return { ok: true, skipped: true, reason: "no device link" };

  const applyAction = async (link: typeof links[number]) => {
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
      });

    // Ask the entity-OWNING module how this reading's mode maps to one of its
    // OWN actions — core-devices stays kind-agnostic (no hardcoded
    // `kind === "inventory:part"`). inventory registers its set/add → set-stock/
    // adjust-stock mapping via platform().entities.registerDeviceApply; other
    // kinds (assets:asset loan, builds:build run) slot in by registering their
    // own provider, no change here. (Audit 2026-06-26 follow-up.)
    const mapped = platform().entities.applyDevice(link.entity_kind, {
      mode: link.mode,
      value: typeof payload.value === "number" ? payload.value : null,
      entityId: link.entity_id,
      reason: `device:${device}`,
    });
    if (mapped) {
      await invoke(mapped.actionId, mapped.args);
      return { ok: true, applied: mapped.actionId, entityId: link.entity_id, args: mapped.args };
    }
    return { ok: true, skipped: true, reason: `mode '${link.mode}' on '${link.entity_kind}' not yet supported` };
  };

  const measured = links.filter(item => item.mode === "log");
  if (measured.length) {
    if (typeof payload.value !== "number" || !Number.isFinite(payload.value)) return { ok: false, reason: "A reading needs a finite value." };
    const at = payload.at ? new Date(payload.at) : new Date();
    if (!Number.isFinite(at.getTime())) return { ok: false, reason: "A reading needs a valid sample time." };
    let applied = 0;
    for (const link of measured) {
      const reading = { link_id: link.id, value: payload.value, unit: payload.unit ?? null, sampled_at: at };
      const stored = await db.insertInto("core_devices_readings").values(reading).onConflict(oc => oc.column("link_id").doUpdateSet(reading).where("core_devices_readings.sampled_at", "<", at)).returning("link_id").executeTakeFirst();
      if (!stored) continue;
      applied++;
      const baseKind = await platform().entities.baseKindOf(orgId, link.entity_kind);
      await platform().events.emit("core-devices.record.reading", { orgId, [sourceIdKey(baseKind)]: link.entity_id, connection, device, entityKind: link.entity_kind, entityId: link.entity_id, value: payload.value, unit: payload.unit ?? null, at: at.toISOString() });
    }
    for (const link of links.filter(item => item.mode !== "log")) await applyAction(link);
    return applied ? { ok: true, applied: "reading", records: applied } : { ok: true, skipped: true, reason: "An equal or newer reading is already stored." };
  }

  return applyAction(link);
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
    const command = typeof args.command === "string" ? args.command : "";
    // Run ON a record ("open the valve on the greenhouse bed"), the record
    // says which connection: core-devices holds the link both ways, and
    // reading it here is what lets the action be asked for rather than only
    // wired (#3378). The wire's own `connection` arg still wins.
    const named = typeof args.connection === "string" ? args.connection : "";
    const linked = named || !ctx.entity ? "" : await connectionFor(ctx.orgId, ctx.entity);
    const connection = named || linked;
    if (!command) return { ok: false, error: "which command? pass `command` (what to send to the device)" };
    if (!connection) {
      return {
        ok: false,
        error: ctx.entity
          ? "no device connection is linked to this record; pass `connection` (its id or name)"
          : "which connection? run this on a record linked to a device, or pass `connection`",
      };
    }
    // Everything except the two control args is the command's params.
    const { connection: _c, command: _cmd, ...params } = args;

    const internal = await platform().devices.connections().getInternal(ctx.orgId, connection);
    if (internal?.type === "esphome") {
      const linked = await platform().devices.connections().get(ctx.orgId, internal.id);
      const credentialId = linked?.config.service_connection;
      if (typeof credentialId !== "string") return { ok: false, error: "Connect this ESPHome device to Services first." };
      const job = await platform().services.invoke({ orgId: ctx.orgId, capability: "device.esphome.command", input: { command, ...params }, via: { credentialId } });
      return { ok: true, result: { jobId: job.id, status: job.status } };
    }
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

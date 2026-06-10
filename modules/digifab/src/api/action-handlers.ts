// digifab action handlers — the ACTUATOR action surface.
//
// digifab:run-command is the piece that turns "Cobblr can reach a device" into
// "an entity's schedule commands a device." A wire (e.g. assets.asset.recurred,
// fired per-plant by each row's water_rrule) invokes it with the source entity's
// own values rendered into args — { connection, command, zone, seconds, … } —
// and we fire a parameterized command-and-forget at the connected controller via
// that connection's driver. No file, no job. See docs/BACKLOG.md "Outbound
// device COMMANDS — the actuator driver shape".

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { buildDriverById } from "../jobs-core.js";
import type { DigifabDB } from "../db.js";

let registered = false;

/** Map a wire's `connection` arg to a connection id: an exact id match first,
 *  then a case-insensitive label match (so a seeded wire can reference the
 *  connection by name). Returns null when nothing matches. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveConnectionRef(db: Kysely<DigifabDB>, ref: string): Promise<string | null> {
  // Only probe the id column when ref actually looks like a UUID — comparing
  // the uuid column to an arbitrary label ("Irrigation") throws Postgres 22P02.
  if (UUID_RE.test(ref)) {
    const byId = await db
      .selectFrom("digifab_connections")
      .select("id")
      .where("id", "=", ref)
      .executeTakeFirst();
    if (byId) return byId.id;
  }
  const byLabel = await db
    .selectFrom("digifab_connections")
    .select("id")
    .where(sql<boolean>`lower(label) = lower(${ref})`)
    .executeTakeFirst();
  return byLabel?.id ?? null;
}

export function registerActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("digifab.run-command", async (ctx) => {
    const args = (ctx.args as Record<string, unknown> | null) ?? {};
    const connection = typeof args.connection === "string" ? args.connection : "";
    const command = typeof args.command === "string" ? args.command : "";
    if (!connection || !command) {
      return { ok: false, skipped: true, reason: "missing `connection` or `command` arg" };
    }
    // Everything except the two control args is the command's params — the
    // wire's per-entity values (e.g. { zone, seconds } from this plant).
    const { connection: _c, command: _cmd, ...params } = args;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    // Resolve `connection` by id OR by label (case-insensitive). A seeded
    // bundle wire can't know the runtime connection UUID, so it references the
    // connection by the name the user gave it (e.g. "Irrigation") and the user
    // just labels their connection to match. An explicit id still wins.
    const connectionId = await resolveConnectionRef(db, connection);
    if (!connectionId) return { ok: false, error: "connection_not_found" };
    const driver = await buildDriverById(db, ctx.orgId, connectionId);
    if (!driver) return { ok: false, error: "connection_not_found" };
    if (!driver.runCommand) return { ok: false, error: "driver_has_no_commands" };

    const result = await driver.runCommand(command, params);
    await platform().events.emit("digifab.command.sent", {
      orgId: ctx.orgId,
      connection,
      command,
      params,
      ok: result.ok,
      ref: result.ref ?? null,
    });
    return {
      ok: result.ok,
      command,
      // Echo what was dispatched — useful for audit and proves the per-entity
      // params (zone, seconds) flowed through to the driver.
      params,
      ref: result.ref ?? null,
      detail: result.detail ?? null,
    };
  });
}

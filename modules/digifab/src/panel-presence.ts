// Which of digifab's record panels have something to show on a machine
// (#6337). Each panel names the collections it belongs on in the manifest; a
// machine filed elsewhere that already has the panel's data still shows it,
// so a kiln with a profile keeps its firing logs whatever it is called, and
// a 3D printer never shows a kiln's.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";

const MACHINE = "machines:machine";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onMachine(ctx: { orgId: string; kind: string; id: string }, has: (db: Kysely<DigifabDB>, machineId: string) => Promise<boolean>): Promise<boolean> {
  if (!UUID.test(ctx.id)) return false;
  const { base } = await platform().entities.resolveKind(ctx.orgId, ctx.kind);
  if (base !== MACHINE) return false;
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
  return has(db, ctx.id);
}

export const exists = async (q: { executeTakeFirst(): Promise<unknown> }) => (await q.executeTakeFirst()) !== undefined;

/** Called once when the module's api loads. */
export function registerPanelPresence(): void {
  const panels = platform().panels;
  panels.registerPresence("digifab:kiln", (ctx) =>
    onMachine(ctx, async (db, id) =>
      (await exists(db.selectFrom("digifab_kiln_profiles").select("machine_id").where("machine_id", "=", id))) ||
      exists(db.selectFrom("digifab_firings").select("machine_id").where("machine_id", "=", id).limit(1)),
    ),
  );
  panels.registerPresence("digifab:instrument", (ctx) =>
    onMachine(ctx, async (db, id) => {
      if (await exists(db.selectFrom("digifab_bench_readings").select("machine_id").where("machine_id", "=", id).limit(1))) return true;
      // A linked device the fleet cache says is a bench instrument.
      const r = await sql<{ n: number }>`
        select 1 as n from digifab_device_links l
        join digifab_fleet_device_cache c on c.connection_id = l.connection_id
        cross join lateral jsonb_array_elements(case when jsonb_typeof(c.devices) = 'array' then c.devices else '[]'::jsonb end) d
        where l.machine_id = ${id} and d->>'id' = l.remote_device_id and d->'raw'->'bench' is not null
        limit 1`.execute(db);
      return r.rows.length > 0;
    }),
  );
  panels.registerPresence("digifab:cockpit", (ctx) =>
    onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_device_links").select("machine_id").where("machine_id", "=", id).limit(1))),
  );
  panels.registerPresence("digifab:loaded", (ctx) =>
    onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_machine_slots").select("machine_id").where("machine_id", "=", id))),
  );
  panels.registerPresence("digifab:printing-profile", (ctx) =>
    onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_printing_profiles").select("machine_id").where("machine_id", "=", id))),
  );
}

// Entity-kind resolvers for digifab:job. Lets other modules look a job
// up via platform.entities.lookup(), lets the wire composer render
// digifab:job as a real source kind (the seeded completion wire's
// source), and lets search, views and an assistant list and count jobs.
// Registered as a side-effect of mounting the api.

import { registerRowHistoryWriter } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { platform, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { listMakes } from "./makes.js";

let registered = false;

export function registerFarmResolvers(): void {
  if (registered) return;
  registered = true;
  registerRowHistoryWriter("digifab:job", "digifab_jobs");
  registerRowHistoryWriter("digifab:make", "digifab_makes");

  // A Make: found by name, prompt, printer, material and outcome, from
  // search and from any view (services.md §13).
  const makeEntity = (r: { id: string; name: string; prompt: string | null; start_step: string; printer_name: string | null; material: string | null; outcome: string | null; created_at: Date; last_step?: { step: string; status: string } | null }) =>
    ({
      kind: "digifab:make",
      id: r.id,
      title: r.name,
      subtitle: [r.last_step ? `${r.last_step.step}${r.last_step.status === "done" ? "" : ` (${r.last_step.status.replace("_", " ")})`}` : null, r.printer_name, r.material, r.outcome === "pass" ? "came out well" : r.outcome === "fail" ? "failed" : null]
        .filter(Boolean)
        .join(" · "),
      detailUrl: `/makes/${r.id}`,
      fields: {
        name: r.name,
        prompt: r.prompt,
        start_step: r.start_step,
        printer_name: r.printer_name,
        material: r.material,
        outcome: r.outcome,
        created_at: r.created_at,
      },
    }) satisfies ResolvedEntity;

  platform().entities.registerResolver("digifab:make", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    const row = await db.selectFrom("digifab_makes").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? makeEntity(row) : null;
  });

  platform().entities.registerListResolver("digifab:make", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    const rows = await listMakes(db, query.q, Math.min(query.limit ?? 50, 200), query.offset ?? 0);
    return { items: rows.map(makeEntity) };
  });

  platform().entities.registerResolver("digifab:job", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    const row = await db.selectFrom("digifab_jobs").select(JOB_COLUMNS).where("id", "=", id).executeTakeFirst();
    return row ? jobToResolved(row) : null;
  });

  platform().entities.registerListResolver("digifab:job", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    let q = db.selectFrom("digifab_jobs").select(JOB_COLUMNS);
    const status = query.filter?.status;
    if (typeof status === "string") q = q.where("status", "=", status as never);
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["file_ref", "status", "target_device", "error"] })!);
    const rows = await q.orderBy("created_at", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(jobToResolved) };
  });
}

const JOB_COLUMNS = ["id", "file_ref", "status", "target_device", "progress", "remote_job_id"] as const;

function jobToResolved(row: {
  id: string; file_ref: string; status: string; target_device: string | null; progress: number | null; remote_job_id: string | null;
}): ResolvedEntity {
  return {
    kind: "digifab:job",
    id: row.id,
    title: row.file_ref,
    subtitle: row.status,
    detailUrl: "/configuration/devices?tab=machines",
    fields: {
      file_ref: row.file_ref,
      status: row.status,
      target_device: row.target_device,
      progress: row.progress,
      remote_job_id: row.remote_job_id,
    },
  };
}

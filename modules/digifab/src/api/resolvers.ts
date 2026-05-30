// Entity-kind resolver for digifab:job. Lets other modules look a job
// up via platform.entities.lookup() and lets the wire composer render
// digifab:job as a real source kind (the seeded completion wire's
// source). Registered as a side-effect of mounting the api.

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";

let registered = false;

export function registerFarmResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("digifab:job", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    const row = await db
      .selectFrom("digifab_jobs")
      .select(["id", "file_ref", "status", "target_device", "progress", "remote_job_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      kind: "digifab:job",
      id: row.id,
      title: row.file_ref,
      subtitle: row.status,
      detailUrl: "/configuration/farm",
      fields: {
        file_ref: row.file_ref,
        status: row.status,
        target_device: row.target_device,
        progress: row.progress,
        remote_job_id: row.remote_job_id,
      },
    } satisfies ResolvedEntity;
  });
}

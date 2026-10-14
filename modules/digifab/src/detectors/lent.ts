// Printers lent out: a machine with an open loan (record-loans.md) is away,
// so the print farm sends it nothing until it is back. Keyed like owned.ts,
// "<connId>:<deviceId>", with the words a refusal says.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { lentWhy, loanOfFields } from "@cobblr/platform-contract/loan";
import type { DigifabDB } from "../db.js";

export async function lentDeviceRefs(db: Kysely<DigifabDB>, orgId: string): Promise<Map<string, string>> {
  const links = await db.selectFrom("digifab_device_links").select(["connection_id", "remote_device_id", "machine_id"]).execute();
  const out = new Map<string, string>();
  const why = new Map<string, string | null>();
  for (const l of links) {
    if (!why.has(l.machine_id)) {
      const m = await platform().entities.lookup(orgId, "machines:machine", l.machine_id).catch(() => null);
      const loan = m ? loanOfFields(m.fields) : null;
      why.set(l.machine_id, loan ? lentWhy(loan) : null);
    }
    const said = why.get(l.machine_id);
    if (said) out.set(`${l.connection_id}:${l.remote_device_id}`, said);
  }
  return out;
}

/** Why this job's printer cannot take it now, or null: the machine it is
 *  linked to, or the one its device is linked to, is lent out. */
export async function lentPrinterRefusal(
  db: Kysely<DigifabDB>,
  orgId: string,
  job: { connection_id: string | null; target_device: string | null; linked_machine_id?: string | null },
): Promise<string | null> {
  let machineId = job.linked_machine_id ?? null;
  if (!machineId && job.connection_id && job.target_device) {
    machineId =
      (
        await db
          .selectFrom("digifab_device_links")
          .select("machine_id")
          .where("connection_id", "=", job.connection_id)
          .where("remote_device_id", "=", job.target_device)
          .executeTakeFirst()
      )?.machine_id ?? null;
  }
  if (!machineId) return null;
  const m = await platform().entities.lookup(orgId, "machines:machine", machineId).catch(() => null);
  const loan = m ? loanOfFields(m.fields) : null;
  return loan ? lentWhy(loan) : null;
}

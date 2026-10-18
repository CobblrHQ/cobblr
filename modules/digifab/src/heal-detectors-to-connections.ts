// One-shot heal: move each external print-failure detector's address and key
// onto an adapter service connection (Services S8, the #4034 decision).
//
// DONE WHEN: no tenant DB has a digifab_detectors row whose
// service_connection_id is null. Check with, per tenant:
//   select count(*) from digifab_detectors where service_connection_id is null;
// When that is 0 on prod, staging and dev, delete this file and its boot
// call. New detectors are born on a connection (POST /detectors calls
// moveDetectorToConnection), so nothing makes a new unmoved row.
//
// WHY IT EXISTS: the detectors kept their own connection store (address,
// encrypted key) beside Connections, so a person had two places where an
// outside program's address lives and two Tests. After the move the address
// and key live on the connection only; this row keeps what is per printer
// (the camera map, whether the detector owns its printers), which the watch
// and the single-owner rule (ownedDeviceRefs) still read here.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { adapterProviderId } from "@cobblr/platform-contract/services";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { DigifabDB } from "./db.js";
import { detectorAdapterId } from "./detectors/adapters.js";
import { resolveDetector } from "./detectors/registry.js";

type Db = Kysely<DigifabDB>;

/** platform().connections.createWorkspaceConnection, as the Connections half
 *  defines it; absent on a build without it, when nothing moves. */
type CreateWorkspaceConnection = (req: {
  orgId: string;
  kind: "service";
  providerId: string;
  label: string;
  credentials: Record<string, string>;
  originKey: string;
  note?: string;
}) => Promise<{ credentialId: string; created: boolean }>;

export interface MoveDeps {
  create: CreateWorkspaceConnection | null;
  decrypt(orgId: string, enc: string): Promise<Record<string, unknown>>;
}
const REAL: () => MoveDeps = () => ({
  create: ((platform() as unknown as { connections?: { createWorkspaceConnection?: CreateWorkspaceConnection } }).connections?.createWorkspaceConnection ?? null) as CreateWorkspaceConnection | null,
  decrypt: (orgId, enc) => platform().integrations.decryptCredentials(orgId, enc),
});

export type MoveOutcome = "moved" | "already" | "unknown_detector" | "not_available";

/** Move one detector row. Idempotent: the connection is keyed on the row, so
 *  a second run finds the same one and changes nothing. */
export async function moveDetectorToConnection(orgId: string, db: Db, rowId: string, deps: MoveDeps = REAL()): Promise<MoveOutcome> {
  const row = await db
    .selectFrom("digifab_detectors")
    .select(["id", "key", "label", "base_url", "credentials_enc", "service_connection_id"])
    .where("id", "=", rowId)
    .executeTakeFirst();
  if (!row) return "unknown_detector";
  if (row.service_connection_id) return "already";
  if (!resolveDetector(row.key)?.manifest) return "unknown_detector";
  if (!deps.create) return "not_available";
  let apiKey = "";
  if (row.credentials_enc) {
    try {
      apiKey = String((await deps.decrypt(orgId, row.credentials_enc)).apiKey ?? "");
    // pass-catch: an undecryptable key moves without one, as the watch already used it
    } catch {
      /* undecryptable: moved without a key, as the watch already used it */
    }
  }
  const { credentialId } = await deps.create({
    orgId,
    kind: "service",
    providerId: adapterProviderId(detectorAdapterId(row.key)),
    label: row.label,
    credentials: { base_url: row.base_url, ...(apiKey ? { api_key: apiKey } : {}) },
    originKey: `digifab_detectors:${row.id}`,
    note: "Moved from the detector settings; press Test to check it.",
  });
  // The connection holds the address and key now: the row keeps no copy of
  // either (the secret especially), only what is per printer.
  await db
    .updateTable("digifab_detectors")
    .set({ service_connection_id: credentialId, credentials_enc: null, base_url: "", updated_at: new Date() } as never)
    .where("id", "=", row.id)
    .execute();
  return "moved";
}

/** Heal one workspace: every unmoved row. */
export async function healDetectorsIn(orgId: string, db: Db, since: Date, deps: MoveDeps = REAL()): Promise<number | { found: number; settled: boolean }> {
  const rows = await db.selectFrom("digifab_detectors").select(["id"]).where("service_connection_id", "is", null).where("created_at", "<", since).execute();
  if (rows.length === 0) return 0;
  let moved = 0;
  let unhealable = 0;
  for (const r of rows) {
    try {
      const out = await moveDetectorToConnection(orgId, db, r.id, deps);
      if (out === "moved") moved++;
      else if (out === "unknown_detector") unhealable++;
      else if (out === "not_available") return { found: rows.length, settled: false };
    } catch (err) {
      platform().health.notePassFailure("digifab.heal-detectors-to-connections", orgId, err);
      // No owner to hold the connection, or the Connections half refused:
      // counted, and tried again next round.
      console.warn(`[heal] digifab detector ${r.id} in ${orgId} not moved: ${(err as Error).message}`);
    }
  }
  if (moved) console.log(`[heal] org ${orgId}: moved ${moved} detector(s) onto connections`);
  const left = rows.length - moved;
  return left === 0 ? rows.length : { found: left, settled: left === unhealable };
}

export function registerDetectorsToConnectionsHeal(): void {
  registerHealPass({
    name: "digifab.heal-detectors-to-connections",
    since: "2026-09-30T23:13:35Z",
    shim: "modules/digifab/src/heal-detectors-to-connections.ts",
    module: "digifab",
    visit: ({ orgId, db, since }) => healDetectorsIn(orgId, db as Db, since),
  });
}

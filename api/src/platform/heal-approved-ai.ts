// A workspace that approved an AI and never switched it on.
//
// BORN WITH: planRouteRows (credential-routing.ts) fills the vacancy at attach time, so a new approval writes the active shape; this heals the rows an older approval wrote inactive (SINCE: da44d050ec)
//
// DONE WHEN: no `user_credential_orgs` row anywhere is (mode workspace-default,
// approved, self-approved, active=false) in a workspace with no active AI —
// checked on prod, staging and dev, AND a stable release has shipped with this
// file in it (2026.10.0, so an install that jumps from 2026.8.1 runs it, #7679).
// Then delete this file and its boot call.
//
// WHAT HAPPENED. Attaching your own AI key and ticking the workspaces it serves
// auto-APPROVED each row (you own them) and hardcoded `active: false`. Only the
// other path — approving an AI somebody offered you — had the rule that an
// approved AI goes live when the workspace has none. So a stranger's offer
// switched itself on and your own key did not.
//
// The account that found it (2026-09-02) swapped a Claude bridge for a Gemini
// key: the bridge's routes went with the swap, the Gemini rows landed
// approved-and-inactive, and SEVEN workspaces ran with no AI for twelve days.
// Nothing said so. Scans quietly took the no-AI heuristic path, which is how it
// surfaced at all — a textbook filed into the wrong table.
//
// setCredentialRoutes now fills the vacancy at attach time. That fixes the next
// save; it cannot fix a workspace nobody re-saves, and asking every affected
// owner to go and click something is not a fix, it is a support ticket.
//
// WHAT THIS WILL AND WILL NOT DO. It only ever fills a VACUUM: a workspace with
// any live AI is left exactly as it is, so a deliberate pick is never
// overridden. It only activates a row the workspace's OWN owner approved
// (self-approved), never an outside offer — accepting somebody else's AI on
// their behalf is not this shim's business. And it activates ONE per workspace,
// the earliest approved, so the choice is deterministic rather than whichever
// row a scan happened to return first.

export interface HealedAi {
  orgId: string;
  credentialId: string;
}

export interface IdleAiRow {
  org_id: string;
  credential_id: string;
  /** who approved the row */
  approved_by: string | null;
  /** who owns the credential; equal to approved_by when it is the owner's own key */
  cred_owner: string;
}

/**
 * The decision, apart from the SQL: of the approved-but-idle rows, which ones
 * become their workspace's AI. Exported so the rule is tested directly rather
 * than transcribed into a test that could agree with a broken heal.
 *
 * `idle` must arrive oldest-approval-first; `live` is every workspace that
 * already has an active AI.
 */
export function pickApprovedAiToActivate(idle: IdleAiRow[], live: ReadonlySet<string>): IdleAiRow[] {
  const picked: IdleAiRow[] = [];
  const taken = new Set<string>();
  for (const row of idle) {
    if (live.has(row.org_id) || taken.has(row.org_id)) continue;
    // Self-approved only: the owner attached their OWN key. An offer from
    // somebody else stays for a person to accept.
    if (!row.approved_by || row.approved_by !== row.cred_owner) continue;
    taken.add(row.org_id);
    picked.push(row);
  }
  return picked;
}

/** When the fix merged: an approval made after it was made by code that switches the AI on. */
export const APPROVED_AI_SINCE = new Date("2026-09-04T00:43:27Z");

export async function healApprovedButInactiveAi(since: Date = APPROVED_AI_SINCE): Promise<HealedAi[]> {
  // Imported lazily: the module-level `meta` opens a pg Pool, and the pure
  // decision above must stay importable by a unit test without one.
  const { meta } = await import("../db/meta.js");
  const { noteHealShim } = await import("./heal-shim-log.js");
  const { notePassFailure } = await import("./pass-failures.js");
  // Workspaces that HAVE a live AI: everything below is scoped away from them.
  // AI providers only. The table holds every kind of connection a person can
  // attach, and a workspace whose live workspace-default row is a parcel bridge
  // has a vacancy for an AI - it used to read as occupied, so the one workspace
  // that most needed this heal was the one it always skipped.
  const live = new Set(
    (
      await meta
        .selectFrom("user_credential_orgs as uco")
        .innerJoin("user_credentials as c", "c.id", "uco.credential_id")
        .select("uco.org_id")
        .where("uco.mode", "=", "workspace-default")
        .where("uco.active", "=", true)
        .where("c.kind", "=", "ai-provider")
        .execute()
    ).map((r) => r.org_id),
  );

  // Approved-but-idle rows, oldest approval first so the pick is stable.
  const idle = await meta
    .selectFrom("user_credential_orgs as uco")
    .innerJoin("user_credentials as c", "c.id", "uco.credential_id")
    .select(["uco.org_id", "uco.credential_id", "uco.approved_by", "c.user_id as cred_owner"])
    .where("uco.mode", "=", "workspace-default")
    .where("uco.active", "=", false)
    .where("uco.approved_at", "is not", null)
    .where("uco.approved_at", "<", since)
    .where("c.kind", "=", "ai-provider")
    .orderBy("uco.approved_at", "asc")
    .execute();

  const healed: HealedAi[] = [];
  let failed = 0;
  const picked = pickApprovedAiToActivate(idle, live);
  for (const row of picked) {
    // A row that fails to write is simply left for the next boot; the pick is
    // deterministic, so the same row comes up again.
    try {
      await meta
        .updateTable("user_credential_orgs")
        .set({ active: true })
        .where("org_id", "=", row.org_id)
        .where("credential_id", "=", row.credential_id)
        .where("mode", "=", "workspace-default")
        .execute();
      healed.push({ orgId: row.org_id, credentialId: row.credential_id });
    } catch (err) {
      // One workspace's failure never blocks the rest.
      failed++;
      notePassFailure("heal-approved-ai", row.org_id, err);
      console.error(`[heal-ai] org ${row.org_id}: ${(err as Error).message}`);
    }
  }
  if (healed.length) {
    console.log(
      `[heal-ai] switched on an approved-but-idle AI in ${healed.length} workspace(s) that had none`,
    );
  }
  await noteHealShim("api/src/platform/heal-approved-ai.ts", picked.length, failed);
  return healed;
}

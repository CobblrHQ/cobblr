// DONE WHEN: a round finds no waiting row whose list the fit rule no longer
// chooses (the count /healthz reports is 0); then this shim and its
// registration in module.ts can go.
//
// BORN WITH: routeByIdentity in the route (services/kept-route.ts, called
// from api/inbox/shared.ts), which lifts a row off a module's catch-all to the
// list made for what it is, by the contract's fit rule.
//
// A pack of cinnamon rolls was lifted to Spices: the fit rule read past "Rolls"
// as a packaging count and took "cinnamon" for what the thing is (#9380). The
// rule is fixed, but a row lifted before the fix keeps the list the old rule
// chose, and its card still offers "Add to Spices". So each waiting row whose
// top route is such a lift is asked again, by the same rule a live route asks.
// If the rule still chooses that list, nothing changes. If it no longer does,
// the lift is taken off and the route beneath it leads again. A person's answer
// and a filed row are never touched, nor a lift to a list the workspace no longer
// has. The lift taken off is kept under identity_unlift.prior: putting it back at
// the head of the list undoes the heal.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { scanBetterTable, scanFitItem, storedDestinationOf, type ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import { destinationTables } from "./services/destination.js";
import type { ScanMenuEntry } from "./services/matchmaker.js";

export const IDENTITY_LIFT_RULE = { version: "an-uncounted-roll-is-the-thing", since: "2026-11-10T02:45:00Z" } as const;

interface Candidate {
  module?: string;
  instance?: string | null;
  kind?: string;
  label?: string;
  basis?: string;
}

export interface LiftRow {
  status: string;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: unknown;
  target_module: string | null;
  target_entity_id: string | null;
}

export type LiftVerdict = { action: "keep"; why: string } | { action: "unlift"; from: string; to: string; next: Candidate[]; prior: Candidate };

const listOf = (raw: unknown): Candidate[] => {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    // pass-catch: an unparseable list has no lift to take off
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v.filter((c) => c && typeof c === "object") as Candidate[]) : [];
};

/** What the pass does with one row, given the workspace's tables. Pure. */
export function liftVerdict(row: LiftRow, tables: readonly ScanResolverTable[]): LiftVerdict {
  if (row.status !== "pending") return { action: "keep", why: "not-pending" };
  if (row.target_module || row.target_entity_id) return { action: "keep", why: "filed" };
  const meta = row.suggested_metadata ?? {};
  if (meta.user_fields || meta.reviewed === true || storedDestinationOf(meta)?.by === "person") return { action: "keep", why: "person-answered" };
  const list = listOf(row.suggested_candidates);
  const [lifted, ...rest] = list;
  // Only a lift the route made itself: one that moved a candidate already on
  // the list keeps that candidate's own basis.
  if (!lifted || lifted.basis !== "identity" || !rest.length) return { action: "keep", why: "no-lift" };
  // Only a list the workspace still has: a lift to a table since taken away
  // is not this rule's to undo.
  const installed = tables.some((t) => (t.instance_name ?? null) === (lifted.instance ?? null) && (!t.module_name || t.module_name === lifted.module));
  if (!installed) return { action: "keep", why: "list-gone" };
  const under = rest[0]!;
  const item = scanFitItem({ suggested_name: row.suggested_name, suggested_manufacturer: row.suggested_manufacturer, suggested_metadata: row.suggested_metadata, suggested_candidates: rest } as never);
  const fits = scanBetterTable(item, under.kind ?? null, tables, under.module ?? null);
  if (fits?.instance_name && fits.instance_name === lifted.instance && (!fits.module_name || fits.module_name === lifted.module)) return { action: "keep", why: "still-fits" };
  return { action: "unlift", from: String(lifted.label ?? lifted.instance), to: String(under.label ?? under.module), next: rest, prior: lifted };
}

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    suggested_name: string | null;
    suggested_manufacturer: string | null;
    suggested_metadata: unknown;
    suggested_candidates: unknown;
    target_module: string | null;
    target_entity_id: string | null;
    created_at: Date;
  };
}

/** Heal one workspace. Returns how many rows lost a lift. */
export async function healIdentityLiftsIn(orgId: string, db: Kysely<HealDB>, since: Date, menuOf: (orgId: string) => Promise<ScanMenuEntry[] | null>): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_name", "suggested_manufacturer", "suggested_metadata", "suggested_candidates", "target_module", "target_entity_id"])
    .where("created_at", "<", since)
    .where("status", "=", "pending")
    .limit(2000)
    .execute();
  const lifted = rows.filter((r) => listOf(r.suggested_candidates)[0]?.basis === "identity");
  if (!lifted.length) return 0;
  const menu = await menuOf(orgId);
  if (!menu?.length) return 0;
  const tables = destinationTables(menu);
  let healed = 0;
  for (const r of lifted) {
    const v = liftVerdict(r as LiftRow, tables);
    if (v.action !== "unlift") continue;
    try {
      // `prior` is the lift itself: putting it back at the head of the list
      // undoes this, the way reroute_prior keeps a rerouted row's list.
      const stamp = { identity_unlift: { at: new Date().toISOString(), rule: IDENTITY_LIFT_RULE.version, from: v.from, to: v.to, prior: v.prior } };
      const done = await db
        .updateTable("core_scan_inbox_items")
        .set({
          // jsonb-replace-ok: candidates are a LIST; this writes the read list minus its lifted head, and only while the row still holds that list (the where below)
          suggested_candidates: JSON.stringify(v.next) as never,
          suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb` as never,
        })
        .where("id", "=", r.id)
        .where("status", "=", "pending")
        .where(sql<boolean>`suggested_candidates = ${JSON.stringify(listOf(r.suggested_candidates))}::jsonb`)
        .execute();
      // A row changed since it was read is left for the next round.
      if (!Number(done[0]?.numUpdatedRows ?? 0)) continue;
      healed++;
      console.log(`[core-scan] org ${orgId}: ${r.suggested_name ?? r.id} no longer goes to ${v.from}; ${v.to} again`);
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-identity-lifts", orgId, err);
      console.error(`[core-scan] org ${orgId}: could not take a lift off ${r.id}:`, (err as Error).message);
    }
  }
  return healed;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerIdentityLiftsHeal(): void {
  registerHealPass({
    name: "core-scan.heal-identity-lifts",
    since: IDENTITY_LIFT_RULE.since,
    shim: "modules/core-scan/src/heal-identity-lifts.ts",
    module: "core-scan",
    visit: async ({ orgId, db, since }) => {
      const { menuFor } = await import("./services/reroute-keyword-rows.js");
      return healIdentityLiftsIn(orgId, db as Kysely<HealDB>, since, menuFor);
    },
  });
}

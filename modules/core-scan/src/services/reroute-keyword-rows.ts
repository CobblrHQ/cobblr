// PERMANENT RECONCILE: when the no-AI planner's rules change, every waiting
// row it planned under the old rules is asked again, once (#3019, #9380).
// DONE WHEN: never retired, because the next rule change asks again. What
// /healthz reports for this path is how many rows this instance has moved
// under the current rules since it booted, and how many workspace visits
// failed (tallyMoves): a sweep that moves a person's rows says how many.
//
// Three tea rows matched by keywords routed to Inventory beside a fourth
// that routed to Groceries, in a workspace with Groceries installed. The
// three were matched before #3004 changed the order (the catalog's category
// outranks a word the name grazed; a route the category contradicts is
// dropped); the rule fixed every row matched after it and left every row
// matched before it as it was. It happened again with #9380: the fit rule
// read past an uncounted "Rolls", so a pack of cinnamon rolls was planned onto
// Spices, and the fix left every row planned before it there, where its
// same-name twins followed it (kept-route.ts). Each fix had healed only the
// rows of its own rule, by its own date. So the planner's rules carry a
// version (REROUTE_RULE), and a change that can move where a heuristic plan
// routes a thing bumps it. Same rule as the retrim of stored pictures and
// docs/architecture/platform-spec.md §8.1: what was stored before heals itself.
//
// What it does, per pending row whose route the no-AI planner made (noun,
// keywords or the catch-all) and that nobody has answered over: re-run the
// matchmaker's no-AI plan on the evidence already on the row (name, code,
// catalog category, description, observations), through the same
// deterministic passes a live route gets, and replace the candidate list only
// when the top route differs. The old list is kept under `reroute_prior`
// (putting it back undoes the move); the row is stamped `reroute` with the
// rules' version either way, so a second look under the same rules costs
// nothing. The plan is then lifted where the live route lifts it
// (kept-route.ts): to the record the thing already is, the collection it was
// shared from, or where its same-name twins scanned before it are kept, as
// they are now. So a row that only followed a misplaced twin goes back with
// it, and one a person's twin or its own record keeps stays (#9404). A row
// waits while a twin scanned before it is still to be asked, and the pages
// run oldest first, so a leader is judged before its followers. Only rows made before the later of the version's merge and the
// first time this instance ran it: a row made since was planned by these
// rules, and an import or a restore made today is never moved (#5430). Never
// a person's answer: a row with typed values (user_fields), a filed or picked
// destination, a confirmed row or one a person marked "looks fine" is left
// alone. Never an AI route.
//
// A read-only count per workspace first (the audit), the heal on request,
// and the same heal a page a minute in the background behind the pictures
// sweeper, so every workspace heals on its own.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { TenantSweepPass } from "@cobblr/platform-contract";
import { narrowSweep } from "@cobblr/platform-contract/sweep-candidates";
import { scanTrackedMatch, storedDestinationOf, type ScanTriageRow } from "@cobblr/platform-contract/scan-triage";
import { assembleMergedMenu, heuristicMatch, perceiveRow, type MatchCandidate, type ScanMenuEntry } from "./matchmaker.js";
import { applyReceiptFacts } from "./receipt-candidate-facts.js";
import { applySplitInheritance } from "./split-inherit.js";
import { stripUnsupportedPurchaseFields } from "./field-provenance.js";
import { applyNameFacts } from "./name-facts.js";
import { alignStorageFields } from "./align-storage-fields.js";
import { retargetByCategory } from "./retarget-by-category.js";
import { workspaceIdentity } from "./receipt-photo.js";
import { routeWhereKept, type KeptTable } from "./kept-route.js";
import { destinationTables } from "./destination.js";
import { scannedBefore, twinTablesOf, type TwinRow } from "./twin-tables.js";
import { selfOrigin } from "@cobblr/platform-contract/self-api";

/** The no-AI planner's rules, by version. A change that can move where a
 *  heuristic plan routes a thing (matchmaker.ts heuristicMatch, the contract's
 *  table fit, the deterministic passes rerouteVerdict runs) bumps `version`
 *  and sets `since` to when it merges; every waiting row planned before it is
 *  then asked again. Earlier versions: "category-outranks-word" (#3004),
 *  "an-uncounted-roll-is-the-thing" (#9380). */
export const REROUTE_RULE = { version: "a-may-contain-list-is-not-evidence", since: "2026-11-12T14:50:00Z" } as const;
const SHIM = "modules/core-scan/src/services/reroute-keyword-rows.ts";

/** Rows per workspace per tick. The plan is pure; the query is the cost. */
export const REROUTE_PER_TICK = 50;
const TICK_MS = 20 * 60 * 1000;
const DRAIN_MS = 60 * 1000;
const INTERNAL_API = selfOrigin();
export const REROUTE_PASS = "core-scan.reroute-keyword-rows";

/** The walk is the kernel's (platform().sweeps, #3036): this registers the
 *  per-workspace visit and its cadence. */
export function startRerouteSweeper(): void {
  platform().sweeps.register(reroutePass());
  console.log(`[core-scan] keyword re-route sweeper registered — every ${TICK_MS / 60_000} min, a page a minute while there is a backlog`);
}

const bootedAt = new Date();
let arrival: Promise<Date> | null = null;
/** Rows made before this were planned under older rules: the later of the
 *  version's merge and the first time this instance ran it (heal-pass.ts, the
 *  same arrival a registered heal keeps). Keyed by the version, so each bump
 *  arrives afresh on every box, including one that upgrades late. */
export async function rerouteSince(): Promise<Date> {
  const merged = new Date(REROUTE_RULE.since);
  arrival ??= platform()
    .health.healArrival({ name: `${REROUTE_PASS}@${REROUTE_RULE.version}`, shim: `${SHIM}@${REROUTE_RULE.version}`, since: merged }, bootedAt)
    .catch((err) => {
      arrival = null;
      throw err;
    });
  const arrived = await arrival;
  return arrived > merged ? arrived : merged;
}

/**
 * A pass that moves rows says how many on /healthz: the rows its visits
 * report as `rerouted`, added up since this process started, and the visits
 * that threw. Reported when each round is chosen, so the count a round
 * reaches is on /healthz by the next one (a drain tick a minute later, or a
 * cadence). A running total, not a round's: the drain ticks a backlog takes
 * are rounds too, and a per-round count would read 0 between them.
 */
export function tallyMoves(pass: TenantSweepPass, report: (moved: number, failed: number) => void): TenantSweepPass {
  let moved = 0;
  let failed = 0;
  return {
    ...pass,
    candidates: async (orgIds, opts) => {
      report(moved, failed);
      return pass.candidates ? pass.candidates(orgIds, opts) : orgIds;
    },
    visit: async (ctx) => {
      try {
        const out = await pass.visit(ctx);
        const n = Number((out as { rerouted?: unknown } | undefined)?.rerouted ?? 0);
        if (Number.isFinite(n) && n > 0) moved += n;
        return out;
      } catch (err) {
        failed++;
        throw err;
      }
    },
  };
}

/** The pass, narrowed to the workspaces with work (#9048), with its moves on /healthz. */
export function reroutePass(read?: Parameters<typeof narrowSweep>[2]) {
  const pass = narrowSweep({
    name: REROUTE_PASS,
    everyMs: TICK_MS,
    drainMs: DRAIN_MS,
    module: "core-scan",
    visit: async ({ orgId }) => {
      const done = await rerouteWorkspace(orgId);
      return { visited: done.visited, rerouted: done.rerouted, backlog: done.visited >= REROUTE_PER_TICK };
    },
  }, hasUnjudgedKeywordRow, read);
  return tallyMoves(pass, (moved, failed) => void platform().health.noteHealShim("modules/core-scan/src/services/reroute-keyword-rows.ts", moved, failed));
}

/** The rows rerouteVerdict could act on: planned before these rules, by the
 *  no-AI planner, and not judged under them. Rows made after the rules arrived
 *  never qualify, so a workspace without one now never gains one. */
const unjudgedUnder = (since: Date) => sql`
        status = 'pending'
        and created_at < ${since.toISOString()}::timestamptz
        and target_entity_id is null
        and coalesce(suggested_metadata->'reroute'->>'rule', '') <> ${REROUTE_RULE.version}
        and (suggested_metadata->'reroute'->>'undone') is null
        and (suggested_metadata->>'matched_at') is not null
        and ((suggested_candidates->0->>'heuristic') = 'true'
             or ((suggested_candidates->0->>'basis') = 'kept' and (suggested_candidates->1->>'heuristic') = 'true'))`;

/** A row older rules planned that nobody has judged since: unjudgedPage's filter. */
export async function hasUnjudgedKeywordRow({ db }: { db: unknown }): Promise<boolean> {
  const tdb = db as Kysely<unknown>;
  const { rows } = await tdb.executeQuery(sql`select 1 from core_scan_inbox_items where ${unjudgedUnder(await rerouteSince())} limit 1`.compile(tdb));
  return rows.length > 0;
}

export interface RerouteRow {
  id: string;
  status: string;
  source_kind?: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  barcode_text: string | null;
  ai_notes: string | null;
  scan_area: string | null;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: unknown;
  target_module: string | null;
  target_entity_id: string | null;
  /** When the row was made. A row made after the rule was never routed by
   *  the old one, whatever its stamp says (#5430). */
  created_at?: string | Date | null;
}

export type RerouteWhy =
  | "not-pending"
  | "not-matched"
  | "made-after-rule"
  | "already-judged"
  | "twin-unjudged"
  | "put-back"
  | "no-route"
  | "ai-route"
  | "person-answered"
  | "filed"
  | "no-menu"
  | "unchanged"
  | "rerouted";

export interface RerouteVerdict {
  action: "skip" | "unchanged" | "reroute";
  why: RerouteWhy;
  from?: string;
  to?: string;
  next?: MatchCandidate[];
}

const candidateList = (raw: unknown): Array<Record<string, unknown>> => {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    // pass-catch: an unparseable value has no keywords to reroute
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
};

const routeKey = (c: Record<string, unknown> | undefined): string => (c ? `${String(c.module ?? "")}:${String(c.instance ?? "")}` : "");
const routeLabel = (c: Record<string, unknown> | undefined): string => (c ? String(c.label ?? routeKey(c)) : "");

/** The no-AI planner's own routes. A route a later pass lifted to the top
 *  (identity, given values) is not the planner's to re-ask; a kept route is,
 *  when the planner's route is right beneath it, because the kept step is run
 *  again with the plan. */
const PLANNER_BASES = ["noun", "keywords", "fallback"];
const plannerRoute = (c: Record<string, unknown> | undefined) => !!c && c.heuristic === true && PLANNER_BASES.includes(String(c.basis));

/** What the workspace knows beside the plan, read for one row: the tables
 *  its twins say it is kept in (twin-tables.ts), and whether a twin scanned
 *  before it is still to be asked under these rules. */
export interface RowKnown {
  twins: readonly KeptTable[];
  leaderUnjudged: boolean;
}

/**
 * What the pass would do with one row, given the workspace's tables and when
 * these rules arrived (rerouteSince). Pure apart from the plan it runs; the
 * rule that matters is "never a person's answer, never an AI route, never
 * twice under the same rules", and that rule should not need a database to
 * prove.
 */
export function rerouteVerdict(row: RerouteRow, menu: readonly ScanMenuEntry[], since: Date, known: RowKnown = { twins: [], leaderUnjudged: false }): RerouteVerdict {
  if (row.status !== "pending") return { action: "skip", why: "not-pending" };
  const meta = row.suggested_metadata ?? {};
  // A row put back (reroute-undo.ts) said the move was wrong: never asked again, under any rules.
  if ((meta.reroute as { undone?: unknown } | undefined)?.undone) return { action: "skip", why: "put-back" };
  if ((meta.reroute as { rule?: unknown } | undefined)?.rule === REROUTE_RULE.version) return { action: "skip", why: "already-judged" };
  const matchedAt = typeof meta.matched_at === "string" ? Date.parse(meta.matched_at) : NaN;
  if (Number.isNaN(matchedAt)) return { action: "skip", why: "not-matched" };
  // A row made after these rules arrived was planned by them, or not by this
  // code at all: an import can carry an old stamp, and healing it moved a
  // fresh workspace's rows mid-use, a page at a time (#5430).
  const madeAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  if (Number.isNaN(madeAt) || madeAt >= since.getTime()) return { action: "skip", why: "made-after-rule" };
  if (row.target_entity_id || row.target_module) return { action: "skip", why: "filed" };
  if (meta.user_fields || meta.reviewed === true || storedDestinationOf(meta)?.by === "person") return { action: "skip", why: "person-answered" };
  const stored = candidateList(row.suggested_candidates);
  const top = stored[0];
  if (!top) return { action: "skip", why: "no-route" };
  const planned = plannerRoute(top) ? top : top.basis === "kept" && plannerRoute(stored[1]) ? stored[1]! : null;
  if (!planned) return { action: "skip", why: "ai-route" };
  if (!menu.length) return { action: "skip", why: "no-menu" };
  // A follower is judged against its leader as the leader will be, never as
  // it was: judged now, it would be stamped and never asked again.
  if (known.leaderUnjudged) return { action: "skip", why: "twin-unjudged" };
  const why = (typeof planned.ai_fallback === "string" ? planned.ai_fallback : "no-provider") as Parameters<typeof heuristicMatch>[2];
  const reason = typeof planned.ai_fallback_reason === "string" ? (planned.ai_fallback_reason as Parameters<typeof heuristicMatch>[3]) : undefined;
  const next = heuristicMatch(perceiveRow(row), [...menu], why, reason);
  if (!next.length) return { action: "unchanged", why: "unchanged", from: routeLabel(top) };
  // The deterministic passes a live route gets after the plan, in the
  // same order as matchItem: the receipt's facts, what the group photo
  // established, the purchase fields a picture cannot know, the facts the
  // name states, one storage story, and the list a category names.
  const evidence = applyReceiptFacts(meta as Parameters<typeof applyReceiptFacts>[0], next, menu);
  applySplitInheritance(meta as Parameters<typeof applySplitInheritance>[0], next, menu);
  stripUnsupportedPurchaseFields({ source_kind: row.source_kind ?? null, suggested_metadata: meta }, next, evidence);
  applyNameFacts(row.suggested_name, next, menu);
  alignStorageFields(next, menu);
  retargetByCategory(next, menu);
  // Then where the workspace already keeps it, as the live route asks
  // (shared.ts): the record it already is, the collection it was shared
  // from, its twins as they are now.
  const tracked = scanTrackedMatch(row as unknown as ScanTriageRow);
  const offered = meta.offered_collection as { module?: unknown; instance?: unknown } | null | undefined;
  routeWhereKept(next, menu, {
    tracked: tracked?.kind ? { kind: tracked.kind, instance: tracked.instance } : null,
    twins: [...(offered && typeof offered.module === "string" ? [{ module: offered.module, instance: typeof offered.instance === "string" ? offered.instance : null }] : []), ...known.twins],
  });
  const newTop = next[0] as unknown as Record<string, unknown> | undefined;
  if (!newTop || routeKey(newTop) === routeKey(top)) return { action: "unchanged", why: "unchanged", from: routeLabel(top) };
  return { action: "reroute", why: "rerouted", from: routeLabel(top), to: routeLabel(newTop), next };
}

/** The next page of pending rows older rules planned and nobody judged under
 *  these. The SQL narrows to what the verdict could act on; the verdict decides. */
async function unjudgedPage(orgId: string, limit: number, since: Date): Promise<RerouteRow[]> {
  let rows: RerouteRow[] = [];
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql<RerouteRow>`
      select id, status, source_kind, suggested_name, suggested_manufacturer, suggested_sku, barcode_text, ai_notes, scan_area,
             suggested_metadata, suggested_candidates, target_module, target_entity_id, created_at
      from core_scan_inbox_items
      where ${unjudgedUnder(since)}
      order by created_at, id
      limit ${limit}
    `.compile(tdb);
    rows = (await tdb.executeQuery(q)).rows as RerouteRow[];
  });
  return rows;
}

/** One row's twins (the same name, never itself, newest first, a handful,
 *  as the live route reads them) and whether one scanned before it is still
 *  to be asked under these rules. */
async function knownFor(orgId: string, row: RerouteRow, menu: readonly ScanMenuEntry[], since: Date): Promise<RowKnown> {
  const said = (row.suggested_name ?? "").trim();
  if (said.length < 3) return { twins: [], leaderUnjudged: false };
  let rows: Array<TwinRow & { unjudged: boolean }> = [];
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql<TwinRow & { unjudged: boolean }>`
      select *, (${unjudgedUnder(since)}) as unjudged
      from core_scan_inbox_items
      where id <> ${row.id}
        and status in ('pending', 'resolved')
        and lower(suggested_name) = ${said.toLowerCase()}
      order by created_at desc
      limit 12
    `.compile(tdb);
    rows = (await tdb.executeQuery(q)).rows as typeof rows;
  });
  const me = { id: row.id, created_at: row.created_at ?? null };
  return {
    twins: twinTablesOf(rows, destinationTables(menu), me),
    leaderUnjudged: rows.some((r) => r.unjudged === true && scannedBefore(r, me)),
  };
}

/** The workspace's tables as the matchmaker sees them, through a session
 *  minted for the workspace's own member: the menu is an org read, and a
 *  background pass has no request to borrow a bearer from. Null when the
 *  workspace has nobody to act as. */
export async function menuFor(orgId: string): Promise<ScanMenuEntry[] | null> {
  const who = await workspaceIdentity(orgId);
  if (!who) return null;
  const token = await platform().auth.mintSession({ userId: who.userId });
  return assembleMergedMenu(INTERNAL_API, who.slug, token, orgId);
}

export interface RerouteAudit {
  scanned: number;
  count: number;
  capped: boolean;
  items: Array<{ id: string; suggested_name: string | null; from: string; to: string }>;
}

/** Read-only: how many pending rows of this workspace the pass would
 *  re-route, and to where. Writes nothing. */
export async function auditReroute(orgId: string, cap = 1000): Promise<RerouteAudit> {
  const since = await rerouteSince();
  const rows = await unjudgedPage(orgId, cap + 1, since);
  const capped = rows.length > cap;
  const scanned = capped ? rows.slice(0, cap) : rows;
  const menu = scanned.length ? await menuFor(orgId) : [];
  const items: RerouteAudit["items"] = [];
  for (const r of scanned) {
    const v = rerouteVerdict(r, menu ?? [], since, menu?.length ? await knownFor(orgId, r, menu, since) : undefined);
    if (v.action === "reroute") items.push({ id: r.id, suggested_name: r.suggested_name, from: v.from!, to: v.to! });
  }
  return { scanned: scanned.length, count: items.length, capped, items };
}

/** One workspace, one page: every unjudged row is judged and stamped; the
 *  ones whose top route moved have their list replaced, the old kept. */
export async function rerouteWorkspace(orgId: string, limit = REROUTE_PER_TICK): Promise<{ visited: number; rerouted: number; items: Array<{ id: string; from: string; to: string }> }> {
  const since = await rerouteSince();
  const rows = await unjudgedPage(orgId, limit, since);
  if (!rows.length) return { visited: 0, rerouted: 0, items: [] };
  const menu = await menuFor(orgId);
  const items: Array<{ id: string; from: string; to: string }> = [];
  for (const row of rows) {
    // Read after the rows before it in this page were judged, so a leader's new route is what its follower meets.
    const v = rerouteVerdict(row, menu ?? [], since, menu?.length ? await knownFor(orgId, row, menu, since) : undefined);
    // Asked again when the menu can be read, or once the twin it follows has been judged.
    if (v.action === "skip" && (v.why === "no-menu" || v.why === "twin-unjudged")) continue;
    await platform().tenants.withDb(orgId, async (raw) => {
      const tdb = raw as Kysely<unknown>;
      const at = new Date().toISOString();
      const q =
        v.action === "reroute"
          ? sql`
              update core_scan_inbox_items
                 set suggested_candidates = ${JSON.stringify(v.next)}::jsonb,
                     suggested_metadata = coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
                       reroute_prior: candidateList(row.suggested_candidates),
                       reroute: { at, rule: REROUTE_RULE.version, from: v.from, to: v.to },
                     })}::jsonb,
                     updated_at = now()
               where id = ${row.id}
                 and coalesce(suggested_metadata->'reroute'->>'rule', '') <> ${REROUTE_RULE.version}
                 and suggested_candidates = ${JSON.stringify(candidateList(row.suggested_candidates))}::jsonb
            `
          : sql`
              update core_scan_inbox_items
                 set suggested_metadata = coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ reroute: { at, rule: REROUTE_RULE.version, why: v.why } })}::jsonb
               where id = ${row.id}
            `;
      await tdb.executeQuery(q.compile(tdb));
    });
    if (v.action === "reroute") items.push({ id: row.id, from: v.from!, to: v.to! });
  }
  return { visited: rows.length, rerouted: items.length, items };
}


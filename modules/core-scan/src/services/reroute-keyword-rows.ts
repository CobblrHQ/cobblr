// The rows the keyword tier routed before its rule changed heal (#3019).
//
// Three tea rows matched by keywords routed to Inventory beside a fourth
// that routed to Groceries, in a workspace with Groceries installed. The
// three were matched before #3004 changed the order (the catalog's category
// outranks a word the name grazed; a route the category contradicts is
// dropped); the rule fixed every row matched after it and left every row
// matched before it as it was. Same rule as the retrim of stored pictures
// and CLAUDE.md §8.1: what was stored before heals itself.
//
// What it does, per pending row whose route came from the keyword tier and
// that nobody has answered over: re-run the matchmaker's no-AI plan on the
// evidence already on the row (name, code, catalog category, description,
// observations), through the same deterministic passes a live route gets,
// and replace the candidate list only when the top route differs. The old
// list is kept under `reroute_prior`; the row is stamped `reroute` either
// way, so a second look costs nothing. Never a person's answer: a row with
// typed values (user_fields), a filed or picked destination, a confirmed
// row or one a person marked "looks fine" is left alone. Never an AI route.
//
// A read-only count per workspace first (the audit), the heal on request,
// and the same heal a page a minute in the background behind the pictures
// sweeper, so every workspace heals on its own.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { assembleMergedMenu, heuristicMatch, perceiveRow, type MatchCandidate, type ScanMenuEntry } from "./matchmaker.js";
import { applyReceiptFacts } from "./receipt-candidate-facts.js";
import { applySplitInheritance } from "./split-inherit.js";
import { stripUnsupportedPurchaseFields } from "./field-provenance.js";
import { applyNameFacts } from "./name-facts.js";
import { alignStorageFields } from "./align-storage-fields.js";
import { retargetByCategory } from "./retarget-by-category.js";
import { workspaceIdentity } from "./receipt-photo.js";

/** The rule this pass heals rows up to: the catalog's category outranks a
 *  word the name grazed (#3004), merged at `since`. A row matched before it
 *  by the keyword tier is a candidate; one matched after already has it. */
export const REROUTE_RULE = { version: "category-outranks-word", since: "2026-09-14T21:41:22Z" } as const;

/** Rows per workspace per tick. The plan is pure; the query is the cost. */
export const REROUTE_PER_TICK = 50;
const TICK_MS = 20 * 60 * 1000;
const DRAIN_MS = 60 * 1000;
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let drainHandle: ReturnType<typeof setTimeout> | null = null;

export function startRerouteSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 150_000);
  console.log(`[core-scan] keyword re-route sweeper started — every ${TICK_MS / 60_000} min, a page a minute while there is a backlog`);
}

async function safeTick(): Promise<void> {
  try {
    let backlog = false;
    await platform().exclusive.run("core-scan.reroute-keyword-rows", async () => {
      backlog = (await rerouteTick()).backlog;
    });
    if (backlog) {
      if (drainHandle) clearTimeout(drainHandle);
      drainHandle = setTimeout(safeTick, DRAIN_MS);
    }
  } catch (err) {
    console.error("[core-scan] keyword re-route failed:", (err as Error).stack ?? (err as Error).message);
  }
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
}

export type RerouteWhy =
  | "not-pending"
  | "not-matched"
  | "matched-after-rule"
  | "already-judged"
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
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
};

const routeKey = (c: Record<string, unknown> | undefined): string => (c ? `${String(c.module ?? "")}:${String(c.instance ?? "")}` : "");
const routeLabel = (c: Record<string, unknown> | undefined): string => (c ? String(c.label ?? routeKey(c)) : "");

/**
 * What the pass would do with one row, given the workspace's tables. Pure
 * apart from the plan it runs; the rule that matters is "never a person's
 * answer, never an AI route, never twice", and that rule should not need
 * a database to prove.
 */
export function rerouteVerdict(row: RerouteRow, menu: readonly ScanMenuEntry[]): RerouteVerdict {
  if (row.status !== "pending") return { action: "skip", why: "not-pending" };
  const meta = row.suggested_metadata ?? {};
  if (meta.reroute) return { action: "skip", why: "already-judged" };
  const matchedAt = typeof meta.matched_at === "string" ? Date.parse(meta.matched_at) : NaN;
  if (Number.isNaN(matchedAt)) return { action: "skip", why: "not-matched" };
  if (matchedAt >= Date.parse(REROUTE_RULE.since)) return { action: "skip", why: "matched-after-rule" };
  if (row.target_entity_id || row.target_module) return { action: "skip", why: "filed" };
  if (meta.user_fields || meta.reviewed === true) return { action: "skip", why: "person-answered" };
  const stored = candidateList(row.suggested_candidates);
  const top = stored[0];
  if (!top) return { action: "skip", why: "no-route" };
  if (top.heuristic !== true || !["noun", "keywords"].includes(String(top.basis))) return { action: "skip", why: "ai-route" };
  if (!menu.length) return { action: "skip", why: "no-menu" };
  const why = (typeof top.ai_fallback === "string" ? top.ai_fallback : "no-provider") as Parameters<typeof heuristicMatch>[2];
  const reason = typeof top.ai_fallback_reason === "string" ? (top.ai_fallback_reason as Parameters<typeof heuristicMatch>[3]) : undefined;
  const next = heuristicMatch(perceiveRow(row), [...menu], why, reason);
  if (!next.length) return { action: "unchanged", why: "unchanged", from: routeLabel(top) };
  // The deterministic passes a live route gets after the plan, in the
  // same order as matchItem: the receipt's facts, what the group photo
  // established, the purchase fields a picture cannot know, the facts the
  // name states, one storage story, and the list a category names.
  applyReceiptFacts(meta as Parameters<typeof applyReceiptFacts>[0], next, menu);
  applySplitInheritance(meta as Parameters<typeof applySplitInheritance>[0], next, menu);
  stripUnsupportedPurchaseFields({ source_kind: row.source_kind ?? null, suggested_metadata: meta }, next);
  applyNameFacts(row.suggested_name, next, menu);
  alignStorageFields(next, menu);
  retargetByCategory(next, menu);
  const newTop = next[0] as unknown as Record<string, unknown> | undefined;
  if (!newTop || routeKey(newTop) === routeKey(top)) return { action: "unchanged", why: "unchanged", from: routeLabel(top) };
  return { action: "reroute", why: "rerouted", from: routeLabel(top), to: routeLabel(newTop), next };
}

/** The next page of unjudged, pre-rule, keyword-routed pending rows. The
 *  SQL narrows to what the verdict could act on; the verdict decides. */
async function unjudgedPage(orgId: string, limit: number): Promise<RerouteRow[]> {
  let rows: RerouteRow[] = [];
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql<RerouteRow>`
      select id, status, source_kind, suggested_name, suggested_manufacturer, suggested_sku, barcode_text, ai_notes, scan_area,
             suggested_metadata, suggested_candidates, target_module, target_entity_id
      from core_scan_inbox_items
      where status = 'pending'
        and target_entity_id is null
        and (suggested_metadata->'reroute') is null
        and (suggested_metadata->>'matched_at') is not null
        and (suggested_metadata->>'matched_at')::timestamptz < ${REROUTE_RULE.since}::timestamptz
        and (suggested_candidates->0->>'heuristic') = 'true'
      order by created_at desc
      limit ${limit}
    `.compile(tdb);
    rows = (await tdb.executeQuery(q)).rows as RerouteRow[];
  });
  return rows;
}

/** The workspace's tables as the matchmaker sees them, through a session
 *  minted for the workspace's own member: the menu is an org read, and a
 *  background pass has no request to borrow a bearer from. Null when the
 *  workspace has nobody to act as. */
async function menuFor(orgId: string): Promise<ScanMenuEntry[] | null> {
  const who = await workspaceIdentity(orgId);
  if (!who) return null;
  const token = await platform().auth.mintSession({ userId: who.userId });
  return assembleMergedMenu(INTERNAL_API, who.slug, token);
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
  const rows = await unjudgedPage(orgId, cap + 1);
  const capped = rows.length > cap;
  const scanned = capped ? rows.slice(0, cap) : rows;
  const menu = scanned.length ? await menuFor(orgId) : [];
  const items: RerouteAudit["items"] = [];
  for (const r of scanned) {
    const v = rerouteVerdict(r, menu ?? []);
    if (v.action === "reroute") items.push({ id: r.id, suggested_name: r.suggested_name, from: v.from!, to: v.to! });
  }
  return { scanned: scanned.length, count: items.length, capped, items };
}

/** One workspace, one page: every unjudged row is judged and stamped; the
 *  ones whose top route moved have their list replaced, the old kept. */
export async function rerouteWorkspace(orgId: string, limit = REROUTE_PER_TICK): Promise<{ visited: number; rerouted: number; items: Array<{ id: string; from: string; to: string }> }> {
  const rows = await unjudgedPage(orgId, limit);
  if (!rows.length) return { visited: 0, rerouted: 0, items: [] };
  const menu = await menuFor(orgId);
  const items: Array<{ id: string; from: string; to: string }> = [];
  for (const row of rows) {
    const v = rerouteVerdict(row, menu ?? []);
    if (v.action === "skip" && v.why === "no-menu") continue; // try again when the menu can be read
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
                 and (suggested_metadata->'reroute') is null
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

export async function rerouteTick(opts: { orgId?: string } = {}): Promise<{ visited: number; rerouted: number; backlog: boolean }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) => j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "core-scan"))
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);
  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[core-scan] keyword re-route skipped — meta read failed:", (err as Error).message);
    return { visited: 0, rerouted: 0, backlog: false };
  }
  let visited = 0;
  let rerouted = 0;
  let backlog = false;
  for (const { id: orgId } of orgs) {
    try {
      const done = await rerouteWorkspace(orgId);
      visited += done.visited;
      rerouted += done.rerouted;
      if (done.visited >= REROUTE_PER_TICK) backlog = true;
    } catch (err) {
      console.warn(`[core-scan] keyword re-route skipped org ${orgId}:`, (err as Error).message);
    }
  }
  if (visited > 0) console.log(`[core-scan] keyword re-route: ${rerouted} of ${visited} pre-rule keyword route(s) moved${backlog ? "; more waiting, next page in a minute" : ""}`);
  return { visited, rerouted, backlog };
}

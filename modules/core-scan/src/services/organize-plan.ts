// Guided Organize — the batch put-away planner (docs/product/guided-organize.md).
//
// Given a pile of identified-but-unfiled inbox items, produce a PLAN: how the
// pile groups, and where each group should live — an existing bin its siblings
// already occupy, a proposed new bin, or "unassigned" when there's no
// defensible answer (blank beats wrong). Three tiers, cheapest first:
//
//   1. A deterministic pass — a "bin census" of what already lives where
//      (one aggregated sweep, the batch cousin of suggest-location.ts's
//      per-item sibling signal) scores every item against every occupied bin.
//   2. ONE folded LLM call over the whole batch (the same shape as the
//      matchmaker / barcode identify+classify calls): items + census +
//      deterministic hints in, groups with destinations out.
//   3. A pure-heuristic fallback when AI is unavailable or unparseable —
//      capture-first never goes dark. Groups by plurality census candidate;
//      proposes no new bins (naming a new bin well is the LLM's job).
//
// The planner only PROPOSES. Applying a group is the caller's job (api/organize.ts),
// gated on explicit user acceptance, and human-set locations never re-plan.

import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { significantTokens } from "./suggest-location.js";
import { bucketForCategory, type CategoryBucket } from "./category-buckets.js";
import { LengthUnitResolver, entityLongestMm, unitFieldDefsByKind } from "./organize-dims.js";
import {
  PER_KIND_SWEEP_LIMIT,
  buildBinCensus,
  maxAxisMm,
  routeItem,
  scoreTitles,
  type Census,
  type RouteHit,
} from "./putaway-route.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrganizeInputItem {
  id: string;
  name: string;
  manufacturer: string | null;
  category: string | null;
  quantity: number;
  /** The item's longest DECLARED dimension in mm — from fields whose def
   *  declares a length-category unit (entities), or metadata values that
   *  literally carry a length unit (inbox). Null = undeclared: no size logic
   *  ever runs for this item (declared-only, never guessed from names). */
  longest_mm?: number | null;
  /** Human line for the warning ("Overall length 180 mm"). */
  dims_detail?: string | null;
}

export type OrganizeDestination =
  | { kind: "existing"; location_id: string; location_name: string; location_path: string }
  | { kind: "new"; name: string; parent_id: string | null; parent_name: string | null }
  | { kind: "unassigned" };

export interface OrganizeGroup {
  id: string;
  label: string;
  rationale: string;
  item_ids: string[];
  destination: OrganizeDestination;
  /** Why an existing bin is trustworthy: how many similar things already live
   *  there, with a few of their names. Absent for new/unassigned. */
  evidence?: { sibling_count: number; sample_names: string[] };
  /** Size check (declared dims only): set when a member's longest declared
   *  dimension exceeds the destination's max interior axis. A WARNING, not a
   *  silent reroute — the human decides. */
  size_warning?: string;
  /** An AI-picked existing destination with NO computed evidence (nothing
   *  similar lives there). Allowed only for bin-grade locations, and the UI
   *  must render it as the model's suggestion, never as a finding. */
  ai_guess?: boolean;
}

export interface OrganizePlan {
  groups: OrganizeGroup[];
  census_truncated: boolean;
  /** Which tier produced the grouping — surfaced in the UI so a heuristic plan
   *  isn't mistaken for an AI one. */
  source: "ai" | "heuristic";
}

// The bin census + deterministic scorer live in putaway-route.ts (the shared
// put-away routing signal — docs/product/put-away.md §2.1); this planner is
// its batch caller.
type Hint = RouteHit;

// ── Heuristic plan (no AI) ───────────────────────────────────────────────────

function labelFor(items: OrganizeInputItem[]): string {
  // Dominant significant token across the members' names, capitalized.
  const freq = new Map<string, number>();
  for (const it of items) {
    for (const t of new Set(significantTokens(it.name))) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  if (!top || top[1] < 2) return items.length === 1 ? items[0]!.name : "Miscellaneous";
  return top[0]!.charAt(0).toUpperCase() + top[0]!.slice(1);
}

function heuristicPlan(
  items: OrganizeInputItem[],
  hints: Map<string, Hint>,
  census: Census,
): OrganizeGroup[] {
  const groups: OrganizeGroup[] = [];
  // 1. Items whose deterministic candidate agrees on a bin group together.
  const byBin = new Map<string, OrganizeInputItem[]>();
  const rest: OrganizeInputItem[] = [];
  for (const it of items) {
    const h = hints.get(it.id);
    if (h) (byBin.get(h.location_id) ?? byBin.set(h.location_id, []).get(h.location_id)!).push(it);
    else rest.push(it);
  }
  for (const [locId, members] of byBin) {
    const loc = census.all.get(locId);
    if (!loc) continue;
    const counts = members.map((m) => hints.get(m.id)!.sibling_count);
    const sampleNames = hints.get(members[0]!.id)!.sample_names;
    groups.push({
      id: randomUUID(),
      label: labelFor(members),
      rationale: `Similar items already live in ${loc.name}.`,
      item_ids: members.map((m) => m.id),
      destination: { kind: "existing", location_id: locId, location_name: loc.name, location_path: loc.path },
      evidence: { sibling_count: Math.max(...counts), sample_names: sampleNames },
    });
  }
  // 2. CATEGORY STARTER BINS. Most captured goods carry a catalog category; on
  //    a workspace with no matching bin yet (the fresh-install common case) the
  //    heuristic used to strand every one of them at "unassigned" — nowhere to
  //    put anything. Roll the noisy categories into coarse shelves and PROPOSE a
  //    new bin per shelf, named from the item's own data (not the LLM's). This
  //    is the deterministic naming exception the "no new bins" rule allows: the
  //    category IS a durable, human bin name.
  const byBucket = new Map<string, { bucket: CategoryBucket; members: OrganizeInputItem[] }>();
  const uncategorized: OrganizeInputItem[] = [];
  for (const it of rest) {
    const bucket = bucketForCategory(it.category);
    if (bucket) {
      const g = byBucket.get(bucket.key) ?? { bucket, members: [] };
      g.members.push(it);
      byBucket.set(bucket.key, g);
    } else uncategorized.push(it);
  }
  for (const { bucket, members } of byBucket.values()) {
    groups.push({
      id: randomUUID(),
      label: bucket.name,
      rationale:
        members.length > 1
          ? `Grouped by category — start a "${bucket.name}" bin for these.`
          : `Start a "${bucket.name}" bin for this.`,
      item_ids: members.map((m) => m.id),
      destination: { kind: "new", name: bucket.name, parent_id: null, parent_name: null },
    });
  }
  // 3. What's left has no category to shelve on. Cluster by shared dominant
  //    name token (2+ members), destination unassigned — no new bins guessed
  //    from a bare name.
  const byToken = new Map<string, OrganizeInputItem[]>();
  const singles: OrganizeInputItem[] = [];
  for (const it of uncategorized) {
    const toks = significantTokens(it.name).sort((a, b) => b.length - a.length);
    const key = toks[0] ?? null;
    if (key) (byToken.get(key) ?? byToken.set(key, []).get(key)!).push(it);
    else singles.push(it);
  }
  for (const [, members] of byToken) {
    if (members.length >= 2) {
      groups.push({
        id: randomUUID(),
        label: labelFor(members),
        rationale: "These look related; no existing bin holds similar items yet.",
        item_ids: members.map((m) => m.id),
        destination: { kind: "unassigned" },
      });
    } else {
      singles.push(...members);
    }
  }
  // 4. True orphans — no placed siblings, no category, no shared family — each
  //    stands ALONE.
  //    Merging them into one "Unassigned" group falsely implies they belong
  //    together (several unrelated orphans are several separate decisions), and
  //    a group has ONE destination, so a merged orphan group can never be filed
  //    correctly. One item, one group, one destination.
  for (const it of singles) {
    groups.push({
      id: randomUUID(),
      label: it.name,
      rationale: "Nothing similar is placed yet — pick a spot for this one, or organize it by hand.",
      item_ids: [it.id],
      destination: { kind: "unassigned" },
    });
  }
  return groups;
}

// ── The folded LLM call ──────────────────────────────────────────────────────

const PLAN_DEADLINE_MS = Number(process.env.SCAN_ORGANIZE_DEADLINE_MS ?? 30_000);

const SYSTEM_PROMPT = `You are an organization planner for a physical workspace. You receive:
- ITEMS: things just captured, not yet put away (id, name, maker, category, qty).
- BINS: existing storage locations and a sample of what already lives in each
  (kind: "container" = bin-grade; "area" = a room/zone).
- EMPTY: existing locations that currently hold nothing (same kinds).
- HINTS: a deterministic pre-pass ("similar items already live at ...").
- USER_HINT (optional): ground truth typed by the human ("these are camping
  gear, not car parts" / "I have a supply closet — office supplies go
  there"). It OVERRIDES your priors about what the items are, how they group,
  and what to call them. If it names a place that is NOT in BINS/EMPTY, do not
  fabricate a location_id — propose it as {"kind":"new"} using the human's own
  words for the name ("Electrical closet"), parented under a sensible existing
  location or null for top level. On a brand-new workspace with no locations
  at all, the hint is how the first places get made.

Produce a put-away plan as STRICT JSON (no prose, no code fences):
{"groups":[{"label":"...","rationale":"...","item_ids":["..."],"destination":{"kind":"existing","location_id":"..."}|{"kind":"new","name":"...","parent_id":"...or null"}|{"kind":"unassigned"}}]}

Rules, in priority order:
1. BLANK BEATS WRONG. If no destination is defensible, use {"kind":"unassigned"}. Never guess.
2. Group by what items ARE (same family of thing belongs together), not by superficial name overlap. A group is a COHERENT FAMILY — even an "unassigned" group. NEVER merge unrelated items into one group just because they all lack a home: several unrelated orphans are several separate decisions, not one "miscellaneous" pile. Each unrelated orphan is its OWN single-item group (label = the item's name). Only group items that genuinely belong together.
3. Prefer an existing bin with real sibling evidence over anything else. Prefer an existing EMPTY location over creating a new one. Only propose "new" when a coherent group has no plausible home; give it a short, durable name (the noun of the group, not a date or adjective pile) and parent it under a sensible existing location (parent_id from BINS/EMPTY) or null for top level.
4. PHYSICAL FIT: when an item carries longest_mm and a bin carries interior_mm, never place the item in a bin whose largest interior axis is smaller than longest_mm. Items/bins without declared dims have NO size constraint — do not invent one.
5. A coherent group gets ONE destination — never scatter a family across bins.
6. Every item id appears in exactly one group. Use only ids given. location_id/parent_id must come from BINS or EMPTY.
7. rationale: one short sentence a person can verify at a glance.
8. NEVER file items directly into a kind:"area" location (a room/zone) unless HINTS show similar items already live there. "Somewhere in the garage" is not a home. A coherent group that belongs in that area gets {"kind":"new"} PARENTED under it instead.
9. Use THIS workspace's own vocabulary — its location names and the words its items already use — for group labels and new-bin names. Never invent generic retail taxonomy the workspace doesn't use.`;

interface RawGroup {
  label?: unknown;
  rationale?: unknown;
  item_ids?: unknown;
  destination?: { kind?: unknown; location_id?: unknown; name?: unknown; parent_id?: unknown };
}

function parsePlanReply(content: string): RawGroup[] | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { groups?: unknown };
    return Array.isArray(parsed.groups) ? (parsed.groups as RawGroup[]) : null;
  } catch {
    return null;
  }
}

async function aiPlan(
  orgId: string,
  items: OrganizeInputItem[],
  hints: Map<string, Hint>,
  census: Census,
  userHint?: string,
  userId?: string | null,
): Promise<OrganizeGroup[] | null> {
  const user = JSON.stringify({
    ...(userHint ? { USER_HINT: userHint } : {}),
    ITEMS: items.map((i) => ({
      id: i.id,
      name: i.name,
      maker: i.manufacturer ?? undefined,
      category: i.category ?? undefined,
      qty: i.quantity !== 1 ? i.quantity : undefined,
      longest_mm: i.longest_mm ?? undefined,
    })),
    BINS: census.bins.map((b) => ({
      location_id: b.location_id,
      name: b.name,
      path: b.path,
      kind: b.kind,
      holds: b.sample_titles,
      interior_mm: b.interior_mm ?? undefined,
    })),
    EMPTY: census.empty.map((e) => ({
      location_id: e.location_id,
      name: e.name,
      path: e.path,
      kind: e.kind,
      interior_mm: e.interior_mm ?? undefined,
    })),
    HINTS: [...hints.values()].map((h) => ({
      item_id: h.item_id,
      location_id: h.location_id,
      note: `${h.sibling_count} similar item(s) already there`,
    })),
  });

  const call = platform()
    .ai.invoke({
      orgId,
      // Pass the requesting user so a USER-SCOPED personal AI connection (BYO
      // creds routed by that user) resolves — org-scoped routes resolve either
      // way, but without this a user-only route silently falls through to the
      // managed provider (and its entitlement gate), landing on the heuristic.
      userId: userId ?? undefined,
      capability: "chat",
      input: {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      },
      source: { kind: "core-scan:organize", id: "" },
    })
    .then((r) => r.result as { content?: string })
    .catch(() => null);
  const res = await Promise.race([
    call,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PLAN_DEADLINE_MS)),
  ]);
  const raw = res?.content ? parsePlanReply(res.content) : null;
  if (!raw) return null;

  return groundAiGroups(raw, items, hints, census);
}

/** Ground a raw AI reply against reality (pure — unit-tested directly).
 *  Hard validation: only known item ids, each item once, only known
 *  locations; a reply that survives none of it falls back to the heuristic
 *  (null). Then the honesty pass, because the model's say-so is never
 *  evidence:
 *  - evidence for an existing destination = OUR deterministic hints, or a
 *    post-hoc token-overlap of the group's members against what actually
 *    lives in that bin;
 *  - an evidence-less pick of an AREA is converted to a new-bin proposal
 *    parented under it ("somewhere in the garage" is not a home);
 *  - an evidence-less pick of a bin-grade location keeps the destination but
 *    is flagged ai_guess so the UI renders it as a suggestion, not a
 *    finding. */
export function groundAiGroups(
  raw: RawGroup[],
  items: OrganizeInputItem[],
  hints: Map<string, Hint>,
  census: Census,
): OrganizeGroup[] | null {
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const binById = new Map(census.bins.map((b) => [b.location_id, b] as const));
  const claimed = new Set<string>();
  const groups: OrganizeGroup[] = [];
  for (const g of raw) {
    const ids = (Array.isArray(g.item_ids) ? g.item_ids : [])
      .filter((x): x is string => typeof x === "string")
      .filter((x) => itemById.has(x) && !claimed.has(x));
    if (ids.length === 0) continue;
    for (const id of ids) claimed.add(id);

    const label =
      typeof g.label === "string" && g.label.trim()
        ? g.label.trim().slice(0, 80)
        : labelFor(ids.map((id) => itemById.get(id)!));

    let destination: OrganizeDestination = { kind: "unassigned" };
    const d = g.destination;
    if (d && d.kind === "existing" && typeof d.location_id === "string") {
      const loc = census.all.get(d.location_id);
      if (loc) {
        destination = {
          kind: "existing",
          location_id: d.location_id,
          location_name: loc.name,
          location_path: loc.path,
        };
      }
    } else if (d && d.kind === "new" && typeof d.name === "string" && d.name.trim()) {
      const parentId =
        typeof d.parent_id === "string" && census.all.has(d.parent_id) ? d.parent_id : null;
      destination = {
        kind: "new",
        name: d.name.trim().slice(0, 120),
        parent_id: parentId,
        parent_name: parentId ? census.all.get(parentId)!.name : null,
      };
    }

    // Evidence for existing destinations comes from OUR deterministic scorer —
    // per-item hints first, else a post-hoc pass of the whole group against
    // what actually lives in the chosen bin.
    let evidence: OrganizeGroup["evidence"];
    let aiGuess = false;
    if (destination.kind === "existing") {
      const locId = destination.location_id;
      const supporting = ids
        .map((id) => hints.get(id))
        .filter((h): h is Hint => !!h && h.location_id === locId);
      if (supporting.length > 0) {
        evidence = {
          sibling_count: Math.max(...supporting.map((h) => h.sibling_count)),
          sample_names: supporting[0]!.sample_names,
        };
      } else {
        const bin = binById.get(locId);
        const want = new Set(
          ids.flatMap((id) => {
            const it = itemById.get(id)!;
            return [...significantTokens(it.name), ...significantTokens(it.category)];
          }),
        );
        const scored = bin && want.size > 0 ? scoreTitles(bin.sample_titles, want) : null;
        if (scored) {
          evidence = { sibling_count: scored.count, sample_names: scored.samples };
        } else {
          // No evidence at all. Areas hard-convert (rule 8 belt-and-braces);
          // bin-grade picks survive as an honestly-labeled guess.
          const loc = census.all.get(locId)!;
          if (loc.kind === "area") {
            destination = {
              kind: "new",
              name: label,
              parent_id: locId,
              parent_name: loc.name,
            };
          } else {
            aiGuess = true;
          }
        }
      }
    }

    groups.push({
      id: randomUUID(),
      label,
      rationale:
        typeof g.rationale === "string" && g.rationale.trim()
          ? g.rationale.trim().slice(0, 300)
          : "",
      item_ids: ids,
      destination,
      ...(evidence ? { evidence } : {}),
      ...(aiGuess ? { ai_guess: true } : {}),
    });
  }
  return groups.length > 0 ? groups : null;
}

// ── Phase 3: gather UNPLACED committed entities ──────────────────────────────
// The same planner pointed at the workspace instead of the inbox: every
// scannable entity with no location_id is a candidate. Item ids are composite
// "<kind>::<uuid>" refs (an entity kind itself contains a ':'), and the caller
// stores display names/barcodes in the plan payload — the walk can't resolve
// entities through the inbox. NOTE: an entity placed inside a CONTAINER
// normally carries a synced location_id (core-placement keeps them coherent),
// so location_id-null is a faithful "unplaced" test; a container-placed row
// with no location sync would show up here, which errs toward visibility.

export interface UnplacedGather {
  items: OrganizeInputItem[];
  names: Record<string, string>;
  barcodes: Record<string, string>;
  truncated: boolean;
}

const UNPLACED_MAX = 200;

export function splitEntityRef(ref: string): { kind: string; id: string } | null {
  const at = ref.lastIndexOf("::");
  if (at <= 0) return null;
  return { kind: ref.slice(0, at), id: ref.slice(at + 2) };
}

export async function gatherUnplacedEntities(orgId: string): Promise<UnplacedGather> {
  const kinds = platform().entities.listScannable();
  const sweeps = await Promise.all(
    kinds.map((k) =>
      platform()
        .entities.list(orgId, k.kind, { limit: PER_KIND_SWEEP_LIMIT })
        .then((r) => r.items)
        .catch(() => []),
    ),
  );
  const items: OrganizeInputItem[] = [];
  const names: Record<string, string> = {};
  const barcodes: Record<string, string> = {};
  let truncated = false;
  // Declared physical dims: field defs with a length-category unit, per kind
  // (Guided Organize 3b). One meta read + one unit resolution per distinct
  // unit string for the whole gather.
  const dimDefs = await unitFieldDefsByKind(orgId, kinds.map((k) => k.kind));
  const lengths = new LengthUnitResolver(orgId);
  for (let i = 0; i < sweeps.length; i++) {
    const list = sweeps[i]!;
    const kindDefs = dimDefs.get(kinds[i]!.kind) ?? [];
    if (list.length >= PER_KIND_SWEEP_LIMIT) truncated = true;
    for (const e of list) {
      if (typeof e.fields.location_id === "string" && e.fields.location_id) continue;
      if (!e.title?.trim()) continue;
      const ref = `${e.kind}::${e.id}`;
      const dims = kindDefs.length ? await entityLongestMm(e.fields, kindDefs, lengths) : null;
      items.push({
        id: ref,
        name: e.title,
        manufacturer: null,
        // Pass the entity's own category through so the planner can match it to
        // the sorting style already in place (the exact-category facet in
        // putaway-route.ts). Was hardcoded null — which blinded every entity
        // plan to the one signal that makes granular bin routing reliable.
        // Generic: any kind whose bundle populates `category` benefits.
        category: typeof e.fields.category === "string" && e.fields.category.trim()
          ? e.fields.category.trim()
          : null,
        quantity: 1,
        ...(dims ? { longest_mm: dims.longest_mm, dims_detail: dims.detail } : {}),
      });
      names[ref] = e.title;
      const bc = typeof e.fields.barcode === "string" ? e.fields.barcode : null;
      if (bc) barcodes[ref] = bc;
    }
  }
  if (items.length > UNPLACED_MAX) truncated = true;
  const kept = items.slice(0, UNPLACED_MAX);
  return { items: kept, names, barcodes, truncated };
}

// ── Gather SPECIFIC entity refs (the scope:"refs" door) ──────────────────────
// The batch-scoped plan: an action that just produced a pile of entities (a
// disassemble spawning parts, an order receipt stocking items) opens the organize
// flow over EXACTLY those refs, instead of "everything unplaced workspace-wide".
// Refs are the same composite "<kind>::<uuid>" the walk uses. Refs that already
// have a location are dropped (a human decision stands); unknown/foreign refs are
// skipped. Higher cap than the inbox path: a large kit disassembles into many
// distinct part+colour lines, and the deterministic tier (below) places them
// without an LLM ceiling.
const REFS_MAX = 2000;

export async function gatherEntitiesByRefs(
  orgId: string,
  refs: string[],
): Promise<UnplacedGather> {
  const dedup = [...new Set(refs)].slice(0, REFS_MAX);
  const truncated = refs.length > REFS_MAX;
  // Distinct kinds present, so we resolve the length-unit field defs once each.
  const kinds = [...new Set(dedup.map((r) => splitEntityRef(r)?.kind).filter((k): k is string => !!k))];
  const dimDefs = await unitFieldDefsByKind(orgId, kinds);
  const lengths = new LengthUnitResolver(orgId);
  const items: OrganizeInputItem[] = [];
  const names: Record<string, string> = {};
  const barcodes: Record<string, string> = {};
  for (const ref of dedup) {
    const split = splitEntityRef(ref);
    if (!split) continue;
    const e = await platform()
      .entities.lookup(orgId, split.kind, split.id)
      .catch(() => null);
    if (!e || !e.title?.trim()) continue;
    if (typeof e.fields.location_id === "string" && e.fields.location_id) continue;
    const kindDefs = dimDefs.get(split.kind) ?? [];
    const dims = kindDefs.length ? await entityLongestMm(e.fields, kindDefs, lengths) : null;
    items.push({
      id: ref,
      name: e.title,
      manufacturer: null,
      category:
        typeof e.fields.category === "string" && e.fields.category.trim()
          ? e.fields.category.trim()
          : null,
      quantity: 1,
      ...(dims ? { longest_mm: dims.longest_mm, dims_detail: dims.detail } : {}),
    });
    names[ref] = e.title;
    const bc = typeof e.fields.barcode === "string" ? e.fields.barcode : null;
    if (bc) barcodes[ref] = bc;
  }
  return { items, names, barcodes, truncated };
}

// ── Entry point ──────────────────────────────────────────────────────────────

// The LLM sees at most this many items in one call. A small pile goes whole (the
// model's holistic grouping is worth it). A big batch (a kit disassembled into
// hundreds of part+colour lines) routes deterministically first — no AI ceiling —
// and only the residue the router couldn't place goes to the LLM, bounded.
const AI_ITEM_CAP = Number(process.env.SCAN_ORGANIZE_AI_ITEM_CAP ?? 150);

export async function planOrganize(
  orgId: string,
  items: OrganizeInputItem[],
  userHint?: string,
  userId?: string | null,
): Promise<OrganizePlan> {
  const census = await buildBinCensus(orgId);
  const hints = new Map<string, Hint>();
  for (const it of items) {
    const h = routeItem(it, census);
    if (h) hints.set(it.id, h);
  }

  // Small pile: unchanged — the whole batch to the LLM for best holistic grouping.
  if (items.length <= AI_ITEM_CAP) {
    const ai = await aiPlan(orgId, items, hints, census, userHint, userId);
    const groups = ai ?? heuristicPlan(items, hints, census);
    annotateSizeWarnings(groups, items, census);
    return { groups, census_truncated: census.truncated, source: ai ? "ai" : "heuristic" };
  }

  // Large batch. Everything the deterministic router placed groups by its bin
  // (heuristic step 1) with no LLM cost. Only the residue it couldn't route goes
  // to the LLM, capped; overflow past the cap is heuristic-grouped so nothing is
  // ever dropped. This is what lets a full-set disassemble be organized at once.
  const placed = items.filter((it) => hints.has(it.id));
  const residue = items.filter((it) => !hints.has(it.id));
  const detGroups = placed.length > 0 ? heuristicPlan(placed, hints, census) : [];
  let residueGroups: OrganizeGroup[] = [];
  let usedAi = false;
  if (residue.length > 0) {
    const forAi = residue.slice(0, AI_ITEM_CAP);
    const ai = await aiPlan(orgId, forAi, hints, census, userHint, userId);
    usedAi = !!ai;
    residueGroups = ai ?? heuristicPlan(forAi, hints, census);
    if (residue.length > AI_ITEM_CAP) {
      residueGroups = [...residueGroups, ...heuristicPlan(residue.slice(AI_ITEM_CAP), hints, census)];
    }
  }
  const groups = [...detGroups, ...residueGroups];
  annotateSizeWarnings(groups, items, census);
  return { groups, census_truncated: census.truncated, source: usedAi ? "ai" : "heuristic" };
}

/** Size check on the FINAL groups (both tiers — the deterministic scorer
 *  already vetoes, but an AI pick or a later human override can still land on
 *  a too-small bin). Declared dims only; a WARNING the review UI surfaces,
 *  never a silent reroute — the human decides. */
function annotateSizeWarnings(
  groups: OrganizeGroup[],
  items: OrganizeInputItem[],
  census: Census,
): void {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  for (const g of groups) {
    if (g.destination.kind !== "existing") continue;
    const loc = census.all.get(g.destination.location_id);
    const binMax = maxAxisMm(loc?.interior_mm);
    if (binMax == null) continue;
    const offender = g.item_ids
      .map((id) => byId.get(id))
      .find((i) => i?.longest_mm != null && i.longest_mm > binMax);
    if (offender) {
      g.size_warning = `${offender.name} (${Math.round(offender.longest_mm!)} mm${
        offender.dims_detail ? ` ${offender.dims_detail}` : ""
      }) may not fit — ${loc!.name}'s interior maxes out at ${Math.round(binMax)} mm.`;
    }
  }
}

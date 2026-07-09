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

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrganizeInputItem {
  id: string;
  name: string;
  manufacturer: string | null;
  category: string | null;
  quantity: number;
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
}

export interface OrganizePlan {
  groups: OrganizeGroup[];
  census_truncated: boolean;
  /** Which tier produced the grouping — surfaced in the UI so a heuristic plan
   *  isn't mistaken for an AI one. */
  source: "ai" | "heuristic";
}

// ── Bin census ───────────────────────────────────────────────────────────────

interface CensusBin {
  location_id: string;
  name: string;
  path: string;
  item_count: number;
  /** Distinct titles of what lives there (capped) — the prompt's evidence and
   *  the deterministic scorer's corpus. */
  sample_titles: string[];
}

interface Census {
  /** Occupied bins, most-populated first, capped. */
  bins: CensusBin[];
  /** Empty locations (names only) — the LLM may target one instead of minting
   *  a new bin. */
  empty: Array<{ location_id: string; name: string; path: string }>;
  /** Every known location id → {name, path} (validation + display, uncapped). */
  all: Map<string, { name: string; path: string }>;
  truncated: boolean;
}

const CENSUS_MAX_BINS = 60;
const CENSUS_MAX_EMPTY = 40;
const CENSUS_TITLES_PER_BIN = 30;
const PER_KIND_SWEEP_LIMIT = 300;

export async function buildBinCensus(orgId: string): Promise<Census> {
  // All locations first: names + parent chains for paths.
  const locs = await platform()
    .entities.list(orgId, "core-locations:location", { limit: 1000 })
    .then((r) => r.items)
    .catch(() => []);
  const byId = new Map(locs.map((l) => [l.id, l] as const));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur: string | null = id;
    let hops = 0;
    while (cur && hops++ < 10) {
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(node.title);
      cur = typeof node.fields.parent_id === "string" ? node.fields.parent_id : null;
    }
    return parts.join(" / ");
  };
  const all = new Map<string, { name: string; path: string }>();
  for (const l of locs) all.set(l.id, { name: l.title, path: pathOf(l.id) });

  // One sweep per scannable kind, grouped by location_id. Best-effort per kind.
  const occupied = new Map<string, string[]>(); // location_id → titles
  const kinds = platform().entities.listScannable();
  const sweeps = await Promise.all(
    kinds.map((k) =>
      platform()
        .entities.list(orgId, k.kind, { limit: PER_KIND_SWEEP_LIMIT })
        .then((r) => r.items)
        .catch(() => []),
    ),
  );
  for (const items of sweeps) {
    for (const e of items) {
      const loc = typeof e.fields.location_id === "string" ? e.fields.location_id : null;
      if (!loc || !all.has(loc)) continue;
      const titles = occupied.get(loc) ?? [];
      if (titles.length < CENSUS_TITLES_PER_BIN) titles.push(e.title);
      occupied.set(loc, titles);
    }
  }

  const binsAll = [...occupied.entries()]
    .map(([location_id, sample_titles]) => ({
      location_id,
      name: all.get(location_id)!.name,
      path: all.get(location_id)!.path,
      item_count: sample_titles.length,
      sample_titles: [...new Set(sample_titles)],
    }))
    .sort((a, b) => b.item_count - a.item_count);
  const bins = binsAll.slice(0, CENSUS_MAX_BINS);

  const empty = locs
    .filter((l) => !occupied.has(l.id))
    .slice(0, CENSUS_MAX_EMPTY)
    .map((l) => ({ location_id: l.id, name: l.title, path: pathOf(l.id) }));

  return {
    bins,
    empty,
    all,
    truncated: binsAll.length > CENSUS_MAX_BINS || locs.length > 1000,
  };
}

// ── Deterministic candidate scoring (against the census, no extra DB reads) ──

interface Hint {
  item_id: string;
  location_id: string;
  /** Distinct sibling titles at that bin sharing a significant token. */
  sibling_count: number;
  sample_names: string[];
}

function scoreItemAgainstCensus(item: OrganizeInputItem, census: Census): Hint | null {
  const want = new Set([
    ...significantTokens(item.name),
    ...significantTokens(item.category),
  ]);
  if (want.size === 0) return null;
  let best: Hint | null = null;
  let bestStrength = 0;
  for (const bin of census.bins) {
    let count = 0;
    let strongest = 0;
    const samples: string[] = [];
    for (const title of bin.sample_titles) {
      const overlap = significantTokens(title).filter((t) => want.has(t)).length;
      if (overlap < 1) continue;
      count++;
      strongest = Math.max(strongest, overlap);
      if (samples.length < 3) samples.push(title);
    }
    // Same plurality gate as suggest-location: 2+ siblings agree, or a single
    // very strong near-twin (3+ shared significant tokens).
    if (count < 2 && strongest < 3) continue;
    const strength = count * 10 + strongest;
    if (strength > bestStrength) {
      bestStrength = strength;
      best = { item_id: item.id, location_id: bin.location_id, sibling_count: count, sample_names: samples };
    }
  }
  return best;
}

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
  // 2. Leftovers cluster by shared dominant token (2+ members), destination
  //    unassigned — the heuristic proposes no new bins on purpose.
  const byToken = new Map<string, OrganizeInputItem[]>();
  const singles: OrganizeInputItem[] = [];
  for (const it of rest) {
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
  if (singles.length > 0) {
    groups.push({
      id: randomUUID(),
      label: "Unassigned",
      rationale: "No similar items are placed anywhere yet — pick a spot, or organize these by hand.",
      item_ids: singles.map((s) => s.id),
      destination: { kind: "unassigned" },
    });
  }
  return groups;
}

// ── The folded LLM call ──────────────────────────────────────────────────────

const PLAN_DEADLINE_MS = Number(process.env.SCAN_ORGANIZE_DEADLINE_MS ?? 30_000);

const SYSTEM_PROMPT = `You are an organization planner for a physical workspace. You receive:
- ITEMS: things just captured, not yet put away (id, name, maker, category, qty).
- BINS: existing storage locations and a sample of what already lives in each.
- EMPTY: existing locations that currently hold nothing.
- HINTS: a deterministic pre-pass ("similar items already live at ...").

Produce a put-away plan as STRICT JSON (no prose, no code fences):
{"groups":[{"label":"...","rationale":"...","item_ids":["..."],"destination":{"kind":"existing","location_id":"..."}|{"kind":"new","name":"...","parent_id":"...or null"}|{"kind":"unassigned"}}]}

Rules, in priority order:
1. BLANK BEATS WRONG. If no destination is defensible, use {"kind":"unassigned"}. Never guess.
2. Group by what items ARE (same family of thing belongs together), not by superficial name overlap.
3. Prefer an existing bin with real sibling evidence over anything else. Prefer an existing EMPTY location over creating a new one. Only propose "new" when a coherent group has no plausible home; give it a short, durable name (the noun of the group, not a date or adjective pile) and parent it under a sensible existing location (parent_id from BINS/EMPTY) or null for top level.
4. A coherent group gets ONE destination — never scatter a family across bins.
5. Every item id appears in exactly one group. Use only ids given. location_id/parent_id must come from BINS or EMPTY.
6. rationale: one short sentence a person can verify at a glance.`;

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
): Promise<OrganizeGroup[] | null> {
  const user = JSON.stringify({
    ITEMS: items.map((i) => ({
      id: i.id,
      name: i.name,
      maker: i.manufacturer ?? undefined,
      category: i.category ?? undefined,
      qty: i.quantity !== 1 ? i.quantity : undefined,
    })),
    BINS: census.bins.map((b) => ({
      location_id: b.location_id,
      name: b.name,
      path: b.path,
      holds: b.sample_titles,
    })),
    EMPTY: census.empty,
    HINTS: [...hints.values()].map((h) => ({
      item_id: h.item_id,
      location_id: h.location_id,
      note: `${h.sibling_count} similar item(s) already there`,
    })),
  });

  const call = platform()
    .ai.invoke({
      orgId,
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

  // Validate hard: only known item ids, each item once, only known locations.
  // A reply that survives none of it falls back to the heuristic.
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const claimed = new Set<string>();
  const groups: OrganizeGroup[] = [];
  for (const g of raw) {
    const ids = (Array.isArray(g.item_ids) ? g.item_ids : [])
      .filter((x): x is string => typeof x === "string")
      .filter((x) => itemById.has(x) && !claimed.has(x));
    if (ids.length === 0) continue;
    for (const id of ids) claimed.add(id);

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

    // Evidence for existing destinations comes from OUR deterministic scorer,
    // not the model's say-so.
    let evidence: OrganizeGroup["evidence"];
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
      }
    }

    groups.push({
      id: randomUUID(),
      label: typeof g.label === "string" && g.label.trim() ? g.label.trim().slice(0, 80) : labelFor(ids.map((id) => itemById.get(id)!)),
      rationale:
        typeof g.rationale === "string" && g.rationale.trim()
          ? g.rationale.trim().slice(0, 300)
          : "",
      item_ids: ids,
      destination,
      ...(evidence ? { evidence } : {}),
    });
  }
  if (groups.length === 0) return null;

  // Items the model forgot land in an explicit unassigned group rather than
  // silently vanishing from the plan.
  const missing = items.filter((i) => !claimed.has(i.id));
  if (missing.length > 0) {
    groups.push({
      id: randomUUID(),
      label: "Unassigned",
      rationale: "The planner had no defensible destination for these.",
      item_ids: missing.map((m) => m.id),
      destination: { kind: "unassigned" },
    });
  }
  return groups;
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
  sweeps.forEach((list) => {
    if (list.length >= PER_KIND_SWEEP_LIMIT) truncated = true;
    for (const e of list) {
      if (typeof e.fields.location_id === "string" && e.fields.location_id) continue;
      if (!e.title?.trim()) continue;
      const ref = `${e.kind}::${e.id}`;
      items.push({ id: ref, name: e.title, manufacturer: null, category: null, quantity: 1 });
      names[ref] = e.title;
      const bc = typeof e.fields.barcode === "string" ? e.fields.barcode : null;
      if (bc) barcodes[ref] = bc;
    }
  });
  if (items.length > UNPLACED_MAX) truncated = true;
  const kept = items.slice(0, UNPLACED_MAX);
  return { items: kept, names, barcodes, truncated };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function planOrganize(
  orgId: string,
  items: OrganizeInputItem[],
): Promise<OrganizePlan> {
  const census = await buildBinCensus(orgId);
  const hints = new Map<string, Hint>();
  for (const it of items) {
    const h = scoreItemAgainstCensus(it, census);
    if (h) hints.set(it.id, h);
  }
  const ai = await aiPlan(orgId, items, hints, census);
  return {
    groups: ai ?? heuristicPlan(items, hints, census),
    census_truncated: census.truncated,
    source: ai ? "ai" : "heuristic",
  };
}

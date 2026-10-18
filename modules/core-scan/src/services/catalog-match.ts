// Confirming a scan offers the catalog entry it matches (#6888): scan a Lego
// brick in a workspace with the Rebrickable catalogs and its confirm offers
// the part it is, so the record is filed bound to that entry (the same
// `matches` pairing the record's Match to catalog writes).
//
// Heuristic first, AI last, and no candidate is better than a wrong one:
//   1. a part number the scan carries (its barcode, its SKU, a part or model
//      number it read), looked up EXACTLY in each catalog that applies;
//   2. the name, offered only when the entry's whole title is in it, as one
//      run of words (a trigram score only ranks, since "Brick 2 x 2" and
//      "Brick 1 x 2" share most of their letters);
//   3. only when the name found plausible but unsure entries, the
//      match-to-catalog model picks among them, and only above a confidence
//      floor.
// A catalog applies when it binds to the destination's kind (its
// `bindable_to_kinds`, read through the platform: this module never names
// core-catalogs' tables). With none, nothing is asked past one list.

import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { NUMBER_OR_NULL, listOf, objectWith } from "@cobblr/platform-contract/ai-output-schemas";

const ENTRY = "core-catalogs:entry";
const CATALOG = "core-catalogs:catalog";
/** A trigram score at which an entry is close enough for the model to weigh;
 *  below it the name names nothing. A score never offers an entry on its own. */
export const NAME_PLAUSIBLE = 0.3;
/** The model's own confidence it must state for its pick to be offered. */
export const AI_SURE = 0.7;
const MAX = 3;

export type CatalogBasis = "part-number" | "name" | "ai";

export interface CatalogCandidate {
  /** The entry's id, what confirm's `catalog_entry_id` takes. */
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  catalog: string;
  external_id: string;
  /** Why it is offered: the part number, the name, or the model's pick. */
  basis: CatalogBasis;
}

export interface ScanRowForCatalog {
  barcode_text?: string | null;
  suggested_sku?: string | null;
  suggested_name?: string | null;
  suggested_metadata?: unknown;
}

/** The numbers a scan carries that a catalog could hold as an id: its
 *  barcode, its SKU, and a part, model or MPN number it read. Pure. */
export function partNumbersOf(row: ScanRowForCatalog): string[] {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const said = [row.barcode_text, row.suggested_sku, meta.part_number, meta.part_num, meta.mpn, meta.model_number, meta.model];
  const out: string[] = [];
  for (const v of said) {
    const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    if (s.length >= 2 && s.length <= 64 && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

/** Whether a catalog's entries describe this kind of record: a catalog that
 *  says nothing binds to anything (as the create form reads it); an empty
 *  list binds to nothing (a colour or theme table). Pure. */
export function catalogApplies(bindable: unknown, baseKind: string): boolean {
  if (bindable == null) return true;
  return Array.isArray(bindable) && bindable.includes(baseKind);
}

/** A name's words: numbers whole (a brick's 2 and 4 are what tell it from
 *  another brick), single letters dropped ("2 x 4"'s x). */
const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 || /^\d$/.test(w));

/** The entry's title is in the scan's name as one run of words, in order,
 *  and there are at least two: "Brick 2 x 4" is offered for "LEGO Brick 2 x 4
 *  red"; "Brick 2 x 2" is not offered for "Brick 1 x 2" (its words, but not
 *  its run); "Brick" alone never is. Pure. */
export function titleWithinName(title: string, name: string): boolean {
  const t = words(title);
  const n = words(name);
  if (t.length < 2) return false;
  for (let i = 0; i + t.length <= n.length; i++) if (t.every((w, k) => n[i + k] === w)) return true;
  return false;
}

/** How sure a name match is: sure only when the title is in the name; a
 *  close trigram score is the model's to weigh, never an offer. Pure. */
export function nameTier(score: number, title: string, name: string): "sure" | "plausible" | "none" {
  if (titleWithinName(title, name)) return "sure";
  return score >= NAME_PLAUSIBLE ? "plausible" : "none";
}

function candidateOf(e: ResolvedEntity, catalogName: string, basis: CatalogBasis): CatalogCandidate {
  const f = (e.fields ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    title: e.title,
    subtitle: e.subtitle ?? null,
    image: e.image_path ?? null,
    catalog: catalogName,
    external_id: String(f.external_id ?? ""),
    basis,
  };
}

/** The catalog entries this scan could be, best first, at most three; empty
 *  when no catalog applies or nothing matches well enough. `allowAi` false
 *  (an assistant reading the item) never asks the model. */
export async function catalogCandidatesFor(args: {
  orgId: string;
  userId?: string | null;
  row: ScanRowForCatalog;
  destinationKind: string | null;
  allowAi?: boolean;
}): Promise<{ candidates: CatalogCandidate[]; askedAi: boolean }> {
  const none = { candidates: [], askedAi: false };
  if (!args.destinationKind) return none;
  const catalogs = await platform().entities.list(args.orgId, CATALOG, { limit: 200 });
  if (!catalogs.items.length) return none;
  const base = await platform().entities.baseKindOf(args.orgId, args.destinationKind);
  const applies = catalogs.items.filter((c) => catalogApplies((c.fields as Record<string, unknown> | undefined)?.bindable_to_kinds, base));
  if (!applies.length) return none;

  // 1. A part number, exactly.
  const exact: CatalogCandidate[] = [];
  for (const id of partNumbersOf(args.row)) {
    for (const c of applies) {
      const hit = await platform().entities.list(args.orgId, ENTRY, { filter: { catalog_id: c.id, external_id: id }, limit: 2 });
      for (const e of hit.items) if (!exact.some((x) => x.id === e.id)) exact.push(candidateOf(e, c.title, "part-number"));
    }
  }
  if (exact.length) return { candidates: exact.slice(0, MAX), askedAi: false };

  // 2. The name, only when it matches strongly.
  const name = (args.row.suggested_name ?? "").trim();
  if (!name) return none;
  const sure: Array<CatalogCandidate & { score: number }> = [];
  const plausible: Array<{ entity: ResolvedEntity; catalog: string; score: number }> = [];
  for (const c of applies) {
    const scored = await platform().catalogs.similaritySearch({ orgId: args.orgId, catalogId: c.id, queryText: name, limit: 5 });
    // A hosted catalog keeps no rows here, so trigrams find nothing: its own
    // search answers, judged by the title-within-name rule alone.
    const hits = scored.length
      ? await Promise.all(scored.map(async (s) => ({ entity: await platform().entities.lookup(args.orgId, ENTRY, s.id), score: s.score })))
      : (await platform().entities.list(args.orgId, ENTRY, { filter: { catalog_id: c.id }, q: name, limit: 5 })).items.map((entity) => ({ entity, score: 0 }));
    for (const { entity, score } of hits) {
      if (!entity) continue;
      const tier = nameTier(score, entity.title, name);
      if (tier === "sure") sure.push({ ...candidateOf(entity, c.title, "name"), score });
      else if (tier === "plausible") plausible.push({ entity, catalog: c.title, score });
    }
  }
  if (sure.length) return { candidates: sure.sort((a, b) => b.score - a.score).slice(0, MAX).map(({ score: _s, ...c }) => c), askedAi: false };

  // 3. The model, among plausible entries only, never on its own.
  if (!args.allowAi || !plausible.length) return none;
  const pool = plausible.sort((a, b) => b.score - a.score).slice(0, 8);
  let text: string;
  try {
    const out = await platform().ai.invoke({
      orgId: args.orgId,
      userId: args.userId ?? undefined,
      capability: "match-to-catalog",
      input: {
        output_schema: objectWith(["matches"], { matches: listOf(["candidate_id"], { candidate_id: { type: "string" }, confidence: NUMBER_OR_NULL }) }),
        user_entity: { name, ...(args.row.barcode_text ? { barcode: args.row.barcode_text } : {}) },
        candidates: pool.map((p) => ({ candidate_id: p.entity.id, external_id: String((p.entity.fields as Record<string, unknown> | undefined)?.external_id ?? ""), payload: { name: p.entity.title } })),
      },
      source: { kind: "core-scan:catalog-match", id: pool[0]!.entity.id },
      noAi: { heuristic: "only a part number or a name holding the entry's whole title is offered; the person can still pick one with Match to catalog" },
    });
    text = out.text;
  } catch (err) {
    // No model, or it failed: the confirm offers nothing rather than waiting
    // or guessing. Said in the log so a quiet confirm can be explained.
    console.warn(`[core-scan] catalog match: the model was not asked or failed: ${(err as Error).message}`);
    return { candidates: [], askedAi: true };
  }
  const picks = parseAiPicks(text);
  const chosen = picks
    .filter((p) => p.confidence >= AI_SURE)
    .map((p) => pool.find((x) => x.entity.id === p.candidate_id))
    .filter((x): x is (typeof pool)[number] => !!x)
    .map((x) => candidateOf(x.entity, x.catalog, "ai"));
  return { candidates: chosen.slice(0, MAX), askedAi: true };
}

/** The model's picks, tolerant of a wrapped or fenced reply. Pure. */
export function parseAiPicks(text: string): Array<{ candidate_id: string; confidence: number }> {
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    return [];
  }
  const matches = (parsed as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  return matches
    .map((x) => x as { candidate_id?: unknown; confidence?: unknown })
    .filter((x) => typeof x.candidate_id === "string")
    .map((x) => ({ candidate_id: x.candidate_id as string, confidence: typeof x.confidence === "number" ? x.confidence : 0 }));
}

/** Bind a record a scan just made to the catalog entry the person picked:
 *  the `matches` pairing, under the record's own module kind (an instance's
 *  thing pairs as the module's kind, as Match to catalog writes it). */
export async function bindToCatalogEntry(args: { orgId: string; userId?: string | null; kind: string; id: string; entryId: string }): Promise<void> {
  const sourceKind = await platform().entities.baseKindOf(args.orgId, args.kind);
  await platform().pairings.create({
    orgId: args.orgId,
    sourceKind,
    sourceId: args.id,
    targetKind: ENTRY,
    targetId: args.entryId,
    relationshipKind: "matches",
    createdBy: args.userId ?? null,
  });
}

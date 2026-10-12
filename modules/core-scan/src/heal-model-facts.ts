// DONE WHEN: a round fills no waiting row (the count /healthz reports is 0); it
// stays registered, because a model fact can be learned at any time.
// PERMANENT RECONCILE: what a waiting row knows about its model reaches every
// other waiting row of that model (#6013).
//
// BORN WITH: applyModelFacts in the match (services/model-facts.ts), which
// fills, learns and spreads on every match, replay and re-run.
//
// Rows that waited in the inbox before the match learned model facts keep
// whatever their own model call happened to say: the owner's two Bambu Lab
// P1Ps, one with a 250 x 250 bed and one without. A model fact can also be
// learned while a row waits and is not matched again (a person typing a bed
// size on one of them). So every round this reads the waiting rows, keeps
// what each teaches about its model, and fills it into the others of that
// model. Settled, it learns nothing new and writes nothing: one read of the
// waiting rows and one of their tables' fields.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { factScopeOf, modelKeyOf, type ScopedFieldDef } from "@cobblr/platform-contract/fact-scope";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { factsTaughtBy, personValuesOf, readModelFacts, recordModelFacts, scopedFieldsOf, spreadModelFacts, type ModelFactCandidate } from "./services/model-facts.js";

interface HealDB {
  core_scan_model_facts: { kind: string; model_key: string; field: string; value: unknown; source: string; from_item_id: string | null; updated_at: Date };
  core_scan_inbox_items: { id: string; status: string; suggested_name: string | null; suggested_candidates: unknown; suggested_metadata: unknown };
}

/** Heal one workspace. Returns how many rows it filled. */
export async function healModelFactsIn(orgId: string, db: Kysely<HealDB>): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_candidates", "suggested_metadata"])
    .where("status", "=", "pending")
    .where("suggested_name", "is not", null)
    .limit(2000)
    .execute();
  const defsByKind = new Map<string, ScopedFieldDef[]>();
  const learnedFor = new Map<string, { kind: string; key: string }>();
  for (const r of rows) {
    const key = modelKeyOf(r.suggested_name);
    const top = Array.isArray(r.suggested_candidates) ? (r.suggested_candidates[0] as ModelFactCandidate | undefined) : undefined;
    const kind = typeof top?.kind === "string" ? top.kind : null;
    if (!key || !kind) continue;
    if (!defsByKind.has(kind)) defsByKind.set(kind, await scopedFieldsOf(orgId, kind));
    const defs = defsByKind.get(kind)!;
    if (!defs.some((d) => factScopeOf(d) === "model")) continue;
    const meta = r.suggested_metadata as { field_provenance?: Record<string, { by?: string; from?: string }> } | null;
    const taught = factsTaughtBy({ defs, candidate: top, provenance: meta?.field_provenance ?? null, personValues: personValuesOf(meta) });
    if (!taught.size) continue;
    if ((await recordModelFacts(db as never, kind, key, taught, r.id)).length) learnedFor.set(`${kind}\u0000${key}`, { kind, key });
  }
  let filled = 0;
  for (const { kind, key } of learnedFor.values()) {
    try {
      const known = await readModelFacts(db as never, kind, key);
      filled += await spreadModelFacts(db as never, { kind, key, defs: defsByKind.get(kind)!, known });
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-model-facts", orgId, err);
      console.error(`[core-scan] org ${orgId}: could not fill what is known about ${key}:`, (err as Error).message);
    }
  }
  if (filled) console.log(`[core-scan] org ${orgId}: filled model facts into ${filled} waiting row(s)`);
  return filled;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerModelFactsHeal(): void {
  registerHealPass({
    name: "core-scan.heal-model-facts",
    shim: "modules/core-scan/src/heal-model-facts.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healModelFactsIn(orgId, db as Kysely<HealDB>),
  });
}

// The build engine — the distinctive logic: "how many can I build right now,
// and what's the limiting component?" + consuming stock on a build. Reads/writes
// inventory ONLY through the platform (lookup + the inventory:adjust-stock
// action), never a table join — cross-module isolation.

import { type Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "./db.js";
import { shortageSentence } from "./shortage.js";

export interface ComponentInput {
  part_id: string;
  quantity: number;
  optional: boolean;
}

export interface ComponentStock extends ComponentInput {
  name: string;
  available: number;
  per_build: number;
  /** floor(available / per_build), or Infinity when per_build is 0. */
  max_from_this: number;
}

/** Read each component part's current stock + name via the inventory resolver. */
export async function readComponentStock(
  orgId: string,
  comps: ComponentInput[],
): Promise<ComponentStock[]> {
  const out: ComponentStock[] = [];
  for (const c of comps) {
    const ent = await platform()
      .entities.lookup(orgId, "inventory:part", c.part_id)
      .catch(() => null);
    const available = Number((ent?.fields?.qty as number | undefined) ?? 0) || 0;
    const name = ent?.title ?? "(unknown part)";
    const per = c.quantity > 0 ? c.quantity : 0;
    out.push({
      ...c,
      name,
      available,
      per_build: per,
      max_from_this: per > 0 ? Math.floor(available / per) : Infinity,
    });
  }
  return out;
}

export interface Buildable {
  max_buildable: number;
  limiting: Array<{ part_id: string; name: string; available: number; per_build: number }>;
  components: ComponentStock[];
}

/** Given each component's stock, how many builds can be made now + the limiting
 *  component(s). Optional components don't constrain buildability. */
export function computeBuildable(stock: ComponentStock[]): Buildable {
  const required = stock.filter((c) => !c.optional && c.per_build > 0);
  if (required.length === 0) {
    return { max_buildable: 0, limiting: [], components: stock };
  }
  const max = Math.min(...required.map((c) => c.max_from_this));
  const limiting = required
    .filter((c) => c.max_from_this === max)
    .map((c) => ({ part_id: c.part_id, name: c.name, available: c.available, per_build: c.per_build }));
  return { max_buildable: Number.isFinite(max) ? max : 0, limiting, components: stock };
}

/** Per-component shortfall to hit a target build count. */
export function computeShortfall(
  stock: ComponentStock[],
  targetQty: number,
): Array<{ part_id: string; name: string; required: number; available: number; short: number }> {
  return stock
    .filter((c) => c.per_build > 0)
    .map((c) => {
      const required = c.per_build * targetQty;
      const short = Math.max(0, required - c.available);
      return { part_id: c.part_id, name: c.name, required, available: c.available, short };
    })
    .filter((s) => s.short > 0);
}

/** A single component line as stored: EITHER a leaf part or a sub-assembly. */
export interface RawComponentRow {
  part_id: string | null;
  sub_assembly_build_id: string | null;
  quantity: number;
  optional: boolean;
  /** A sub-assembly line: take its output part's stock before making more
   *  (the default), or always make it. Ignored on a part line. */
  use_stock?: boolean;
}

/** A sub-assembly's output: the part it makes and how many of it one build makes. */
export interface SubAssemblyOutput {
  part_id: string | null;
  per_build: number;
  name: string;
}

/** How one sub-assembly line of a plan is met: so many from its output-part
 *  stock, the rest made (exploded into its own components). */
export interface SubAssemblyPlan {
  build_id: string;
  name: string;
  part_id: string | null;
  needed: number;
  from_stock: number;
  to_make: number;
  use_stock: boolean;
}

export interface BuildPlan {
  /** Every leaf part, in total for the planned quantity. */
  leaves: ComponentInput[];
  /** Stocked sub-assembly outputs the plan takes, in total. */
  from_stock: ComponentInput[];
  sub_assemblies: SubAssemblyPlan[];
}

/** Pure make-or-buy plan for `qty` builds: a sub-assembly line takes its output
 *  part's stock first and explodes only the shortfall, unless the line says
 *  always make. Stock is shared across the tree, so a sub-assembly reached
 *  twice never counts the same shelf twice. Same recursion, aggregation,
 *  optional rule and cycle guard as explodeWith. */
export async function planWith(
  load: (buildId: string) => Promise<RawComponentRow[]> | RawComponentRow[],
  outputOf: (buildId: string) => Promise<SubAssemblyOutput | null> | SubAssemblyOutput | null,
  stockOf: (partId: string) => Promise<number> | number,
  rootBuildId: string,
  qty: number,
): Promise<BuildPlan> {
  const leaves = new Map<string, { quantity: number; optional: boolean }>();
  const taken = new Map<string, { quantity: number; optional: boolean }>();
  const left = new Map<string, number>();
  const subs: SubAssemblyPlan[] = [];
  const add = (into: typeof leaves, id: string, quantity: number, optional: boolean) => {
    const prev = into.get(id);
    if (prev) { prev.quantity += quantity; prev.optional = prev.optional && optional; }
    else into.set(id, { quantity, optional });
  };

  async function walk(bid: string, mult: number, optionalPath: boolean, path: Set<string>): Promise<void> {
    if (path.has(bid)) {
      console.error(`[builds] sub-assembly cycle detected at build ${bid} — skipping`);
      return;
    }
    const nextPath = new Set(path).add(bid);
    for (const r of await load(bid)) {
      const need = (Number(r.quantity) || 0) * mult;
      if (need <= 0) continue;
      const optional = optionalPath || r.optional;
      if (r.part_id) { add(leaves, r.part_id, need, optional); continue; }
      if (!r.sub_assembly_build_id) continue;
      const out = await outputOf(r.sub_assembly_build_id);
      const useStock = r.use_stock !== false;
      const per = out && out.per_build > 0 ? out.per_build : 1;
      let fromStock = 0;
      if (useStock && out?.part_id) {
        if (!left.has(out.part_id)) left.set(out.part_id, Math.max(0, Number(await stockOf(out.part_id)) || 0));
        fromStock = Math.min(left.get(out.part_id)!, need * per);
        left.set(out.part_id, left.get(out.part_id)! - fromStock);
        if (fromStock > 0) add(taken, out.part_id, fromStock, optional);
      }
      const toMake = Math.ceil((need * per - fromStock) / per);
      subs.push({ build_id: r.sub_assembly_build_id, name: out?.name ?? "(unknown build)", part_id: out?.part_id ?? null, needed: need * per, from_stock: fromStock, to_make: toMake, use_stock: useStock });
      if (toMake > 0) await walk(r.sub_assembly_build_id, toMake, optional, nextPath);
    }
  }

  await walk(rootBuildId, qty, false, new Set());
  const list = (m: typeof leaves) => [...m.entries()].map(([part_id, v]) => ({ part_id, quantity: v.quantity, optional: v.optional }));
  return { leaves: list(leaves), from_stock: list(taken), sub_assemblies: subs };
}

/** Pure BoM explosion — recursion + aggregation + cycle guard, independent of
 *  the DB (so it's unit-testable). `load(buildId)` returns that build's direct
 *  component rows. Nested sub-assemblies multiply through (Q of a sub-assembly
 *  per build × the sub-assembly's own per-build quantities). A leaf is `optional`
 *  only if EVERY path that reaches it is optional — required always wins.
 *  Cycle-guarded: a sub-assembly already on the current path is skipped (logged),
 *  so a self/mutual reference can't loop. */
export async function explodeWith(
  load: (buildId: string) => Promise<RawComponentRow[]> | RawComponentRow[],
  rootBuildId: string,
): Promise<ComponentInput[]> {
  const leaves = new Map<string, { quantity: number; optional: boolean }>();

  async function walk(bid: string, mult: number, optionalPath: boolean, path: Set<string>): Promise<void> {
    if (path.has(bid)) {
      console.error(`[builds] sub-assembly cycle detected at build ${bid} — skipping`);
      return;
    }
    const nextPath = new Set(path).add(bid);
    const rows = await load(bid);
    for (const r of rows) {
      const qty = (Number(r.quantity) || 0) * mult;
      if (qty <= 0) continue;
      const optional = optionalPath || r.optional;
      if (r.part_id) {
        const prev = leaves.get(r.part_id);
        if (prev) {
          prev.quantity += qty;
          prev.optional = prev.optional && optional; // required wins
        } else {
          leaves.set(r.part_id, { quantity: qty, optional });
        }
      } else if (r.sub_assembly_build_id) {
        await walk(r.sub_assembly_build_id, qty, optional, nextPath);
      }
    }
  }

  await walk(rootBuildId, 1, false, new Set());
  return [...leaves.entries()].map(([part_id, v]) => ({
    part_id,
    quantity: v.quantity,
    optional: v.optional,
  }));
}

const componentRows = (db: Kysely<BuildsDB>) => (bid: string) =>
  db
    .selectFrom("builds_components")
    .select(["part_id", "sub_assembly_build_id", "quantity", "optional", "use_stock"])
    .where("build_id", "=", bid)
    .orderBy("created_at", "asc")
    .execute()
    .then((rows) =>
      rows.map((r) => ({
        part_id: r.part_id,
        sub_assembly_build_id: r.sub_assembly_build_id,
        quantity: Number(r.quantity) || 0,
        optional: r.optional,
        use_stock: r.use_stock,
      })),
    );

/** Explode a build's bill-of-materials all the way down to aggregated leaf
 *  inventory-part requirements per build, every sub-assembly made. What a
 *  build needs when nothing is on the shelf; planBuild is what a run takes. */
export async function explodeLeafComponents(
  orgId: string,
  buildId: string,
): Promise<ComponentInput[]> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
  return explodeWith(componentRows(db), buildId);
}

/** One reading of the shelf for a whole question: each part's stock is looked
 *  up once, however many plans ask. */
export function shelf(orgId: string): (partId: string) => Promise<number> {
  const seen = new Map<string, Promise<number>>();
  return (partId) => {
    if (!seen.has(partId)) {
      seen.set(partId, platform().entities.lookup(orgId, "inventory:part", partId).then((e) => Number((e?.fields?.qty as number | undefined) ?? 0) || 0).catch(() => 0));
    }
    return seen.get(partId)!;
  };
}

/** The make-or-buy plan for `qty` runs of a build, read from its tables and the shelf. */
export async function planBuild(orgId: string, buildId: string, qty: number, stockOf = shelf(orgId)): Promise<BuildPlan> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
  return planWith(
    componentRows(db),
    async (bid) => {
      const b = await db.selectFrom("builds_builds").select(["name", "output_part_id", "output_qty"]).where("id", "=", bid).executeTakeFirst();
      return b ? { part_id: b.output_part_id, per_build: Number(b.output_qty) || 1, name: b.name } : null;
    },
    stockOf,
    buildId,
    qty,
  );
}

/** A plan less the parts something else charges: a print's measured spool is
 *  its one charge, so the recipe's line for that spool is not taken again (#8757). */
export function withoutParts(plan: BuildPlan, parts: ReadonlySet<string>): BuildPlan {
  if (!parts.size) return plan;
  return { ...plan, leaves: plan.leaves.filter((c) => !parts.has(c.part_id)), from_stock: plan.from_stock.filter((c) => !parts.has(c.part_id)) };
}

/** What a plan takes from the shelf: its leaves and its stocked sub-assemblies, in total. */
export const planInputs = (plan: BuildPlan): ComponentInput[] => [...plan.from_stock, ...plan.leaves];

/** Whether the shelf covers every required line of a plan (an optional one gives what it has). */
async function covers(plan: BuildPlan, stockOf: (partId: string) => Promise<number>): Promise<boolean> {
  for (const c of plan.leaves) if (!c.optional && c.quantity > 0 && (await stockOf(c.part_id)) < c.quantity) return false;
  return true;
}

/** How many runs the shelf covers now, taking stocked sub-assemblies first,
 *  and what stops one more. Make-or-buy is not linear in the count (two
 *  boards on the shelf cover two runs, the third makes one), so the count is
 *  searched, not divided. */
export async function buildableOf(orgId: string, buildId: string): Promise<Buildable & { plan: BuildPlan }> {
  const stockOf = shelf(orgId);
  const one = await planBuild(orgId, buildId, 1, stockOf);
  const components = await readComponentStock(orgId, planInputs(one));
  const required = one.leaves.filter((c) => !c.optional && c.quantity > 0);
  if (!required.length && !one.from_stock.length) return { max_buildable: 0, limiting: [], components, plan: one };
  let lo = 0;
  let hi = 1;
  while (hi <= 1_000_000 && (await covers(await planBuild(orgId, buildId, hi, stockOf), stockOf))) { lo = hi; hi *= 2; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await covers(await planBuild(orgId, buildId, mid, stockOf), stockOf)) lo = mid; else hi = mid;
  }
  const next = await planBuild(orgId, buildId, lo + 1, stockOf);
  const short = await readComponentStock(orgId, next.leaves.filter((c) => !c.optional));
  const limiting = short.filter((c) => c.available < c.quantity).map((c) => ({ part_id: c.part_id, name: c.name, available: c.available, per_build: one.leaves.find((l) => l.part_id === c.part_id)?.quantity ?? c.quantity }));
  return { max_buildable: lo, limiting, components, plan: lo > 0 ? await planBuild(orgId, buildId, lo, stockOf) : one };
}

/** What is short to make `target` runs, after stocked sub-assemblies are taken. */
export async function shortfallOf(orgId: string, buildId: string, target: number) {
  const plan = await planBuild(orgId, buildId, target);
  return { plan, shortfall: computeShortfall(await readComponentStock(orgId, plan.leaves), 1) };
}

/** Consume all required components atomically through inventory's stock action.
 * The preliminary read names shortages; inventory checks again under row locks.
 * Optional components give what is available. Only committed draws are returned. */
export async function consumeComponents(
  orgId: string,
  userId: string | null,
  buildId: string,
  comps: ComponentInput[],
  qty: number,
): Promise<Array<{ part_id: string; quantity: number }>> {
  const combined = new Map<string, ComponentInput>();
  for (const c of comps) {
    const previous = combined.get(c.part_id);
    combined.set(c.part_id, previous
      ? { ...c, quantity: previous.quantity + c.quantity, optional: previous.optional && c.optional }
      : { ...c });
  }
  const inputs = [...combined.values()];
  const refusal = shortageSentence(await readComponentStock(orgId, inputs), qty);
  if (refusal) throw new ActionRefusal(refusal);
  const draws = inputs.filter(c => c.quantity * qty > 0).map(c => ({
    partId: c.part_id, quantity: c.quantity * qty, optional: c.optional,
  }));
  if (draws.length === 0) return [];
  const result = await platform().actions.invoke("inventory:adjust-stock", {
    orgId,
    userId,
    event: {
      name: "builds.build.completed",
      payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" },
      timestamp: new Date().toISOString(),
      trigger_type: "event",
    },
    args: { draws, reason: `build:${buildId}` },
  }) as { ok?: boolean; error?: string; consumed?: Array<{ part_id: string; quantity: number }> } | null;
  if (!result?.ok || !Array.isArray(result.consumed)) {
    throw new ActionRefusal(result?.error || "The required component stock could not be drawn. Nothing was built.");
  }
  for (const c of draws.filter(c => !c.optional)) {
    const moved = result.consumed.filter(m => m.part_id === c.partId).reduce((sum, m) => sum + m.quantity, 0);
    if (!Number.isFinite(moved) || Math.abs(moved - c.quantity) > 1e-9) {
      throw new ActionRefusal("The required component stock was not drawn in full. Nothing was built.");
    }
  }
  return result.consumed;
}

/** Run a plan: take its stocked sub-assemblies and its leaves off the shelf
 *  (refused, before anything moves, when a required line is short). Each
 *  stocked sub-assembly taken says which build it stands in for, so the run's
 *  genealogy shows what came from the shelf and what was made. */
export async function consumePlan(
  orgId: string,
  userId: string | null,
  buildId: string,
  plan: BuildPlan,
): Promise<Array<{ part_id: string; quantity: number; sub_assembly_build_id?: string }>> {
  const consumed = await consumeComponents(orgId, userId, buildId, planInputs(plan), 1);
  const standsIn = new Map(plan.sub_assemblies.filter((s) => s.part_id && s.from_stock > 0).map((s) => [s.part_id!, s.build_id]));
  return consumed.map((c) => (standsIn.has(c.part_id) ? { ...c, sub_assembly_build_id: standsIn.get(c.part_id)! } : c));
}

/** "Controller board: 2 from stock, 1 to make", one line per sub-assembly, as a person and Cobb read a plan. */
export function planLines(plan: BuildPlan): string[] {
  const by = new Map<string, SubAssemblyPlan>();
  for (const s of plan.sub_assemblies) {
    const prev = by.get(s.build_id);
    by.set(s.build_id, prev ? { ...prev, needed: prev.needed + s.needed, from_stock: prev.from_stock + s.from_stock, to_make: prev.to_make + s.to_make } : { ...s });
  }
  return [...by.values()].map((s) => {
    const parts = [s.from_stock > 0 ? `${s.from_stock} from stock` : null, s.to_make > 0 ? `${s.to_make} to make` : null].filter(Boolean);
    return `${s.name}: ${parts.join(", ") || "none needed"}${s.use_stock ? "" : " (always made)"}`;
  });
}

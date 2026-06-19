// The build engine — the distinctive logic: "how many can I build right now,
// and what's the limiting component?" + consuming stock on a build. Reads/writes
// inventory ONLY through the platform (lookup + the inventory:adjust-stock
// action), never a table join — cross-module isolation.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "./db.js";

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

/** Explode a build's bill-of-materials down to aggregated leaf inventory-part
 *  requirements, reading the builds tables through the platform. v1 semantic =
 *  pure "make from leaves": a sub-assembly is always exploded to its raw parts,
 *  never satisfied from its own output-part stock (make-or-buy is a later
 *  refinement). Leaf stock is read separately, via the inventory API, by
 *  readComponentStock. */
export async function explodeLeafComponents(
  orgId: string,
  buildId: string,
): Promise<ComponentInput[]> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
  return explodeWith(
    (bid) =>
      db
        .selectFrom("builds_components")
        .select(["part_id", "sub_assembly_build_id", "quantity", "optional"])
        .where("build_id", "=", bid)
        .orderBy("created_at", "asc")
        .execute()
        .then((rows) =>
          rows.map((r) => ({
            part_id: r.part_id,
            sub_assembly_build_id: r.sub_assembly_build_id,
            quantity: Number(r.quantity) || 0,
            optional: r.optional,
          })),
        ),
    buildId,
  );
}

/** Consume the components for `qty` builds via the inventory adjust-stock action.
 *  Returns the consumed snapshot. Best-effort per component (a failure logs +
 *  continues — the run still records what it tried). */
export async function consumeComponents(
  orgId: string,
  userId: string | null,
  buildId: string,
  comps: ComponentInput[],
  qty: number,
): Promise<Array<{ part_id: string; quantity: number }>> {
  const consumed: Array<{ part_id: string; quantity: number }> = [];
  for (const c of comps) {
    const dec = c.quantity * qty;
    if (dec <= 0) continue;
    await platform()
      .actions.invoke("inventory:adjust-stock", {
        orgId,
        userId,
        entity: { kind: "inventory:part", id: c.part_id },
        event: {
          name: "builds.build.completed",
          payload: {},
          actor: { user_id: userId, display_name: null, auth_method: "session" },
          timestamp: new Date().toISOString(),
          trigger_type: "event",
        },
        args: { partId: c.part_id, delta: -dec, reason: `build:${buildId}` },
        entityKind: "inventory:part",
        entityId: c.part_id,
      })
      .catch((e) => console.error("[builds] adjust-stock failed:", (e as Error).message));
    consumed.push({ part_id: c.part_id, quantity: dec });
  }
  return consumed;
}

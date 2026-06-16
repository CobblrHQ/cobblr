// The build engine — the distinctive logic: "how many can I build right now,
// and what's the limiting component?" + consuming stock on a build. Reads/writes
// inventory ONLY through the platform (lookup + the inventory:adjust-stock
// action), never a table join — cross-module isolation.

import { platform } from "@cobblr/platform-contract";

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

// What an uninstall puts back (#3918).
//
// An install claims what it caused: the modules it switched on and the places
// it created (bundle-claims.ts). An uninstall drops the bundle's claims and then
// looks at each thing nothing else claims any more:
//
//   - a PLACE is removed when it is empty: no place inside it and nothing
//     filed in it. A Pantry with twelve things in it is the person's now, and
//     stays, and the summary says why.
//   - a MODULE is switched off when it holds no records. A Lists module with a
//     shopping list in it is in use, and stays.
//
// Nothing the ledger does not name is ever touched: a module that was already
// on, a Kitchen that was already there, anything from before the ledger knew
// about places. Unknown origin means the person's.
//
// Places before modules, so the module that owns places is still on while its
// empty places go; modules with dependents before the modules they depend on.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";
import { list, listKindsForOrg } from "./entities.js";
import { disableModuleForOrg } from "../modules/enable.js";
import { getEntry } from "../modules/registry.js";
import { listInstances } from "./instances.js";
import type { ResourceClaim } from "./bundle-claims.js";

export interface KeptResource {
  type: "module" | "place";
  key: string;
  name: string;
  /** Plain words: "12 things live there", "3 records use it". */
  reason: string;
}

export interface ReleaseSummary {
  removed: Array<{ type: "module" | "place"; key: string; name: string }>;
  kept: KeptResource[];
}

interface PlacesDB {
  core_locations_locations: { id: string; name: string; parent_id: string | null };
}

const LOCATION_KIND = "core-locations:location";
const COUNT_PAGE = 500;

/** What is in a place: places inside it, and things filed there. */
async function placeContents(
  orgId: string,
  id: string,
  going: ReadonlySet<string> = new Set(),
): Promise<{ name: string; children: number; things: number } | null> {
  const db = (await getTenantDb(orgId)) as unknown as Kysely<PlacesDB>;
  const row = await db.selectFrom("core_locations_locations").select(["name"]).where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  // Places inside it, less any the same uninstall is removing (a preview asks
  // before they have gone).
  const kids = await db.selectFrom("core_locations_locations").select(["id"]).where("parent_id", "=", id).execute();
  const children = { n: kids.filter((k) => !going.has(k.id)).length };
  let things = 0;
  try {
    // Through the placement seam, which reads every record under its base
    // kind, whatever spelling filed it.
    things = (await platform().placement.contents({ orgId, container: { kind: LOCATION_KIND, id } })).length;
  } catch {
    // No placement to ask: we cannot see what is in it, so treat it as in use.
    things = Number.POSITIVE_INFINITY;
  }
  return { name: row.name, children: children.n, things };
}

/** How many records a module holds, across its kinds. Null when it cannot be
 *  counted, which callers treat as "in use". */
export async function moduleRecordCount(
  orgId: string,
  moduleName: string,
  opts: { skipInstances?: Set<string> } = {},
): Promise<number | null> {
  let total = 0;
  try {
    // Its own kinds AND its collections' (a Yarn table is an inventory
    // instance): a module whose collection holds records is in use. A
    // preview skips the collections the same uninstall deletes.
    // The kinds of ONE module, to count what it holds; a collection the
    // same uninstall deletes is left out of the count.
    // registry-filter-ok: one module's own kinds, counted, not a listing
    const kinds = (await listKindsForOrg(orgId)).filter(
      (k) => k.module_name === moduleName && !(k.instance_name && opts.skipInstances?.has(k.instance_name)),
    );
    for (const k of kinds) {
      // A page, not one row: a kind that reports no total is counted by what
      // it returns, and "1 record" for a shelf of them reads as a lie.
      const r = await list(orgId, k.id, { limit: COUNT_PAGE, include_retired: true });
      total += typeof r.total === "number" ? r.total : r.items.length;
    }
  } catch {
    return null;
  }
  return total;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Remove the unclaimed, unused places (children before parents) and switch
 *  off the unclaimed, unused modules; keep and explain the rest. */
export async function releaseUnclaimed(orgId: string, released: ResourceClaim[]): Promise<ReleaseSummary> {
  const out: ReleaseSummary = { removed: [], kept: [] };

  // Places: several passes, so a Kitchen whose Fridge and Freezer were the
  // bundle's own empty places goes once they have gone.
  let pending = released.filter((c) => c.resource_type === "place").map((c) => c.resource_key);
  for (let round = 0; pending.length > 0 && round < 6; round++) {
    const next: string[] = [];
    for (const id of pending) {
      const c = await placeContents(orgId, id).catch(() => null);
      if (!c) continue; // already gone
      if (c.children === 0 && c.things === 0) {
        const db = (await getTenantDb(orgId)) as unknown as Kysely<PlacesDB>;
        await db.deleteFrom("core_locations_locations").where("id", "=", id).execute();
        out.removed.push({ type: "place", key: id, name: c.name });
      } else {
        next.push(id);
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const id of pending) {
    const c = await placeContents(orgId, id).catch(() => null);
    if (!c) continue;
    const reason = Number.isFinite(c.things) && c.things > 0
      ? `${plural(c.things, "thing lives", "things live")} there`
      : c.children > 0
        ? `${plural(c.children, "place is", "places are")} inside it`
        : "what is in it could not be checked";
    out.kept.push({ type: "place", key: id, name: c.name, reason });
  }

  // Modules: dependents first.
  const modules = released
    .filter((c) => c.resource_type === "module")
    .map((c) => c.resource_key)
    .sort((a, b) => (getEntry(b)?.manifest.dependencies.length ?? 0) - (getEntry(a)?.manifest.dependencies.length ?? 0));
  for (const name of modules) {
    const label = getEntry(name)?.manifest.displayName ?? name;
    // A collection of it still exists (kept by an uninstall that did not
    // delete data): switching the module off would strand it.
    const collections = (await listInstances(orgId, name).catch(() => [])).filter((i) => !i.is_default);
    if (collections.length > 0) {
      out.kept.push({ type: "module", key: name, name: label, reason: `${collections.map((c) => c.display_name ?? c.instance_name).join(", ")} still ${collections.length === 1 ? "uses" : "use"} it` });
      continue;
    }
    const held = await moduleRecordCount(orgId, name);
    if (held === null || held > 0) {
      out.kept.push({ type: "module", key: name, name: label, reason: held ? `${plural(held, "record uses", "records use")} it` : "what it holds could not be checked" });
      continue;
    }
    try {
      await disableModuleForOrg(orgId, name);
      out.removed.push({ type: "module", key: name, name: label });
    } catch (err) {
      // Foundational, or another module still needs it.
      out.kept.push({ type: "module", key: name, name: label, reason: (err as Error).message || "another part of the workspace needs it" });
    }
  }
  return out;
}

/** The words for what stayed: "Kept Pantry: 12 things live there." */
export function describeKept(kept: KeptResource[]): string[] {
  return kept.map((k) => `Kept ${k.name}: ${k.reason}.`);
}

/** What an uninstall would do with these places, decided the way the release
 *  decides it: an empty one goes, and a parent whose only contents are going
 *  goes after them. */
export async function previewPlaces(
  orgId: string,
  ids: string[],
): Promise<{ going: Array<{ id: string; name: string }>; kept: Array<{ name: string; reason: string }> }> {
  const going = new Set<string>();
  const names = new Map<string, string>();
  let pending = [...ids];
  for (let round = 0; pending.length > 0 && round < 6; round++) {
    const next: string[] = [];
    for (const id of pending) {
      const c = await placeContents(orgId, id, going).catch(() => null);
      if (!c) continue;
      names.set(id, c.name);
      if (c.children === 0 && c.things === 0) going.add(id);
      else next.push(id);
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  const kept: Array<{ name: string; reason: string }> = [];
  for (const id of pending) {
    const d = await describePlace(orgId, id, going);
    if (d?.inUse) kept.push({ name: d.name, reason: d.reason });
  }
  return { going: [...going].map((id) => ({ id, name: names.get(id) ?? "" })), kept };
}

/** A place an uninstall would look at: its name, and whether it is in use. */
export async function describePlace(
  orgId: string,
  id: string,
  going: ReadonlySet<string> = new Set(),
): Promise<{ name: string; inUse: boolean; reason: string } | null> {
  const c = await placeContents(orgId, id, going).catch(() => null);
  if (!c) return null;
  if (c.children === 0 && c.things === 0) return { name: c.name, inUse: false, reason: "" };
  const reason = Number.isFinite(c.things) && c.things > 0
    ? `${plural(c.things, "thing lives", "things live")} there`
    : c.children > 0
      ? `${plural(c.children, "place is", "places are")} inside it`
      : "what is in it could not be checked";
  return { name: c.name, inUse: true, reason };
}

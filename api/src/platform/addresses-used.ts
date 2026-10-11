// The addresses a workspace already used, for the address picker (#5317).
//
// Every address field on every kind is read, newest records first, and each
// place is offered once with the record it was last used on and how often it
// was used: "mvc" finds the MVC Lodi Agency a car's registration renewal went
// to last year, before anything else is asked. Free, private and instant.
//
// Read as the person asking, so a record they cannot read lends them nothing.
// Bounded like the choice picker's list: the newest records of each kind.

import { addressKey, addressMatches, asAddress, type AddressValue } from "@cobblr/platform-contract/address";
import type { EntityViewer, UsedAddressRow } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { listAll as listAllEntities } from "./entities.js";

const SCAN = 2000;
const LIMIT = 8;

export interface UsedAddress {
  address: AddressValue;
  /** The record it was last used on. */
  usedOn: { kind: string; id: string; name: string };
  uses: number;
  lastUsed: string | null;
}

/** The address fields this workspace has, by kind. */
export async function addressFieldsByKind(orgId: string): Promise<Map<string, string[]>> {
  const rows = await meta
    .selectFrom("module_field_defs")
    .select(["entity_kind", "name"])
    .where("org_id", "=", orgId)
    .where("type", "=", "address")
    .execute();
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.entity_kind, [...(out.get(r.entity_kind) ?? []), r.name]);
  return out;
}

// Modules that keep addresses outside record fields (a service visit's).
const sources = new Map<string, (orgId: string) => Promise<UsedAddressRow[]>>();

export function registerUsedAddressSource(id: string, source: (orgId: string) => Promise<UsedAddressRow[]>): void {
  sources.set(id, source);
}

const stamp = (v: unknown): string | null => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : null);

/** The places used, most recently used first, matching `query` when given. */
export async function addressesUsed(orgId: string, opts: { query?: string; viewer?: EntityViewer; limit?: number } = {}): Promise<UsedAddress[]> {
  const byKey = new Map<string, UsedAddress>();
  const note = (address: AddressValue | null, usedOn: UsedAddress["usedOn"], at: string | null) => {
    if (!address) return;
    const key = addressKey(address);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { address: { ...address, source: "used" }, usedOn, uses: 1, lastUsed: at });
      return;
    }
    cur.uses += 1;
    if (at && (!cur.lastUsed || at > cur.lastUsed)) {
      cur.lastUsed = at;
      cur.usedOn = usedOn;
      // The newest spelling of a place wins: a corrected street replaces the old.
      cur.address = { ...address, source: "used" };
    }
  };
  for (const [kind, fields] of await addressFieldsByKind(orgId)) {
    // A kind whose module is off lists nothing (`unlisted`), and a failed list
    // says so (`failed`): either way it lends no addresses and the rest stand.
    const { items } = await listAllEntities(orgId, kind, { include_retired: true }, opts.viewer, { cap: SCAN });
    for (const it of items) {
      const f = it.fields as Record<string, unknown>;
      const bag = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
      const at = stamp(f.updated_at) ?? stamp(f.created_at);
      for (const field of fields) note(asAddress(field in f ? f[field] : bag[field]), { kind, id: it.id, name: it.title }, at);
    }
  }
  for (const [id, source] of sources) {
    // One module's addresses failing leaves the rest offered, and says so.
    const rows = await source(orgId).catch((err: unknown) => {
      console.error(`[addresses] source '${id}' failed:`, (err as Error).message);
      return [] as UsedAddressRow[];
    });
    for (const r of rows) note(asAddress(r.address), r.usedOn, r.at);
  }
  const q = opts.query?.trim() ?? "";
  return [...byKey.values()]
    .filter((u) => !q || addressMatches(u.address, q))
    .sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") || b.uses - a.uses)
    .slice(0, opts.limit ?? LIMIT);
}

/** The coordinates of the most recently used place that has some: where a
 *  map lookup is biased toward, so "Lodi MVC" finds the one nearby. */
export function nearestBias(used: UsedAddress[]): { lat: number; lon: number } | undefined {
  const withCoords = used.find((u) => u.address.lat !== undefined && u.address.lon !== undefined);
  return withCoords ? { lat: withCoords.address.lat!, lon: withCoords.address.lon! } : undefined;
}

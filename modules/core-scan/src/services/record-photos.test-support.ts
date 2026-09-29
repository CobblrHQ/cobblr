// An in-memory SuggestionStore, for the tests of the record-photo rules. It
// keeps the product store's one guard (only a queued row is settled) so a
// test cannot pass on a write the database would have refused.

import type { EntitySavedEvent } from "@cobblr/platform-contract/entity-saved";
import type { SuggestionStore } from "./record-photos.js";

export interface MemoryRow {
  entity_kind: string;
  entity_id: string;
  name: string;
  status: string;
  attempts: number;
  file_id?: string;
  source_url?: string;
  query?: string;
  seq: number;
}

export function memoryStore(opts: { autoApply?: boolean; backfilled?: boolean } = {}): SuggestionStore & { rows: Map<string, MemoryRow> } {
  const rows = new Map<string, MemoryRow>();
  let seq = 0;
  let backfilled = opts.backfilled ?? true;
  const key = (k: string, id: string) => `${k}|${id}`;
  return {
    rows,
    get: async (k, id) => {
      const r = rows.get(key(k, id));
      return r ? { status: r.status, name: r.name } : null;
    },
    queue: async (e: EntitySavedEvent) => {
      rows.set(key(e.kind, e.id), { entity_kind: e.kind, entity_id: e.id, name: (e.title ?? "").trim(), status: "queued", attempts: 0, seq: seq++ });
    },
    forget: async (k, id) => {
      rows.delete(key(k, id));
    },
    queued: async (limit) =>
      [...rows.values()]
        .filter((r) => r.status === "queued")
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map((r) => ({ entity_kind: r.entity_kind, entity_id: r.entity_id, attempts: r.attempts })),
    settle: async (k, id, set) => {
      const r = rows.get(key(k, id));
      if (!r || r.status !== "queued") return;
      Object.assign(r, set);
    },
    autoApply: async () => opts.autoApply === true,
    backfilled: async () => backfilled,
    markBackfilled: async () => {
      backfilled = true;
    },
    queueIfAbsent: async (k, id, name) => {
      if (rows.has(key(k, id))) return false;
      // Behind every save, as the product store dates it at the epoch.
      rows.set(key(k, id), { entity_kind: k, entity_id: id, name, status: "queued", attempts: 0, seq: -1_000_000 + seq++ });
      return true;
    },
    requeue: async (k, id) => {
      const r = rows.get(key(k, id));
      if (!r) return false;
      Object.assign(r, { status: "queued", attempts: 0, file_id: undefined, source_url: undefined });
      return true;
    },
  };
}

export const saved = (over: Partial<EntitySavedEvent> = {}): EntitySavedEvent => ({
  orgId: "org-1",
  kind: "machines:machine",
  id: "m-1",
  title: "Dremel 3D20",
  hasImage: false,
  created: true,
  userId: "u-1",
  ...over,
});

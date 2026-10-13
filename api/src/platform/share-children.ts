// The rows a module declares as belonging to a record, carried with it when
// it is shared (ShareChildren in the contract, #6252). Coordinator,
// 2026-10-13: shared records carry their child rows.
import type { ShareChildren } from "@cobblr/platform-contract";

const sets = new Map<string, ShareChildren[]>();

export function registerShareChildren(def: ShareChildren): void {
  const had = (sets.get(def.kind) ?? []).filter((d) => d.name !== def.name);
  sets.set(def.kind, [...had, def]);
}

export function shareChildrenFor(kind: string): ShareChildren[] {
  return sets.get(kind) ?? [];
}

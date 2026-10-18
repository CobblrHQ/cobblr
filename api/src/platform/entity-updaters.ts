// In-process registry of record updaters. A module that owns an entity kind
// registers, at boot via platform().entities.registerUpdater(kind, fn, opts),
// how a member's edit of that kind is applied. The kernel's one edit verb
// (platform:update-fields, update-record-fields.ts) dispatches here, so it
// never learns a module's tables and the module never learns about apps.
// Inert until a module opts in: an unregistered kind is "not updatable".

import type { EntityUpdater } from "@cobblr/platform-contract";

interface Registered {
  update: EntityUpdater;
  capability: string | null;
  nativeFields: ReadonlySet<string> | null;
}

const updaters = new Map<string, Registered>();

export function registerUpdater(kind: string, update: EntityUpdater, opts?: { capability?: string; nativeFields?: readonly string[] }): void {
  updaters.set(kind, { update, capability: opts?.capability ?? null, nativeFields: opts?.nativeFields ? new Set(opts.nativeFields) : null });
}

export function updaterFor(kind: string): Registered | null {
  return updaters.get(kind) ?? null;
}

export function updatableKinds(): string[] {
  return [...updaters.keys()].sort();
}

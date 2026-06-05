// In-process registry of create-time field-default providers. Modules register
// at boot via platform().entities.registerCreateDefaults(kind, fn); a create
// handler calls resolveCreateDefaults(ctx) before insert and applies the merged
// result only to fields the caller left unset.
//
// This is the provider-agnostic seam behind "default a field from context on
// create" — a presence module defaults `scan_area`/`location_id` from the room
// the user is in, a GPS source or a manual room-pin register the same way. The
// create path never imports any provider's module.
//
// Providers are best-effort: one that throws contributes nothing rather than
// failing the create. The registry is INERT when nothing is registered for a
// kind (resolve returns {}), so wiring a call-site is a no-op until some module
// opts in.

import type {
  CreateDefaultsContext,
  CreateDefaultsProvider,
} from "@cobblr/platform-contract";

const providers = new Map<string, CreateDefaultsProvider[]>();

export function registerCreateDefaults(kind: string, provider: CreateDefaultsProvider): void {
  const arr = providers.get(kind);
  if (arr) arr.push(provider);
  else providers.set(kind, [provider]);
}

export function unregisterCreateDefaults(kind: string, provider: CreateDefaultsProvider): void {
  const arr = providers.get(kind);
  if (!arr) return;
  const i = arr.indexOf(provider);
  if (i !== -1) arr.splice(i, 1);
  if (arr.length === 0) providers.delete(kind);
}

export function listKinds(): string[] {
  return [...providers.keys()];
}

export async function resolveCreateDefaults(
  ctx: CreateDefaultsContext,
): Promise<Record<string, unknown>> {
  const arr = providers.get(ctx.kind);
  if (!arr || arr.length === 0) return {};
  const merged: Record<string, unknown> = {};
  for (const provider of arr) {
    let out: Record<string, unknown> | undefined;
    try {
      out = await provider(ctx);
    } catch (err) {
      console.error(
        `[create-defaults] provider for '${ctx.kind}' failed:`,
        (err as Error).message,
      );
      continue;
    }
    if (!out) continue;
    for (const [k, v] of Object.entries(out)) {
      if (v === undefined || v === null) continue; // empty contributes nothing
      if (merged[k] === undefined) merged[k] = v; // first provider to set a key wins
    }
  }
  return merged;
}

// Module registry — process-wide Map<name, RegisteredModule>
// populated by the loader at boot.
//
// rootPath is stored alongside the manifest so the enablement code
// can resolve the module's migrations directory (and any other
// relative paths) when running migrations against a tenant DB. The
// manifest's `schema.migrationsDir` is relative to rootPath.

import type { ModuleManifest } from "@cobblr/platform-contract";

export interface RegisteredModule {
  manifest: ModuleManifest;
  rootPath: string;
}

const registry = new Map<string, RegisteredModule>();
const aliases = new Map<string, string>();

export function register(entry: RegisteredModule): void {
  const name = entry.manifest.name;
  const names = [name, ...(entry.manifest.aliases ?? [])];
  if (new Set(names).size !== names.length) throw new Error(`Module name conflict: duplicate alias for ${name}`);
  for (const id of names) {
    if (registry.has(id) || aliases.has(id)) {
      throw new Error(`Module name conflict: ${id} already registered`);
    }
  }
  registry.set(name, entry);
  for (const alias of entry.manifest.aliases ?? []) aliases.set(alias, name);
}

export function canonicalModuleName(name: string): string {
  return aliases.get(name) ?? name;
}

export function getEntry(name: string): RegisteredModule | undefined {
  return registry.get(canonicalModuleName(name));
}

export function get(name: string): ModuleManifest | undefined {
  return getEntry(name)?.manifest;
}

export function list(): ModuleManifest[] {
  return Array.from(registry.values()).map((e) => e.manifest);
}

export function listEntries(): RegisteredModule[] {
  return Array.from(registry.values());
}

export function size(): number {
  return registry.size;
}

/** Remove a module from the in-memory registry. Used by the
 *  runtime sandbox-uninstall path. The Express router that was
 *  mounted at boot stays mounted for the process lifetime — but
 *  subsequent requests find no live registration + the route
 *  handler short-circuits via the sandbox loader's stale-entry
 *  check. A full unmount needs an api restart. */
export function deregister(name: string): boolean {
  const canonical = canonicalModuleName(name);
  for (const [alias, owner] of aliases) if (owner === canonical) aliases.delete(alias);
  return registry.delete(canonical);
}

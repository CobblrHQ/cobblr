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

export function register(entry: RegisteredModule): void {
  const name = entry.manifest.name;
  if (registry.has(name)) {
    throw new Error(`Module name conflict: ${name} already registered`);
  }
  registry.set(name, entry);
}

export function getEntry(name: string): RegisteredModule | undefined {
  return registry.get(name);
}

export function get(name: string): ModuleManifest | undefined {
  return registry.get(name)?.manifest;
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
  return registry.delete(name);
}

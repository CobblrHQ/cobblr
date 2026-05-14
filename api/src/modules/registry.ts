// Module registry — a process-wide Map<name, ModuleManifest>
// populated by the loader at boot. The platform reads from here to
// answer "which modules exist?" and route requests; modules
// themselves never touch it directly.

import type { ModuleManifest } from "@cobblr/platform-contract";

const registry = new Map<string, ModuleManifest>();

export function register(manifest: ModuleManifest): void {
  if (registry.has(manifest.name)) {
    throw new Error(`Module name conflict: ${manifest.name} already registered`);
  }
  registry.set(manifest.name, manifest);
}

export function list(): ModuleManifest[] {
  return Array.from(registry.values());
}

export function get(name: string): ModuleManifest | undefined {
  return registry.get(name);
}

export function size(): number {
  return registry.size;
}

// Tiny standalone registry of per-sandboxed-module facts (table prefix +
// the cross-module tables it may SELECT) that the per-module Postgres
// role setup needs.
//
// Deliberately SEPARATE from loader.ts: loader pulls in the whole wasm
// runtime (worker pool, express, undici) AND uses `import.meta.url`.
// Importing loader.ts from enable.ts / delete-org.ts dragged all of that
// into the import graph of unrelated tests, and vitest's SSR transform
// then choked on an `import.meta` in that graph ("Cannot split a chunk
// that has already been edited"). Keeping this module dependency-free
// (no heavy imports, no import.meta) lets the enable/delete paths read
// sandboxed-module facts without that blast radius.

export interface SandboxedModuleInfo {
  /** Table prefix the module owns, e.g. "url_archive_". */
  prefix: string;
  /** Fully-qualified cross-module tables the manifest grants SELECT on. */
  readsTables: string[];
}

const infoByName = new Map<string, SandboxedModuleInfo>();

/** Called by the loader as each sandboxed module registers. */
export function setSandboxedModuleInfo(name: string, info: SandboxedModuleInfo): void {
  infoByName.set(name, info);
}

/** Called by the loader when a sandboxed module is uninstalled. */
export function deleteSandboxedModuleInfo(name: string): void {
  infoByName.delete(name);
}

/** Null when `name` isn't a sandboxed module (→ no per-module role;
 *  in-process modules run unconstrained by design). */
export function getSandboxedModuleInfo(name: string): SandboxedModuleInfo | null {
  return infoByName.get(name) ?? null;
}

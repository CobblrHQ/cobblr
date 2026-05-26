// Marketplace v2: sync the installed_modules registry from the
// currently-loaded modules. Runs once at boot, AFTER the module
// loader has populated the in-memory registry. Idempotent — upserts
// by name, updates version + manifest + source.
//
// Provenance (source_url / source_sha256 / signed_by) comes from the
// image-build's installed-modules.manifest.json — written by
// scripts/install-registry-modules.mjs at docker build time. The
// runtime module loader doesn't have those fields; only the build
// pipeline that fetched + verified the tarball does. We merge the
// two views here so super-admin's audit page can show "module X is
// version Y, signed by Z, sha256 W".
//
// See docs/design-decisions/marketplace.md §4 + §6.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { RUNTIME_INSTALL_DIR } from "../sandbox/loader.js";
import { sql } from "kysely";

// RUNTIME_INSTALL_DIR is owned by sandbox/loader (it's the same path
// the sandbox loader scans for installed modules + the volume bind
// in docker-compose). Re-deriving the literal here drifted once
// already (was "/var/cobblr/modules", actual is "…/sandboxed-modules")
// and quietly mis-classified every registry install as "manual".

type BuildManifestEntry = {
  name: string;
  version: string;
  band: string;
  source: "vendored" | "registry";
  source_url: string | null;
  source_sha256: string | null;
  signed_by: string | null;
};

function loadBuildManifest(): Map<string, BuildManifestEntry> {
  // Manifest is written to /app/installed-modules.manifest.json by
  // the image-build pipeline. In dev/test (no docker build), it
  // doesn't exist — that's fine, we fall back to runtime-only data.
  const candidates = [
    "/app/installed-modules.manifest.json",
    resolve(process.cwd(), "..", "installed-modules.manifest.json"),
    resolve(process.cwd(), "installed-modules.manifest.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as {
          modules: BuildManifestEntry[];
        };
        return new Map(raw.modules.map((m) => [m.name, m]));
      } catch {
        // Bad JSON — log + fall through. Better to boot without
        // provenance than to crash the api.
        console.warn(`[installed-modules] could not parse ${path}, ignoring`);
      }
    }
  }
  return new Map();
}

function deriveSource(rootPath: string): "image" | "registry" | "manual" {
  if (rootPath.startsWith(RUNTIME_INSTALL_DIR)) return "registry";
  if (rootPath.includes("/app/modules/") || rootPath.includes("/modules/")) return "image";
  return "manual";
}

export async function syncInstalledModules(): Promise<number> {
  const entries = listEntries();
  const buildManifest = loadBuildManifest();
  let upserted = 0;
  for (const entry of entries) {
    const buildEntry = buildManifest.get(entry.manifest.name);
    // Build manifest takes precedence for marketplace modules — it
    // knows the verified sha + signature. Fall back to runtime path
    // for foundational/stock modules (not in the build manifest).
    const source = buildEntry
      ? buildEntry.source === "registry"
        ? "registry"
        : "image"
      : deriveSource(entry.rootPath);
    await meta
      .insertInto("installed_modules")
      .values({
        name: entry.manifest.name,
        version: entry.manifest.version,
        band: entry.manifest.band ?? "user",
        source,
        source_url: buildEntry?.source_url ?? null,
        source_sha256: buildEntry?.source_sha256 ?? null,
        signed_by: buildEntry?.signed_by ?? null,
        manifest: sql`${JSON.stringify(entry.manifest)}::jsonb` as never,
        installed_by: null,
      })
      .onConflict((c) =>
        c.column("name").doUpdateSet({
          version: entry.manifest.version,
          band: entry.manifest.band ?? "user",
          source,
          source_url: buildEntry?.source_url ?? null,
          source_sha256: buildEntry?.source_sha256 ?? null,
          signed_by: buildEntry?.signed_by ?? null,
          manifest: sql`${JSON.stringify(entry.manifest)}::jsonb` as never,
        }),
      )
      .execute();
    upserted++;
  }
  return upserted;
}

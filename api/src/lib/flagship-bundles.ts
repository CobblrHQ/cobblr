// Flagship bundle catalog — server-side.
//
// The flagship bundle manifests (bundles/*.json at the repo root, the same ones
// that publish to the registry) are BAKED into the api image (docker/api.Dockerfile
// copies `bundles/`). We read them locally so capture-first onboarding works
// offline + for every self-hoster, independent of the private GitHub registry —
// and so the field SHAPES the matchmaker extracts into are exactly the shapes a
// later install registers. `getFlagshipManifest` falls back to the published
// registry if a manifest isn't on disk (belt-and-suspenders for odd packagings).
//
// Used by: the capture-first quickstart menu (routes a capture against bundles
// the workspace could BECOME) and materialize (installs the chosen bundle).

import fs from "node:fs";
import path from "node:path";
import { getOfficialBundleManifest } from "../routes/registry.js";

/** One extraction-target field, mirroring core-scan's MenuField shape. */
export interface BundleMenuField {
  name: string;
  label: string;
  type: string;
  help?: string;
  choices?: string[];
}

/** A not-yet-installed bundle as a routable scan-menu destination. Shape is a
 *  superset-compatible with core-scan's ScanMenuEntry (which carries
 *  bundle_external_id), so the matchmaker routes to it unchanged. */
export interface BundleMenuEntry {
  module: string;
  /** Synthetic routing token (default-skinning bundles) or the real instance
   *  name (provides_instances bundles). Unique per entry so the matchmaker's
   *  module::instance key never collides across bundles. */
  instance: string;
  kind: string;
  noun: string;
  label: string;
  fields: BundleMenuField[];
  scan_keywords?: string[];
  bundle_external_id: string;
}

/** The real entity target a bundle's items commit to once installed — distinct
 *  from the synthetic routing `instance` above. Default-skinning bundles commit
 *  to the module's default table (instance null); provides_instances bundles
 *  commit to the named instance. */
export interface BundleTarget {
  bundle_external_id: string;
  module: string;
  /** The module's BASE kind for the create endpoint + qty-field mapping
   *  (inventory:part / assets:asset / machines:machine). */
  base_kind: string;
  /** Real instance name, or null when the bundle skins the module default. */
  instance: string | null;
  /** The entity_kind the menu used (named-instance kind or the base kind). */
  menu_kind: string;
  label: string;
  noun: string;
}

interface RawManifest {
  id?: string;
  name?: string;
  field_defs?: Array<Record<string, unknown>>;
  provides_instances?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

// The module + the create-target kind are derived ENTIRELY from each manifest's
// own entity_kind (e.g. "inventory:part") — the kernel never hardcodes a module
// name (module-isolation rule C). A bundle is "capturable" simply by shipping
// field defs on a kind; core-scan's confirm decides what it can actually create,
// and materialize skips anything it can't (graceful, see runMatchmaker callers).
function moduleOf(entityKind: string): string {
  return entityKind.split(":")[0] ?? "";
}

function bundlesDir(): string | null {
  const candidates = [
    path.join(process.cwd(), "bundles"), // repo root (tsx / vitest)
    path.join(process.cwd(), "..", "bundles"), // /app/api → /app/bundles (prod runtime)
    "/app/bundles",
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

let cache: { manifests: RawManifest[]; byId: Map<string, RawManifest> } | null = null;

function load(): { manifests: RawManifest[]; byId: Map<string, RawManifest> } {
  if (cache) return cache;
  const dir = bundlesDir();
  const manifests: RawManifest[] = [];
  if (dir) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
        // bundles/*.json wrap the manifest in { manifest, confirm } — accept both.
        const m = (raw.manifest ?? raw) as RawManifest;
        if (typeof m?.id === "string" && m.id.includes(".flagship.")) manifests.push(m);
      } catch {
        /* a malformed manifest shouldn't sink the whole catalog */
      }
    }
  }
  cache = { manifests, byId: new Map(manifests.map((m) => [m.id as string, m])) };
  return cache;
}

function mapFields(defs: Array<Record<string, unknown>> | undefined): BundleMenuField[] {
  if (!Array.isArray(defs)) return [];
  return defs
    .filter((d) => d.type !== "computed")
    .map((d) => ({
      name: String(d.name),
      label: String(d.display_label ?? d.name),
      type: String(d.type ?? "text"),
      ...(d.help ? { help: String(d.help) } : {}),
      ...(Array.isArray(d.choices) && d.choices.length ? { choices: (d.choices as unknown[]).map(String) } : {}),
    }));
}

function shortSlug(id: string): string {
  return id.replace(/^cobblr\.flagship\./, "").replace(/[^a-z0-9-]/gi, "-");
}

export function listFlagshipManifests(): RawManifest[] {
  return load().manifests;
}

/** Resolve a flagship manifest by id — local first, registry fallback. */
export async function getFlagshipManifest(id: string): Promise<unknown | null> {
  const local = load().byId.get(id);
  if (local) return local;
  return getOfficialBundleManifest(id);
}

/** The capture-first menu: every trackable flagship kind as a routable
 *  destination tagged with the bundle that would hold it. */
export function flagshipBundleMenu(): BundleMenuEntry[] {
  const out: BundleMenuEntry[] = [];
  for (const m of listFlagshipManifests()) {
    const id = m.id as string;
    const pis = Array.isArray(m.provides_instances) ? m.provides_instances : [];
    if (pis.length) {
      for (const pi of pis) {
        const moduleName = String(pi.module ?? "");
        const instName = String(pi.instance_name ?? "");
        if (!moduleName || !instName) continue;
        out.push({
          module: moduleName,
          instance: instName,
          kind: `${instName}:item`,
          noun: String(pi.item_noun || pi.display_name || instName).toLowerCase(),
          label: String(pi.display_name || m.name || instName),
          fields: mapFields(pi.field_defs as Array<Record<string, unknown>> | undefined),
          ...(Array.isArray(pi.scan_keywords) && pi.scan_keywords.length
            ? { scan_keywords: (pi.scan_keywords as unknown[]).map(String) }
            : {}),
          bundle_external_id: id,
        });
      }
      continue;
    }
    const fds = Array.isArray(m.field_defs) ? m.field_defs : [];
    if (!fds.length) continue;
    const byKind = new Map<string, Array<Record<string, unknown>>>();
    for (const fd of fds) {
      const k = String(fd.entity_kind ?? "");
      if (!k) continue;
      (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(fd);
    }
    for (const [kind, defs] of byKind) {
      const moduleName = moduleOf(kind);
      if (!moduleName) continue;
      out.push({
        module: moduleName,
        instance: shortSlug(id), // synthetic routing token (unique per bundle)
        kind,
        noun: String(m.name ?? moduleName).toLowerCase(),
        label: String(m.name ?? kind),
        fields: mapFields(defs),
        bundle_external_id: id,
      });
    }
  }
  return out;
}

/** The real commit target(s) for a bundle once installed — used by materialize
 *  to route captured items onto the now-real table. */
export function flagshipBundleTargets(id: string): BundleTarget[] {
  const m = load().byId.get(id);
  if (!m) return [];
  const out: BundleTarget[] = [];
  const pis = Array.isArray(m.provides_instances) ? m.provides_instances : [];
  if (pis.length) {
    for (const pi of pis) {
      const moduleName = String(pi.module ?? "");
      const instName = String(pi.instance_name ?? "");
      if (!moduleName) continue;
      // The base create-kind is the kind the instance's field defs live on
      // (e.g. "inventory:part") — read from the manifest, not hardcoded.
      const piFields = Array.isArray(pi.field_defs) ? pi.field_defs : [];
      const baseKind = String((piFields[0] as Record<string, unknown> | undefined)?.entity_kind ?? "") || `${moduleName}:item`;
      out.push({
        bundle_external_id: id,
        module: moduleName,
        base_kind: baseKind,
        instance: instName || null,
        menu_kind: `${instName}:item`,
        label: String(pi.display_name || m.name || instName),
        noun: String(pi.item_noun || instName).toLowerCase(),
      });
    }
    return out;
  }
  const fds = Array.isArray(m.field_defs) ? m.field_defs : [];
  const kinds = new Set(fds.map((fd) => String(fd.entity_kind ?? "")).filter(Boolean));
  for (const kind of kinds) {
    const moduleName = moduleOf(kind);
    if (!moduleName) continue;
    out.push({
      bundle_external_id: id,
      module: moduleName,
      base_kind: kind, // a default-skinning bundle's entity_kind IS the base kind
      instance: null,
      menu_kind: kind,
      label: String(m.name ?? kind),
      noun: String(m.name ?? moduleName).toLowerCase(),
    });
  }
  return out;
}

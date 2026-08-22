// What installing a bundle actually did, in terms a person can check.
//
// A bundle lands in one of two shapes, and only one of them is visible on its
// own. A bundle that PROVIDES an instance creates its own table, so it gets a
// nav entry and you can see it. A bundle that SKINS a module's default table
// creates no table and no nav entry at all: it adds fields to something you
// already have and wires up some automations. A complete, correct install of
// the second kind leaves the screen looking exactly as it did before.
//
// That happened, and the only way to answer "did it even install?" was to go
// hunting through the module list and the field defs (2026-08-22). So the
// install now says what it changed, and where each part of it went.
//
// Everything here is derived from the manifest and the install's own counts.
// Nothing knows what any particular bundle is FOR.

/** The install's own report of what it wrote. */
export interface AppliedCounts {
  wires: number;
  field_defs: number;
  field_overrides: number;
  catalogs: number;
  auto_enabled_modules: string[];
}

/** A bundle manifest, in the shape this summary reads. */
export interface SummarisableManifest {
  name?: unknown;
  requires?: unknown;
  provides_instances?: unknown;
  field_defs?: unknown;
}

export interface BundleInstallSummary {
  /** The bundle's display name. */
  bundle: string;
  /**
   * `instance` - it created its own table, and has a place of its own to go.
   * `skin` - it added to a table you already had; there is no new nav entry,
   * which is the fact a person most needs told.
   */
  kind: "instance" | "skin";
  /** The instance it created, when it created one. */
  instance: string | null;
  /** The module its changes landed in, when they landed in exactly one. */
  module: string | null;
  /** Fields added to an existing kind (defs plus overrides - both are fields
   *  as far as anyone looking at an item is concerned). */
  fields: number;
  /** Automations wired up. These are invisible until they fire, so they are
   *  worth naming even though nothing on screen changes. */
  wires: number;
  catalogs: number;
  /** Modules this install had to turn on. Empty when they were all already on,
   *  which is itself worth knowing - it is why nothing appeared in the nav. */
  modules_enabled: string[];
  /** The entity kinds whose fields changed, so the caller can link to them. */
  kinds_touched: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function bundleInstallSummary(
  manifest: SummarisableManifest,
  applied: AppliedCounts,
): BundleInstallSummary {
  const instances = Array.isArray(manifest.provides_instances) ? manifest.provides_instances : [];
  const first = instances[0] as Record<string, unknown> | undefined;
  const instance = first ? str(first.instance_name) : null;

  const fieldDefs = Array.isArray(manifest.field_defs) ? manifest.field_defs : [];
  const kinds = [
    ...new Set(
      fieldDefs
        .map((f) => str((f as Record<string, unknown>).entity_kind))
        .filter((k): k is string => !!k),
    ),
  ];

  const requires = Array.isArray(manifest.requires) ? manifest.requires : [];
  const requiredModules = [
    ...new Set(
      requires.map((r) => str((r as Record<string, unknown>).module)).filter((m): m is string => !!m),
    ),
  ];
  // The module to point at is the one its fields landed in. Only when that is
  // unambiguous - a bundle touching several modules has no single home, and
  // saying one of them would be a guess.
  const fromKinds = [...new Set(kinds.map((k) => k.split(":")[0]!).filter(Boolean))];
  const module =
    fromKinds.length === 1
      ? fromKinds[0]!
      : instance
        ? (str(first?.module) ?? null)
        : requiredModules.length === 1
          ? requiredModules[0]!
          : null;

  return {
    bundle: str(manifest.name) ?? "The bundle",
    kind: instance ? "instance" : "skin",
    instance,
    module,
    fields: applied.field_defs + applied.field_overrides,
    wires: applied.wires,
    catalogs: applied.catalogs,
    modules_enabled: applied.auto_enabled_modules,
    kinds_touched: kinds,
  };
}

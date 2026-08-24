// Did the install actually do what the manifest said?
//
// The install summary is built from the MANIFEST - "this bundle provides an
// instance called tea" - so it reports what was ASKED FOR, and nothing compares
// that against what exists afterwards.
//
// Most of the install is transactional and a real failure raises. But the
// tenant-side work is best-effort by design: `install_status: "partial"` exists
// precisely because an install can half-succeed, and today a partial one still
// answers 201 with a summary that reads exactly like a whole one. A workspace
// can therefore hold a bundle listed as installed with no table to file into,
// and nothing says so.
//
// A silent no-op is worse than a failure. A failure gets retried; a no-op gets
// believed, and the time after goes on why routing finds no tables when the
// answer is that the table was never made.
//
// So the install checks its own postcondition and says so. Not a throw: a
// partial install is a recoverable state, not an error. The point is that it
// stops being invisible.

/** What a manifest promised it would set up. */
export interface PromisedInstance {
  module: string;
  instance_name: string;
}

export interface PostconditionReport {
  /** Instances the manifest declared that do NOT exist afterwards. */
  missing: PromisedInstance[];
  /** True when everything promised is there. */
  ok: boolean;
  /** One line for a log or an api response. Empty when ok. */
  message: string;
}

/**
 * Compare what was promised against what is actually there.
 *
 * `present` is the set of instance names that exist in the workspace AFTER the
 * install, read back rather than inferred - reading it from the same manifest
 * that made the promise would prove nothing.
 */
export function checkInstalled(
  promised: readonly PromisedInstance[],
  present: ReadonlySet<string>,
): PostconditionReport {
  // `promised` is a MANIFEST's declared instances, not the entity-kind registry.
  // Nothing is sliced out of a user's list of kinds here: this compares two
  // lists to find what a bundle failed to create.
  // registry-filter-ok: comparing manifest promises against reality
  const missing = promised.filter((p) => p.instance_name && !present.has(p.instance_name));
  if (missing.length === 0) return { missing: [], ok: true, message: "" };
  const names = missing.map((m) => m.instance_name).join(", ");
  return {
    missing,
    ok: false,
    message:
      `install reported success but ${missing.length === 1 ? "this table was" : "these tables were"} ` +
      `not created: ${names}. The bundle is installed; its table is not, so nothing can be filed into it.`,
  };
}

/** The instances a manifest promises, including those its enabled features add. */
export function promisedInstances(manifest: {
  provides_instances?: Array<{ module?: string; instance_name?: string }>;
  features?: Array<{ key?: string; provides_instances?: Array<{ module?: string; instance_name?: string }> }>;
}, enabledFeatureKeys: readonly string[] = []): PromisedInstance[] {
  const on = new Set(enabledFeatureKeys);
  const all = [
    ...(manifest.provides_instances ?? []),
    // A feature that is OFF promises nothing, so its absence is not a failure.
    ...(manifest.features ?? []).filter((f) => f.key && on.has(f.key)).flatMap((f) => f.provides_instances ?? []),
  ];
  const seen = new Set<string>();
  const out: PromisedInstance[] = [];
  for (const i of all) {
    const name = i.instance_name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ module: i.module ?? "", instance_name: name });
  }
  return out;
}

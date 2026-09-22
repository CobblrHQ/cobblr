// Whether the module api bundles have been mounted yet.
//
// Several registries are filled by each module's api bundle as it loads:
// entity writers, the scannable kinds, action handlers. Those bundles are
// imported by mountModules, part way through boot. Before that, the
// registries are not EMPTY, they are UNKNOWN, and answering "nothing" is a
// lie that looks exactly like a workspace with nothing in it.
//
// It has cost twice. The scan category axis sat inert in production because
// its boot pass read the scannable registry before the mount (#1049), and the
// #3223 retire would have done nothing at boot on every workspace for the same
// reason had it been written into the pass that runs before the mount. Both
// passes caught nothing, logged nothing, and moved on.
//
// So a registry filled by mounting REFUSES to answer before the mount has
// finished, with an error that names the fix. A boot pass that asks too early
// fails loud, on every workspace it touches, instead of quietly doing nothing;
// the ordering stops being something a pass's author has to know about.

let mounted = false;

export class ModulesNotMountedError extends Error {
  constructor(what: string) {
    super(
      `${what} asked for before the module api bundles were mounted. They are registered by each module's ` +
        `api bundle, which mountModules imports part way through boot, so an answer now would be "nothing" for ` +
        `every workspace. Run this after mountModules; api/src/modules/mount-state.ts says why.`,
    );
    this.name = "ModulesNotMountedError";
  }
}

export function markModulesMounted(): void {
  mounted = true;
}

export function modulesMounted(): boolean {
  return mounted;
}

/** Throw unless mountModules has finished. Called by every lookup whose
 *  registry the module api bundles fill. */
export function assertModulesMounted(what: string): void {
  if (!mounted) throw new ModulesNotMountedError(what);
}

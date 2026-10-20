// When may a one-shot heal be deleted? Only once a STABLE release has shipped with it in (#7679).
//
// THE BUG THIS PREVENTS. A heal's DONE WHEN is read off our own deployments
// (heal-shim-status: "clean on all six"). Those run the nightly, so they ran every
// heal the day it merged. An install that stays on a stable release and jumps to the
// next one never saw the heal, and its rows stayed wrong: eight heals were added after
// 2026.8.1 and deleted before 2026.10.0, among them the one for orders listing every
// receipt line twice and the one that scrubbed order-email sign-in links from the
// archive. The soak is evidence that OUR rows are healed; it says nothing about the
// installs that skip the builds in between.
//
// THE RULE. A file whose header states `DONE WHEN:` may be deleted only if it was in
// the tree of the latest stable tag (scripts/heals-in-stable.json lists those paths):
// every stable install already ran it. A heal added since waits for the next stable.
//
// Pure, so a test shows it failing on the case that shipped: no git, no disk.

/** Does this source carry a heal's retirement condition in its header? */
export function isHealSource(src) {
  return src.split("\n").slice(0, 60).some((l) => /^\/\/\s*DONE WHEN:/.test(l));
}

/** A path a heal may live at: kernel or module source, never a test. */
export function isHealPath(path) {
  return /^(api\/src|modules\/[^/]+\/src)\/.+\.ts$/.test(path) && !/\.test\.tsx?$/.test(path);
}

/**
 * @param deleted  files this change deletes: [{ path, oldSource }]
 * @param stable   paths of the heals the latest stable release shipped with
 * @returns one message per heal deleted before a stable release carried it
 */
export function healsRetiredTooEarly(deleted, stable) {
  const shipped = new Set(stable);
  return deleted
    .filter((d) => isHealPath(d.path) && isHealSource(d.oldSource) && !shipped.has(d.path))
    .map(
      (d) =>
        `${d.path}: a heal deleted before any stable release carried it. An install that goes from the last stable release to the next never runs it, so its rows stay wrong (#7679). Keep the file until the next stable release has shipped with it in (then scripts/heals-in-stable.json lists it); "clean on all six" is only our own deployments`,
    );
}

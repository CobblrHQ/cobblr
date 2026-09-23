// The ordinal a migration's filename leads with, for lint-migration-ordinals
// and for merge-pr.sh's check at merge time (ordinal-at-merge.mjs):
// `YYYYMMDD-NNN` for the platform and tenant-base sets, `NNNN` for a module's
// `NNNN_name.sql`. One reader for both shapes, so the lint cannot again say
// "no new duplicate ordinals" over a module directory it never read (#2910).
// Plain JS so the shell side can run it without tsx.

/** @param {string} filename @returns {string | null} */
export function ordinalOf(filename) {
  const platform = /^(\d{8}-\d+)/.exec(filename);
  if (platform) return platform[1];
  const module = /^(\d{4})_/.exec(filename);
  return module ? module[1] : null;
}

/** Is this repo path a directory of ordered migrations? The same set the lint
 *  walks: the platform and tenant-base sets, and every module's migrations/.
 *  @param {string} dir */
export function isMigrationDir(dir) {
  return /^api\/migrations\/(platform|tenant-base)$/.test(dir) || /^modules\/[^/]+\/migrations$/.test(dir);
}

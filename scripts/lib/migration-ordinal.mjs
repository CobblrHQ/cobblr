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

/** The next free ordinal after `highest`, in its own shape: a module's `NNNN` + 1, or a platform set's
 *  `YYYYMMDD-NNN` with today's date (never earlier than highest's) and NNN + 1.
 *  @param {string} highest @param {Date} [today] @returns {string} */
export function nextOrdinal(highest, today = new Date()) {
  const platform = /^(\d{8})-(\d+)$/.exec(highest);
  if (platform) {
    const day = today.toISOString().slice(0, 10).replaceAll("-", "");
    return `${day > platform[1] ? day : platform[1]}-${String(Number(platform[2]) + 1).padStart(platform[2].length, "0")}`;
  }
  return String(Number(highest) + 1).padStart(highest.length, "0");
}

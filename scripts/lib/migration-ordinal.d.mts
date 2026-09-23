// Types for migration-ordinal.mjs. The implementation stays plain ESM so
// merge-pr.sh can run it with node; these let the lint and tests import it
// under `strict`.

/** The ordinal a migration's filename leads with, or null for neither shape. */
export declare function ordinalOf(filename: string): string | null;

/** Is this repo path a directory of ordered migrations? */
export declare function isMigrationDir(dir: string): boolean;

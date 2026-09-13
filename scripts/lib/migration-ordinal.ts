// The ordinal a migration's filename leads with, for lint-migration-ordinals:
// `YYYYMMDD-NNN` for the platform and tenant-base sets, `NNNN` for a module's
// `NNNN_name.sql`. One reader for both shapes, so the lint cannot again say
// "no new duplicate ordinals" over a module directory it never read (#2910).
export function ordinalOf(filename: string): string | null {
  const platform = /^(\d{8}-\d+)/.exec(filename);
  if (platform) return platform[1]!;
  const module = /^(\d{4})_/.exec(filename);
  return module ? module[1]! : null;
}

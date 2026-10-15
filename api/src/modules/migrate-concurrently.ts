// Turning several modules on at once without waiting for each one's migrations
// in turn (#6689). Pure: the caller hands in how one module migrates.

/** How many modules migrate at once into one workspace's database:
 *  below the tenant pool's five connections, so a request still gets one. */
export const MIGRATION_CONCURRENCY = 4;

/** The slow half of turning modules on, at once (#6689): each module's
 *  migrations into the workspace's database, a few at a time, in waves by
 *  dependency. Each module migrates under its own advisory lock and ledger
 *  rows, so two modules never contend; the sequential enable that follows
 *  finds nothing left to apply and does the meta-side steps in order, as
 *  before. A failure here is left to that enable, which reports it. Returns
 *  the waves, for the test that holds the order. */
export async function migrateConcurrently(
  entries: ReadonlyArray<{ rootPath: string; manifest: { name: string; dependencies: string[]; schema?: { migrationsDir: string } | null } }>,
  run: (entry: (typeof entries)[number]) => Promise<unknown>,
  concurrency = MIGRATION_CONCURRENCY,
): Promise<string[][]> {
  const pending = entries.filter((e) => e.manifest.schema);
  const names = new Set(pending.map((e) => e.manifest.name));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (pending.length) {
    const ready = pending.filter((e) => e.manifest.dependencies.every((d) => done.has(d) || !names.has(d)));
    // A cycle: leave the rest to the sequential enable, which says so.
    if (!ready.length) break;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ready.length) }, async () => {
        while (next < ready.length) {
          const entry = ready[next++]!;
          try {
            await run(entry);
          } catch {
            // Reported by enableModuleForOrg, which runs it again in order.
          }
        }
      }),
    );
    waves.push(ready.map((e) => e.manifest.name));
    for (const e of ready) {
      done.add(e.manifest.name);
      pending.splice(pending.indexOf(e), 1);
    }
  }
  return waves;
}

// Which contributed record panels have something to show on one record
// (#6337). A panel that declares `presence: true` registers a check here
// through platform().panels.registerPresence: a kiln's firing logs show on a
// machine with a kiln profile, wherever that machine is filed, and on no
// other machine. The checks are cheap reads; one failing says "not present"
// for its own panel and is logged, never the whole page.

type Check = (ctx: { orgId: string; kind: string; id: string; collection: string | null }) => Promise<boolean>;

const checks = new Map<string, Check>();

export function registerPanelPresence(panelId: string, check: Check): void {
  checks.set(panelId, check);
}

/** The ids of the registered panels that have something to show on this record. */
export async function presentPanels(orgId: string, kind: string, id: string, collection: string | null = null): Promise<string[]> {
  const entries = [...checks.entries()];
  const answers = await Promise.all(
    entries.map(([panelId, check]) =>
      check({ orgId, kind, id, collection }).catch((err: unknown) => {
        console.error(`[panel-presence] ${panelId} could not answer for ${kind}/${id}:`, (err as Error).message);
        return false;
      }),
    ),
  );
  return entries.filter((_, n) => answers[n]).map(([panelId]) => panelId);
}

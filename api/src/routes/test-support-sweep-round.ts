import type { TenantSweepRunResult } from "@cobblr/platform-contract";

interface Runs {
  all: (opts: { orgIds: string[] }) => Promise<Record<string, TenantSweepRunResult>>;
}

export async function testSweepRound(runs: Runs, orgId: string) {
  const passes = await runs.all({ orgIds: [orgId] });
  // The runner has already waited for held locks within its shared deadline.
  // Starting per-pass waits here can outlive the test that asked for setup.
  const failed = Object.entries(passes).filter(([, r]) => r.failed > 0 || r.skipped).map(([name, r]) => ({ name, skipped: r.skipped, failures: r.failures }));
  return { passes: Object.keys(passes).length, failed };
}

// How each test's workspace was provisioned, for the CI measurement ledger (#7183): taken from the pre-baked pool,
// or signed up for real and why (the pool off, exhausted, or not answering), and what it cost. One JSON line per
// workspace to COBBLR_FIXTURE_LOG when it is set (the test job sets it; scripts/ci/ledger-tests.mjs keeps the
// summary); nothing otherwise. A pool that ran dry looked, in the suite's time, like every test getting slower.
import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { expect } from "vitest";

export type ProvisionedBy = "pool" | "pool off" | "pool exhausted" | `pool HTTP ${number}` | "pool unreachable";

export function noteProvisioning(by: ProvisionedBy, ms: number): void {
  const out = process.env.COBBLR_FIXTURE_LOG;
  if (!out) return;
  let file = "";
  try {
    file = relative(process.cwd(), expect.getState().testPath ?? "");
  } catch {
    file = "";
  }
  try {
    appendFileSync(out, `${JSON.stringify({ file, by, ms: Math.round(ms) })}\n`);
  } catch {
    /* a log that cannot be written never fails a test */
  }
}

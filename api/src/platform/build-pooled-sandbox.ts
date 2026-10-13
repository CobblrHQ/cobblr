// No imports on purpose: the order of the steps is what the test holds, with no database or env behind it.

/** The three steps of making a pooled sandbox, in the one order that is safe: provisioned, stocked, and
 *  only THEN claimable. A visitor arriving between provisioning and the end of the seed used to be
 *  handed the workspace while it was still being stocked, and the stock that landed after the
 *  hand-over row counted as the visitor's own work (#6156). */
export interface BuildOps<W> {
  provision: () => Promise<W>;
  seed: (ws: W) => Promise<void>;
  makeClaimable: (ws: W) => Promise<void>;
}
export async function buildPooledSandbox<W>(ops: BuildOps<W>): Promise<W> {
  const ws = await ops.provision();
  try {
    await ops.seed(ws);
  } catch (err) {
    // A sandbox with nothing in it is still usable, and refusing to pool it
    // would mean an empty pool every time the catalogue is having a bad day.
    console.error("[try-pool] seed failed, pooling it empty:", (err as Error).message);
  }
  await ops.makeClaimable(ws);
  return ws;
}

// The bench's page: the readings already kept, and the live instrument when
// its bridge answers. The kept readings are read alongside the bridge and
// never wait past bridgeAnswer's limit for it (#8653).
import { BRIDGE_SILENT, BRIDGE_WAIT_MS, bridgeAnswer } from "./bridge-wait.js";

export const BENCH_BRIDGE_SILENT = `${BRIDGE_SILENT} Saved readings are below; try again in a moment.`;

export async function readBenchPage<I, S>(reads: { live: () => Promise<I | null>; saved: () => Promise<S> }, waitMs = BRIDGE_WAIT_MS): Promise<{ saved: S; instrument: I | null; connection_error: string | null }> {
  const live = bridgeAnswer(reads.live(), waitMs).then(
    (instrument) => ({ instrument, connection_error: null }),
    (error: unknown) => ({ instrument: null, connection_error: error instanceof Error ? (error.message === BRIDGE_SILENT ? BENCH_BRIDGE_SILENT : error.message) : "The bridge is unavailable." }),
  );
  const [saved, answer] = await Promise.all([reads.saved(), live]);
  return { saved, ...answer };
}

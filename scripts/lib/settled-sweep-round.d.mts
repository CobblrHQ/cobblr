// Types for settled-sweep-round.mjs, so a test under `strict` can import it.
export interface SweepRoundBody {
  passes: number;
  failed: Array<{ name: string; skipped: boolean; failures: unknown[] }>;
}
export interface RoundAnswer {
  status: number;
  body: SweepRoundBody;
}
export declare function onlyBusy(body: SweepRoundBody): boolean;
export declare function settledSweepRound(
  ask: () => Promise<RoundAnswer>,
  opts: { deadlineMs: number; gapMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<SweepRoundBody>;

import { runExclusive } from "./exclusive.js";

/** Every caller chooses: wait a holder out (a change someone is waiting on),
 *  or skip and say why that is safe (a pass that comes round again). A mirror
 *  apply that skipped by default refused an owner's change whenever the
 *  friend's edits pass held the copy, and the owner was told it had not
 *  arrived (CI run 41902). */
export type CopyStateWait = { waitMs: number } | { skipIfBusy: string };

/** A mirror write and its base are one state: the edit sender must never
 *  compare the new copy with the old base, or overwrite a base the mirror
 *  just recorded. The same lock covers both sides across API processes.
 *  Null when it did not run: still held after waitMs, or held at once
 *  under skipIfBusy. */
export async function withShareCopyState<T>(linkId: string, work: () => Promise<T>, how: CopyStateWait): Promise<T | null> {
  const until = Date.now() + ("waitMs" in how ? how.waitMs : 0);
  for (;;) {
    let result: T | null = null;
    const run = await runExclusive(`share.copy-state.${linkId}`, async () => {
      result = await work();
    });
    if (run.ran) return result;
    if (Date.now() >= until) return null;
    await new Promise((res) => setTimeout(res, 100));
  }
}

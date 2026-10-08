import { runExclusive } from "./exclusive.js";

/** A mirror write and its base are one state: the edit sender must never
 *  compare the new copy with the old base, or overwrite a base the mirror
 *  just recorded. The same lock covers both sides across API processes. */
export async function withShareCopyState<T>(linkId: string, work: () => Promise<T>): Promise<T | null> {
  let result: T | null = null;
  const run = await runExclusive(`share.copy-state.${linkId}`, async () => {
    result = await work();
  });
  return run.ran ? result : null;
}

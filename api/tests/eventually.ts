// Read until the answer says yes, for a test of something that happens in
// the background: no import of the api, so any test can use it.
/** Read until the answer says yes or the deadline passes, and hand back the
 *  last answer either way, so a failure shows what the page said. The gap
 *  between reads is not a guess about the machine: the deadline is. */
const POLL_GAP_MS = 250;
/** Said when a wait runs out (2026-10-18). A pooled test workspace is visited by no scheduled sweep round (#7282),
 *  so a test that waits for a sweep's work only ever reads the value from before it: #7007's cell tests waited
 *  out 248 s for the cell monitor and failed on a stale read with nothing to say why. */
export const SWEEP_HINT =
  "no scheduled sweep round visits a test's workspace (#7282): if this waits for a sweep's work, run that pass by name in the read: testSupport(\"run-sweep\", { body: { name, org_id } })";
export async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, deadlineMs: number): Promise<T> {
  const until = Date.now() + deadlineMs;
  let last = await read();
  while (!done(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    last = await read();
  }
  if (!done(last)) console.warn(`eventually: not done after ${Math.round(deadlineMs / 1000)} s. ${SWEEP_HINT}`);
  return last;
}

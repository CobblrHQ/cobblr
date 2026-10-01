// Read until the answer says yes, for a test of something that happens in
// the background: no import of the api, so any test can use it.
/** Read until the answer says yes or the deadline passes, and hand back the
 *  last answer either way, so a failure shows what the page said. The gap
 *  between reads is not a guess about the machine: the deadline is. */
const POLL_GAP_MS = 250;
export async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, deadlineMs: number): Promise<T> {
  const until = Date.now() + deadlineMs;
  let last = await read();
  while (!done(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    last = await read();
  }
  return last;
}

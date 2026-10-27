// How long a machine's page waits for its bridge before it answers without
// the live part. A bridge that has just gone quiet answers nothing until the
// server gives up on it, about a minute, and every page that read its kept
// records after the live read was blank for that long: the bench station,
// saved readings and all (#8653), and the kiln, arm and cell pages the same way.

export const BRIDGE_WAIT_MS = 5000;
export const BRIDGE_SILENT = "The bridge did not answer within five seconds.";

/** The bridge's answer, or a refusal once the wait is up. The work itself is
 *  left to finish or fail on its own; nobody is waiting for it. */
export async function bridgeAnswer<T>(work: Promise<T>, waitMs = BRIDGE_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(BRIDGE_SILENT)), waitMs); });
  try {
    return await Promise.race([work, silent]);
  } finally {
    clearTimeout(timer);
  }
}

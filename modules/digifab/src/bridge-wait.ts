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

/** What went wrong with a bridge or what it answered, in words for the person at
 *  the bench. A reading that fails its schema carries its sentence inside a zod
 *  error, whose own message is JSON; a bridge that is gone is node's "fetch failed". */
export function bridgeErrorText(error: unknown, otherwise: string): string {
  if (!(error instanceof Error)) return otherwise;
  const issues = (error as { name?: string; issues?: Array<{ message: string }> }).name === "ZodError" ? (error as unknown as { issues: Array<{ message: string }> }).issues : null;
  if (issues?.length) return [...new Set(issues.map(issue => issue.message))].join(" ");
  if (error.message === "fetch failed") return "The bridge did not answer. Check that it is running and on this network.";
  return error.message;
}

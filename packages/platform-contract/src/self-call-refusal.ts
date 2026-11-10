// What a refusal from the api's own route says, kept when a handler passes
// it on (#9413).
//
// A handler or service that calls a record's own route (a loopback
// apiFetch or selfFetch) and gets a no must not answer its own "Try again":
// a refusal the person can act on (403: their role may not change this; 404:
// it is gone; 409: it changed) is passed on with its status and its words.
// Only a server fault, or an answer with no words, is a plain "try again",
// because then trying again may help. lint:self-call-refusals holds every
// write to the api's own routes to this.

export interface SelfCallRefusal {
  status: number;
  message: string;
}

/** The refusal in an answer already read as text: its own status and words
 *  when it is one a person can act on, else `fallback` as a 502. */
export function refusalFromBody(status: number, body: string, fallback: string): SelfCallRefusal {
  let said: unknown;
  try {
    said = (JSON.parse(body) as { error?: { message?: unknown } } | null)?.error?.message;
  } catch {
    said = undefined;
  }
  if (status >= 400 && status < 500 && typeof said === "string" && said.trim()) return { status, message: said };
  return { status: 502, message: fallback };
}

/** The refusal in an answer that was not ok, read from the answer itself. */
export async function refusalOf(res: { status: number; text(): Promise<string> }, fallback: string): Promise<SelfCallRefusal> {
  return refusalFromBody(res.status, await res.text().catch(() => ""), fallback);
}

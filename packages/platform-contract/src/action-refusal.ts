// How a handler says no, in words meant for the person who pressed the button.
//
// The invoke route answers a handler that throws with a sentence rather than
// a bare 500 (#2847). But not every thrown message is a sentence: a Postgres
// error names a table, a failed internal fetch names a loopback address, a
// provider error carries a request id. Those used to be "Internal error" and
// must not reach a screen now. So a handler that REFUSES, deliberately, with
// words for a person, throws this (or returns `{ ok: false, error }`), and
// the route repeats it verbatim. Anything else thrown is a crash: it is
// logged in full with the handler named, and the person gets a generic
// sentence with a short reference they can quote.
//
// Duck-typed on `refusal === true` rather than `instanceof`, because a module
// and the api may hold different copies of this package.

export class ActionRefusal extends Error {
  readonly refusal = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ActionRefusal";
  }
}

/** True for an ActionRefusal from any copy of the contract. */
export function isActionRefusal(err: unknown): err is ActionRefusal {
  return err instanceof Error && (err as { refusal?: unknown }).refusal === true;
}

/** What a person is told about a crash: no internals, one reference to quote. */
export function crashSentence(ref: string): string {
  return `That action couldn't run. Ask an admin to check the log for ${ref}.`;
}

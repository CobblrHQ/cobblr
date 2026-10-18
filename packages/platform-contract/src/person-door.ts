// The gate in front of a person's own answer to the assistant: Confirm on an
// offered change, Cancel, Undo, running a plan's section (#7157).
//
// Each of these is what an assistant waits for, so an assistant that could
// call it would answer itself. The confirmation route checked the role only:
// a member's assistant on a change token reached it, sent a proposal with no
// offer, and its delete ran without the hold every other assistant delete
// waits on, because the route's own internal calls no longer said an
// assistant was behind them. So the answer here is decided from what signed
// the request and where it came from, never from an optional header: a
// person's own signed-in session, not made through any assistant door and
// not the api calling itself on an assistant's behalf.

import { platform } from "@cobblr/platform-contract";

interface PersonRequest {
  session?: { ai_door?: string | null } | null;
}
interface PersonResponse {
  status(code: number): { json(body: unknown): unknown };
}

export const NEEDS_A_PERSON = "Only the person can answer this, in the app. An assistant offers the change and waits for them.";

/** Is this the person themself, in their own signed-in session? */
export async function isAPersonsOwnAnswer(req: unknown): Promise<boolean> {
  if ((req as PersonRequest).session?.ai_door) return false;
  const source = await platform().auth.requestSource();
  return !!source && source.auth_method === "session" && source.via === null && !source.assistant;
}

/** Answers 403 needs_a_person and returns false unless the person is answering. */
export async function requireAPerson(req: unknown, res: PersonResponse): Promise<boolean> {
  if (await isAPersonsOwnAnswer(req)) return true;
  res.status(403).json({ error: { code: "needs_a_person", message: NEEDS_A_PERSON } });
  return false;
}

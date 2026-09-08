// Two questions about a turn that both reply guards need, in one place so they
// cannot answer them differently.
//
// The split they turn on is the whole design of those guards:
//
//   a QUESTION about a particular thing, answered with nothing read
//     -> look it up first            (groundless-answer.ts)
//   an INSTRUCTION, answered in prose after looking the actions up
//     -> run the one you found       (act-dont-describe.ts)
//
// Getting the halves the wrong way round is not a smaller mistake than missing
// them: nudging an instruction to "go and read" is how a create proposal
// became a paragraph on the path with no tool-calling (CI, 2026-09-08).

/** Is this a question, rather than something to DO? */
export function isAQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(who|what|whats|what's|which|where|when|whose|why|is|are|was|were|does|do|did|has|have|had|can|could|should|any)\b/i.test(t);
}

/** Is this reply the tool-less JSON move rather than prose? A model with no
 *  tool-calling expresses every create and action this way and the app parses
 *  it into a proposal, so handing one back re-opens a finished turn. */
export function looksLikeAMove(reply: string): boolean {
  const t = reply.trim().replace(/^```(?:json)?/i, "").trim();
  return t.startsWith("{") && /"type"\s*:/.test(t);
}

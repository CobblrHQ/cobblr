// What an action's answer means. One reading, for every door and every
// reader of a result: the invoke route, the wire engine, the assistant's
// card, the MCP server, the bench.
//
//   { ok: true, summary, ... }           it ACTED: something changed or was
//                                        produced, and `summary` says what,
//                                        in the person's words.
//   { ok: false, skipped: true, error }  it DECLINED: nothing applied to
//                                        (a shipment with no tracking
//                                        number, a receipt already
//                                        confirmed). Nothing changed. `error`
//                                        is the reason, for a person.
//   { ok: false, error }                 it REFUSED: the call could not be
//                                        served (an argument missing, a
//                                        record not found). Nothing changed.
//   throw                                it CRASHED: logged in full, the
//                                        person gets crashSentence().
//
// `ok: true` means acted. Nothing else.
//
// The line was not drawn before. Forty-one handlers answered a wire-fired
// action that found nothing to do with `{ ok: true, skipped: "why" }`, which
// a wire ignores and every other reader took as success: a person's card
// went green, the bench scored a pass, on an action that did nothing
// (#3141; eleven actions answered a call with no arguments that way, seven
// of them on an entity id that matched no record). So the door normalises
// that legacy spelling into the declined shape, and a result that does not
// say whether it ran at all is a refusal with the handler named in the log,
// never a pass.

export interface ActionActed {
  ok: true;
  /** What happened, in a sentence: "3 spools added to Filament". */
  summary?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface ActionDeclined {
  ok: false;
  skipped: true;
  /** Why nothing applied, for a person. */
  error: string;
  [k: string]: unknown;
}
export interface ActionRefused {
  ok: false;
  skipped?: false;
  error: string;
  [k: string]: unknown;
}
export type ActionResult = ActionActed | ActionDeclined | ActionRefused;

/** The legacy spelling of declined: a wire-fired handler saying it found
 *  nothing to do. `skipped` is the reason, or true with `reason` beside it. */
function legacySkip(r: Record<string, unknown>): string | null {
  if (r.ok !== true) return null;
  const s = r.skipped;
  if (typeof s === "string" && s.trim()) return s.trim();
  if (s === true) return typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : "nothing to do";
  return null;
}

/** Bring what a handler answered to the one shape above. Pure. */
export function normaliseActionResult(result: unknown, handlerKey: string): ActionResult & { malformed?: true } {
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as { ok?: unknown }).ok !== "boolean") {
    return {
      ok: false,
      error: "That action answered without saying whether it ran; nothing was changed on your behalf.",
      malformed: true,
      handler: handlerKey,
      raw: result,
    };
  }
  const r = result as Record<string, unknown>;
  const why = legacySkip(r);
  if (why !== null) {
    const { ok: _ok, skipped: _skipped, reason: _reason, ...rest } = r;
    return { ...rest, ok: false, skipped: true, error: why };
  }
  // `{ ok: false, skipped: "why" }` with no error: already not a pass, but
  // the reason was in a field nobody shows.
  if (r.ok === false && typeof r.skipped === "string" && typeof r.error !== "string") {
    const { skipped, ...rest } = r;
    return { ...rest, ok: false, skipped: true, error: String(skipped) };
  }
  return r as ActionResult;
}

/** True when the answer says the action changed or produced something. */
export function actionActed(result: unknown): result is ActionActed {
  return !!result && typeof result === "object" && (result as { ok?: unknown }).ok === true && legacySkip(result as Record<string, unknown>) === null;
}

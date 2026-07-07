// Vision constants + the classify-image → probability parse, shared by the
// `llm` detector package and the failure API. Kept here (no imports back into
// failure-detect) so the detector packages don't create an import cycle with the
// watch loop.

export const FAILURE_LABELS = ["printing normally", "print failure or spaghetti"] as const;

export const FAILURE_PROMPT =
  "You are watching a 3D printer's live camera. Decide whether the print is " +
  "failing — spaghetti/stringing, a detached or shifted part, a blob/clog, or a " +
  "collapsed model. A clean in-progress print is 'printing normally'.";

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Read the failure label's confidence out of a classify-image result. */
export function parseFailureProbability(result: unknown): number | null {
  const labels = (result as { labels?: Array<{ label?: string; confidence?: number }> })?.labels;
  if (!Array.isArray(labels)) return null;
  const fail = labels.find((l) => typeof l.label === "string" && /fail|spaghetti/i.test(l.label));
  if (fail && typeof fail.confidence === "number") return clamp01(fail.confidence);
  // Model answered only "normal" with a confidence → failure is the complement.
  const ok = labels.find((l) => typeof l.label === "string" && /normal/i.test(l.label));
  if (ok && typeof ok.confidence === "number") return clamp01(1 - ok.confidence);
  return null;
}

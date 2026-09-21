// A baseline of ALLOWED findings that states its case.
//
// An allowlist weakens in one way, and it is never dramatic: a run goes red,
// somebody adds the line that failed, and nothing records why. Six months of
// that and it allows everything. So every entry here is `{ key, why }`, the
// `why` a sentence somebody can disagree with ("the operator console shows
// the action id because the id IS the object here" is an argument; a bare
// path is a reflex), and a lint reading the file refuses to run when an entry
// has no reason. There is no bulk write: a red build is answered with the ONE
// entry to add, so following the instruction in front of you never baselines
// three offences and whatever else somebody added since (#3336). The e2e
// harness e2e/fresh-dashboard-4xx.mjs holds its allowed 4xx list to the same
// standard; this is that standard for a lint.
import { readFileSync } from "node:fs";

export interface ReasonedEntry {
  key: string;
  why: string;
}

/** Below this a "reason" is a word, not a case. */
export const MIN_WHY_LENGTH = 20;

export type BaselineRead =
  | { ok: true; entries: Map<string, string> }
  | { ok: false; problems: string[] };

/**
 * Read a reasoned baseline. `ok: false` carries one line per entry that is
 * not `{ key, why }` with a real sentence, or that repeats a key; the caller
 * prints them and exits before scanning anything, so a list that cannot be
 * audited never guards a build. `shown` is the path as the message names it
 * (repo-relative), when `path` has a fixture root in front of it.
 */
export function readReasonedBaseline(path: string, shown = path): BaselineRead {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, problems: [`${shown} is not readable JSON: ${(e as Error).message}`] };
  }
  if (!Array.isArray(raw)) return { ok: false, problems: [`${shown} must be an array of { key, why } entries.`] };
  const entries = new Map<string, string>();
  const problems: string[] = [];
  raw.forEach((e: unknown, i: number) => {
    const at = `${shown}[${i}]`;
    if (typeof e === "string") {
      problems.push(`${at} is a bare key with no reason: ${JSON.stringify(e.slice(0, 80))}`);
      return;
    }
    if (typeof e !== "object" || e === null) {
      problems.push(`${at} is not an object.`);
      return;
    }
    const { key, why } = e as Partial<ReasonedEntry>;
    if (typeof key !== "string" || key.length === 0) {
      problems.push(`${at} has no key.`);
      return;
    }
    if (typeof why !== "string" || why.trim().length < MIN_WHY_LENGTH) {
      problems.push(`${at} has no reason (key ${JSON.stringify(key.slice(0, 80))}). Every allowed finding carries a sentence saying why it is not a defect.`);
      return;
    }
    if (entries.has(key)) {
      problems.push(`${at} repeats the key ${JSON.stringify(key.slice(0, 80))}.`);
      return;
    }
    entries.set(key, why.trim());
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries };
}

/** The exact entry to paste for one new finding, ready for the baseline file. */
export function entryToAdd(key: string, hint: string): string {
  return `  {\n    "key": ${JSON.stringify(key)},\n    "why": "<${hint}>"\n  }`;
}

/** Keys the baseline allows that no finding needs any more, in baseline order. */
export function staleKeys(entries: Map<string, string>, present: Set<string>): string[] {
  return [...entries.keys()].filter((k) => !present.has(k));
}

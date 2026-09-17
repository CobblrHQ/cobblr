// Does what a model DID satisfy what the corpus CLAIMS? Pure, so the bench
// and its tests share one reading of a claim.
//
// Claims (the `ai` field of a corpus case):
//   action:<id>                   invoke that action
//   action:<id>{tag_name=fragile,hours=4}
//                                 ...with those arguments (text: case-insensitive
//                                 substring; number: equal; "*": present at all)
//   create:record | update | delete
//                                 propose that record write
//   read:<tool>|<tool>            call one of those reads, then answer in words
//   answer | clarify              answer in words, propose nothing
//   escort:<x>                    take_user_to that screen (or at least no write)
//   action:computed | action:undo the no-AI paths: never judged here (null)
//   <claim>|<claim>               either is right (between classes; a read's own
//                                 "read:a|b" is one claim naming two reads)
//
// Judging the ARGUMENTS is the point. "Tag the Kossel Mini as fragile" passed
// on the action id alone even with tag_name "Kossel"; the id is where the
// model was right, the arguments are where it can still be wrong.

export interface Claim {
  cls: string;
  rest: string;
  /** Expected arguments, from the {k=v,...} suffix; empty when none. */
  args: Record<string, string>;
}

export interface Verdict {
  /** The action id invoked, "(create_record)" etc. for a record write, or null for a prose answer. */
  picked: string | null;
  /** The arguments handed to the invoked action, when any. */
  args?: Record<string, unknown>;
  /** Read tools called on the way; ["(unobserved via rig)"] when the path cannot show them. */
  reads: string[];
  /** The records the answer names as chips (the response's `mentions`, by
   *  label), when the path can show them. */
  names?: string[];
  /** The answer's words, when the path can show them. */
  text?: string;
  /** The record an entity-scoped action was invoked on, from the call. */
  entity?: { kind: string; id: string };
  /** What the DOOR did when the bench opened it: the action run for real
   *  with the arguments the model sent, and put back. The id is where the
   *  model chose; the outcome is whether the choice worked. "remove tea
   *  category from inventory" scored green on the id for days while the
   *  handler refused the arguments three times (#3090). */
  outcome?: Outcome;
}

export type Outcome =
  | { ran: true; ok: boolean; said: string }
  | { ran: false; why: string };

export function parseClaim(ai: string): Claim {
  const m = /^([a-z]+)(?::([^{]*))?(?:\{(.*)\})?$/.exec(ai.trim());
  if (!m) return { cls: ai, rest: "", args: {} };
  const args: Record<string, string> = {};
  for (const pair of (m[3] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) args[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { cls: m[1]!, rest: (m[2] ?? "").trim(), args };
}

/** Does one handed-in value satisfy the claimed one? */
export function argMatches(want: string, got: unknown): boolean {
  if (want === "*") return got !== undefined && got !== null && got !== "";
  if (got === undefined || got === null) return false;
  const num = Number(want);
  if (want !== "" && !Number.isNaN(num) && typeof got === "number") return got === num;
  return String(got).toLowerCase().includes(want.toLowerCase());
}

export type Judgement = { ok: boolean; why: string } | null;

/**
 * null means the claim cannot be hosted here (SKIPPED): an action the
 * workspace lacks, or a no-AI path. Otherwise ok + one line saying why.
 *
 * `names`: the records the case says the answer must open, not only say
 * (a corpus case's `names`). Judged after the road: a right answer that
 * names "The Hobbit" in plain text, with no chip, is the miss the 2026-09-13
 * review reported, and it is scored here as one.
 */
export function judge(
  ai: string,
  v: Verdict,
  knownActions: Set<string>,
  names: readonly string[] = [],
  says: readonly string[] = [],
): Judgement {
  // "escort:members|answer", "action:lists:add-item|create:record": either is
  // right. Judged left to right; the first that passes wins, else the first
  // hostable verdict is reported. A read claim's own "a|b" stays inside
  // "read:" (split on "|" only between classes, never inside one).
  const alternatives = splitClaims(ai);
  let road: Judgement;
  if (alternatives.length > 1) {
    let first: Judgement = null;
    road = null;
    for (const alt of alternatives) {
      const j = judgeOne(alt, v, knownActions);
      if (j?.ok) {
        road = { ok: true, why: `${j.why} (accepted: ${alt})` };
        break;
      }
      first ??= j;
    }
    road ??= first;
  } else {
    road = judgeOne(ai, v, knownActions);
  }
  if (!road?.ok) return road;
  let verdict = road;
  // Two signals, read apart: the wrong door is the wrong door above; the
  // right door that refused is a miss here, with the refusal, and a door the
  // bench could not open is a pass on the door alone that says so.
  if (v.outcome && v.picked && !v.picked.startsWith("(")) {
    if (v.outcome.ran && !v.outcome.ok) return { ok: false, why: `${road.why}, but the door refused: ${v.outcome.said}` };
    verdict = { ok: true, why: v.outcome.ran ? `${road.why}; ran and put back` : `${road.why} (door only: ${v.outcome.why})` };
  }
  if (names.length) {
    const have = new Set((v.names ?? []).map((n) => n.toLowerCase()));
    const missing = names.filter((n) => !have.has(n.toLowerCase()));
    if (missing.length) return { ok: false, why: `${road.why}, but named in plain text with no chip: ${missing.join(", ")}` };
    verdict = { ok: true, why: `${road.why}; named as chips: ${names.join(", ")}` };
  }
  // What the answer must SAY ("Living room" for a where-question): a right
  // road with the wrong words is the miss the review reported.
  if (says.length) {
    const text = (v.text ?? "").toLowerCase();
    const unsaid = says.filter((s) => !text.includes(s.toLowerCase()));
    if (unsaid.length) return { ok: false, why: `${verdict.why}, but the answer does not say: ${unsaid.join(", ")}` };
    verdict = { ok: true, why: `${verdict.why}; says ${says.join(", ")}` };
  }
  return verdict;
}

/** Split "a|b|c" between CLASSES only: "read:x|y" is one claim with two reads. */
export function splitClaims(ai: string): string[] {
  const parts = ai.split("|").map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (/^[a-z]+(?::|$)/.test(part) && !(out.length && out[out.length - 1]!.startsWith("read:") && !/^(action|create|update|delete|read|answer|clarify|escort):?/.test(part))) out.push(part);
    else if (out.length) out[out.length - 1] += `|${part}`;
    else out.push(part);
  }
  return out;
}

/** What the model did, said the way a person reads it. */
function gotWord(picked: string | null): string {
  if (picked === null) return "words";
  if (picked.startsWith("(escort:")) return `an escort to ${picked.slice(8, -1)}`;
  if (/^\((create|update|delete)_records?\)$/.test(picked)) return `a record ${picked.slice(1, -1).replace(/_records?$/, "")}`;
  return `the action ${picked}`;
}

function judgeOne(ai: string, v: Verdict, knownActions: Set<string>): Judgement {
  const c = parseClaim(ai);
  switch (c.cls) {
    case "action": {
      if (c.rest === "computed" || c.rest === "undo") return null;
      if (!knownActions.has(c.rest)) return null;
      if (v.picked !== c.rest) return { ok: false, why: `wanted ${c.rest}, got ${v.picked ?? "words"}` };
      for (const [k, want] of Object.entries(c.args)) {
        const got = v.args?.[k];
        if (!argMatches(want, got)) return { ok: false, why: `right action, wrong ${k}: wanted ${want}, got ${got === undefined ? "nothing" : JSON.stringify(got)}` };
      }
      return { ok: true, why: Object.keys(c.args).length ? "action and arguments" : "action" };
    }
    // A record write is wanted; the why says what came instead in the same
    // words a person reads: "wanted a record update, got the action
    // projects:mark-task-done" and never "got X (got X)".
    case "create": {
      const ok = v.picked === "(create_record)" || v.picked === "(create_records)";
      return { ok, why: ok ? "created the record" : `wanted a record create, got ${gotWord(v.picked)}` };
    }
    case "update": {
      const ok = v.picked === "(update_record)";
      return { ok, why: ok ? "updated the record" : `wanted a record update, got ${gotWord(v.picked)}` };
    }
    case "delete": {
      const ok = v.picked === "(delete_record)";
      return { ok, why: ok ? "deleted the record" : `wanted a record delete, got ${gotWord(v.picked)}` };
    }
    case "read": {
      if (v.picked !== null) return { ok: false, why: `proposed ${v.picked} instead of answering` };
      if (v.reads[0] === "(unobserved via rig)") return { ok: true, why: "answered in words (reads unobserved)" };
      const wanted = c.rest.split("|").map((t) => t.trim());
      const hit = wanted.find((t) => v.reads.includes(t));
      return hit ? { ok: true, why: `read ${hit}` } : { ok: false, why: `answered without ${wanted.join(" or ")}; read ${v.reads.join(",") || "nothing"}` };
    }
    case "escort": {
      // An escort is right when the model took the person to that screen, or
      // at least did not propose a write instead.
      if (v.picked === `(escort:${c.rest})`) return { ok: true, why: `escorted to ${c.rest}` };
      if (v.picked?.startsWith("(escort:")) return { ok: false, why: `escorted to the wrong screen: ${v.picked}` };
      return { ok: v.picked === null, why: v.picked === null ? "answered in words (no escort seen)" : `proposed ${v.picked}` };
    }
    case "answer":
    case "clarify":
      return { ok: v.picked === null, why: v.picked === null ? "answered in words" : `proposed ${v.picked}` };
    default:
      return null;
  }
}

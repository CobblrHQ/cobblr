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
}

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
 */
export function judge(ai: string, v: Verdict, knownActions: Set<string>): Judgement {
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
    case "create":
      return { ok: v.picked === "(create_record)" || v.picked === "(create_records)", why: `got ${v.picked ?? "words"}` };
    case "update":
      return { ok: v.picked === "(update_record)", why: `got ${v.picked ?? "words"}` };
    case "delete":
      return { ok: v.picked === "(delete_record)", why: `got ${v.picked ?? "words"}` };
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

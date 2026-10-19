// What a turn says when one of its writes did not happen (#5067).
//
// "I want to create Mugs and file these 11 in it" ran the filing first, before
// Mugs existed; the filing was refused, the list was then made, and the answer
// said both were done. The person saw "filed those 11" over an inbox still
// holding all eleven. Three things here, each its own guard:
//
//   - the ORDER: in one round, a step that makes a list runs before a step
//     that names one, whatever order the model wrote them in;
//   - the RETRY: a step refused for "no list called X" runs once more after
//     X is made in the same turn, which is the order a model that called them
//     in separate rounds needed;
//   - the ANSWER: a write that still did not happen is said as not done, in
//     words built from the step and its refusal. The model's own sentence is
//     not shown beside it, since it is the sentence that claimed the step.
import type { ToolCall } from "../providers/tool-wire.js";
import type { AppliedWrite, FailedWrite } from "./agent-loop.js";
import { WORKSPACE_TOOLS } from "@cobblr/workspace-tools";
import { forAPerson } from "./says-something.js";

const MAKES_A_LIST = "platform:create-instance";

function actionOf(call: ToolCall): string | null {
  const a = (call.args as { action_id?: unknown }).action_id;
  return typeof a === "string" ? a : null;
}

function argsOf(call: ToolCall): Record<string, unknown> {
  const a = (call.args as { args?: unknown }).args;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

/** The name a list-making call gives the list it makes. */
export function listMadeBy(call: ToolCall): string | null {
  if (call.name !== "invoke_action" || actionOf(call) !== MAKES_A_LIST) return null;
  const a = argsOf(call);
  const name = typeof a.display_name === "string" ? a.display_name : typeof a.name === "string" ? a.name : null;
  return name?.trim() || null;
}

/** A round's writes, list-makers first, the rest in the model's order. */
export function orderWrites(calls: ToolCall[]): ToolCall[] {
  const makers = calls.filter((c) => listMadeBy(c) !== null);
  if (!makers.length) return calls;
  return [...makers, ...calls.filter((c) => listMadeBy(c) === null)];
}

const NO_LIST = /no list called "([^"]+)"/i;

/** Retry a write refused for a missing list once that list has been made. */
export function retryAfter(failed: FailedWrite, made: AppliedWrite): boolean {
  const list = listMadeBy(made.call);
  if (!list) return false;
  const missing = NO_LIST.exec(failed.error)?.[1];
  const named = typeof (failed.call.args as { list?: unknown }).list === "string" ? String((failed.call.args as { list?: unknown }).list) : null;
  const same = (x: string | null | undefined) => !!x && x.trim().toLowerCase() === list.toLowerCase();
  return same(missing) || (!!missing && same(named));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a write was going to do, in the words of the step a person saw. */
export function stepSaid(call: ToolCall, actionLabel?: (id: string) => string | undefined): string {
  const a = call.args as Record<string, unknown>;
  switch (call.name) {
    case "file_inbox_items": {
      const n = Array.isArray(a.ids) ? a.ids.length : 0;
      const list = typeof a.list === "string" ? a.list : "the list";
      return `Filing ${plural(n, "item", "items")} into ${list}`;
    }
    case "create_record":
    case "add_thing":
      return "Adding the record";
    case "put_back_scan_item":
      return "Putting the inbox item back";
    case "change_scan_item":
      return "Changing the inbox item";
    case "create_records": {
      const n = Array.isArray(a.records) ? a.records.length : 0;
      return n === 1 ? "Adding one record" : `Adding ${n} at once`;
    }
    case "update_record":
      return "Changing the record";
    case "delete_record":
      return "Deleting the record";
    case "invoke_action": {
      const id = actionOf(call);
      const list = listMadeBy(call);
      if (list) return `Making the list ${list}`;
      const label = id ? actionLabel?.(id) : undefined;
      return label ? label : "Running that step";
    }
    default:
      return "One step";
  }
}

/** An action id ("platform:create-instance") or one of the assistant's own
 *  tool names ("list_actions"): words for the model, never for a person. A
 *  field's name ("module_name") is not one: forAPerson words those. */
const TOOL_NAMES = WORKSPACE_TOOLS.map((t) => t.name).sort((a, b) => b.length - a.length);
const PROGRAM_WORDS = new RegExp(`\\b[a-z][a-z0-9-]*:[a-z][a-z0-9_-]+\\b|\\b(?:${TOOL_NAMES.join("|")})\\b`);

/** The person's half of a refusal. A tool refuses in two halves, what is wrong
 *  and what the model should try ("no list called Cups; make it first
 *  (platform:create-instance) or name one the app shows"); the second is
 *  for the model. Clauses and asides that name a program's words are left
 *  out, then the rest goes through forAPerson. */
export function personReason(error: string): string {
  const kept = error
    .split(/;\s*/)
    .filter((clause) => clause.trim() && !PROGRAM_WORDS.test(clause))
    .join("; ")
    .replace(/\([^)]*\)/g, (aside) => (PROGRAM_WORDS.test(aside) ? "" : aside))
    .replace(/\s{2,}/g, " ")
    .trim();
  const explained = error
    .replace(/call list_actions to see what runs here/gi, "I need to check which changes are available")
    .replace(/no such read tool:\s*[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*/gi, "the requested change is not available")
    .replace(new RegExp(PROGRAM_WORDS.source, "g"), "")
    .replace(/^\s*:\s*/, "")
    .replace(/\(\s*\)/g, "")
    .trim();
  return (kept ? forAPerson(kept) : `Turning a request into a change did not work: ${forAPerson(explained)}`).replace(/[.\s]+$/, "");
}

/** The answer for a turn with writes that did not happen. */
export function saidWhatFailed(failed: readonly FailedWrite[], doneCount: number, actionLabel?: (id: string) => string | undefined): string {
  const lines = failed.map((f) => `${stepSaid(f.call, actionLabel)} did not happen: ${personReason(f.error)}.`);
  const rest = doneCount > 0 ? ` The ${doneCount === 1 ? "other step is" : "other steps are"} done, shown above.` : " Nothing was changed.";
  return `${lines.join(" ")}${rest}`;
}


/** A failure that may go through if tried again as it was: a service that
 *  did not answer, a busy one, a limit. Anything else fails the same way on a
 *  plain retry, so it is offered a different way out or none (#5067). */
const PASSING = /\btime(?:d)? ?out\b|\btimeout\b|unreachable|not reachable|could not be reached|ECONN|\bbusy\b|temporar|rate.?limit|\b50[234]\b/i;
export function mayPassOnRetry(error: string): boolean {
  return PASSING.test(error);
}

/** The list a filing named that does not exist ("no list called Cups"). */
export function missingList(f: FailedWrite): string | null {
  if (f.call.name !== "file_inbox_items") return null;
  return NO_LIST.exec(f.error)?.[1]?.trim() || null;
}

function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[y.length]!;
}

/** Where the filing could go instead: the list this turn made, else the
 *  existing list whose name is closest to the one asked for (one that
 *  contains it, or two letters off). Null when nothing is close. */
export function insteadList(missing: string, madeThisTurn: readonly string[], existing: readonly string[]): string | null {
  const made = madeThisTurn.at(-1);
  if (made) return made;
  const m = missing.toLowerCase();
  let best: { name: string; d: number } | null = null;
  for (const name of existing) {
    const n = name.toLowerCase();
    const d = n.includes(m) || m.includes(n) ? 0 : distance(n, m);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

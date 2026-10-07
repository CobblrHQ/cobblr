// What Cobb is actually doing, in words, while you wait.
//
// The panel used to show one replaced line, so a ninety-second turn read as the
// word "Thinking" for a minute and a half: every step that would have explained
// the wait scrolled past invisibly, and the least informative one was the one
// left on screen. The events carried the tool's ARGUMENTS all along; nobody was
// reading them.
//
// "Reading: list records" is the shape of the call. "Reading your locations" is
// what somebody wanted to know.

import { withArticle } from "@cobblr/platform-contract/plural";

/** The record kind's readable half: "core-locations:location" → "location". */
const kindLabel = (id: string): string => id.split(":")[1] ?? id;

/** What a tool is actually doing, not just its name. */
export function describeTool(name: string, args: Record<string, unknown>): string {
  const kind = typeof args.kind === "string" ? kindLabel(args.kind) : "";
  const q = typeof args.q === "string" ? args.q : typeof args.query === "string" ? args.query : "";
  switch (name) {
    case "list_records":
      return kind ? `Reading your ${kind}s` : "Reading your records";
    case "get_record":
      return kind ? `Looking at one ${kind}` : "Looking at a record";
    case "search_records":
      return q ? `Searching for “${q}”` : "Searching your workspace";
    case "list_record_kinds":
      return "Seeing what this workspace holds";
    case "list_actions":
      return "Checking what it can do here";
    case "get_attention":
      return "Checking what needs you";
    case "get_putaway_plan":
      return "Reading your put-away plan";
    case "list_scan_inbox":
      return "Reading your scan inbox";
    case "get_scan_item":
      return "Looking at one scan";
    case "create_record":
      return kind ? `Adding ${withArticle(kind)}` : "Adding a record";
    case "update_record":
      return kind ? `Changing ${withArticle(kind)}` : "Changing a record";
    case "delete_record":
      return kind ? `Removing ${withArticle(kind)}` : "Removing a record";
    case "invoke_action": {
      const made = args.action_id === "platform:create-instance" && args.args && typeof (args.args as { display_name?: unknown }).display_name === "string"
        ? String((args.args as { display_name: string }).display_name)
        : "";
      if (made) return `Making the list ${made}`;
      const id = typeof args.action_id === "string" ? args.action_id.split(":")[1] ?? args.action_id : "";
      return id ? `Running ${id.replace(/-/g, " ")}` : "Running an action";
    }
    case "file_inbox_items": {
      const n = Array.isArray(args.ids) ? args.ids.length : 0;
      const list = typeof args.list === "string" ? args.list : "a list";
      return `Filing ${n} ${n === 1 ? "item" : "items"} into ${list}`;
    }
    default:
      return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}


/** One step of a turn, as the panel lists it. A failed one keeps why. */
export interface TurnStep {
  text: string;
  state: "doing" | "done" | "failed";
  why?: string;
}

/** Fold one turn event into the step list. Pure, so the live panel and a
 *  finished turn read back from its events build the same list (#5067). */
export function foldStep(prev: TurnStep[], kind: string, data: Record<string, unknown>): TurnStep[] {
  switch (kind) {
    case "thinking":
      // Only the FIRST think is a step of its own; the later ones are the gap
      // between tools and would otherwise fill the list with the word.
      return (data.round as number) > 0 ? prev : [...prev, { text: "Thinking", state: "doing" }];
    case "tool": {
      const done = prev.map((x) => (x.state === "doing" ? { ...x, state: "done" as const } : x));
      return [...done, { text: describeTool(String(data.name ?? ""), (data.args as Record<string, unknown>) ?? {}), state: "doing" }];
    }
    case "tool-result":
    case "applied": {
      const ok = kind === "applied" || data.ok !== false;
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i]!.state === "doing") {
          copy[i] = ok ? { ...copy[i]!, state: "done" } : { ...copy[i]!, state: "failed", ...(typeof data.summary === "string" && data.summary ? { why: data.summary } : {}) };
          return copy;
        }
      }
      // A failure with no step of its own (a write handed back before it ran)
      // is still a step the person should see.
      return ok ? copy : [...copy, { text: describeTool(String(data.name ?? ""), {}), state: "failed", ...(typeof data.summary === "string" && data.summary ? { why: data.summary } : {}) }];
    }
    default:
      return prev;
  }
}

/** The finished list: anything still "doing" when the answer came is done. */
export function settledSteps(steps: TurnStep[]): TurnStep[] {
  return steps.filter((s) => s.text !== "Thinking").map((s) => (s.state === "doing" ? { ...s, state: "done" } : s));
}

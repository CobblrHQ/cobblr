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
    case "create_record":
      return kind ? `Adding a ${kind}` : "Adding a record";
    case "update_record":
      return kind ? `Changing a ${kind}` : "Changing a record";
    case "delete_record":
      return kind ? `Removing a ${kind}` : "Removing a record";
    case "invoke_action": {
      const id = typeof args.action_id === "string" ? args.action_id.split(":")[1] ?? args.action_id : "";
      return id ? `Running ${id.replace(/-/g, " ")}` : "Running an action";
    }
    default:
      return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

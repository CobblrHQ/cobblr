// An add is tidied before its card, as the tool tidies it before the intake
// (addThingArgs). A role marked unsaid ({} or null) is no role, so the card
// never confirms into "Roles acquired for: Invalid input". With no name left
// it goes back to the model, never to the person as the whole answer: "I need
// to know what the thing is called" for a drill the person named (walk #9477).
import { addThingArgs } from "@cobblr/workspace-tools";
import type { ToolCall } from "../providers/tool-wire.js";

/** Tidies an add_thing call in place; the reason to hand it back, or null. */
export function checkedAdd(call: ToolCall): string | null {
  if (call.name !== "add_thing") return null;
  call.args = addThingArgs(call.args ?? {});
  return call.args.name ? null : 'add_thing needs name: the thing as your person called it ("DeWalt cordless drill"), not left out or put in fields.';
}

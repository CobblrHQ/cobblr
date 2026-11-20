// "What can you do?" is answered from this workspace (#4115, the first hour).
//
// Asked by a newcomer with free Gemini connected, it came back "I can help you
// answer questions, explain concepts, find information": true of any
// assistant, nothing about this one, and no next step. The one question a
// person asks to learn the tool deserves the tool.
//
// The code plans, the model narrates: the facts come from the workspace (the
// lists a person can add to here, things to say from the actions this
// workspace really has, one first step to try), and the model is asked only
// to say them in its own words. Phrasing that drops any fact is not what the
// person sees; the plan's own sentences are.

import { withArticle } from "@cobblr/platform-contract/plural";
import { addableLists, type ListKind } from "../their-lists.js";

/** The whole message asks what Cobb can do, or where to start. */
const ASKS =
  /^(?:so\s+)?(?:what\s+(?:can|could|do)\s+(?:you|cobb)\s+do(?:\s+(?:here|for\s+me|in\s+here|in\s+this\s+workspace))?|what\s+are\s+you\s+able\s+to\s+do|how\s+can\s+you\s+help(?:\s+me)?|what\s+should\s+i\s+do\s+first|where\s+do\s+i\s+start|how\s+do\s+i\s+(?:get\s+)?start(?:ed)?|help)\s*[?.!]*$/i;

export function asksWhatCobbCanDo(message: string): boolean {
  return ASKS.test(message.trim());
}

export interface ActionRow {
  id: string;
  module_name?: string;
  label?: string;
  examples?: string[] | null;
  internal?: boolean;
  refused_here?: string | null;
}

export interface CobbCanDo {
  lists: string[];
  /** Sentences a person can say, from the actions this workspace has. */
  says: string[];
  /** The one thing to try first, as the words to type. */
  first: string;
}

const NAMED = 3;

/** The plan: three lists, three things to say from three different modules, one first step. */
export function whatCobbCanDo(kinds: readonly (ListKind & { display_name?: string | null })[], actions: readonly ActionRow[]): CobbCanDo {
  const lists = addableLists(kinds).slice(0, NAMED);
  const says: string[] = [];
  const modules = new Set<string>();
  const usable = actions.filter((a) => !a.internal && !a.refused_here && (a.examples?.length ?? 0) > 0);
  // A module's own actions before the platform's, one sentence per module.
  for (const a of [...usable.filter((a) => !a.module_name?.startsWith("core-") && a.module_name !== "platform"), ...usable]) {
    const module = a.module_name ?? a.id.split(":")[0]!;
    if (modules.has(module)) continue;
    modules.add(module);
    says.push(a.examples![0]!);
    if (says.length === NAMED) break;
  }
  // The first step adds one thing to the list named first: the workspace's own.
  const firstList = kinds.find((k) => k.can_create && (k.display_name_plural || k.display_name) === lists[0]);
  const noun = (firstList?.display_name || "").toLowerCase();
  const first = noun ? `add ${withArticle(noun)} called My first ${noun}` : "what can I track here";
  return { lists, says, first };
}

/** The plan in Cobb's own words, for when the model's phrasing will not do. */
export function sayWhatCobbCanDo(plan: CobbCanDo): string {
  const lines = ["Here's what I can do in this workspace:"];
  if (plan.lists.length) lines.push(`- **Add and find things** in ${plan.lists.join(", ")}: ask where something is, how many you have, or to add one.`);
  if (plan.says.length) lines.push(`- **Do things for you**, such as ${plan.says.map((s) => `"${s}"`).join(", ")}.`);
  lines.push("- **Change what I make** only after you press Do it, and **undo** puts it back.");
  lines.push("", `Try this first: "${plan.first}"`);
  return lines.join("\n");
}

/** What the model is asked to phrase: the plan, and nothing it may add. */
export function phraseRequest(asked: string, plan: CobbCanDo): string {
  return `${asked}\n\n(Answer that in your own words from these facts only, in a few short lines. Name every list and quote every sentence exactly as written; end with: Try this first: "${plan.first}". Add nothing that is not here.\n\n${sayWhatCobbCanDo(plan)})`;
}

/** The model's phrasing, if it kept every fact of the plan; null to say the plan itself. */
export function keptThePlan(phrased: string, plan: CobbCanDo): string | null {
  const text = phrased.trim();
  if (!text) return null;
  const low = text.toLowerCase();
  const facts = [...plan.lists, ...plan.says, plan.first];
  return facts.every((f) => low.includes(f.toLowerCase())) && /\btry\b/i.test(text) ? text : null;
}

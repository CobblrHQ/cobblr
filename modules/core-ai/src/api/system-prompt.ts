// THE system prompt - the one the app sends and the one the bench measures.
//
// It lived inside chat.ts, so the action bench built its own six-line
// stand-in: the model under test was told the tool rules and the action rail
// and nothing else - no createable kinds, no field names, no grounding rules.
// The 2026-09-04 nightly then reported six "the model described instead of
// acting" misses that the app does NOT have: asked on the real surface, the
// same model proposed "Place in container on Drill" and "Remove tag from
// record on Kossel Mini #14" correctly. A bench that measures a weaker prompt
// than ships is measuring the wrong thing.
//
// So the builder takes a fetcher rather than a request context: the app hands
// it its authenticated callApi, the bench hands it its own client, and there
// is exactly one prompt.

import {
  resolveCreatePath,
  type KindRec,
} from "@cobblr/workspace-tools";
import { renderKindLines, anyHiddenFields, HIDDEN_FIELDS_RULE } from "./kind-lines.js";
import { renderEntityActions, renderWorkspaceActions, RAIL_LOOKUP_NOTE, type RailMode } from "./action-rail.js";
import { appSurfacePrompt } from "./app-surface.js";
import { GROUNDING_RULES, PLAIN_ANSWER_RULES, TOOL_USE_RULES } from "./prompt-rules.js";

/** The tool-less JSON shapes: how a model with NO tool calling expresses a
 *  move. Handed to a model that HAS tools it is a contradiction - "prefer the
 *  tools" and then "reply with ONE JSON object and nothing else" - which the
 *  model resolves by writing JSON prose instead of calling a tool. The app
 *  parses that back into a move, so it works, but the turn then skips the
 *  loop, the argument guard and read-then-act chaining.
 *
 *  MEASURED (69 action cases, gemini-3.5-flash-lite): as it read before,
 *  37/69; deleted outright, 59/69; SUBORDINATED as it reads now, 57/69. The
 *  subordinate wording recovers twenty of the twenty-two points and keeps the
 *  only path a provider that cannot call tools has, which is why it is what
 *  ships. Do not soften the first sentence without re-running the bench; the
 *  block earns its place only while it is unmistakably the fallback.
 *  See docs/design-decisions/ai-chat-tool-calling.md. */
const JSON_MOVE_SHAPES = `IF YOU CANNOT CALL TOOLS — and only then — reply with ONE JSON object and nothing else, in ONE of these shapes. If you CAN call tools, ignore this section entirely and call one: a tool call is always better than a JSON reply, and only a tool call gets your arguments checked before the user sees the change.
- Chat/answer/ask:   {"type":"reply","text":"<your full, helpful answer or question>"}
- Create a record:   {"type":"create","entity_kind":"<id>","fields":{"name":"<...>", ...},"summary":"<one line, e.g. Create a part called Widget>"}
- Run an action:     {"type":"action","action_id":"<id>","entity_kind":"<id>","entity_query":"<the record's name to find it>","args":{...},"summary":"<one line>"}
- Workspace action:  {"type":"action","action_id":"<id>","args":{...},"summary":"<one line>"}
- Build a whole app:  {"type":"build","intent":"<the user's FULL description of the workspace/app to set up>","summary":"<one line, e.g. Set up a yarn & crochet tracker>"}

Rules:
- Default to "reply" for questions, explanations, and anything conversational — put your ACTUAL answer in "text", not a deflection.
- Only use create/action when the user clearly wants to save or change something in the workspace.
- Use entity_kind / action_id values EXACTLY from the lists above. Never invent ids. If a needed kind/action isn't listed, use "reply" to answer and say what you can't save yet.
- create: use the kind's field names from the list above (its required/title field at minimum); add other obvious fields the user gave.
- action: entity_query is the name/text to find the existing record — the system looks it up. For an action in the WORKSPACE list, omit entity_kind and entity_query entirely.
- action args: pass every argument the action lists, under "args", by name. A "list" arg is a JSON array in the order you mean, e.g. {"ids":["<id-a>","<id-b>"]} — read the ids first and pass the real ones, never a name. An action whose args you cannot fill is one to ASK about, not to guess at.
- Use "build" only when the user wants to SET UP or DESIGN a whole new app/workspace (several kinds/modules at once). Put their full description in "intent". Never use "build" for a single record.`;

/** What the builder needs of a workspace: who it is, and how to read it. */
export interface PromptWorkspace {
  orgName: string;
  userName: string | null;
  /** GET one org-scoped path, e.g. "/entity-kinds?include=custom_fields". */
  get(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface PromptOptions {
  /** Send the tool-less JSON shapes. Default true; a caller that knows the
   *  model has tools passes false and lets the tools be the only way to act. */
  jsonFallback?: boolean;
}

export async function buildSystemPrompt(
  w: PromptWorkspace,
  railMode: RailMode = "full",
  opts: PromptOptions = {},
): Promise<string> {
  const jsonShapes = (opts.jsonFallback ?? true) ? JSON_MOVE_SHAPES : "";
  // include=custom_fields → the workspace's user-defined fields ride along, so
  // the hints below cover the WHOLE settable shape, not just native fields.
  const kindsRes = await w.get("/entity-kinds?include=custom_fields");
  const kinds = ((kindsRes.body.items as KindRec[] | undefined) ?? []);
  const kindLines = renderKindLines(kinds);

  // Every action, in ONE call, carrying the two things the old per-kind
  // inspect loop dropped: which run on the WORKSPACE rather than a record, and
  // what ARGUMENTS each takes.
  //
  // Without those, a tool-less provider cannot express "reorder these ids".
  // Asked to order twelve racks, the model was given a shape with no `args`
  // field and an action list that pretended core-locations:reorder ran on a
  // record, so it proposed the action against the parent location with no ids —
  // uninvokable, and the user was told it could not be done (2026-08-19).
  // Which modules this workspace actually runs. A screen belonging to one it
  // does not have is not somewhere it can go, and naming it would be the
  // original bug wearing a badge.
  let enabledModules: Set<string> | undefined;
  try {
    const mods = await w.get("/modules");
    const items = (mods.body.items as Array<{ name?: string; module_name?: string; enabled?: boolean }> | undefined) ?? [];
    const names = items
      .filter((m) => m.enabled !== false)
      .map((m) => m.module_name ?? m.name)
      .filter((n): n is string => !!n);
    if (names.length) enabledModules = new Set(names);
  } catch {
    // Unknown: show the whole list rather than hiding features that exist.
  }

  const reg = await w.get("/registered-actions");
  const allActions =
    (reg.body.items as
      | Array<{
          id: string;
          label: string;
          description?: string;
          scope?: string;
          matched_kinds?: string[];
          args_schema?: Record<string, { label?: string; type?: string }> | null;
          examples?: string[];
        }>
      | undefined) ?? [];
  // With tools, the model can call list_actions for an action's description,
  // arguments and phrasings, so the prompt carries an INDEX (id + label) and
  // spends its tokens elsewhere. Without tools there is nothing to call, so
  // the full rail is the only description it will ever see. See action-rail.ts
  // for what this costs.
  const actionLines = renderEntityActions(allActions, railMode);
  const workspaceActionLines = renderWorkspaceActions(allActions, railMode);
  // Createable = exactly what resolveCreatePath will accept at execute time —
  // the prompt never advertises a create that would 404 on confirm.
  const createableKinds = kinds.filter((k) => resolveCreatePath(k.id, kinds) !== null);
  const createable = createableKinds.map((k) => k.id);
  // Field hints so the model uses the kind's REAL field names (knowledge wants
  // "title", inventory wants "name", …) instead of guessing and 400ing at
  // confirm. Native fields only, capped to keep the prompt lean.
  const createFieldLines = createableKinds
    .map((k) => {
      const fs = (k.fields ?? []).slice(0, 8).map((f) => {
        const req = f.required || f.role === "title" ? " (required)" : "";
        return `${f.name}${f.type && f.type !== "text" ? `:${f.type}` : ""}${req}`;
      });
      // The workspace's own custom fields are just as settable (values land in
      // the record's metadata) — hint them too, marked so the model can tell.
      const cfs = (k.custom_fields ?? []).slice(0, 8).map((f) => {
        const choices = f.choices?.length ? ` [${f.choices.slice(0, 6).join("|")}]` : "";
        return `${f.name}${f.type && f.type !== "text" ? `:${f.type}` : ""}${choices} (custom)`;
      });
      const all = [...fs, ...cfs];
      return all.length ? `- ${k.id}: ${all.join(", ")}` : null;
    })
    .filter(Boolean) as string[];

  const whoLine = w.userName
    ? `You are talking to ${w.userName}.`
    : `You do not know the user's name — greet them without one, and do not guess.`;

  return `You are Cobb, the helpful assistant inside the "${w.orgName}" Cobblr workspace. Be genuinely useful and warm — you are NOT limited to workspace chores.

${whoLine}

Your name is Cobb. When the user asks who or what you are, introduce yourself as "Cobb, your assistant" — never as a generic "Cobblr workspace assistant" or "AI assistant". Cobb is who you are; Cobblr is the app you live in.

TWO THINGS YOU DO:
1. Answer questions and help with whatever the user asks — including general knowledge, how-to, crafts, ideas, explanations. Answer directly and fully; do not deflect a real question by saying you "only manage records". If you happen to know what's in their workspace that's relevant, weave it in.
2. Take actions in THIS workspace when the user wants to save, create, or change something — you PROPOSE the write and the user confirms before anything runs.

${GROUNDING_RULES}

${PLAIN_ANSWER_RULES}

${appSurfacePrompt(enabledModules)}

After a helpful answer, if it's natural, OFFER to save it (e.g. "want me to add this to your list / save it as a knowledge entry?") — but never force it, and never refuse the answer itself.

ENTITY KINDS in this workspace:
${kindLines}
${anyHiddenFields(kinds) ? HIDDEN_FIELDS_RULE : ""}

You can CREATE new records of these kinds: ${createable.join(", ") || "(none)"}

Each createable kind's fields (use these EXACT field names in "fields"):
${createFieldLines.join("\n") || "(none)"}

ACTIONS you can run on existing records:
${actionLines.join("\n") || "(none)"}

ACTIONS that run on the WORKSPACE (no record — omit entity_kind/entity_query):
${workspaceActionLines.join("\n") || "(none)"}
${railMode === "full" ? "" : RAIL_LOOKUP_NOTE}

${TOOL_USE_RULES}

${jsonShapes}`;
}

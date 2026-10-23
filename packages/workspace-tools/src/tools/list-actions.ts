import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool, firstSentence, offerableToAssistant } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_actions",
  description:
    "Discover actions: no filter gives an index of action ids and labels. Pass kind for that kind's actions with arguments, or action_id for one in full. Run with invoke_action; send_targets lists destinations and recent sends.",
  mode: "read",
  paging: { by: "one-call", why: "every action the workspace registers; the registry is small and whole" },
  wholeResult: "the index is the menu of every action Cobb can offer; a trimmed index drops actions that exist",
  params: {
    send_targets: z.boolean().optional().describe("Send destinations and your sends"),
    kind: z.string().optional().describe("Only the actions that run on this kind's records or settings"),
    action_id: z.string().optional().describe("One action from the index, with its arguments and consent requirements"),
  },
  execute: async (api, args) => {
    if (args.send_targets) {
      const r = await api.request("GET", "/records/send-targets");
      return r.status >= 400 ? toolFail(apiErrorMessage(r, "couldn't list send destinations")) : toolOk(r.body);
    }
    const res = await api.request("GET", "/registered-actions");
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list actions"));
    const items =
      (res.body.items as
        | Array<{
            id?: string;
            label?: string;
            description?: string;
            module_name?: string;
            matched_kinds?: string[];
            scope?: string;
            args_schema?: Record<string, { label?: string; type?: string; required?: boolean; oneOf?: string }> | null;
            undoable?: boolean;
            refused_here?: string | null;
            user_invokable?: boolean;
            internal?: boolean;
            wire_only?: boolean;
            record_optional?: boolean;
            examples?: string[];
          }>
        | undefined) ?? [];
    const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : null;
    // A kind's actions are the ones that run on its records, and the
    // workspace actions that take a kind (lend these, group its fields). The
    // rest of the workspace's actions are in the index: listing every one of
    // them, described in full, under any kind made one call about 139 KB
    // (#6335), more than a turn has room for. A wire-only action is never
    // offered (offerableToAssistant).
    const actionId = typeof args.action_id === "string" ? args.action_id.trim() : "";
    const takesAKind = (a: (typeof items)[number]) => !!a.args_schema && "entity_kind" in a.args_schema;
    const picked = items.filter(offerableToAssistant)
      .filter((a) => !actionId || a.id === actionId)
      .filter((a) => !kind || (a.scope === "workspace" ? takesAKind(a) : (a.matched_kinds ?? []).includes(kind)));
    if (!kind && !actionId) return toolOk({ index: Object.fromEntries(picked.map((a) => [a.id, a.label])) });
    // Project to what a caller needs to actually RUN one. `args` is the
    // decisive field: an action listed without its arguments is an action
    // that cannot be invoked, and the honest-looking conclusion is "I have no
    // way to run this" — which is what happened with core-locations:reorder
    // and its `ids` (2026-08-19).
    return toolOk(
      picked.map((a) => ({
        id: a.id,
        label: a.label,
        // Under a kind, a sentence each; action_id gives the whole of one.
        description: kind && !actionId ? firstSentence(a.description) : a.description,
        // Which module it came from: dropped once in the projection below and
        // caught only by a test that pins it, so it stays named here.
        module_name: a.module_name,
        scope: a.scope ?? "entity",
        // Whether running it by mistake can be put right here. A connection
        // with no way to show a confirmation may run only the undoable ones,
        // so this is the difference between "I will do that" and a refusal
        // the user can act on.
        undoable: a.undoable === true,
        // Why this connection cannot run it (it needs a person in the app):
        // listed so the person can be sent there, not refused after the ask.
        ...(a.refused_here ? { run_it_in_the_app: a.refused_here } : {}),
        // How a person asks for it, so a sentence can be matched to an action
        // rather than guessed at from the id.
        ...(a.examples?.length ? { said_like: kind && !actionId ? a.examples.slice(0, 2) : a.examples } : {}),
        ...(a.scope === "workspace" ? {} : { matched_kinds: a.matched_kinds ?? [] }),
        // Runs on one of those records, OR with no record at all: "put milk
        // on the shopping list" names no record, and without this said the
        // model created an empty list instead (#3255).
        ...(a.record_optional ? { runs_without_a_record: true } : {}),
        args: a.args_schema && Object.keys(a.args_schema).length
          ? Object.fromEntries(
              Object.entries(a.args_schema).map(([name, spec]) => {
                const type = spec?.type ?? "text";
                return [
                  name,
                  {
                    type,
                    ...(spec?.label ? { describes: spec.label } : {}),
                    // What the door will refuse the call for. #3137 gave
                    // every argument these markers and four readers use
                    // them (the plan door, the invoke door, the chat guard,
                    // the bench); the model saw them only in a hand-back,
                    // one round late, so it learned what an action needs by
                    // being refused (#3142).
                    ...(spec?.required ? { required: true } : {}),
                    ...(spec?.oneOf ? { one_of: spec.oneOf } : {}),
                    // Spelling out the JSON shape for a list: "type: list"
                    // alone was read as "a comma-separated string" often
                    // enough to matter, and the order inside a list is
                    // frequently the whole point of the call.
                    ...(type === "list" ? { pass_as: 'a JSON array, in order — ["…", "…"]' } : {}),
                  },
                ];
              }),
            )
          : undefined,
      })),
    );
  },
};

export default tool;

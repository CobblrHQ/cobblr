// How the workspace's actions are described to the model.
//
// Two renderings, because there are two ways the model can reach an action:
//
//   FULL  — every action with its description, argument names and example
//           phrasings. This is the ONLY description the model gets on the
//           legacy JSON path, where there is no `list_actions` to call.
//
//   BRIEF — id, kinds, label and description: everything that makes an action
//           RECOGNISABLE, without the argument names and example phrasings
//           that only matter once it has been chosen. Used when tools are
//           available, because `list_actions(kind)` returns those on demand.
//
//   INDEX — id, kinds and label only. Measured and NOT shipped: see below.
//
// The reason is cost, measured on a dev workspace with 83 actions and 10
// entity kinds (2026-08-27): FULL renders 49,263 chars — about 12,300 of the
// ~20,000 input tokens EVERY turn spent, on a workspace that had 14 records
// in it. Three or four questions is a free provider tier's per-minute quota,
// which is how a person asking about their printers got a 429.
//
// How far it can be cut is a measured question, not a taste one
// (scripts/bench-action-rail.ts, 33 utterances, 83 real actions, the real
// tool definitions):
//
//   full   49,263 chars   31/33
//   brief  34,657 chars   31/33   ← shipped; misses the SAME two as full
//   index  11,383 chars   27/33
//
// INDEX is the tempting one and it is wrong: told only that an action exists,
// the model stopped acting and answered in words ("tag the Kossel Mini as
// fragile" → prose). A description is what makes an action recognisable; the
// arguments are not. So BRIEF is the floor, and anyone tempted to cut further
// should re-run the bench rather than reason about it.

export interface RailAction {
  id: string;
  label: string;
  description?: string;
  scope?: string;
  matched_kinds?: string[];
  args_schema?: Record<string, { label?: string; type?: string }> | null;
  examples?: string[];
}

export type RailMode = "full" | "brief" | "index";

const saidLike = (a: RailAction): string =>
  a.examples?.length ? ` — said like: ${a.examples.map((e) => `"${e}"`).join(", ")}` : "";

const argsHint = (a: RailAction): string => {
  const entries = Object.entries(a.args_schema ?? {});
  if (!entries.length) return "";
  return ` — args: ${entries
    .map(([n, spec]) => `${n} (${spec?.type ?? "text"}${spec?.label ? `, ${spec.label}` : ""})`)
    .join("; ")}`;
};

/** Actions that run ON a record, and so are offered per entity kind. */
export function entityActions(all: RailAction[]): RailAction[] {
  return all.filter((a) => a.scope !== "workspace" && (a.matched_kinds?.length ?? 0) > 0);
}

/** Actions that run on the whole workspace (config/admin), with no record. */
export function workspaceActions(all: RailAction[]): RailAction[] {
  return all.filter((a) => a.scope === "workspace");
}

const tail = (a: RailAction, mode: RailMode): string => {
  if (mode === "index") return "";
  const desc = a.description ? `: ${a.description}` : "";
  // BRIEF keeps what makes an action RECOGNISABLE (its description) and drops
  // what is only needed once it has been chosen (argument names, phrasings) —
  // both of which list_actions returns.
  return mode === "brief" ? desc : `${desc}${argsHint(a)}${saidLike(a)}`;
};

export function renderEntityActions(all: RailAction[], mode: RailMode): string[] {
  return entityActions(all).map(
    (a) => `- ${a.id} (on ${a.matched_kinds!.join(", ")}) — ${a.label}${tail(a, mode)}`,
  );
}

export function renderWorkspaceActions(all: RailAction[], mode: RailMode): string[] {
  return workspaceActions(all).map((a) => `- ${a.id} — ${a.label}${tail(a, mode)}`);
}

/** The sentence that has to accompany a trimmed rail. It is imperative on
 *  purpose: told merely that details are available, a model treats the lookup
 *  as friction and answers in words instead of acting (measured — the passive
 *  wording lost five of fifteen action cases that the full rail got right). */
export const RAIL_LOOKUP_NOTE =
  "The lists above are a menu, not the whole story. When the user asks you to DO something and any action above could be it, call list_actions (with the record's kind when you know it) to get that action's arguments and phrasings, THEN call invoke_action. Looking one up is cheap and expected — never answer in words instead of acting, and never guess an action's arguments.";


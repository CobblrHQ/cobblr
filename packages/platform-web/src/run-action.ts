// Running an action is the one place that knows what to refresh afterwards.
//
// Every surface that offered an action re-implemented "what to re-read when
// it is done": the vending renderer invalidated the two keys it knew, the
// chip hook invalidated the labels queue, the app's button nothing at all.
// The newest surface missed the key the page it lived on read through, and
// Groceries → What's on hand kept saying ×1 / in stock after Use / restock
// until a reload, both directions, so a person tapped again (#2969).
//
// So the action's completion says what changed, once: the server answers
// `affected.kinds` (the record's kind and its base kind, the two spellings
// of the same rows), and this refreshes every query that shows records of
// those kinds. A query says which kinds it shows either by carrying the kind
// in its key (`["view-data", slug, viewId, "groceries:item"]`) or by
// declaring `meta.kinds` (`["groceries:item"]`, or `"*"` for a feed over
// every kind, such as the dashboard's attention rows). A workspace action
// names no kind, and everything is refreshed. Undo goes through here too.
//
// And the record itself: a detail reads its record by id
// (`["project", id]`, `["inventory-part", id]`) and seldom names the kind,
// so a query whose key carries the record's id is refreshed as well. Restock
// one moved the table behind an open detail and left the detail saying the
// old quantity (#3615).
//
// No surface calls `api.invokeAction` itself: lint:actions-run-through-one-door.
// And an Undo the action hands back always reaches the person: the hook
// offers it unless the surface draws it itself (offerUndo, #5812).

import { useCallback } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useToast } from "./ToastContext";
import type { PlatformWebApi } from "./types";
import type { ActionUndoStep } from "@cobblr/platform-contract/action-undo";
import { verdictOf } from "./action-outcome-compose";

export interface ActionBody {
  actionId: string;
  entityKind?: string;
  entityId?: string;
  bindingId?: string;
  args?: Record<string, unknown>;
  /** The Undo this press is, as its run handed it back (#7924). */
  undo_id?: string;
  /** The original held by this screen, uploaded outside the JSON arguments. */
  document?: File;
  /** The code of the action label the press came from: the door checks it and
   *  the history says "via label" (#3897). */
  label?: string;
}

export interface ActionAffected {
  kinds: string[];
  entity?: { kind: string; id: string };
}

export interface ActionRun {
  ok: boolean;
  result: unknown;
  undo?: unknown;
  affected?: ActionAffected;
}

/** What a query declares about the records it shows. */
export interface KindMeta {
  kinds?: readonly string[] | "*";
}

/** Does this query show records of any of these kinds? By its key, by its
 *  meta, or by declaring it shows every kind. */
export function queryShowsKinds(query: Pick<Query, "queryKey" | "meta">, kinds: readonly string[]): boolean {
  const meta = (query.meta ?? {}) as KindMeta;
  if (meta.kinds === "*") return true;
  if (Array.isArray(meta.kinds) && meta.kinds.some((k) => kinds.includes(k))) return true;
  return query.queryKey.some((part) => typeof part === "string" && kinds.includes(part));
}

/** The kinds an outcome touched: what the server said, else what was sent. */
export function affectedKindsOf(outcome: Partial<ActionRun> | null | undefined, body: Pick<ActionBody, "entityKind">): string[] {
  const said = outcome?.affected?.kinds;
  if (Array.isArray(said) && said.length) return said;
  return body.entityKind ? [body.entityKind] : [];
}

/** Does this query show this one record? Its key carries the record's id. */
export function queryShowsRecord(query: Pick<Query, "queryKey">, entityId: string | null | undefined): boolean {
  return !!entityId && query.queryKey.some((part) => part === entityId);
}

/** Refresh everything that showed the affected records, and the record the
 *  action ran on. No kinds (a workspace action) refreshes every query, since
 *  anything may have moved. */
export function refreshAfterAction(qc: QueryClient, kinds: readonly string[], entityId?: string | null): void {
  if (kinds.length === 0) {
    void qc.invalidateQueries();
    return;
  }
  void qc.invalidateQueries({ predicate: (q) => queryShowsKinds(q, kinds) || queryShowsRecord(q, entityId) });
}

/** Invoke, then refresh what the action touched. The one door. */
export async function runAction(
  api: Pick<PlatformWebApi, "invokeAction">,
  qc: QueryClient,
  orgSlug: string,
  body: ActionBody,
): Promise<ActionRun> {
  const outcome = (await api.invokeAction(orgSlug, body)) as ActionRun;
  refreshAfterAction(qc, affectedKindsOf(outcome, body), outcome?.affected?.entity?.id ?? body.entityId);
  return outcome;
}

/** One way back, as the action's own undoer said it: an action and its args. */
export type UndoStep = Omit<Extract<ActionUndoStep, { action_id: string }>, "args"> & {
  args?: Record<string, unknown>;
};

/** An outcome's undo, one step or several, as a list. */
export function undoStepsOf(undo: unknown): UndoStep[] {
  return (Array.isArray(undo) ? undo : undo ? [undo] : []).filter((s): s is UndoStep => !!s && typeof (s as UndoStep).action_id === "string");
}

/** How a surface runs an action through the hook. */
export interface RunOptions {
  /** "shown-here": this surface draws the outcome's Undo itself (a row that
   *  ticks off with its own Undo, a card's Undo button). Left out, the door
   *  offers it in a toast, so a returned Undo is never dropped. "is-undo":
   *  this run IS a way back, and is not offered an undo of its own. */
  undo?: "shown-here" | "is-undo";
  /** What the toast says was done; else the action's own summary, else "Done.". */
  done?: string;
}

/** Offer an outcome's Undo: a toast saying what was done, whose Undo runs the
 *  action's own way back through the door. Nothing to undo, nothing offered.
 *  Returns whether it offered one. */
export function offerUndo(
  toast: Pick<ReturnType<typeof useToast>, "action" | "success" | "error">,
  runBack: (body: ActionBody) => Promise<ActionRun>,
  outcome: Pick<ActionRun, "undo" | "result"> | null | undefined,
  _body: Pick<ActionBody, "entityKind" | "entityId">,
  done?: string,
): boolean {
  const steps = undoStepsOf(outcome?.undo);
  if (!steps.length) return false;
  toast.action(done ?? verdictOf(outcome?.result, "Done."), {
    actionLabel: "Undo",
    duration: 8000,
    onAction: async () => {
      try {
        // Issued inverses are authorized with their own target, which may
        // be absent or differ from the record that started the action.
        for (const step of steps) await runBack({
          actionId: step.action_id,
          ...(step.entity_kind !== undefined ? { entityKind: step.entity_kind } : {}),
          ...(step.entity_id !== undefined ? { entityId: step.entity_id } : {}),
          ...(step.undo_id ? { undo_id: step.undo_id } : {}),
          args: step.args ?? {},
        });
        toast.success("Undone.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't undo that.");
      }
    },
  });
  return true;
}

/** The door as a hook: bound to the workspace and the query cache, and the
 *  Undo every action that hands one back is owed. Use one on a counted record
 *  took one and its Undo came back in the response, but no surface showed it
 *  (#5812; #5808 the same for a renewal correction). So the door offers it,
 *  unless the surface says it draws the Undo itself (`undo: "shown-here"`,
 *  held by lint:action-undo-reaches-the-person). */
export function useRunAction(): (body: ActionBody, opts?: RunOptions) => Promise<ActionRun> {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (body: ActionBody, opts?: RunOptions) => {
      const outcome = await runAction(api, qc, orgSlug, body);
      if (!opts?.undo) offerUndo(toast, (b) => runAction(api, qc, orgSlug, b), outcome, body, opts?.done);
      return outcome;
    },
    [api, qc, orgSlug, toast],
  );
}

/** The door with a sentence for what was done: Undo when the action hands
 *  one back, else a plain success toast (#5808: a renewal term corrected with
 *  no Undo). */
export function useRunWithUndo(): (body: ActionBody, done: string) => Promise<ActionRun> {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (body: ActionBody, done: string) => {
      const outcome = await runAction(api, qc, orgSlug, body);
      if (!offerUndo(toast, (b) => runAction(api, qc, orgSlug, b), outcome, body, done)) toast.success(done);
      return outcome;
    },
    [api, qc, orgSlug, toast],
  );
}

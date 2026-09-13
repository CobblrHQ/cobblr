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
// No surface calls `api.invokeAction` itself: lint:actions-run-through-one-door.

import { useCallback } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { PlatformWebApi } from "./types";

export interface ActionBody {
  actionId: string;
  entityKind: string;
  entityId: string;
  bindingId?: string;
  args?: Record<string, unknown>;
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

/** Refresh everything that showed the affected records. No kinds (a
 *  workspace action) refreshes every query, since anything may have moved. */
export function refreshAfterAction(qc: QueryClient, kinds: readonly string[]): void {
  if (kinds.length === 0) {
    void qc.invalidateQueries();
    return;
  }
  void qc.invalidateQueries({ predicate: (q) => queryShowsKinds(q, kinds) });
}

/** Invoke, then refresh what the action touched. The one door. */
export async function runAction(
  api: Pick<PlatformWebApi, "invokeAction">,
  qc: QueryClient,
  orgSlug: string,
  body: ActionBody,
): Promise<ActionRun> {
  const outcome = (await api.invokeAction(orgSlug, body)) as ActionRun;
  refreshAfterAction(qc, affectedKindsOf(outcome, body));
  return outcome;
}

/** The door as a hook: bound to the workspace and the query cache. */
export function useRunAction(): (body: ActionBody) => Promise<ActionRun> {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  return useCallback((body: ActionBody) => runAction(api, qc, orgSlug, body), [api, qc, orgSlug]);
}

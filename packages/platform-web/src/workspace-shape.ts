// Changing the workspace's shape is the one place that knows what to refresh
// afterwards.
//
// An action changes records; run-action.ts refreshes the queries that show
// their kind. Some doors change the workspace's SHAPE instead: saving a
// bundle's features, turning a module on or off, installing or removing a
// bundle, creating or renaming an instance, editing a field definition.
// After one of those the modules, the registered actions, the nav, the
// field defs and the views a record can be shown in are all different, and
// every door re-implemented "what to re-read when it is done" from memory:
// the feature save refreshed the six keys its author knew, the nav gained
// Labels, and an open item still offered no Print label until a reload
// (#2975). Same class as #2969, one level up.
//
// So a shape change refreshes the workspace, once: every query that carries
// the workspace's slug in its key (which is how a workspace query is keyed,
// `["platform-actions", slug, kind]`, `["org-modules", slug]`, ...), every
// query that declares the kinds it shows (`meta.kinds`, since a shape change
// can change what any record looks like), and a query that has neither but
// says `meta: { shape: true }`. Nothing is listed by name, so a shape query
// added tomorrow is refreshed the same day.
//
// No surface calls a shape endpoint itself; it runs it through
// changeWorkspaceShape / useChangeWorkspaceShape:
// lint:shape-changes-run-through-one-door.

import { useCallback } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { KindMeta } from "./run-action";

/** What a query declares about its place in the workspace. */
export interface ShapeMeta extends KindMeta {
  /** A workspace query keyed without the slug says so here. */
  shape?: boolean;
}

/** Is this query part of the workspace's shape, or shaped by it? By the slug
 *  in its key, by the kinds it declares, or by saying so. */
export function queryFollowsWorkspaceShape(query: Pick<Query, "queryKey" | "meta">, slug: string): boolean {
  const meta = (query.meta ?? {}) as ShapeMeta;
  if (meta.shape === true) return true;
  if (meta.kinds === "*" || (Array.isArray(meta.kinds) && meta.kinds.length > 0)) return true;
  return slug !== "" && query.queryKey.includes(slug);
}

/** Refresh everything the workspace's new shape can have changed. Resolves
 *  once the queries on screen have been read back. */
export function afterWorkspaceShapeChange(qc: QueryClient, slug: string): Promise<void> {
  return qc.invalidateQueries({ predicate: (q) => queryFollowsWorkspaceShape(q, slug) });
}

export interface ChangeShapeOptions {
  /** Resolve only once the refresh has landed, for a caller about to select
   *  what it just created (a new dropdown choice) and so needs it on screen
   *  first. Off by default: a toast need not wait for the nav to re-read. */
  settled?: boolean;
}

/** Run a shape endpoint, then refresh the workspace. The one door. The
 *  refresh runs even when the call fails: a bundle applied halfway is a
 *  changed shape too, and reading it back is how the screen tells the truth. */
export async function changeWorkspaceShape<T>(
  qc: QueryClient,
  slug: string,
  run: () => Promise<T>,
  opts: ChangeShapeOptions = {},
): Promise<T> {
  try {
    return await run();
  } finally {
    const refresh = afterWorkspaceShapeChange(qc, slug);
    if (opts.settled) await refresh;
  }
}

/** The door as a hook: bound to the workspace and the query cache. */
export function useChangeWorkspaceShape(): <T>(run: () => Promise<T>, opts?: ChangeShapeOptions) => Promise<T> {
  const { orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  return useCallback(<T,>(run: () => Promise<T>, opts?: ChangeShapeOptions) => changeWorkspaceShape(qc, orgSlug, run, opts), [qc, orgSlug]);
}

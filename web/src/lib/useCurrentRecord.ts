// Which record is this page about?
//
// The rail needs an answer for EVERY kind, including instance kinds and any
// module added next year, and it needs it without each page opting in. A page
// that has to publish itself is a page someone forgets to wire, and the
// Discussion tab would then be quietly missing on exactly the surfaces nobody
// tested.
//
// So it reads the URL against the entity-kind registry, which already carries
// each kind's `detail_route` template ("/inventory/parts/{id}"). Two facts make
// that exact rather than a guess:
//
//  1. `/w/:slug` is the router BASENAME (App.tsx), so `useLocation().pathname`
//     is already stripped of it and lines up with the templates verbatim.
//  2. Matching is anchored and segment-counted, so "/lists/{id}" cannot swallow
//     "/lists/items/{id}" — different segment counts, no collision.
//
// The same registry that resolves kind → route for links now resolves route →
// kind, which is why no page and no module has to know this exists.

import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface CurrentRecord {
  /** Entity kind id, e.g. "machines:machine". */
  kind: string;
  id: string;
  /** `<module>` half of the kind — the source triple's first column. */
  sourceModule: string;
  /** `<type>` half. Normalised to the base kind server-side on write. */
  sourceType: string;
}

/** A `detail_route` template as an anchored matcher. */
function toMatcher(template: string): { re: RegExp } | null {
  if (!template.includes("{id}")) return null; // a static page is not a record
  const escaped = template
    .split("{id}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("([^/]+)");
  return { re: new RegExp(`^${escaped}/?$`) };
}

/** The pure half: which of these kinds does this path name a record of?
 *
 *  Exported for its own test. The property worth pinning is that matching is
 *  ANCHORED and segment-counted, so "/lists/{id}" cannot claim
 *  "/lists/items/abc" with id="items" — a silent mis-attribution that would
 *  file a comment against the wrong record entirely. */
export function matchRecordRoute(
  kinds: ReadonlyArray<{ id: string; detail_route?: string | null }>,
  pathname: string,
): CurrentRecord | null {
  for (const k of kinds) {
    if (!k.detail_route) continue;
    const m = toMatcher(k.detail_route);
    if (!m) continue;
    const hit = m.re.exec(pathname);
    if (!hit?.[1]) continue;
    const [sourceModule, sourceType] = k.id.split(":");
    if (!sourceModule || !sourceType) continue;
    return { kind: k.id, id: hit[1], sourceModule, sourceType };
  }
  return null;
}

export function useCurrentRecord(slug: string): CurrentRecord | null {
  const { pathname } = useLocation();
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });

  return useMemo(
    () => matchRecordRoute(kinds.data?.items ?? [], pathname),
    [kinds.data, pathname],
  );
}

import { NearSpellings } from "@cobblr/platform-web";
import { getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";

/** A web list's filter that found nothing offers the close spellings, each
 *  opening where its own row would (#9643). */
export function ListNearSpellings({ kind, q, noun }: { kind: string; q: string; noun?: string }) {
  const { activeSlug } = useActiveOrg();
  const routeFor = useDetailRoute(activeSlug ?? "");
  if (!activeSlug || !q.trim()) return null;
  return (
    <div className="mt-3 not-italic text-left">
      <NearSpellings slug={activeSlug} kind={kind} q={q} noun={noun} getToken={getToken} hrefFor={(id) => routeFor(kind, id) ?? "#"} />
    </div>
  );
}

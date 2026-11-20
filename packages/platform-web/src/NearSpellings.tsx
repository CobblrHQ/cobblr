// A list's filter that found nothing offers the close spellings (#9643).
//
// "drills" typed in Parts, in a workspace holding a "Cordless drill", left the
// list empty, and the person was told there is no drill: the search page and
// the palette ask again by near words (#9631), a list's filter did not. What
// would be expensive if wrong: a person told they have no drill buys another.
// Asked once, when the filter's words as typed found nothing, through the
// kind's own list with near=1 (#9642), and said for what it is: close
// spellings, each by its own name, never the exact match.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { workspaceFetch } from "./acting-role";

interface NearItem {
  id: string;
  title?: string | null;
  name?: string | null;
}

/** The kind's records a near spelling of `q` finds, at most `limit`. */
export async function nearSpellings(slug: string, kind: string, q: string, token: string | null, limit = 8): Promise<NearItem[]> {
  const res = await workspaceFetch(`/api/v1/orgs/${encodeURIComponent(slug)}/entities/${encodeURIComponent(kind)}?q=${encodeURIComponent(q)}&near=1&limit=${limit}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`close spellings answered ${res.status}`);
  const body = (await res.json()) as { items?: NearItem[] };
  return body.items ?? [];
}

export function NearSpellings({ slug, kind, q, hrefFor, noun, getToken }: {
  slug: string;
  /** The session the page's own reads go with. */
  getToken: () => string | null;
  kind: string;
  /** The filter's words as typed, which found nothing. */
  q: string;
  /** Where one of them opens, the way the list's own rows do. */
  hrefFor: (id: string) => string;
  /** What the list calls one, for the sentence. */
  noun?: string;
}) {
  const words = q.trim();
  const near = useQuery({
    queryKey: ["near-spellings", slug, kind, words],
    queryFn: () => nearSpellings(slug, kind, words, getToken()),
    enabled: !!slug && words.length > 0,
    staleTime: 30_000,
  });
  if (!words || !near.isSuccess || near.data.length === 0) return null;
  return (
    <div className="space-y-2 text-sm" data-testid="near-spellings">
      <p className="text-muted dark:text-slate-400">
        No exact match for “{words}”; showing close spellings{noun ? ` of ${noun}` : ""}.
      </p>
      <ul className="flex flex-col gap-1">
        {near.data.map((it) => (
          <li key={it.id}>
            <Link to={hrefFor(it.id)} className="text-accent hover:underline">
              {it.title || it.name || it.id}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

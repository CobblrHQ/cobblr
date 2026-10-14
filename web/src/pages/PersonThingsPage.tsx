// /people/:who — everything that belongs to one person, across every
// collection (#3787). `/people/me` is My things. Reached from the account menu
// and from each row of Configuration → People.
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PersonThingsPage() {
  const { who = "me" } = useParams<{ who: string }>();
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const q = useQuery({
    queryKey: ["person-things", slug, who],
    queryFn: () => api.personThings(slug, who),
    enabled: !!slug,
    retry: false,
  });
  const mine = who === "me";
  const title = mine ? "My things" : q.data ? `${q.data.person.name}'s things` : "Their things";
  usePageTitle(title);

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 flex items-center gap-2">
        <Package size={22} /> {title}
      </h1>
      {q.isLoading && <p className="text-sm text-faint">Looking…</p>}
      {q.error && (
        <p className="text-sm text-ember-500">{q.error instanceof ApiError ? q.error.message : "Couldn't look that up."}</p>
      )}
      {q.data && q.data.count === 0 && (
        <p className="text-sm text-muted dark:text-slate-400" data-testid="person-things-empty">
          {mine ? "Nothing is marked as yours yet." : `Nothing is marked as ${q.data.person.name}'s yet.`} A field of type
          person, like Owner, says whose a thing is.
        </p>
      )}
      {q.data?.groups.map((g) => (
        <section key={`${g.kind}:${g.field}`} className="space-y-2" data-testid="person-things-group">
          <h2 className="text-[11px] uppercase tracking-widest text-muted">
            {`${g.label} (${g.items.length})`}
            <span className="normal-case tracking-normal ml-2 text-faint">by {g.field_label}</span>
          </h2>
          <ul className="space-y-1.5">
            {g.items.map((it) => (
              <li key={it.id} className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-sm">
                {it.path ? (
                  <Link to={it.path} className="text-content dark:text-mortar-100 hover:underline">
                    {it.title}
                  </Link>
                ) : (
                  <span className="text-content dark:text-mortar-100">{it.title}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

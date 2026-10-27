import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { usePageTitle } from "@cobblr/platform-web";
import { dayHere } from "@cobblr/platform-contract/day";
import { loanOverdue } from "@cobblr/platform-contract/loan";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { useDetailRoute } from "../lib/useDetailRoute";
import { groupLentByHolder, type LentRow } from "../lib/lent-out";

/** What is out right now, by who has it. The loan itself is made and ended on the record. */
export function LentOutPage() {
  usePageTitle("Lent out");
  const { activeSlug } = useActiveOrg();
  const routeFor = useDetailRoute(activeSlug ?? "");
  const loans = useQuery({
    queryKey: ["loans", activeSlug],
    queryFn: () => api.request<{ items: LentRow[] }>("GET", `/orgs/${activeSlug}/loans`),
    enabled: !!activeSlug,
  });
  const today = dayHere(new Date());
  if (loans.isLoading) return <p role="status">Loading what is lent out…</p>;
  if (loans.isError) return <p role="alert">{loans.error.message}</p>;
  const items = loans.data?.items ?? [];
  const groups = groupLentByHolder(items, today);
  if (!groups.length) return <p>Nothing is lent out. Open a record and choose Lend to say who has it.</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {items.length === 1 ? "1 thing is" : `${items.length} things are`} out, with {groups.length === 1 ? "1 person" : `${groups.length} people`}.
      </p>
      <ul className="space-y-3">
        {groups.map((g) => (
          <li key={g.holder} data-testid="lent-holder" className="rounded-xl border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold break-words">
              {g.holder}
              {g.overdue > 0 && <span className="ml-2 text-xs font-medium text-ember-700 dark:text-ember-300">{g.overdue} overdue</span>}
            </h2>
            <ul className="mt-2 space-y-1">
              {g.rows.map((r) => {
                const to = routeFor(r.kind, r.id);
                return (
                  <li key={`${r.kind}:${r.id}`} data-testid="lent-row" className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    {to ? <Link to={to} className="min-w-0 break-words text-accent hover:underline">{r.title}</Link> : <span className="min-w-0 break-words">{r.title}</span>}
                    <span className={`text-xs ${loanOverdue(r, today) ? "font-medium text-ember-700 dark:text-ember-300" : "text-muted"}`}>
                      {r.said.replace(/^With [^·]+· /, "")}
                      {loanOverdue(r, today) ? " · overdue" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

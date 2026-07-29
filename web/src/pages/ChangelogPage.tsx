// Public "What's new" page. Renders the parsed CHANGELOG.md (GET /changelog),
// date-grouped, with a type badge per entry. Reachable signed-in or signed-out.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Sparkles, ArrowLeft } from "lucide-react";
import { api, type ChangelogEntry } from "../lib/api";

const BADGE: Record<ChangelogEntry["type"], { label: string; cls: string }> = {
  feature: { label: "New", cls: "bg-cobble-100 text-cobble-700 dark:bg-cobble-500/15 dark:text-cobble-300" },
  improvement: { label: "Improved", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  fix: { label: "Fixed", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
  change: { label: "Changed", cls: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300" },
};

function prettyDate(iso: string): string {
  // iso is "YYYY-MM-DD" (UTC date the digest stamped). Render relative-ish.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  const today = new Date();
  const days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function ChangelogPage() {
  const q = useQuery({ queryKey: ["changelog"], queryFn: () => api.changelog() });
  const sections = q.data?.sections ?? [];

  return (
    <div className="min-h-screen bg-canvas dark:bg-slate-950 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={20} className="text-cobble-600 dark:text-cobble-400" />
            <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">What's new</h1>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-content dark:text-slate-400 dark:hover:text-slate-200 transition"
          >
            <ArrowLeft size={13} /> Back
          </Link>
        </div>

        {q.isLoading && <div className="text-xs font-mono text-faint dark:text-slate-500">loading…</div>}
        {q.isError && (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-sm text-muted dark:text-slate-400">
            Couldn't load the changelog right now.
          </div>
        )}
        {!q.isLoading && !q.isError && sections.length === 0 && (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 text-sm text-muted dark:text-slate-400">
            Nothing here yet - updates will show up as they ship.
          </div>
        )}

        <div className="space-y-8">
          {sections.map((day) => (
            <section key={day.date}>
              <h2 className="mb-3 text-[11px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                {prettyDate(day.date)}
              </h2>
              <ul className="space-y-2.5">
                {day.entries.map((e, i) => {
                  const badge = BADGE[e.type] ?? BADGE.change;
                  return (
                    <li
                      key={i}
                      className="flex gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3"
                    >
                      <span className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <p className="text-sm leading-relaxed text-content dark:text-mortar-100">
                        {e.scope && <span className="text-muted dark:text-slate-400">{e.scope}: </span>}
                        {e.text}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

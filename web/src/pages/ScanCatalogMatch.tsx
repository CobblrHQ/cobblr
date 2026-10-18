// The catalog entries a scan could be, beside its confirm (#6888): scan a
// Lego brick in a workspace with the Rebrickable catalogs and its part is
// offered; tapping it files the record bound to that entry. Loaded beside the
// form, never before it: the confirm never waits on the match, and nothing
// renders when no catalog applies. Nothing is picked for the person, so a
// candidate is a suggestion until tapped.

import { useQuery } from "@tanstack/react-query";
import { BookMarked, Check } from "lucide-react";
import { EntityPhoto } from "@cobblr/platform-web";
import { api, type ScanCatalogCandidate } from "../lib/api";

const BASIS_WORDS: Record<ScanCatalogCandidate["basis"], string> = {
  "part-number": "its part number",
  name: "its name",
  ai: "the AI's pick",
};

export function ScanCatalogMatch({
  slug,
  itemId,
  kind,
  picked,
  onPick,
}: {
  slug: string;
  itemId: string;
  /** Where it is being filed: a catalog applies only when it binds there. */
  kind: string;
  picked: string | null;
  onPick: (id: string | null) => void;
}) {
  const q = useQuery({
    queryKey: ["scan-catalog-candidates", slug, itemId, kind],
    queryFn: () => api.scanCatalogCandidates(slug, itemId, kind),
    staleTime: 60_000,
  });
  const items = q.data?.candidates ?? [];
  if (!items.length) return null;
  return (
    <div data-testid="scan-catalog-match" className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint dark:text-slate-500">
        <BookMarked size={12} aria-hidden /> Matches a catalog entry
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((c) => {
          const on = picked === c.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : c.id)}
              title={`${c.title} (#${c.external_id}) in ${c.catalog}, matched by ${BASIS_WORDS[c.basis]}. ${on ? "Tap again to file it without the match." : "Tap to file it bound to this entry."}`}
              className={
                "inline-flex min-h-11 max-w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs transition " +
                (on
                  ? "border-accent bg-accent/10 text-content dark:bg-accent/20 dark:text-mortar-100"
                  : "border-line bg-surface text-content hover:border-accent dark:border-slate-700 dark:bg-slate-900 dark:text-mortar-100")
              }
            >
              {c.image ? <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded"><EntityPhoto src={c.image} alt="" fill fit="contain" className="bg-transparent" /></span> : null}
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.title}</span>
                <span className="block truncate text-faint dark:text-slate-400">
                  #{c.external_id} · {c.catalog} · by {BASIS_WORDS[c.basis]}
                </span>
              </span>
              {on ? <Check size={14} className="shrink-0 text-accent" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

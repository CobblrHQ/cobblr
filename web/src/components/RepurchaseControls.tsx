// A scan of something you already have: the record it matched, and the
// File everything plan's per-line choice.
//
// The three re-buy BUTTONS that used to live here ("Replaced the one that ran
// out", "+1, still had some", "Old one went bad") are gone from the card and
// the banner: the count is changed by what is in your hands, or set to the
// total, in ScanCountBlock, and those reasons are an optional chip there
// (#3884). The plan keeps its choice, in the collection's own words (the
// faces verdict through repurchaseWords), because a bulk file has no stepper.
import { useQuery } from "@tanstack/react-query";
import { useFaces } from "@cobblr/platform-web";
import { repurchaseWords, type RestockChoice } from "@cobblr/platform-contract/kind-label";
import { api, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useKindLabels } from "../lib/useKindLabels";

/** The best tracked match for a scan and the name of where it lives. The inbox
 *  card only carries a cached title, so this resolves the record from the same
 *  endpoint the banner uses; a caller that already holds the match passes it
 *  and no request is made. */
export function useBestTrackedMatch(itemId: string, matchProp?: TrackedMatch | null) {
  const { activeSlug } = useActiveOrg();
  const resolved = useQuery({
    queryKey: ["scan-tracked", activeSlug, itemId],
    queryFn: () => api.scanTrackedMatches(activeSlug, itemId),
    enabled: !matchProp && !!itemId,
    staleTime: 60_000,
  });
  const match: TrackedMatch | null =
    matchProp ??
    (resolved.data?.barcode_matches ?? []).concat(resolved.data?.name_matches ?? [])[0] ??
    null;
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && !!match?.location_id,
    staleTime: 60_000,
  });
  const where = match?.location_id
    ? ((locations.data?.items ?? []).find((l) => l.id === match.location_id)?.name ?? null)
    : null;
  return { match, where };
}

/** The restock answers a scan of a record you already have can give, in the
 *  collection's own words: the File N plan's choice on a line that adds to a
 *  record you already have. Pure. */
export function repurchaseOptions(words: ReturnType<typeof repurchaseWords>): Array<{ key: RestockChoice; label: string; title?: string }> {
  return [
    words.replace ? { key: "replaced" as const, label: words.replace.label, title: words.replace.title } : null,
    { key: "add" as const, label: words.add.label, title: words.add.title || undefined },
    words.wentBad ? { key: "went_bad" as const, label: words.wentBad.label, title: words.wentBad.title } : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
}

/** The File N plan's side: the same answers as a choice on a line that adds
 *  to a record you already have. The plan files by it (seen[].restock). */
export function RestockPlanChoice({ kind, qty, hasSome, value, onChange }: { kind: string; qty: number; hasSome: boolean; value: RestockChoice; onChange: (v: RestockChoice) => void }) {
  const { activeSlug } = useActiveOrg();
  const worn = useFaces(kind);
  const noun = useKindLabels(activeSlug).noun(kind);
  if (!worn.verdict) return null;
  const options = repurchaseOptions(repurchaseWords({ stock: worn.on.has("stock"), perishable: worn.on.has("perishable") }, noun, qty, hasSome));
  if (options.length < 2) return null;
  return (
    <select
      value={value}
      data-testid="plan-restock"
      aria-label="What this one means for what you have"
      onChange={(e) => onChange(e.target.value as RestockChoice)}
      className="shrink-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs text-content dark:text-mortar-100"
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}


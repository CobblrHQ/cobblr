// "Do these belong together?" - asked about ONE session's group, and only when
// asked.
//
// This used to run on every inbox load, over the 50 most recent pending items
// in the whole workspace (2026-09-03), and then over every pending row of the
// session's batch while the sentence counted the rows the group showed: a
// group of three imported teas read "These 3 look related... Also add category
// Groceries to 10 of them", and Tag them would have tagged rows nobody could
// see (#3595). A bulk suggestion is now built from ONE explicit list: the
// group sends the ids it shows, the server answers about exactly those and
// returns them, and every number, every name and the button's own label below
// is read from that answer. Apply sends the same ids back and nothing else.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanSessionThemeAnswer } from "../lib/api";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

export interface ThemeWords {
  /** What the suggestion says, counted from the answer alone. */
  sentence: string;
  /** The items the category goes on, by name, when it is not all of them. */
  categoryNames: string[] | null;
  /** The button: says exactly how many rows it changes. */
  button: string;
  /** Every id Apply would touch: the union of the two changes. */
  touches: string[];
}

const nameOf = (a: ScanSessionThemeAnswer, id: string) => a.items.find((i) => i.id === id)?.name?.trim() || "an unnamed item";

/** The words and the scope of a theme, from one answer. Null when it proposes
 *  nothing. Every count is the length of an id list the answer carries, and
 *  those lists are all inside `items`, so they cannot disagree. */
export function themeWords(a: ScanSessionThemeAnswer): ThemeWords | null {
  const inSet = new Set(a.items.map((i) => i.id));
  const tagIds = a.tag ? a.tag_item_ids.filter((id) => inSet.has(id)) : [];
  const catIds = a.category ? a.category.item_ids.filter((id) => inSet.has(id)) : [];
  if (!tagIds.length && !catIds.length) return null;
  const n = a.items.length;
  const catAll = catIds.length === n;
  const categoryNames = catIds.length && !catAll ? catIds.map((id) => nameOf(a, id)) : null;
  const touches = [...new Set([...tagIds, ...catIds])];
  if (tagIds.length) {
    const cat = a.category && catIds.length ? ` Also add category "${a.category.value}" to ${catAll ? `all ${n}` : `${catIds.length} of them`}.` : "";
    return {
      sentence: `These ${tagIds.length} look related. Tag each of them "${a.tag}"? A tag on each row; nothing is combined.${cat}`,
      categoryNames,
      button: `Tag ${tagIds.length}`,
      touches,
    };
  }
  return {
    sentence: `${catAll ? `All ${n}` : `${catIds.length} of these ${n}`} look like "${a.category!.value}". Add that category to each? A field on each row; nothing is combined.`,
    categoryNames,
    button: `Add to ${catIds.length}`,
    touches,
  };
}

export function ScanSessionTheme({ slug, batchId, itemIds, evidence }: { slug: string; batchId: string; itemIds: readonly string[]; evidence: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const ids = [...itemIds].sort();
  const theme = useQuery({
    // The ids are the question: a group that grows as more rows load is a
    // different question with its own answer.
    queryKey: ["scan-session-theme", slug, batchId, ids.join(",")],
    queryFn: () => api.scanSessionTheme(slug, batchId, ids),
    enabled: !dismissed && ids.length >= 2,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const answer = theme.data;
  const words = answer ? themeWords(answer) : null;
  const apply = useMutation({
    mutationFn: () => {
      const a = answer!;
      const inSet = new Set(a.items.map((i) => i.id));
      return api.applyScanTheme(slug, {
        ...(a.tag ? { tag: a.tag, tag_item_ids: a.tag_item_ids.filter((id) => inSet.has(id)) } : {}),
        ...(a.category ? { category: { value: a.category.value, item_ids: a.category.item_ids.filter((id) => inSet.has(id)) } } : {}),
      });
    },
    onSuccess: (r) => {
      toast.success(`Tagged ${r.tagged}${r.categorized ? ` · categorised ${r.categorized}` : ""} - applied when you confirm each.`);
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      setDismissed(true);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't apply that."),
  });
  if (dismissed || ids.length < 2) return null;
  if (theme.isFetching) return <div className="pt-0.5 text-xs text-faint">Reading the {ids.length}…</div>;
  if (!answer || !words) {
    // Evidence that led nowhere says nothing: the rows agreed on a category
    // and the pass found nothing to add, so there is no question to ask.
    if (evidence || !answer) return null;
    return (
      <div className="pt-0.5 text-xs text-faint">
        Nothing these {answer.items.length} obviously share.{" "}
        <button type="button" onClick={() => setDismissed(true)} className="underline hover:text-content">
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div data-testid="session-theme" data-evidence={evidence ? "" : undefined} className="pt-0.5 rounded-lg border border-cobble-300 dark:border-cobble-700/60 bg-cobble-50/70 dark:bg-cobble-950/20 px-3 py-2.5 flex items-center gap-3">
      <Sparkles size={15} className="text-accent shrink-0" />
      <div className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">
        <span data-testid="session-theme-sentence">{words.sentence}</span>
        {words.categoryNames && (
          <span data-testid="session-theme-category-items" className="block text-xs text-muted">
            The category goes on: {words.categoryNames.join(", ")}.
          </span>
        )}
      </div>
      <button
        type="button"
        data-testid="session-theme-apply"
        disabled={apply.isPending}
        onClick={() => apply.mutate()}
        className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {apply.isPending ? "Applying…" : words.button}
      </button>
      <button aria-label="Dismiss" type="button" onClick={() => setDismissed(true)} className="shrink-0 text-faint hover:text-content p-1" title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

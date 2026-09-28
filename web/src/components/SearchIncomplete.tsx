// What a search result says when some of it could not be searched.
//
// A search fans out to every kind the workspace has, and a kind whose search
// FAILED used to come back empty, exactly like one that found nothing. For
// three weeks every search on a real workspace skipped orders and projects
// that way, and the only sign was a server log (#3824). The api now names the
// kinds it could not search (`kinds_failed`), and every surface that shows
// search results says so here, in words, instead of showing a quietly shorter
// list.
import { AlertTriangle } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useKindLabels } from "../lib/useKindLabels";

/** The sentence, or null when nothing failed. Pure, so it is tested. */
export function searchIncompleteWords(failed: readonly string[] | undefined, collection: (kind: string) => string): string | null {
  if (!failed || failed.length === 0) return null;
  const names = [...new Set(failed.map(collection))];
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `Some of your things couldn't be searched just now (${list}), so they may be missing here. Try again in a moment.`;
}

export function SearchIncomplete({ failed, compact = false }: { failed: readonly string[] | undefined; compact?: boolean }) {
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const words = searchIncompleteWords(failed, (k) => labels.collection(k));
  if (!words) return null;
  return (
    <div
      role="status"
      className={
        "flex items-start gap-1.5 rounded-md border border-ember-200 bg-ember-50/60 text-ember-800 dark:border-ember-700/40 dark:bg-slate-900 dark:text-ember-200 " +
        (compact ? "px-2 py-1 text-[11px]" : "px-3 py-2 text-xs")
      }
    >
      <AlertTriangle size={compact ? 11 : 13} className="mt-0.5 shrink-0" />
      <span>{words}</span>
    </div>
  );
}

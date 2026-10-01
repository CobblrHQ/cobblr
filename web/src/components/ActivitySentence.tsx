// One activity entry as a sentence: who, what they did, and the thing, named
// and linked when it still exists ("Robin restocked BANANAS").
//
// The dashboard's Recent activity and the full Activity page both render it,
// so the page a person opens to read further back says the same thing in the
// same words. Before, the dashboard spoke and the Activity page showed
// "tag_created tag:277fddb0" over a raw JSON diff; the ids and the diff are
// still on the page, one tap down, for whoever needs them.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { withArticle } from "@cobblr/platform-contract/plural";
import type { ActivityEntry } from "../lib/api";
import { AUTOMATION_ACTIONS, activityVerb, automationWords, updatedFieldsWords } from "../lib/activity-words";
import { activityKind } from "../lib/activityKind";
import { openSheetImport } from "../lib/sheet-import";
import { useDetailRoute } from "../lib/useDetailRoute";
import type { useKindLabels } from "../lib/useKindLabels";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ACTOR_CELL, ActorVia, ITEM_CELL } from "./ActorVia";

export type KindLabels = ReturnType<typeof useKindLabels>;

export function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** What a row is about, in words: the name it was made with, else the live
 *  record's name the server resolved, else the field and value that changed,
 *  else the kind's own noun. */
export function activityTitle(e: ActivityEntry, labels: KindLabels): ReactNode {
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  if (AUTOMATION_ACTIONS.has(e.action)) {
    const w = automationWords(e);
    return w.hidden ? null : w.said;
  }
  const title = pickString(diff, ["name", "title", "label"]) ?? e.entity_title;
  if (title) return title;
  const changed = /_updated$|^updated$/.test(e.action) ? updatedFieldsWords(e.said) : null;
  const noun = labels.noun(activityKind(e));
  return changed ? <span className="text-xs text-faint">{withArticle(noun)}: {changed}</span> : <span className="text-xs text-faint">{noun}</span>;
}

/** The actor, the verb and the thing, as inline cells of an ACTIVITY_ROW. */
export function ActivitySentence({ entry: e, labels }: { entry: ActivityEntry; labels: KindLabels }) {
  // An automation row is one sentence in the action's own words; the verb
  // would only repeat "ran an automation" in front of it.
  const auto = AUTOMATION_ACTIONS.has(e.action) ? automationWords(e) : null;
  const { activeSlug } = useActiveOrg();
  const routeFor = useDetailRoute(activeSlug);
  // The record, when it is still there (the server resolved its collection):
  // the row names it AND opens it, the way every other mention of a record does.
  const href = !auto && e.entity_kind && e.entity_id ? routeFor(e.entity_kind, e.entity_id) : null;
  return (
    <>
      <span className={`text-muted dark:text-slate-400 ${ACTOR_CELL}`}>
        <ActorVia entry={e} />
      </span>
      {!auto && <span className="text-content dark:text-mortar-200 shrink-0">{activityVerb(e.action)}</span>}
      <span className={`text-content dark:text-mortar-100 ${ITEM_CELL}`} data-testid="activity-item">
        {auto ? (
          auto.hidden ? null : auto.said
        ) : href ? (
          <Link to={href} className="hover:underline" data-testid="activity-item-link">
            {activityTitle(e, labels)}
          </Link>
        ) : (
          activityTitle(e, labels)
        )}
      </span>
      {e.entity_type === "import_run" && e.entity_id && (
        <button type="button" onClick={() => openSheetImport({ runId: e.entity_id })} className="shrink-0 text-xs text-accent hover:underline">
          Open
        </button>
      )}
    </>
  );
}

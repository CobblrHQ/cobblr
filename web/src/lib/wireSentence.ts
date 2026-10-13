// A saved wire as a sentence (#6110): "When “Coffee beans” runs out → Add to
// a list", then what it was given ("Which list: Shopping"). The ids stay on
// the row beneath it for diagnosis.
import { STOCK_CHANGED_EVENT, readStockChange, stockChangePhrase, type NarrowingCondition } from "@cobblr/platform-contract/wire-narrowing";
import type { PlatformBinding } from "./api";

export interface WireSentence {
  /** "When “Coffee beans” runs out → Add to a list", or null with no words to say. */
  headline: string | null;
  /** "Which list: Shopping · How many: 2", or null. */
  given: string | null;
}

export function wireSentence(b: PlatformBinding): WireSentence {
  const said = b.said;
  if (!said) return { headline: null, given: null };
  const f = b.filter as { all?: NarrowingCondition[] } | null;
  const phrase = b.trigger_event === STOCK_CHANGED_EVENT ? stockChangePhrase(readStockChange(f?.all ?? []).change) : null;
  const when = said.record ? `When “${said.record.title ?? "a record that is gone"}” ${phrase ?? "changes"}` : null;
  const action = said.action ?? b.action_id;
  return {
    headline: when ? `${when} → ${action}` : said.action,
    given: said.args.length ? said.args.map((a) => `${a.label}: ${a.value}`).join(" · ") : null,
  };
}

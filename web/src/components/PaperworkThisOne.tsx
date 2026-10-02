// "It's this one": an inbox card made from a document (a bill of sale) whose
// identifier (its VIN) found a record the workspace already has.
//
// A car is not stock: "+1 more, you have 1 → 2" offered to make a second car
// out of the paperwork for the first (#4523). The answer here is the record
// path: the document goes onto the record you already have, its purchase line
// is claimed for it, its empty fields are filled, every disagreement is asked
// about, and the card is done.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import type { ScanInboxItem, TrackedMatch } from "../lib/api";
import { ApiError, api, type PaperworkConflict, type PaperworkHeld } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { PaperworkConflicts, paperworkNoun, useAnnouncePaperwork } from "./PaperworkConflicts";

/** A card from a document about a record already here: its paper is about
 *  that record, not a second one. One rule, in the contract, for the card,
 *  the row's action and the server (#4633). */
export { isPaperworkMatch } from "@cobblr/platform-contract/scan-triage";

export function PaperworkThisOne({ item, match }: { item: ScanInboxItem; match: TrackedMatch }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const record = { kind: match.kind, id: match.id };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    void qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(match.id) });
  };
  const announce = useAnnouncePaperwork(activeSlug, record, refresh);
  const [asked, setAsked] = useState<{ noun: string; conflicts: PaperworkConflict[]; held: PaperworkHeld[]; waiting: "busy" | "limit" | null } | null>(null);
  const go = useMutation({
    mutationFn: () => api.inboxItemIsThisOne(activeSlug, item.id, record),
    onSuccess: (r) => {
      if (!r.read) {
        toast.error(`Couldn't put it on ${match.title}: ${r.reason}`);
        return;
      }
      announce(r);
      // The card stays to ask about any disagreement; it leaves when that is answered.
      if (r.conflicts.length || r.held?.length || r.waiting) setAsked({ noun: paperworkNoun(r), conflicts: r.conflicts, held: r.held ?? [], waiting: r.waiting ?? null });
      else refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't put it on the record."),
  });
  if (asked) {
    return (
      <div data-testid="paperwork-this-one-asked" onClick={(e) => e.stopPropagation()}>
        <PaperworkConflicts slug={activeSlug} record={record} noun={asked.noun} conflicts={asked.conflicts} held={asked.held} waiting={asked.waiting} onChanged={refresh} />
      </div>
    );
  }
  return (
    <div data-testid="paperwork-this-one" className="flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
      {/* A code proved it; a name only suggests it, so it is asked. */}
      <span className="text-content dark:text-mortar-100">
        {match.matched_by === "identifier" ? `This paperwork is for ${match.title}.` : `Is this the paperwork for ${match.title}?`}
      </span>
      <button
        type="button"
        onClick={() => go.mutate()}
        disabled={go.isPending}
        title={`Keeps the document on ${match.title}, links its purchase, and fills only the fields it has empty`}
        className="inline-flex items-center rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 font-medium disabled:opacity-50"
      >
        {go.isPending ? "Putting it on…" : "It's this one"}
      </button>
    </div>
  );
}

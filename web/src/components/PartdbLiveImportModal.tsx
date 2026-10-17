// Part-DB — the one-click LIVE import card. The flow lives in LiveImportModal;
// this is Part-DB's descriptor. Two things are Part-DB-specific:
//   • Part-DB stocks one part in several places (lots). A part lands as one
//     card with a row for each place, so the parts section previews first and
//     the summary says how many parts that applies to and how many places it
//     makes.
//   • A token can be valid and still be refused: the token's user needs the
//     "Access API" permission, and Part-DB answers 403, not 401. Telling the
//     user to re-paste the token would not help, so the 403 gets its own copy.

import { LiveImportModal, type LiveImportSource } from "./LiveImportModal";
import type { ImportPlan } from "../lib/api";

/** What the import does with parts kept in several bins: each is one card with
 *  a place for every bin, so say how many parts and how many places. Counted
 *  from the previewed records, which carry how many more places each makes. */
export function placesNote(plan: ImportPlan): string[] {
  const kept = plan.items.filter((it) => (it.holdings ?? 0) > 0);
  if (kept.length === 0) return [];
  const places = kept.reduce((n, it) => n + (it.holdings ?? 0), 0);
  return [
    `${kept.length} ${kept.length === 1 ? "part is" : "parts are"} kept in more than one place. Each lands as one card with a row for every place, ${places} more ${places === 1 ? "place" : "places"} in all, and the card's quantity is the total across them.`,
  ];
}

export const PARTDB_LIVE: LiveImportSource = {
  connectorId: "partdb",
  name: "Part-DB",
  addressLabel: "Part-DB address",
  addressPlaceholder: "http://parts.local:8080",
  tokenPlaceholder: "Part-DB → User settings → API tokens",
  intro: (
    <>
      In Part-DB, open <strong>User settings → API tokens</strong> and create one (read-only is enough). Paste your
      Part-DB address and that token below. Parts land in <strong>Inventory</strong> with their categories, and the
      storage-location tree rebuilds your <strong>Locations</strong>. You choose whether to import once or keep it
      synced.
    </>
  ),
  sections: [
    { key: "locations", running: "your storage locations", stat: "locations" },
    { key: "categories", running: "your categories", stat: "categories" },
    {
      key: "parts",
      running: "your parts",
      stat: "parts imported",
      previewNotes: placesNote,
    },
  ],
  viewHref: "/inventory",
  viewLabel: "View Inventory",
  testErrorHint: (error) =>
    /→ 403\b/.test(error)
      ? 'Part-DB accepted the token but refused API access. In Part-DB, grant the token\'s user or group the "Access API" permission, then try again.'
      : null,
};

export function PartdbLiveImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <LiveImportModal source={PARTDB_LIVE} open={open} onClose={onClose} />;
}

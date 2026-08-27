// Part-DB — the one-click LIVE import card. The flow lives in LiveImportModal;
// this is Part-DB's descriptor. Two things are Part-DB-specific:
//   • Part-DB stocks one part in several places (lots). Cobblr keeps one
//     location per part today, so the parts section previews first and the
//     summary says how many parts were collapsed, rather than dropping the
//     fact quietly. Every lot is kept on the part.
//   • A token can be valid and still be refused: the token's user needs the
//     "Access API" permission, and Part-DB answers 403, not 401. Telling the
//     user to re-paste the token would not help, so the 403 gets its own copy.

import { LiveImportModal, type LiveImportSource } from "./LiveImportModal";
import type { ImportPlan } from "../lib/api";

/** Parts whose Part-DB record carries more than one lot: the single location_id
 *  Cobblr keeps is a lossy pick for exactly these. Counted from the previewed
 *  records (the mapped metadata rides in `fields`). */
export function multiLotCount(plan: ImportPlan): number {
  let n = 0;
  for (const it of plan.items) {
    const md = (it.fields?.metadata as { partdb?: { lots?: unknown } } | undefined)?.partdb;
    if (Array.isArray(md?.lots) && md.lots.length > 1) n += 1;
  }
  return n;
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
      previewNotes: (plan) => {
        const n = multiLotCount(plan);
        if (n === 0) return [];
        return [
          `${n} ${n === 1 ? "part is" : "parts are"} stocked in more than one place. Cobblr tracks one location per part, so each landed at its first lot's location. Every lot is kept on the part, and the quantity is the total across all of them.`,
        ];
      },
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

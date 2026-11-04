import { Modal } from "@cobblr/platform-web";
import { doubtQuestion, type DoubtedRow } from "../pages/scanFileAll";

/** The one question a person's own ticked rows get when some don't look like
 *  their table (#9179). They chose the rows, so they decide. */
export function ScanDoubtAsk({ rows, onFile, onLeave }: { rows: readonly DoubtedRow[]; onFile: () => void; onLeave: () => void }) {
  const one = rows.length === 1;
  return (
    <Modal open onClose={onLeave} size="sm">
      <div className="p-4 space-y-4">
        <p className="text-sm text-content dark:text-mortar-100">{doubtQuestion(rows)}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onLeave} className="min-h-[44px] rounded border border-line dark:border-slate-600 px-3 text-sm text-content hover:bg-subtle dark:hover:bg-slate-700 transition">
            {one ? "Leave it" : "Leave them"}
          </button>
          <button type="button" onClick={onFile} className="min-h-[44px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 text-sm font-medium transition">
            {one ? "File it anyway" : "File them anyway"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

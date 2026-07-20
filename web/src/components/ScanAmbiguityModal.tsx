// Disambiguation for a scanned key that names more than one entity.
//
// A serial number is unique per product line, not per workspace, so two parts
// legitimately carry "A7" and only the person holding one knows which. The
// resolver deliberately refuses to choose (see qr-resolver.ts, outcome
// "ambiguous"); this is where the human does.
//
// Deliberately NOT a "smart" ranking: any order we invented would be a guess
// wearing confidence. Candidates arrive in resolver order and carry their kind,
// so a part and a unit sharing a serial are visibly different things.

import { Modal } from "@cobblr/platform-web";
import type { ScanResolveCandidate } from "../lib/api";

export function ScanAmbiguityModal({
  scanKey,
  candidates,
  truncated,
  onPick,
  onClose,
}: {
  scanKey: string;
  candidates: ScanResolveCandidate[];
  truncated: boolean;
  onPick: (c: ScanResolveCandidate) => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`“${scanKey}” matches ${candidates.length} things`}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Pick the one you are holding.
          {truncated
            ? " There are more matches than shown, which usually means the numbering has outgrown its length."
            : ""}
        </p>

        <ul className="space-y-2">
          {candidates.map((c) => (
            <li key={`${c.entity_kind}:${c.entity_id}`}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5
                           text-left hover:border-blue-500 hover:bg-blue-50/50
                           dark:hover:bg-blue-950/30 transition-colors"
              >
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  {c.entity_label}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {c.entity_kind}
                  {c.rule_name ? ` · via ${c.rule_name}` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-200
                       dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

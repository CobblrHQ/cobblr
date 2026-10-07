// Save an Ask Cobb answer: a title, where it goes (proposed, always
// changeable), and one button. The write is Cobb's own create action,
// confirmed through /chat/execute, so a saved answer is ledgered like any
// other change the chat makes (web/src/lib/save-answer.ts).
//
// It opens IN the conversation, under the answer, the way a Confirm card
// does, not as a modal: on a phone the chat panel covers the screen above
// the modal layer, and a modal opened from it lands underneath.
import { SegmentedChoice } from "@cobblr/platform-web";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { answerTitle, DESTINATION_LABEL, saveDestination, saveProposal, type SaveDestination } from "../lib/save-answer";

export interface SavedAnswer {
  label: string;
  kind: string;
  id: string;
}

const HINT: Record<SaveDestination, string> = {
  pattern: "A pattern made from these words: the yarn, hook and notions it names are listed, and checked against your stash.",
  knowledge: "A note in your Knowledge Base, with where it came from.",
};

export function SaveAnswerSheet({
  slug,
  text,
  asked,
  hasPatterns,
  onClose,
  onSaved,
}: {
  slug: string;
  /** The answer, as Cobb wrote it. */
  text: string;
  /** What was asked, for the source line. */
  asked?: string | null;
  hasPatterns: boolean;
  onClose: () => void;
  onSaved: (saved: SavedAnswer) => void;
}) {
  const [dest, setDest] = useState<SaveDestination>(() => saveDestination(text, hasPatterns));
  const [title, setTitle] = useState(() => answerTitle(text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices: SaveDestination[] = hasPatterns ? ["pattern", "knowledge"] : ["knowledge"];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.aiChatExecute(slug, saveProposal(dest, { title, text, asked }), asked ?? undefined);
      if (!r.ok || !r.entity?.id) {
        setError(r.message || "Couldn't save it.");
        return;
      }
      onSaved({ label: DESTINATION_LABEL[dest], kind: r.entity.kind, id: r.entity.id });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-3" data-testid="save-answer-sheet">
        <div className="text-sm font-medium text-content dark:text-mortar-100">Save this answer</div>
        <label className="block">
          <span className="block text-[11px] font-medium text-content dark:text-mortar-200 mb-1">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="input" maxLength={160} />
        </label>
        <div>
          <span className="block text-[11px] font-medium text-content dark:text-mortar-200 mb-1">Save to</span>
          <SegmentedChoice
            stack
            label="Save to"
            value={dest}
            onChange={setDest}
            options={choices.map((c) => ({ value: c, label: DESTINATION_LABEL[c], hint: HINT[c] }))}
          />
        </div>
        {error && <p className="text-xs text-ember-600 dark:text-ember-400">{error}</p>}
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !title.trim()}
            className="rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 min-h-9 disabled:opacity-50"
          >
            {busy ? "Saving…" : `Save to ${DESTINATION_LABEL[dest]}`}
          </button>
          <button type="button" onClick={onClose} className="text-sm text-muted hover:text-content min-h-9">
            Cancel
          </button>
        </div>
    </div>
  );
}

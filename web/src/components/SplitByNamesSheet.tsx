// Split a photo into the things you name (#6342): the inbox card's door onto
// the same split the assistant runs (core-scan:add-things-from-photo). Each
// line is one thing; Cobblr finds where each sits, crops it, and keeps the
// photo as their group shot. A photo that shows a different number than the
// names says what it saw, and nothing is added.
import { useState } from "react";
import { Modal } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";

export function SplitByNamesSheet({ slug, itemId, onDone, onClose }: { slug: string; itemId: string; onDone: (count: number) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <Modal open onClose={onClose} title="What is in this photo?" size="sm">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.splitScanItemByNames(slug, itemId, names);
            onDone(r.items.length);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">One thing per line</span>
          <textarea
            data-testid="split-names"
            rows={4}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Midea dehumidifier\nFrigidaire dehumidifier"}
          />
        </label>
        <p className="text-xs text-muted">Each becomes its own row with its own crop; the photo stays as their group shot, and Undo split puts it back as one.</p>
        {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
            Cancel
          </button>
          <button type="submit" disabled={busy || names.length < 2} data-testid="split-names-go" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
            {busy ? "Splitting…" : names.length >= 2 ? `Split into ${names.length}` : "Split"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

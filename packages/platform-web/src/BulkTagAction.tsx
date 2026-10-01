// "Tag" on the selection bar: a tag name typed into a popover on the bar
// itself. One for every list; three pages each had their own copy of the
// same modal.
import { useState } from "react";
import { Tag as TagIcon } from "lucide-react";
import { FooterActionPopover } from "./FooterActionPopover";

export function BulkTagAction({
  count,
  placeholder = "e.g. urgent, archive",
  onTag,
}: {
  count: number;
  placeholder?: string;
  /** Tag the selected rows. Throws to keep the popover open with the reason. */
  onTag: (tagName: string) => Promise<void>;
}) {
  return (
    <FooterActionPopover label="Tag" icon={<TagIcon size={12} />} title={`Tag ${count}`} width={280} data-testid="bulk-tag">
      {(close) => <TagForm count={count} placeholder={placeholder} onTag={onTag} close={close} />}
    </FooterActionPopover>
  );
}

function TagForm({ count, placeholder, onTag, close }: { count: number; placeholder: string; onTag: (n: string) => Promise<void>; close: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await onTag(name.trim());
          close();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={placeholder}
        aria-label="Tag name"
        className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
      />
      <p className="text-[11px] text-faint">Existing tag? Reused. New name? Created on the fly.</p>
      {error && (
        <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !name.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
          {busy ? "Tagging…" : `Tag ${count}`}
        </button>
      </div>
    </form>
  );
}

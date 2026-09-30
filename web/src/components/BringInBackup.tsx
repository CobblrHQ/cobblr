// "Bring in a backup or a sandbox file": a blank workspace's first screen
// takes a file straight in, without anybody having to find restore in the
// settings (#4217). Upload the .zip, or paste the link from a sandbox's email.
import { useState } from "react";
import { Upload } from "lucide-react";
import { ApiError, api } from "../lib/api";

export function BringInBackup({ slug }: { slug: string }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = () => window.location.reload();
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "That could not be brought in. Try again.");

  async function fromFile(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only offered while the person has made nothing here, so filling the
      // workspace from the file replaces nothing of theirs.
      await api.restoreBackupFile(slug, file, { replace: true });
      done();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
  async function fromLink() {
    if (!link.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.restoreFromLink(slug, link.trim(), { replace: true });
      done();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900/40 p-4" data-testid="bring-in-backup">
      <h2 className="text-base font-semibold text-content dark:text-mortar-100">Bring in a backup or a sandbox file</h2>
      <p className="mt-1 text-sm text-muted">Everything in it comes into this workspace: its lists, records and pictures.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className={`inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 text-sm font-medium hover:bg-subtle dark:hover:bg-slate-800 ${busy ? "pointer-events-none opacity-50" : ""}`}>
          <Upload size={14} /> {busy ? "Bringing it in…" : "Upload the file"}
          <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => void fromFile(e.target.files?.[0])} data-testid="bring-file" />
        </label>
        <form
          className="flex w-full min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void fromLink();
          }}
        >
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="or paste the link from the email"
            aria-label="Link to a sandbox's file"
            className="input h-9 min-w-0 flex-1"
            data-testid="bring-link"
          />
          <button type="submit" disabled={busy || !link.trim()} className="h-9 shrink-0 rounded-md border border-line dark:border-slate-600 px-3 text-sm font-medium disabled:opacity-50">
            Bring it in
          </button>
        </form>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600 dark:text-ember-400" data-testid="bring-in-error">{error}</p>}
    </section>
  );
}

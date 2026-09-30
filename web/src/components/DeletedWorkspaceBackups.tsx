// The backups kept after a workspace you owned was deleted. Taken just before
// the drop, whatever else happened, and kept here for a while: the way back
// for "I did not mean to", or "I forgot to download one first". Renders
// nothing when there are none, which is almost always.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Archive, Download, Loader2 } from "lucide-react";
import { downloadBlob, useToast } from "@cobblr/platform-web";
import { api, getToken } from "../lib/api";
import { untilDate } from "./WorkspaceStateBar";

function size(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function DeletedWorkspaceBackups() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["me", "workspace-exports"], queryFn: () => api.myWorkspaceExports() });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;

  const download = async (id: string, filename: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/v1/me/workspace-exports/${id}/download`, {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!r.ok) throw new Error(r.status === 404 ? "That backup has expired." : `Download failed (${r.status})`);
      downloadBlob(await r.blob(), filename);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3"
      data-testid="deleted-workspace-backups"
    >
      <div className="flex items-start gap-3">
        <Archive size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Backups of deleted workspaces</h2>
          <p className="text-xs text-faint dark:text-slate-400">
            Taken just before each workspace was deleted. Restore one into any workspace from its Backup page.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-line dark:divide-slate-700">
        {items.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="font-medium text-content dark:text-mortar-100 min-w-0 truncate">{x.workspace}</span>
            <span className="text-xs text-faint">
              {size(x.size_bytes)} · kept until {untilDate(Date.parse(x.expires_at))}
            </span>
            <button
              type="button"
              onClick={() => download(x.id, x.filename)}
              disabled={busy !== null}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2.5 py-1 text-xs font-medium hover:bg-subtle disabled:opacity-50"
            >
              {busy === x.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Download
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

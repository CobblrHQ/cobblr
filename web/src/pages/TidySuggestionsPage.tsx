import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { usePageTitle, useToast } from "@cobblr/platform-web";

export function TidySuggestionsPage() {
  usePageTitle("Tidy");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["tidy-settings", activeSlug], queryFn: () => api.tidySuggestions(activeSlug), enabled: !!activeSlug });
  if (q.isLoading) return <p className="text-sm text-faint">Loading suggestions settings…</p>;
  if (q.isError) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{q.error.message}</p>;
  if (!q.data?.available) return <p className="text-sm text-faint">Tidy is unavailable on this instance.</p>;
  const flip = async () => {
    setBusy(true);
    try { await api.setTidySuggestions(activeSlug, !q.data.enabled); await qc.invalidateQueries({ queryKey: ["tidy-settings", activeSlug] }); await qc.invalidateQueries({ queryKey: ["attention", activeSlug] }); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
    <h2 className="text-sm font-semibold">Tidy</h2>
    <p className="text-sm text-faint">Look for things to file, move or check overnight. Up to five suggestions appear in Needs you and your notification digest. Nothing changes until you choose it.</p>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={q.data.enabled} disabled={busy} onChange={() => void flip()} />Tidy-up suggestions</label>
    <p className="text-xs text-faint">Off by default. Not now holds a suggestion for seven days. Never suggest this remembers the kind and the things it concerns.</p>
  </section>;
}

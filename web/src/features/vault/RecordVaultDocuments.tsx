// A record's documents in the Vault (#5242), on every record's page. The
// server lists only the documents the person viewing may open; for anyone
// else the list is empty and this panel draws nothing at all, not a title,
// not a count, so a record never says it has a Vault document to someone
// who may not see it.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { useLater, useToast, type EntityDetailPanelCtx } from "@cobblr/platform-web";
import { api } from "../../lib/api";

export function RecordVaultDocuments({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const toast = useToast();
  const later = useLater();
  const [busy, setBusy] = useState<string | null>(null);
  const kind = ctx.kind ?? "";
  const docs = useQuery({
    queryKey: ["vault-record-documents", ctx.slug, kind, ctx.entityId],
    queryFn: () => api.vaultRecordDocuments(ctx.slug, kind, ctx.entityId),
    enabled: !!ctx.slug && !!kind && !!ctx.entityId,
    retry: false,
  });
  const items = docs.data?.items ?? [];
  if (!items.length) return null;
  const open = async (id: string) => {
    setBusy(id);
    try {
      const url = URL.createObjectURL(await api.vaultFileBlob(ctx.slug, id, "open"));
      window.open(url, "_blank", "noopener");
      later.after(`revoke-${id}`, 60_000, () => URL.revokeObjectURL(url));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-2" aria-labelledby="record-vault-documents">
      <h2 id="record-vault-documents" className="text-sm font-semibold flex items-center gap-2">
        <Lock size={14} className="text-accent" aria-hidden /> In the Vault
      </h2>
      <ul className="space-y-1">
        {items.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="break-words min-w-0">{d.name}</span>
            <button type="button" className="rounded-md border border-line px-2 py-1 text-xs min-h-8" disabled={busy !== null} onClick={() => void open(d.id)}>
              {busy === d.id ? "Opening…" : "Open"}
            </button>
            <Link to={`/vault/${d.folder_id}`} className="text-xs text-accent hover:underline">Its folder</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

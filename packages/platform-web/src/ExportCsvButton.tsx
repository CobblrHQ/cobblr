// Any collection as a spreadsheet, from its header. The server writes the
// file as the person reads the collection (a field their role may not read is
// not in it), so this only asks for it and hands it to the browser.
import { useState } from "react";
import { FileDown } from "lucide-react";
import { usePlatformWeb } from "./context";
import { downloadBlob } from "./download-blob";
import { useToast } from "./ToastContext";
import { headerButton } from "./CollectionHeader";

export function ExportCsvButton({ kind, q }: { kind: string; q?: string }) {
  const { api, orgSlug } = usePlatformWeb();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!api.exportEntitiesCsv || !orgSlug) return null;
  const run = api.exportEntitiesCsv.bind(api);
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="collection-export"
      title="Download this list as a spreadsheet (CSV)"
      aria-label="Export as a spreadsheet"
      className={`${headerButton()} disabled:opacity-50`}
      onClick={async () => {
        setBusy(true);
        try {
          const got = await run(orgSlug, kind, q?.trim() || undefined);
          downloadBlob(got.blob, got.filename);
          if (got.complete) toast.success("Spreadsheet downloaded.");
          else toast.info("Downloaded the first 5,000. Narrow the list with search to get the rest.");
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileDown size={14} />
      <span className="hidden sm:inline">{busy ? "Exporting…" : "Export"}</span>
    </button>
  );
}

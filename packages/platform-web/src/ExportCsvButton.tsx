// Any collection as a spreadsheet, from its header. The server writes the
// file as the person reads the collection (a field their role may not read is
// not in it), so this only asks for it and hands it to the browser.
import { useState } from "react";
import { FileDown } from "lucide-react";
import { usePlatformWeb } from "./context";
import { downloadBlob } from "./download-blob";
import { useToast } from "./ToastContext";
import { Modal } from "./Modal";
import { headerButton } from "./CollectionHeader";

export function ExportCsvButton({ kind, q }: { kind: string; q?: string }) {
  const { api, orgSlug, role } = usePlatformWeb();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  if (!api.exportEntitiesCsv || !orgSlug) return null;
  const run = api.exportEntitiesCsv.bind(api);
  async function download(secrets: boolean) {
    setBusy(true);
    try {
      const got = await run(orgSlug, kind, q?.trim() || undefined, secrets);
      setChoose(false);
      downloadBlob(got.blob, got.filename);
      if (got.secretsOmitted) toast.info("Secret fields were left out.");
      if (got.complete) toast.success("Spreadsheet downloaded.");
      else toast.info("Downloaded the first 5,000. Narrow the list with search to get the rest.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (<>
    <button
      type="button"
      disabled={busy}
      data-testid="collection-export"
      title="Download this list as a spreadsheet (CSV)"
      aria-label="Export as a spreadsheet"
      className={`${headerButton()} disabled:opacity-50`}
      onClick={async () => {
  // role-gate: exact: secret access is explicitly limited to owner/admin, creator or the configured field capability.
        if (role === "owner" || role === "admin") {
          setBusy(true);
          try {
            const defs = await api.listFieldDefs(orgSlug, kind);
            if (defs.items.some((field) => field.type === "secret")) {
              setIncludeSecrets(false);
              setChoose(true);
              return;
            }
          } catch {
            toast.error("Could not check this collection's fields.");
            return;
          } finally { setBusy(false); }
        }
        await download(false);
      }}
    >
      <FileDown size={14} />
      <span className="hidden sm:inline">{busy ? "Exporting…" : "Export"}</span>
    </button>
    <Modal open={choose} onClose={() => setChoose(false)} title="Export spreadsheet">
      <div className="space-y-4">
        <p>Secret fields are left out by default.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} />Include secrets</label>
        {includeSecrets && <p>The file will contain secret values. This export is recorded in History.</p>}
        <button type="button" className="btn" disabled={busy} onClick={() => void download(includeSecrets)}>Download</button>
      </div>
    </Modal>
  </>);
}

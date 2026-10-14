import { useState } from "react";
import { LocationTreePicker } from "../../components/LocationTreePicker";
import { SendPreviewCards, downloadBlob, useToast } from "@cobblr/platform-web";
import type { SendFile, SendReceipt } from "@cobblr/platform-contract/send-file";
import { api } from "../../lib/api";
import { randomId } from "@cobblr/platform-contract/random-id";

type Preview = Awaited<ReturnType<typeof api.importSendFile>>;
function saveReceipt(receipt: SendReceipt) {downloadBlob(new Blob([JSON.stringify(receipt)],{type: "application/json"}),`cobblr-${receipt.phase === "undone" ? "return" : "confirmation"}-${receipt.file_id}.json`);}
export function SendFileImport({slug, file, onImported, onReset}: {slug: string;file: SendFile | SendReceipt;onImported: () => void;onReset: () => void}) {
  const toast = useToast();
  const [collection,setCollection] = useState("");
  const [map,setMap] = useState<Record<string,string | null>>({});
  const [addFields,setAddFields] = useState<string[]>([]);
  const [createMatching,setCreateMatching] = useState(false);
  const [location,setLocation] = useState("");
  const [duplicate,setDuplicate] = useState<"update" | "another" | undefined>();
  const [preview,setPreview] = useState<Preview | null>(null);
  const [receiptPreview,setReceiptPreview] = useState<{summary: string;target?: {name: string;instance: string;person: string}} | null>(null);
  const [result,setResult] = useState<{summary: string;import_id?: string;receipt?: SendReceipt} | null>(null);
  const [busy,setBusy] = useState(false);
  const [failure,setFailure] = useState("");
  const [requestId,setRequestId] = useState(() => randomId());
  const receiptFile = file as SendReceipt;
  const packet = file.format === "cobblr-send" ? file : null;
  const args = () => ({packet: packet!,collection: collection || null,field_map: map,add_fields: addFields,create_matching: createMatching,duplicate,location: location && location !== "unplaced" ? location : null,...(location === "unplaced" ? {placement: "unplaced" as const} : {})});
  async function check() {
    setBusy(true); setFailure("");
    try {
      if (packet) {setPreview(await api.importSendFile(slug,{...args(),dry_run: true})); setRequestId(randomId());}
      else {const receipt = file as SendReceipt; setReceiptPreview(await (receipt.phase === "undone" ? api.restoreSendFileSource : api.confirmSendFile)(slug,receipt,true));}
    } catch (err) {setFailure((err as Error).message);} finally {setBusy(false);}
  }
  async function confirm() {
    setBusy(true); setFailure("");
    try {
      if (packet) {const r = await api.importSendFile(slug,{...args(),request_id: requestId}); setResult({summary: r.summary!,import_id: r.import_id,receipt: r.receipt});}
      else {const receipt = file as SendReceipt; setResult(await (receipt.phase === "undone" ? api.restoreSendFileSource : api.confirmSendFile)(slug,receipt));}
      onImported();
    } catch (err) {setFailure((err as Error).message);} finally {setBusy(false);}
  }
  return <div className="space-y-3" data-testid="send-file-import" aria-busy={busy}>
    <p className="font-medium">{packet ? `Send file from ${packet.source.name}` : (file as SendReceipt).phase === "undone" ? "Restore a file Move's source" : "Confirm a file import"}</p>
    {packet && <><p className="text-sm">From {packet.source.instance} by {packet.source.person}. {packet.items.length} {packet.items.length === 1 ? "item" : "items"}, {packet.mode === "move" ? "Move" : "Copy"}. Photos and documents travel as copies. Secrets and source history stay on the source Cobblr.</p><p className="text-sm">Complete items file straight into your collection. Items needing a collection, field or placement wait in your scan inbox.</p></>}
    {!result && packet && <>
      <label className="block">Collection<select aria-label="Collection" value={collection} onChange={(e) => {setCollection(e.target.value);setPreview(null);}} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">{preview?.items[0]?.collection ? `Matching: ${preview.items[0].collection}` : "Find the matching collection"}</option>{preview?.collections?.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}</select></label>
      {preview?.can_configure && <label className="flex gap-2"><input type="checkbox" checked={createMatching} onChange={(e) => {setCreateMatching(e.target.checked);setPreview(null);}} />Create a matching collection here if needed</label>}
      <div className="space-y-1"><LocationTreePicker label="Placement" value={location && location !== "unplaced" ? location : null} onChange={(id) => {setLocation(id ?? "");setPreview(null);}} placeholder={location === "unplaced" ? "Arrive unplaced" : "Choose later if needed"} noneLabel="Choose later if needed" /><label className="flex items-center gap-2"><input type="checkbox" checked={location === "unplaced"} onChange={(e) => {setLocation(e.target.checked ? "unplaced" : "");setPreview(null);}} />Arrive unplaced</label></div>
      {preview && <><SendPreviewCards items={preview.items} canConfigure={!!preview.can_configure} onDrop={(label) => {setMap({...map,[label]: null});setPreview(null);}} onAdd={(label) => {setAddFields([...addFields,label]);setPreview(null);}} />{preview.version_warnings?.map((w) => <p key={w} className="text-sm text-muted">{w}</p>)}{preview.items.some((i) => i.duplicate) && <label className="block">Sent before<select aria-label="Sent before" value={duplicate ?? ""} onChange={(e) => setDuplicate(e.target.value as "update" | "another")} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">Choose what to do</option><option value="update">Update the earlier copy</option><option value="another">Make another copy</option></select></label>}</>}
    </>}
    {!result && !packet && <><p>This file says the {receiptFile.phase === "undone" ? "import was undone" : "items were imported"} in {receiptFile.target.name} ({receiptFile.target.instance}) by {receiptFile.target.person}.</p>{receiptPreview && <p role="status">{receiptPreview.summary}</p>}</>}
    {!result && <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void check()} className="rounded border border-line px-3 py-2">Preview {packet ? "import" : "confirmation"}</button>{(preview || receiptPreview) && <button type="button" disabled={busy || !!preview?.blocked?.length || !!(preview?.items.some((i) => i.duplicate) && !duplicate)} onClick={() => void confirm()} className="rounded bg-cobble-600 px-3 py-2 text-white">{packet ? "Import items" : receiptFile.phase === "undone" ? "Restore source here" : "Confirm import here"}</button>}</div>}
    {preview?.blocked?.map((b) => <p key={b} role="alert" className="text-ember-600 dark:text-ember-400">{b}</p>)}
    {result && <><p role="status">{result.summary}</p><div className="flex flex-wrap gap-2">{result.receipt && <button type="button" onClick={() => saveReceipt(result.receipt!)} className="rounded border border-line px-3 py-2">Download {result.receipt.phase === "undone" ? "return" : "confirmation"} file</button>}{result.import_id && result.receipt?.phase !== "undone" && <button type="button" disabled={busy} className="rounded border border-line px-3 py-2" onClick={async () => {setBusy(true);setFailure("");try {const r = await api.undoSendFileImport(slug,result.import_id!);setResult({...result,...r});onImported();toast.success(r.summary);} catch (err) {setFailure((err as Error).message);} finally {setBusy(false);}}}>Undo import here</button>}</div>{packet?.mode === "move" && result.receipt && <p>Take the {result.receipt.phase === "undone" ? "return file to restore the source separately" : "confirmation file to finish the Move"} on the source Cobblr through Import.</p>}</>}
    {failure && <p role="alert" className="text-ember-600 dark:text-ember-400">{failure}</p>}
    <button type="button" disabled={busy} onClick={onReset} className="text-accent underline">Choose another file</button>
  </div>;
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { usePlatformWeb } from "./context";
import { Modal } from "./Modal";
import { RecordActionItem } from "./RecordActionContributions";
import { useToast } from "./ToastContext";
import { SendPreviewCards } from "./SendPreviewCards";
import { NounChoiceButtons } from "./NounChoice";
import { ConnectCobblr } from "./ConnectCobblr";
import { randomId } from "@cobblr/platform-contract/random-id";

export interface WorkspaceSendRequest {
  entity_kind: string; ids: string[]; target_org: string; connection_id?: string; collection?: string | null; mode: "copy" | "move";
  placement?: "unplaced";
  field_map?: Record<string, string | null>; include_secrets?: boolean; location?: string | null;
  create_matching?: boolean; add_fields?: string[];
  duplicate?: "update" | "another"; request_id?: string; dry_run?: boolean;
}
export interface WorkspaceSendPreview {
  blocked?: string[]; version_warnings?: string[];
  target: { id: string; slug: string; name: string }; can_include_secrets: boolean;
  items: Array<{ id: string; name: string; collection: string | null; mappings: Array<{ from: string; to: string | null }>; missing: string[]; dropped: string[]; needs: string[]; duplicate: string | null; files: number; arrival: "collection" | "inbox" }>;
}
export interface SendFileExportPreview {can_move: boolean; collection: string; items: Array<{id: string;name: string;fields: string[];files: number;dropped: string[];placement_needed: boolean}>; summary: string;}
export interface WorkspaceSendTargets { connection_refusals?: string[]; targets: Array<{ id: string; slug: string; name: string; role: string; connection_id?: string; host?: string | null; places?: Array<{id: string;title: string}>; collections: Array<{ kind: string; label: string; module: string }> }> }

export function SendRecords({ kind, ids, record = false, onDone, onOpenChange }: { kind: string; ids: string[]; record?: boolean; onDone?: () => void; onOpenChange?: (open: boolean) => void }) {
  const { api, orgSlug } = usePlatformWeb();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [collection, setCollection] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [map, setMap] = useState<Record<string, string | null>>({});
  const [createMatching, setCreateMatching] = useState(false);
  const [addFields, setAddFields] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [duplicate, setDuplicate] = useState<"update" | "another" | undefined>();
  const [filePreview, setFilePreview] = useState<SendFileExportPreview | null>(null);
  const [fileSent, setFileSent] = useState<{id: string;summary: string} | null>(null);
  const toFile = target === "file";
  const [preview, setPreview] = useState<WorkspaceSendPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => randomId());
  const [failure, setFailure] = useState("");
  const [sent, setSent] = useState<{ summary: string; offer_ids: string[]; connected?: boolean; restore_available?: boolean; undone?: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const targets = useQuery({ queryKey: ["send-targets", orgSlug], queryFn: () => api.sendTargets!(orgSlug), enabled: open && !!api.sendTargets });
  const chosen = targets.data?.targets.find((t) => (t.connection_id || t.id) === target);
  const matchingCollection = (!collection ? preview?.items[0]?.collection : null) ?? chosen?.collections.find((c) => c.kind === kind)?.label;
  const places = useQuery({ queryKey: ["send-places", chosen?.slug], queryFn: () => api.listEntities!(chosen!.slug, "core-locations:location"), enabled: !!chosen && !chosen.connection_id && !!api.listEntities });
  const label = record ? "Send to another workspace" : `Send ${ids.length} to…`;
  const request = (): WorkspaceSendRequest => ({ entity_kind: kind, ids, target_org: chosen?.id || target, connection_id: chosen?.connection_id, collection: collection || null, mode, include_secrets: includeSecrets, field_map: map, duplicate, create_matching: createMatching, add_fields: addFields, location: location && location !== "unplaced" ? location : null, ...(location === "unplaced" ? { placement: "unplaced" as const } : {}) });
  async function check() {
    setBusy(true); setFailure("");
    try { setRequestId(randomId()); if (toFile) setFilePreview(await api.previewSendFile!(orgSlug, {entity_kind: kind, ids, mode})); else setPreview(await api.previewSend!(orgSlug, request())); }
    catch (err) { setFailure((err as Error).message); }
    finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setFailure("");
    try {
      const r = await api.sendRecords!(orgSlug, { ...request(), request_id: requestId });
      setSent(r); await qc.invalidateQueries(); toast.success(r.summary);
    } catch (err) { setFailure((err as Error).message); }
    finally { setBusy(false); }
  }
  async function download() {
    setBusy(true); setFailure("");
    try {const r = await api.exportSendFile!(orgSlug,{entity_kind: kind,ids,mode,request_id: requestId}); await api.downloadSendFile!(orgSlug,r.id); setFileSent(r); toast.success(r.summary);}
    catch (err) {setFailure((err as Error).message);} finally {setBusy(false);}
  }
  if (!api.sendTargets || !api.sendRecords) return null;
  const button = <button type="button" data-testid={record ? "record-send-workspace" : "bulk-send-workspace"} onClick={() => { onOpenChange?.(true); setOpen(true); setPreview(null); setSent(null); setFilePreview(null); setFileSent(null); }} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-xs text-content hover:border-accent"><Send size={12} /><span className="fc-bar-words">{label}</span></button>;
  return <>
    {record ? <RecordActionItem id="record:send-workspace" group="share" label={label} description="Copy or move this item into another workspace of your own.">{button}</RecordActionItem> : button}
    <Modal open={open} onClose={() => { onOpenChange?.(false); setOpen(false); if (sent) onDone?.(); }} title="Send to another workspace" size="lg">
      <div className="space-y-4" data-testid="send-workspace-dialog" aria-busy={busy}>
        {fileSent ? <div className="space-y-3"><p role="status">{fileSent.summary}</p><p>Import this file on the other Cobblr. For a Move, bring its confirmation file back here through Import before the source moves.</p><button type="button" disabled={busy} className="rounded border border-line px-3 py-2" onClick={() => void api.downloadSendFile!(orgSlug,fileSent.id)}>Download again</button></div> : sent ? <div className="space-y-3"><p role="status">{sent.summary}</p><button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setFailure(""); try {
            let result: {summary?: string;restore_available?: boolean} = {};
            for (const id of sent.offer_ids) result = sent.restore_available ? await api.undoSend!(orgSlug, id, true) : await api.undoSend!(orgSlug, id);
            if (sent.connected && !sent.restore_available) setSent({...sent, summary: result.summary || "Import undone there.", restore_available: result.restore_available, undone: true});
            else {setSent(null); setPreview(null);}
            await qc.invalidateQueries(); toast.success(result.summary || "Send undone. The source is back as it was.");
          } catch (err) { setFailure((err as Error).message); } finally { setBusy(false); }
        }} className="rounded border border-line px-3 py-2" hidden={sent.undone && !sent.restore_available}>{sent.restore_available ? "Restore source here" : sent.connected ? "Undo import there" : "Undo send"}</button></div> : <>
          <label className="block text-sm">Workspace<select aria-label="Workspace" value={target} onChange={(e) => { setTarget(e.target.value); setCollection(""); setPreview(null); setFilePreview(null); }} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">Choose a workspace</option>{api.exportSendFile && <option value="file">To another Cobblr (send file)</option>}{targets.data?.targets.map((t) => <option key={t.connection_id || t.id} value={t.connection_id || t.id}>{t.name}{t.host ? ` on ${t.host}` : ""}</option>)}</select></label>
          <button type="button" className="text-sm text-accent underline" onClick={() => setConnecting(!connecting)}>Connect your other Cobblr</button>
          {connecting && <ConnectCobblr />}
          {targets.data?.connection_refusals?.map((message) => <p key={message} className="text-sm">{message}</p>)}
          {targets.isError && <p role="alert">{(targets.error as Error).message}</p>}
          {targets.isSuccess && !targets.data.targets.length && !toFile && <p>You need another workspace where you can add records.</p>}
          {!toFile && <label className="block text-sm">Collection<select aria-label="Collection" value={collection} onChange={(e) => { setCollection(e.target.value); setPreview(null); }} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">{matchingCollection ? `Matching: ${matchingCollection}` : "Find the matching collection"}</option>{chosen?.collections.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}</select></label>}
          {chosen && ["owner", "admin", "editor"].includes(chosen.role) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createMatching} onChange={(e) => { setCreateMatching(e.target.checked); setPreview(null); }} />Create a matching collection there if needed</label>}
          {/* location-select-ok: the places of the workspace being sent TO, which the location pickers (this workspace's) cannot read */}
          {chosen && <label className="block text-sm">Placement<select aria-label="Placement" value={location} onChange={(e) => { setLocation(e.target.value); setPreview(null); }} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">Choose later if needed</option><option value="unplaced">Arrive unplaced</option>{(chosen.places || places.data?.items)?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
          <fieldset><legend className="mb-1 text-sm">How to send</legend><NounChoiceButtons label="How to send" offer={{of: "item", singular: "copy", plural: "Copy", alternatives: [{singular: "move", plural: "Move"}]}} current={mode} disabled={busy} onPick={(m) => { setMode(m === "move" ? "move" : "copy"); setPreview(null); setFilePreview(null); }} /></fieldset>
          <p className="text-sm text-muted">Photos, attachments and documents are copied. Locations and stock placement stay here. The new record starts with where it came from; the source keeps its history.</p>
          {toFile && <p className="text-sm">Download a send file with the original photos and documents inside. Import it on any Cobblr without connecting accounts. A Move keeps its source here until you import the receiving Cobblr's confirmation file.</p>}
          {filePreview && <div className="space-y-3" data-testid="send-file-preview"><p>{filePreview.summary}</p>{filePreview.items.map((i) => <section key={i.id} className="rounded border border-line p-3"><h3 className="font-medium">{i.name}</h3><p>{i.fields.join(", ")} · {i.files} files</p>{i.placement_needed && <p>Choose a placement when importing.</p>}{i.dropped.map((d) => <p key={d}>Not sent: {d}</p>)}</section>)}</div>}
          {preview?.can_include_secrets && <label className="flex items-center gap-2"><input type="checkbox" checked={includeSecrets} onChange={(e) => { setIncludeSecrets(e.target.checked); setPreview(null); }} />Include secrets</label>}
          {preview?.version_warnings?.map((message) => <p key={message} className="text-sm">{message}</p>)}
          {preview && <div className="space-y-3"><SendPreviewCards items={preview.items} canConfigure={!!chosen && ["owner", "admin", "editor"].includes(chosen.role)} onDrop={(label) => {setMap({...map,[label]: null}); setPreview(null);}} onAdd={(label) => {setAddFields([...addFields,label]); setPreview(null);}} />
            {preview.items.some((i) => i.duplicate) && <label className="block text-sm">Sent before<select aria-label="Sent before" value={duplicate ?? ""} onChange={(e) => setDuplicate(e.target.value as "update" | "another")} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base"><option value="">Choose what to do</option><option value="update">Update the earlier copy</option><option value="another">Make another copy</option></select></label>}
          </div>}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={!target || busy} onClick={() => void check()} className="rounded border border-line px-3 py-2">{busy ? "Working…" : "Preview send"}</button>{filePreview && <button type="button" disabled={busy} onClick={() => void download()} className="rounded bg-cobble-600 px-3 py-2 text-white">Download send file</button>}{preview && <button type="button" disabled={busy || !!preview.blocked?.length || (preview.items.some((i) => i.duplicate) && !duplicate)} onClick={() => void send()} className="rounded bg-cobble-600 px-3 py-2 text-white">Confirm {mode}</button>}</div>
        </>}
        {preview?.blocked?.map((message) => <p key={message} role="alert" className="text-sm text-ember-600 dark:text-ember-400">{message}</p>)}
        {failure && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{failure}</p>}
      </div>
    </Modal>
  </>;
}

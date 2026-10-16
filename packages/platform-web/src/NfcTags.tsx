import { productName } from "./product-name";
import { useEffect, useRef, useState } from "react";
import { createNfcReader, isWebNfcAvailable, nfcFailure, nfcLabelMessage } from "./nfc";

export interface NfcTarget { title: string; url: string }

export function NfcTags({ targets }: { targets: readonly NfcTarget[] }) {
  const supported = isWebNfcAvailable();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); }, []);
  const target = targets[index];
  const button = "rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm hover:border-accent disabled:opacity-50";

  const write = async () => {
    if (!target || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      await createNfcReader().write(nfcLabelMessage(target.url), { signal: controller.signal });
      if (!controller.signal.aborted) { setIndex((i) => i + 1); setCopied(false); }
    } catch (e) {
      if (!controller.signal.aborted) setError(nfcFailure(e));
    } finally {
      if (!controller.signal.aborted) { operation.current = null; setBusy(false); }
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">A tag opens the same link as the record’s QR label.</p>
      {!supported && <>
        <p className="text-sm">Use Android Chrome to write tags; any phone can read them.</p>
        <p className="text-sm text-muted">Paste it into any NFC writer app (for example NFC Tools) to write the tag.</p>
      </>}
      <p className="text-sm text-muted">On iPhone, sign in to {productName()} in Safari once and tags open straight to the record.</p>
      {target ? <>
        <p className="text-sm" role="status">Tag {index + 1} of {targets.length}</p>
        <p className="font-semibold break-words">{target.title}</p>
        <input aria-label="Tag link" readOnly value={target.url} className="w-full rounded-md border border-line dark:border-slate-600 bg-transparent p-2 text-base" />
        {busy && <p role="status" className="text-sm">Hold a writable tag near your phone.</p>}
        <div className="flex flex-wrap gap-2">
          {supported && <button type="button" className={button} disabled={busy} onClick={() => void write()}>Write to NFC tag</button>}
          {busy ? <button type="button" className={button} onClick={() => {
            operation.current?.abort(); operation.current = null; setBusy(false);
          }}>Cancel write</button> : <button type="button" className={button} onClick={async () => {
            setError(null);
            try { await navigator.clipboard.writeText(target.url); setCopied(true); }
            catch { setError("Could not copy the link. Select the tag link above and copy it."); }
          }}>Copy tag link</button>}
          {!supported && copied && <button type="button" className={button} onClick={() => { setIndex((i) => i + 1); setCopied(false); }}>
            {index + 1 === targets.length ? "Done" : "Next tag"}
          </button>}
        </div>
        {copied && <p role="status" className="text-sm">Tag link copied.</p>}
        {supported && index > 0 && <p className="text-sm text-muted">Previous tag written. Remove it before writing the next tag.</p>}
      </> : <p role="status">{supported ? "All tags written." : "All tag links copied."}</p>}
      {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
    </div>
  );
}

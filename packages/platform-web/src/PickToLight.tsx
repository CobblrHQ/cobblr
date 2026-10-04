import { useEffect, useRef, useState } from "react";
import { usePlatformWeb } from "./context";

export interface LightPickLine { id: string; label: string; ref: { kind: string; id: string }; checked?: boolean }

export function PickToLight({ lines, onCheck }: { lines: LightPickLine[]; onCheck?: (id: string) => Promise<unknown> }) {
  const { api, orgSlug } = usePlatformWeb();
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const line = lines.find(l => !l.checked && !done.has(l.id));
  const key = line ? `${line.id}:${line.ref.kind}:${line.ref.id}` : "";
  const last = useRef("");
  useEffect(() => {
    if (!picking || !line || !api.requestLight || last.current === key) return;
    last.current = key;
    void api.requestLight(orgSlug, line.ref, "picked").then(r => { if (last.current === key) setMessage(r.note); }).catch(e => { if (last.current === key) setMessage(e instanceof Error ? e.message : "The light did not answer."); });
  }, [api, orgSlug, picking, key]);
  if (!api.requestLight || !lines.length) return null;
  if (!picking) return <button type="button" className="text-sm text-accent px-2 py-1" onClick={() => { last.current = ""; setDone(new Set()); setPicking(true); }}>Pick with lights</button>;
  return <div className="rounded border border-line p-3 space-y-2" aria-label="Pick with lights">
    <p className="text-sm">{line ? `Pick ${line.label}` : "Every line is picked."}</p>
    {message && <p role="status" className="text-xs text-muted">{message}</p>}
    <div className="flex flex-wrap gap-2">
      {line && <button type="button" disabled={busy} className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50" onClick={async () => {
        setBusy(true);
        try { await onCheck?.(line.id); setDone(prev => new Set([...prev, line.id])); setMessage(""); }
        catch (e) { setMessage(e instanceof Error ? e.message : "This line could not be checked."); }
        finally { setBusy(false); }
      }}>Picked, next bin</button>}
      {line && <button type="button" disabled={busy} className="text-sm px-2 py-1" onClick={async () => {
        try { setMessage((await api.requestLight!(orgSlug, line.ref, "picked")).note); }
        catch (e) { setMessage(e instanceof Error ? e.message : "The light did not answer."); }
      }}>Light again</button>}
      <button type="button" className="text-sm px-2 py-1" onClick={() => setPicking(false)}>Done picking</button>
    </div>
  </div>;
}

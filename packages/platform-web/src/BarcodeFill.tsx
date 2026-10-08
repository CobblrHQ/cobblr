import { useEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { usePlatformWeb } from "./context";
import { barcodeField, barcodeFills, type BarcodeFillField, type BarcodeLookup } from "./barcode-fill";

export interface BarcodeCaptureProps {
  scope: RefObject<HTMLDivElement | null>;
  onCode: (code: string) => void;
}
export function BarcodeFill({ fields, values, onFill, onCodeChange, onBlockedChange }: {
  fields: BarcodeFillField[];
  values: Record<string, unknown>;
  onFill: (fills: Record<string, unknown>) => void;
  onCodeChange: (name: string, value: string) => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const { api, orgSlug, barcodeCapture } = usePlatformWeb();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<BarcodeLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Array<{ name: string; label: string; value: unknown }>>([]);
  const scope = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ fields, values, onFill, onBlockedChange });
  latest.current = { fields, values, onFill, onBlockedChange };
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  const holder = barcodeField(fields);
  const Capture: ComponentType<BarcodeCaptureProps> | undefined = barcodeCapture;
  async function lookup(raw: string) {
    const code = raw.trim();
    if (!code || !api.lookupBarcode) return;
    const seq = ++sequence.current;
    setCode(code);
    setAnswer(null);
    setError(null);
    setMarkers([]);
    setBusy(true);
    latest.current.onBlockedChange(true);
    const initial = latest.current;
    const holder = barcodeField(initial.fields);
    if (holder) onCodeChange(holder.name, code);
    try {
      const answer = await api.lookupBarcode(orgSlug, code);
      if (seq !== sequence.current) return;
      const current = latest.current;
      const fills = barcodeFills(current.fields, current.values, code, answer.fields);
      current.onFill(fills);
      setMarkers(Object.entries(fills).map(([name, value]) => ({ name, value, label: current.fields.find((f) => f.name === name)?.display_label ?? name })));
      setAnswer(answer);
      current.onBlockedChange(answer.existing.length > 0);
    } catch (e) {
      if (seq !== sequence.current) return;
      setError(e instanceof Error ? e.message : "The barcode catalogue could not answer. You can still save this item.");
      latest.current.onBlockedChange(false);
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  }
  if (!holder || !api.lookupBarcode) return null;
  return <div ref={scope} className="space-y-2" data-barcode-fill>
    {Capture && <Capture scope={scope} onCode={(code) => void lookup(code)} />}
    <label className="block text-sm">{holder.display_label ?? "Barcode"}
      <input className="input mt-1" value={String(values[holder.name] ?? code)} onChange={(e) => {
        sequence.current++;
        setBusy(false);
        setAnswer(null);
        setError(null);
        setCode(e.target.value);
        onCodeChange(holder.name, e.target.value);
        onBlockedChange(false);
      }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void lookup(e.currentTarget.value); } }} />
    </label>
    <button type="button" className="text-sm text-accent underline" disabled={busy || !String(values[holder.name] ?? code).trim()} onClick={() => void lookup(String(values[holder.name] ?? code))}>Look up barcode</button>
    {busy && <p role="status" className="text-sm text-muted">Looking up the barcode…</p>}
    {markers.filter((m) => values[m.name] === m.value).map((m) => <p key={m.name} className="text-xs text-muted">{m.label}: from barcode</p>)}
    {answer?.outcome === "miss" && <p role="status" className="text-sm text-muted">No catalogue knows this code. The barcode is filled in. You can still save this item.</p>}
    {answer?.outcome === "unavailable" && <p role="status" className="text-sm text-muted">The barcode catalogue could not answer right now. You can still save this item.</p>}
    {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
    {!!answer?.existing.length && <div className="space-y-1 text-sm" role="status">
      <p>You already have this:</p>
      {answer.existing.map((item) => <p key={`${item.kind}:${item.id}`}>{item.title}{item.detail_url && <> · <a className="text-accent underline" href={`/w/${encodeURIComponent(orgSlug)}${item.detail_url}`}>Open it</a></>}</p>)}
      <button type="button" className="text-accent underline" onClick={() => { onBlockedChange(false); setAnswer({ ...answer, existing: [] }); }}>Add one more</button>
    </div>}
  </div>;
}

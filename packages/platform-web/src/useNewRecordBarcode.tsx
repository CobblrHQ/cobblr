import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { BarcodeFill } from "./BarcodeFill";
import { barcodeField, type BarcodeFillField } from "./barcode-fill";

interface NativeFill {
  name: string;
  label: string;
  key: string;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
}
export function useNewRecordBarcode({ kind, natives, metadata, setMetadata, fields, showFields = true }: {
  kind: string;
  natives: NativeFill[];
  metadata: Record<string, unknown>;
  setMetadata: Dispatch<SetStateAction<Record<string, unknown>>>;
  fields?: BarcodeFillField[];
  showFields?: boolean;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const defs = useQuery({ queryKey: ["new-record-barcode-fields", orgSlug, kind], queryFn: () => api.listFieldDefs(orgSlug, kind), enabled: fields === undefined && !!api.lookupBarcode });
  const custom = fields ?? defs.data?.items ?? [];
  const targets: BarcodeFillField[] = [...custom, ...natives.map((f) => ({ name: `native:${f.name}`, display_label: f.label, decode_role: `decode:${f.key}` }))];
  const [blocked, setBlocked] = useState(false);
  const values = { ...metadata, ...Object.fromEntries(natives.map((f) => [`native:${f.name}`, f.value])) };
  const holder = api.lookupBarcode ? barcodeField(custom) : undefined;
  useEffect(() => { if (!holder || !metadata[holder.name]) setBlocked(false); }, [holder?.name, metadata]);
  const controls = holder ? <>
    <BarcodeFill fields={targets} values={values} onBlockedChange={setBlocked} onCodeChange={(name, value) => setMetadata((m) => ({ ...m, [name]: value }))} onFill={(fills) => {
      setMetadata((m) => {
        const next = { ...m };
        for (const f of custom) if ((next[f.name] == null || next[f.name] === "") && fills[f.name] != null) next[f.name] = fills[f.name];
        return next;
      });
      for (const f of natives) {
        const value = fills[`native:${f.name}`];
        if (typeof value === "string") f.setValue((current) => current || value);
      }
    }} />
    {showFields && custom.filter((f) => f !== holder && !f.server_managed && (f.decode_role?.startsWith("decode:") || f.field_role === "category")).map((f) => <label key={f.name} className="block text-sm">{f.display_label ?? f.name}
      <input className="input mt-1" value={String(metadata[f.name] ?? "")} onChange={(e) => setMetadata((m) => ({ ...m, [f.name]: e.target.value }))} />
    </label>)}
  </> : null;
  return { controls, blocked, barcodeName: holder?.name };
}

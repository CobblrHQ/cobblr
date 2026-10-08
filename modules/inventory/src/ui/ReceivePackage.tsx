import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Modal, useFieldPresentation, usePhotoPick, usePlatformWeb, useRunAction } from "@cobblr/platform-web";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { useInventory } from "./context";
import type { FamilyPayload } from "./api";
import { randomId } from "@cobblr/platform-contract";

type Receipt = { part_id: string; already_received: boolean; quantity: number };

export function ReceivePackage({ data }: { data: FamilyPayload }) {
  const { api, basePath } = useInventory();
  const { decodeBarcodeImage } = usePlatformWeb();
  const { label } = useFieldPresentation(`${data.child}:item`);
  // PRESS-ARGS: the receiving form supplies the label, confirmed count and collection; print carries the saved package.
  const run = useRunAction();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [fields, setFields] = useState<Record<string, unknown> | null>(null);
  const [mpn, setMpn] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [quantity, setQuantity] = useState("");
  const [msl, setMsl] = useState("");
  const [packaging, setPackaging] = useState("reel");
  const [storage, setStorage] = useState("sealed");
  const [exposed, setExposed] = useState("0");
  const [attrition, setAttrition] = useState("0");
  const [location, setLocation] = useState("");
  const [topUp, setTopUp] = useState("");
  const [receiptKey, setReceiptKey] = useState<string | undefined>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [printed, setPrinted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const places = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations(), enabled: open });
  const packages = [...data.types.flatMap(t => t.children), ...data.unclaimed];
  const childPath = basePath.replace(/\/instances\/[^/]+$/, `/instances/${data.child}`);

  async function decode(value: string) {
    setBusy(true); setError(null); setReceipt(null); setReceiptKey(undefined); setPrinted(false); setFields(null); setTopUp("");
    try {
      const result = normaliseActionResult((await run({ actionId: "core-scan:decode-identifier", args: { code: value } })).result, "core-scan.decode-identifier");
      const decoded = result.data as { fields?: Record<string, unknown>; outcome?: string } | undefined;
      if (!result.ok || !decoded?.fields || decoded.outcome === "miss") throw new Error("The 2D label was not readable. Try another scan or a clearer photo.");
      setFields(decoded.fields); setMpn(String(decoded.fields.mpn ?? "")); setManufacturer(String(decoded.fields.manufacturer ?? "")); setQuantity(String(decoded.fields.quantity ?? ""));
      const labelFields = decoded.fields;
      const known = data.types.filter(t => String(t.metadata[data.package_receiving?.identity_field ?? "mpn"] ?? "").toLowerCase() === String(labelFields.mpn ?? "").toLowerCase());
      setMsl(known.length === 1 ? String(known[0]!.metadata.msl ?? "") : "");
    } catch (e) { setError(e instanceof Error ? e.message : "The label could not be decoded."); }
    finally { setBusy(false); }
  }
  const photo = usePhotoPick(files => {
    if (!files[0] || !decodeBarcodeImage) return;
    setBusy(true); setError(null);
    void decodeBarcodeImage(files[0]).then(value => {
      if (!value) throw new Error("No 2D code was readable. Fill the frame with the label and try again.");
      setCode(value); return decode(value);
    }).catch(e => setError(e instanceof Error ? e.message : "The label could not be read.")).finally(() => setBusy(false));
  }, { title: "Scan a package label", label: "Package label photo" });

  async function print(id: string) {
    setBusy(true); setError(null);
    try { await run({ actionId: "labels:print", entityKind: "inventory:part", entityId: id }); setPrinted(true); }
    catch (e) { setError(`Stock was received. Its label was not queued: ${e instanceof Error ? e.message : "try again"}`); }
    finally { setBusy(false); }
  }
  async function receive() {
    setBusy(true); setError(null);
    try {
      const out = normaliseActionResult((await run({ actionId: "inventory:receive-package", args: {
        instance: data.child, code, receipt_key: receiptKey, partId: topUp || undefined, quantity: Number(quantity), identity: mpn,
        fields: { ...fields, ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}), ...(msl ? { msl } : {}), attrition_pct: Number(attrition) },
        location_id: location || null, packaging, storage, exposed_hours: Number(exposed),
      } })).result, "inventory.receive-package");
      if (!out.ok || !out.data) throw new Error(typeof out.error === "string" ? out.error : "This package was not received.");
      const received = out.data as Receipt;
      setReceipt(received);
      if (!received.already_received) await print(received.part_id);
    } catch (e) { setError(e instanceof Error ? e.message : "This package was not received."); }
    finally { setBusy(false); }
  }
  const input = "input w-full";
  return <>
    <button type="button" className="rounded border border-line px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>Receive a package</button>
    <Modal open={open} onClose={() => setOpen(false)} title="Receive a package" size="md">
      <div className="space-y-3" data-testid="package-receiving">
        <p className="text-sm text-muted">Scan the distributor’s 2D label. Review its part and count, then receive it and queue its QR label.</p>
        {error && <p role="alert" className="text-sm text-ember-700 dark:text-ember-300">{error}</p>}
        <form onSubmit={e => { e.preventDefault(); void decode(code); }} className="space-y-2">
          <label className="block text-sm">Distributor label<textarea className={input} value={code} onChange={e => { setCode(e.target.value); setFields(null); setReceipt(null); setReceiptKey(undefined); }} rows={2} /></label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !code} className="rounded border border-line px-3 py-2 text-sm">Read label</button>
            {decodeBarcodeImage && <button type="button" disabled={busy} onClick={photo.pick} className="rounded border border-line px-3 py-2 text-sm">Scan with camera</button>}{photo.input}
          </div>
        </form>
        {fields && !receipt && <form onSubmit={e => { e.preventDefault(); void receive(); }} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <label>Manufacturer part number<input required className={input} value={mpn} onChange={e => setMpn(e.target.value)} /></label>
            <label>{label("manufacturer", "Manufacturer")}<input className={input} value={manufacturer} onChange={e => setManufacturer(e.target.value)} /></label>
            <label>Package quantity<input required type="number" min="1" step="1" className={input} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
            <label>Packaging<select className={input} value={packaging} onChange={e => setPackaging(e.target.value)}>{["reel", "cut tape", "tray", "tube"].map(p => <option key={p}>{p}</option>)}</select></label>
            <label>MSL<select className={input} value={msl} onChange={e => setMsl(e.target.value)}><option value="">Not known</option>{["1", "2", "2a", "3", "4", "5", "5a", "6"].map(v => <option key={v}>{v}</option>)}</select></label>
            <label>Attrition (%)<input type="number" min="0" max="100" step="any" className={input} value={attrition} onChange={e => setAttrition(e.target.value)} /></label>
            <label>Storage<select className={input} value={storage} onChange={e => setStorage(e.target.value)}>{["sealed", "dry", "open"].map(v => <option key={v}>{v}</option>)}</select></label>
            <label>Earlier exposure (hours)<input type="number" min="0" step="any" className={input} value={exposed} onChange={e => setExposed(e.target.value)} /></label>
            <label>Location<select className={input} value={location} onChange={e => setLocation(e.target.value)}><option value="">Choose later</option>{places.data?.items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Receive into<select className={input} value={topUp} onChange={e => setTopUp(e.target.value)}><option value="">New package</option>{packages.filter(p => String(p.metadata.mpn ?? "").toLowerCase() === mpn.toLowerCase()).map(p => <option key={p.id} value={p.id}>{p.name} · {p.metadata.lot_code ? String(p.metadata.lot_code) : "no lot"} · {p.qty} left</option>)}</select></label>
          </div>
          <p className="text-xs text-muted">Lot: {String(fields.lot_code ?? "not on label")} · Date code: {String(fields.date_code ?? "not on label")}. An unknown MSL blocks use until confirmed on the part.</p>
          <button type="submit" disabled={busy} className="rounded bg-cobble-600 text-white px-3 py-2 text-sm">Receive and print label</button>
        </form>}
        {receipt && <div className="space-y-2 text-sm" role="status">
          <p>{receipt.already_received ? "This label was already received. Its count is unchanged." : `Received ${receipt.quantity}. ${printed ? "QR label queued." : "QR label needs printing."}`}</p>
          <Link to={`${childPath}/parts/${receipt.part_id}`} onClick={() => setOpen(false)} className="text-accent underline">Open package</Link>
          <div className="flex flex-wrap gap-2"><button disabled={busy} type="button" onClick={() => void print(receipt.part_id)} className="rounded border border-line px-3 py-2">Print label</button>
            <button type="button" onClick={() => { setReceiptKey(randomId()); setReceipt(null); setPrinted(false); }} className="rounded border border-line px-3 py-2">Receive another package with this label</button></div>
        </div>}
      </div>
    </Modal>
  </>;
}

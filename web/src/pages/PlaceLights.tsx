import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast, runAction, NumberField } from "@cobblr/platform-web";
import { PlaceLight, type PlaceLightMapping } from "@cobblr/platform-contract/place-indicate";
import { api, type Location } from "../lib/api";

export function PlaceLights({ slug, place, hasBins }: { slug: string; place: Location; hasBins: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const saved = PlaceLight.safeParse(place.metadata?.light);
  const mapping = saved.success ? saved.data : null;
  const [connection, setConnection] = useState(mapping?.connection_id ?? "");
  const [segment, setSegment] = useState(mapping && "pixels" in mapping && mapping.pixels?.length ? mapping.pixels[0]!.segment : 0);
  const [start, setStart] = useState(mapping && "pixels" in mapping && mapping.pixels?.length ? mapping.pixels[0]!.led : 0);
  const [count, setCount] = useState(mapping && "pixels" in mapping && mapping.pixels?.length ? mapping.pixels[0]!.count : 1);
  const [entity, setEntity] = useState(mapping && mapping.driver !== "wled" ? mapping.entity : "");
  const [mode, setMode] = useState<"strip" | "xy">("strip");
  const [order, setOrder] = useState<"row-major" | "serpentine">("row-major");
  const [columnSegment, setColumnSegment] = useState(1);
  const [columnStart, setColumnStart] = useState(0);
  const connections = useQuery({ queryKey: ["place-light-connections", slug], queryFn: () => api.lightConnections(slug) });
  const selected = connections.data?.items.find(c => c.credentialId === connection);
  const wled = selected?.provider === "wled.indicate";
  const esphome = selected?.provider === "esphome.indicate";
  const valid = !!selected && (wled || esphome || selected.provider === "home-assistant.indicate");
  const [pixels, setPixels] = useState(mapping?.driver === "esphome" && !!mapping.pixels);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["location", slug] });
    void qc.invalidateQueries({ queryKey: ["locations", slug] });
  };
  const save = useMutation({
    mutationFn: async (test: boolean) => {
      const light: PlaceLightMapping = wled ? { connection_id: connection, driver: "wled", pixels: [{ segment, led: start, count }] } : esphome ? { connection_id: connection, driver: "esphome", entity, ...(pixels ? { pixels: [{ segment, led: start, count }] } : {}) } : { connection_id: connection, driver: "home-assistant", entity };
      await api.setPlaceLight(slug, place.id, PlaceLight.parse(light));
      if (test) {
        // NO-UNDO: a three-second flash of the light; nothing stays to take back.
        // PRESS-ARGS: The saved place is the target; duration is fixed and colour is optional.
        const result = await runAction(api, qc, slug, { actionId: "core-locations:indicate", entityKind: "core-locations:location", entityId: place.id, args: { duration: 3 } });
        if (!result.ok) throw new Error("The light did not answer. Check its mapping and connection.");
      }
    },
    onSuccess: () => { refresh(); toast.success("Light saved"); }, onError: e => toast.error(e.message),
  });
  const clear = useMutation({ mutationFn: () => api.setPlaceLight(slug, place.id, null), onSuccess: () => { setConnection(""); refresh(); toast.success("Light removed. This place can use its nearest lit ancestor."); }, onError: e => toast.error(e.message) });
  const grid = useMutation({
    mutationFn: () => api.setGridLights(slug, place.id, { connection_id: connection, driver: esphome ? "esphome" : "wled", ...(esphome ? { entity } : {}), mode, segment, start, per_bin: count, order, ...(mode === "xy" ? { column_segment: columnSegment, column_start: columnStart } : {}) }),
    onSuccess: r => { refresh(); toast.success(`Lights mapped for ${r.mapped} bins`); }, onError: e => toast.error(e.message),
  });
  const show = useMutation({ mutationFn: () => api.requestLight(slug, { kind: "core-locations:location", id: place.id }, "shown"), onSuccess: r => toast.success(r.note), onError: e => toast.error(e.message) });
  const busy = save.isPending || grid.isPending || clear.isPending;
  const numeric = (label: string, value: number, set: (n: number) => void, min = 0, max = 65534) => <label className="flex flex-col gap-1 min-w-0 text-xs">{label}<NumberField min={min} max={max} value={value} onChange={(n) => set(n)} className="w-full rounded border border-line bg-surface p-2 text-sm" /></label>;
  return <details className="rounded border border-line p-3">
    <summary className="cursor-pointer text-sm font-medium">Light</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted">A bin with no light of its own uses its nearest lit shelf or rack. Lights turn off after 30 seconds unless the connection says otherwise.</p>
      {connections.isError && <p role="alert">Light connections could not be loaded.</p>}
      <label className="flex flex-col gap-1 text-xs">Light connection<select aria-label="Light connection" value={connection} onChange={e => setConnection(e.target.value)} className="w-full rounded border border-line bg-surface p-2 text-sm">
        <option value="">Choose a connection</option>
        {(connections.data?.items ?? []).filter(c => ["wled.indicate", "home-assistant.indicate", "esphome.indicate"].includes(c.provider)).map(c => <option key={c.credentialId} value={c.credentialId}>{c.label}</option>)}
      </select></label>
      <Link to="/me/connections?add=service&capability=place.indicate" className="text-xs text-accent">Connect WLED or Home Assistant, or add ESPHome in Devices</Link>
      {valid && <>
        {wled ? <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{numeric("Segment", segment, setSegment, 0, 255)}{numeric("Starting LED", start, setStart)}{numeric("LEDs per bin", count, setCount, 1, 1024)}</div> : <label className="flex flex-col gap-1 text-xs">Light entity<input placeholder={esphome ? "light-bin" : "light.bin_a1"} value={entity} onChange={e => setEntity(e.target.value)} className="w-full rounded border border-line bg-surface p-2 text-sm" /></label>}
        {esphome && <>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={pixels} onChange={e => setPixels(e.target.checked)} />Use a per-LED effect</label>
          <p className="text-xs text-muted">Choose the entity listed in Devices. Per-LED mappings need the matching {productName()} effect installed in ESPHome.</p>
          {pixels && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{numeric("Segment", segment, setSegment, 0, 255)}{numeric("Starting LED", start, setStart)}{numeric("LEDs per bin", count, setCount, 1, 1024)}</div>}
        </>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => save.mutate(false)} className="rounded border border-line px-3 py-1 text-sm">Save light</button>
          <button type="button" disabled={busy} onClick={() => save.mutate(true)} className="rounded border border-line px-3 py-1 text-sm">Save and test light</button>
        </div>
        {(wled || esphome) && hasBins && <fieldset className="space-y-2 border-t border-line pt-3">
          <legend className="text-sm">Map all bins in this grid</legend>
          <label className="flex flex-col gap-1 text-xs">Layout<select value={mode} onChange={e => setMode(e.target.value as "strip" | "xy")} className="w-full rounded border border-line bg-surface p-2 text-sm"><option value="strip">One strip runs along these bins</option><option value="xy">Row and column strips (X/Y)</option></select></label>
          {mode === "strip" ? <label className="flex flex-col gap-1 text-xs">LED order<select value={order} onChange={e => setOrder(e.target.value as "row-major" | "serpentine")} className="w-full rounded border border-line bg-surface p-2 text-sm"><option value="row-major">Row by row, left to right</option><option value="serpentine">Serpentine, reversing every other row</option></select></label> : <div className="grid grid-cols-2 gap-2">{numeric("Column segment", columnSegment, setColumnSegment, 0, 255)}{numeric("Column starting LED", columnStart, setColumnStart)}</div>}
          <p className="text-xs text-muted">Uses each bin's position from + grid. This replaces the light mapping on every child bin.</p>
          <button type="button" disabled={busy} onClick={() => grid.mutate()} className="rounded border border-line px-3 py-1 text-sm">Map all bin lights</button>
        </fieldset>}
      </>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={show.isPending} onClick={() => show.mutate()} className="rounded border border-line px-3 py-1 text-sm">Show me</button>
        {mapping && <button type="button" disabled={busy} onClick={() => clear.mutate()} className="text-sm px-3 py-1">Remove light</button>}
      </div>
    </div>
  </details>;
}

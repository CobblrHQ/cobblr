import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchInput, SecretInput, useToast } from "@cobblr/platform-web";
import type { DeviceConnectionPublic } from "@cobblr/platform-contract";
import { api, type SearchHit } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";
import { ServiceJobCard } from "../components/ServiceJobCard";

const field = "w-full rounded border border-line bg-surface p-2 text-sm";
const button = "rounded border border-line px-3 py-2 text-sm disabled:opacity-50";

export function ESPHomeDevices() {
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("http://127.0.0.1:8077/esphome");
  const [bridge, setBridge] = useState("");
  const [token, setToken] = useState("");
  const connections = useQuery({ queryKey: ["esphome", slug], queryFn: () => api.esphomeConnections(slug) });
  const add = useMutation({ mutationFn: () => api.addESPHome(slug, { label, base_url: address, bridge, ...(token ? { api_key: token } : {}) }), onSuccess: () => { setLabel(""); setToken(""); void qc.invalidateQueries({ queryKey: ["esphome", slug] }); void qc.invalidateQueries({ queryKey: ["place-light-connections", slug] }); }, onError: e => toast.error(e.message) });
  return <section className="space-y-4">
    <h2 className="text-[10px] font-mono uppercase tracking-widest text-accent">ESPHome devices</h2>
    <p className="text-sm text-muted">Use lights, sensors and switches without Home Assistant. Install an ESPHome driver on your bridge. Its native API key stays in the bridge configuration.</p>
    <form className="space-y-3 max-w-xl" onSubmit={e => { e.preventDefault(); add.mutate(); }}>
      <label className="block text-sm">Name<input className={field} value={label} onChange={e => setLabel(e.target.value)} required /></label>
      <label className="block text-sm">Bridge instance address<input className={field} value={address} onChange={e => setAddress(e.target.value)} type="url" required /></label>
      <label className="block text-sm">Bridge name<input className={field} value={bridge} onChange={e => setBridge(e.target.value)} placeholder="Leave empty for the default bridge" /></label>
      <label className="block text-sm">Bridge access token<SecretInput value={token} onChange={e => setToken(e.target.value)} placeholder="Only if this bridge instance requires one" /></label>
      <button className={button} type="submit" disabled={add.isPending}>Add ESPHome device</button>
    </form>
    {connections.isPending && <p role="status">Loading devices...</p>}
    {connections.isError && <p role="alert">Devices could not be loaded.</p>}
    {connections.data?.items.map(connection => <Device key={connection.id} slug={slug} connection={connection} />)}
  </section>;
}

function Device({ slug, connection }: { slug: string; connection: DeviceConnectionPublic }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  const entities = useQuery({ queryKey: ["esphome-entities", slug, connection.id, connection.config.host], queryFn: () => api.esphomeEntities(slug, connection.id), enabled: opened });
  const links = useQuery({ queryKey: ["device-links", slug, connection.id], queryFn: () => api.deviceLinks(slug, connection.id), enabled: opened, refetchInterval: opened ? 10_000 : false });
  const discover = useMutation({ mutationFn: () => api.discoverESPHome(slug, connection.id), onError: e => toast.error(e.message) });
  const choose = useMutation({ mutationFn: (host: string) => api.chooseESPHome(slug, connection.id, host), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["esphome", slug] }); }, onError: e => toast.error(e.message) });
  const remove = useMutation({ mutationFn: () => api.removeESPHome(slug, connection.id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["esphome", slug] }); }, onError: e => toast.error(e.message) });
  return <details className="border border-line rounded p-3" onToggle={e => setOpened(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{connection.label}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted">{typeof connection.config.host === "string" ? connection.config.host : "Uses the host configured on the bridge"}</p>
      <button type="button" className={button} disabled={discover.isPending} onClick={() => discover.mutate()}>Find devices on this network</button>
      {discover.data && <label className="block text-sm">Found devices<select className={field} value={String(connection.config.host || "")} disabled={choose.isPending} onChange={e => { if (e.target.value) choose.mutate(e.target.value); }}><option value="">Choose a device</option>{discover.data.items.map(d => <option key={d.host} value={d.host}>{d.name} ({d.host})</option>)}</select></label>}
      {entities.isLoading && opened && <p role="status">Reading ESPHome entities...</p>}
      {entities.isError && <p role="alert">ESPHome did not answer. Check the bridge configuration and native API key. <button type="button" className={button} onClick={() => void entities.refetch()}>Try again</button></p>}
      {entities.data?.items.map(entity => <div key={entity.id} className="border-t border-line pt-3 space-y-2">
        <p className="font-medium">{entity.name} <span className="text-xs text-muted">{entity.id}</span></p>
        {entity.id.startsWith("light-") ? <p className="text-sm">Choose this connection and entity in a <Link className="text-accent" to={`/w/${slug}/locations`}>place's Light settings</Link>.</p> : entity.id.startsWith("sensor-") || entity.id.startsWith("binary_sensor-") ? <AttachSensor slug={slug} connection={connection.id} device={entity.id} /> : <EntityAction slug={slug} connection={connection} entity={entity.id} />}
        {links.data?.items.filter(link => link.device === entity.id).map(link => <AttachedReading key={link.id} slug={slug} connection={connection.id} link={link} />)}
      </div>)}
      {links.isError && <p role="alert">Sensor attachments could not be loaded.</p>}
      <p className="text-xs text-muted">Readings need ingest_url and ingest_token in the bridge config. Use sensor readings in Wires. Physical actions ask for your yes before running.</p>
      <button type="button" className={button} disabled={remove.isPending} onClick={() => remove.mutate()}>Remove device connection</button>
    </div>
  </details>;
}

function AttachSensor({ slug, connection, device }: { slug: string; connection: string; device: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [record, setRecord] = useState<SearchHit | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(draft.trim()), 200); return () => clearTimeout(timer); }, [draft]);
  const search = useQuery({ queryKey: ["sensor-record", slug, query], queryFn: () => api.search(slug, { q: query, per_kind: 5 }), enabled: query.length > 1 });
  const attach = useMutation({ mutationFn: () => {
    if (!record) throw new Error("Choose the record this sensor measures.");
    return api.attachDevice(slug, { connection_id: connection, device, entity_kind: record.kind, entity_id: record.id, mode: "log" });
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ["device-links", slug, connection] }); toast.success("Sensor attached"); setDraft(""); setRecord(null); }, onError: e => toast.error(e.message) });
  return <div className="space-y-2 max-w-xl">
    <SearchInput aria-label={`Record measured by ${device}`} placeholder="Find what this sensor measures" value={draft} onChange={value => { setDraft(value); setRecord(null); }} />
    {search.isError && <p role="alert">Records could not be searched.</p>}
    {!record && search.data?.items.map(hit => <button key={`${hit.kind}:${hit.id}`} type="button" className={`${button} block w-full text-left`} onClick={() => { setRecord(hit); setDraft(hit.title); }}>{hit.title}</button>)}
    {record && <button type="button" className={button} disabled={attach.isPending} onClick={() => attach.mutate()}>Attach sensor to {record.title}</button>}
  </div>;
}

function AttachedReading({ slug, connection, link }: { slug: string; connection: string; link: { id: string; entity_kind: string; entity_id: string; value: number | null; unit: string | null; sampled_at: string | null } }) {
  const toast = useToast();
  const qc = useQueryClient();
  const record = useQuery({ queryKey: ["sensor-attached-record", slug, link.entity_kind, link.entity_id], queryFn: () => api.lookupEntity(slug, link.entity_kind, link.entity_id) });
  const detailRoute = useDetailRoute(slug);
  const href = detailRoute(link.entity_kind, link.entity_id, record.data?.detailUrl);
  const unlink = useMutation({ mutationFn: () => api.unlinkDevice(slug, link.id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["device-links", slug, connection] }); }, onError: e => toast.error(e.message) });
  return <p className="text-sm">{href ? <Link className="text-accent" to={`/w/${slug}${href}`}>{record.data?.title || "Attached record"}</Link> : <span>{record.data?.title || "Attached record"}</span>}: {link.value === null ? "Waiting for a reading" : `${link.value} ${link.unit || ""}`}{link.sampled_at && ` · ${new Date(link.sampled_at).toLocaleString()}`} <button type="button" className={button} disabled={unlink.isPending} onClick={() => unlink.mutate()}>Detach sensor</button></p>;
}

function EntityAction({ slug, connection, entity }: { slug: string; connection: DeviceConnectionPublic; entity: string }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [job, setJob] = useState<string | null>(null);
  const command = entity.split("-")[0]!;
  const run = useMutation({ mutationFn: (state?: boolean) => api.esphomeCommand(slug, String(connection.config.service_connection || ""), { command, entity, ...(command === "switch" ? { state } : command === "number" ? { value: Number(value) } : command === "select" ? { option: value } : {}) }), onSuccess: result => setJob(result.id), onError: e => toast.error(e.message) });
  return <div className="space-y-2">
    {["number", "select"].includes(command) && <label className="block text-sm">{command === "number" ? "Value" : "Option"}<input className={field} value={value} type={command === "number" ? "number" : "text"} onChange={e => setValue(e.target.value)} /></label>}
    {command === "switch" ? <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={run.isPending} onClick={() => run.mutate(true)}>Turn on</button><button type="button" className={button} disabled={run.isPending} onClick={() => run.mutate(false)}>Turn off</button></div> : <button type="button" className={button} disabled={run.isPending || (["number", "select"].includes(command) && !value)} onClick={() => run.mutate(undefined)}>{command === "button" ? "Press button" : "Set value"}</button>}
    {job && <ServiceJobCard slug={slug} jobId={job} capability="device.esphome.command" />}
  </div>;
}

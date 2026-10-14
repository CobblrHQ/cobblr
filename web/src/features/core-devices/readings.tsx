import { useQuery } from "@tanstack/react-query";
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { api } from "../../lib/api";

export function ReadingsPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const readings = useQuery({ queryKey: ["record-device-readings", ctx.slug, ctx.kind, ctx.entityId], queryFn: () => api.deviceReadingsForRecord(ctx.slug, ctx.kind!, ctx.entityId), enabled: !!ctx.kind, refetchInterval: 10_000 });
  if (readings.isError) return <p role="alert" className="text-sm">Sensor readings could not be loaded.</p>;
  const items = readings.data?.items ?? [];
  if (!items.length) return null;
  return <section className="space-y-2">
    <h3 className="text-[10px] uppercase tracking-widest text-accent">Sensor readings</h3>
    {items.map(item => <p key={item.id} className="text-sm"><span className="text-muted">{item.device}: </span>{item.value === null ? "Waiting for a reading" : `${item.value} ${item.unit || ""}`}{item.sampled_at && <span className="text-xs text-muted"> · {new Date(item.sampled_at).toLocaleString()}</span>}</p>)}
  </section>;
}

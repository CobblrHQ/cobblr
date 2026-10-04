import type { DigifabFleetDevice } from "../../lib/api";
export function LightBurnReadiness({ readiness }: { readiness: NonNullable<DigifabFleetDevice["lightburn_readiness"]> }) {
  return <div className="rounded border border-line p-2 text-xs space-y-1" aria-label="LightBurn readiness">
    {([["api", "API reachable"], ["paired", "Paired"], ["udp", "UDP listener on"]] as const).map(([key, label]) => <div key={key}>
      <span className={readiness[key].ready ? "text-moss-700 dark:text-moss-300" : "text-amber-700 dark:text-amber-300"}>{label}{readiness[key].ready ? " ✓" : ": needs attention"}</span>
      {!readiness[key].ready && <p className="text-muted">{readiness[key].fix}</p>}
    </div>)}
  </div>;
}

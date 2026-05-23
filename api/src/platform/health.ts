// Health-probe registry. The platform-side implementation that
// PlatformHealth exposes to modules: probes are name → async fn,
// snapshot() runs them all in parallel and uniforms any thrown
// errors into { status: 'error', message }.

import type { HealthProbe, HealthProbeResult } from "@cobblr/platform-contract";

const probes = new Map<string, HealthProbe>();

export function registerProbe(name: string, probe: HealthProbe): void {
  probes.set(name, probe);
}

export async function snapshot(): Promise<Record<string, HealthProbeResult>> {
  const entries = Array.from(probes.entries());
  const results = await Promise.all(
    entries.map(async ([name, probe]) => {
      try {
        return [name, await probe()] as const;
      } catch (err) {
        return [
          name,
          {
            status: "error" as const,
            message: (err as Error).message,
          } satisfies HealthProbeResult,
        ] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

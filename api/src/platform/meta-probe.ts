// What one probed request asked the meta database (#4876): a test sends
// `x-meta-probe: <id>` and reads the answer from /test-support/meta-probe/<id>
// once the response is in. Bounded: the last 200 probes, the 20 most
// repeated statements of each.
import type { RequestScope } from "../lib/request-context.js";

export interface MetaProbe {
  total: number;
  statements: Array<{ text: string; count: number }>;
  cold_ttl_caches?: true;
}
const probes = new Map<string, MetaProbe>();

export function rememberProbe(id: string, scope: RequestScope): void {
  const statements = [...scope.meta.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
  probes.set(id, { total: statements.reduce((n, s) => n + s.count, 0), statements: statements.slice(0, 20), ...(scope.coldTtlCaches ? { cold_ttl_caches: true as const } : {}) });
  while (probes.size > 200) probes.delete(probes.keys().next().value as string);
}

export function readProbe(id: string): MetaProbe | null {
  return probes.get(id) ?? null;
}

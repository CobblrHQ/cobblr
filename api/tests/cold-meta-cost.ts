import type { MetaProbe } from "../src/platform/meta-probe.js";
export type { MetaProbe } from "../src/platform/meta-probe.js";

export async function coldMetaCost(
  id: string,
  request: (headers: Record<string, string>) => Promise<Response>,
  readProbe: (id: string) => Promise<MetaProbe>,
): Promise<MetaProbe> {
  const response = await request({ "x-meta-probe": id, "x-meta-probe-cold": "1" });
  if (response.status !== 200) throw new Error(`measured request answered ${response.status}: ${await response.text()}`);
  await response.arrayBuffer();
  const probe = await readProbe(id);
  if (probe.cold_ttl_caches !== true) throw new Error(`meta probe ${id} did not acknowledge cold caches`);
  return probe;
}

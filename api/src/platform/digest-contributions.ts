import type { DigestContribution, DigestContributor } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
const contributors = new Map<string, { eventType: string; module: string; read: DigestContributor }>();
export function registerDigestContributor(eventType: string, module: string, read: DigestContributor): void {
 contributors.set(`${eventType}:${module}`, { eventType, module, read });
}
export async function digestContributions(eventType: string, orgId: string, db: unknown): Promise<DigestContribution[]> {
 const enabled = new Set((await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map(r => r.module_name));
 const out: DigestContribution[] = [];
 for (const source of contributors.values()) {
  if (source.eventType !== eventType || !enabled.has(source.module)) continue;
  try { out.push(...(await source.read(orgId, db)).map(item => ({ ...item, key: `${source.module}:${item.key}` }))); }
  catch (e) { console.error(`[digest] ${source.module} contribution failed:`, (e as Error).message); }
 }
 return [...new Map(out.map(item => [item.key, item])).values()];
}

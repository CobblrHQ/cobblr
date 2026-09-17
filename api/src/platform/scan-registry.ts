// In-process registry of scan targets. An entity-owning module declares its
// kind as scannable — at boot, via platform().entities.registerScannable(kind,
// { noun, createEndpoint, qtyField }) — and core-scan reads from here instead
// of a hardcoded SCANNABLE set + KIND_CREATE_ENDPOINTS + KIND_QTY_FIELD maps.
// So adding a scannable module needs no core-scan edit, and the module owns the
// device-side knowledge (its own create endpoint + quantity field name).
//
// In-memory (no DB column) — same shape as create-defaults / device-apply.
// (Audit 2026-06-26 follow-up.)

import type { EntityKindRecord, ScannableInfo, ScannableKind } from "@cobblr/platform-contract";
import { listKindsForOrg } from "./entities.js";

const scannable = new Map<string, ScannableInfo>();

export function registerScannable(kind: string, info: ScannableInfo): void {
  scannable.set(kind, info);
}

export function getScannable(kind: string): ScannableInfo | null {
  return scannable.get(kind) ?? null;
}

// Scannability is a MODULE-level property (one create endpoint + qty field per
// module), keyed here by the module's base kind ("assets:asset"). A confirm/apply
// caller may instead hold an INSTANCE-scoped kind ("vehicles:item") — the instance
// routes the create separately, so the module's one scannable still applies. Resolve
// by module prefix so any such kind maps back to its module's scan target instead of
// 400ing. (A module registers exactly one scannable; first match wins.)
export function getScannableForModule(module: string): ScannableInfo | null {
  const prefix = `${module}:`;
  for (const [kind, info] of scannable) {
    if (kind.startsWith(prefix)) return info;
  }
  return null;
}

export function listScannable(): Array<{ kind: string } & ScannableInfo> {
  return [...scannable.entries()].map(([kind, info]) => ({ kind, ...info }));
}

// The scannable kinds THIS workspace has, instances included. `listScannable`
// above is the process-global registry of BASE kinds, one per module, and a
// record living in a named instance (a Groceries table's tomatoes, under
// `groceries:item`) never appears in its base kind's list. Every consumer that
// walked `listScannable()` to read RECORDS saw no grocery and no yarn, returned
// a plausible answer from what it did see, and errored nowhere: the tracked
// match (2026-09-06), then the sibling tier, the Organize plan's unplaced
// sweep, the bin census and the per-kind duplicates door (#3132). A comment in
// one of them said so and three more were written after it, so the answer is
// one seam here and a capability row refusing the registry walk elsewhere.
//
// An instance kind inherits its module's scannable (noun, create endpoint,
// quantity field): the instance routes the write, the module owns the scan.
export async function listScannableForOrg(orgId: string): Promise<ScannableKind[]> {
  const recs = await listKindsForOrg(orgId);
  const out: ScannableKind[] = [];
  for (const rec of recs) {
    const kind = rec.id.includes(":") ? rec.id : `${rec.module_name}:${rec.id}`;
    const info = scannable.get(kind) ?? getScannableForModule(rec.module_name);
    if (!info) continue;
    out.push({ kind, ...info, module: rec.module_name, instance: rec.instance_name ?? null, record: rec as EntityKindRecord });
  }
  return out;
}

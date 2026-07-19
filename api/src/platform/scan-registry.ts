// In-process registry of scan targets. An entity-owning module declares its
// kind as scannable — at boot, via platform().entities.registerScannable(kind,
// { noun, createEndpoint, qtyField }) — and core-scan reads from here instead
// of a hardcoded SCANNABLE set + KIND_CREATE_ENDPOINTS + KIND_QTY_FIELD maps.
// So adding a scannable module needs no core-scan edit, and the module owns the
// device-side knowledge (its own create endpoint + quantity field name).
//
// In-memory (no DB column) — same shape as create-defaults / device-apply.
// (Audit 2026-06-26 follow-up.)

import type { ScannableInfo } from "@cobblr/platform-contract";

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

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

export function listScannable(): Array<{ kind: string } & ScannableInfo> {
  return [...scannable.entries()].map(([kind, info]) => ({ kind, ...info }));
}

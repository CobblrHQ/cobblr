// platform().units — the kernel-side registry for the units service. The
// vocabulary + the conversion math live in core-units (the ONLY allowed home
// per scripts/lint-unit-conversion.ts); core-units registers its service at
// load and every consumer (a module's planner, a kernel route) asks through
// here. No service registered (core-units disabled) → null answers, and
// consumers degrade to "no physical semantics" rather than guessing.

import type { PlatformUnitInfo, UnitsService } from "@cobblr/platform-contract";

let service: UnitsService | null = null;

export function registerService(svc: UnitsService): void {
  service = svc;
}

export async function resolve(orgId: string, raw: string): Promise<PlatformUnitInfo | null> {
  if (!service) return null;
  try {
    return await service.resolve(orgId, raw);
  } catch {
    return null;
  }
}

export async function convert(
  orgId: string,
  value: number,
  fromRaw: string,
  toRaw: string,
): Promise<number | null> {
  if (!service) return null;
  try {
    return await service.convert(orgId, value, fromRaw, toRaw);
  } catch {
    return null;
  }
}

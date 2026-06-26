// In-process registry of device-apply providers. A module that owns an entity
// kind registers — at boot, via platform().entities.registerDeviceApply(kind,
// fn) — how a device reading's `mode` maps to one of its OWN actions. core-
// devices then resolves a reading through applyDevice() and invokes the
// returned action, so it never hardcodes a target module / kind / action id
// (and the isolation lint can't be fooled by a `kind === "…"` branch).
//
// The registry is INERT until a module opts in: applyDevice returns null when
// nothing is registered for a kind, so core-devices just skips the reading.
// (Audit 2026-06-26 follow-up.)

import type { DeviceApplyContext, DeviceApplyProvider } from "@cobblr/platform-contract";

const providers = new Map<string, DeviceApplyProvider>();

export function registerDeviceApply(kind: string, provider: DeviceApplyProvider): void {
  providers.set(kind, provider);
}

export function applyDevice(
  kind: string,
  ctx: DeviceApplyContext,
): { actionId: string; args: Record<string, unknown> } | null {
  const provider = providers.get(kind);
  if (!provider) return null;
  try {
    return provider(ctx);
  } catch (err) {
    console.error(`[device-apply] provider for '${kind}' failed:`, (err as Error).message);
    return null;
  }
}

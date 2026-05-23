// Module-lifecycle hooks. Each registered module can optionally
// declare `lifecycle: { onBoot, onShutdown }` in its manifest.
//
// onBoot runs after mountModules / completeApp, before app.listen —
// modules use it to start background work (schedulers, polling loops,
// background subscribers) that's owned by the module rather than the
// platform.
//
// onShutdown runs on SIGTERM/SIGINT before server.close(). Both are
// independent per module — one failure logs + moves on rather than
// stopping the rest.

import { listEntries } from "./registry.js";

/** Resolve a module's lifecycle hook to the actual function. Hooks
 *  are declared as dynamic imports (same shape as manifest.api) so
 *  the heavy module code only loads when the hook is invoked. */
interface LifecycleHook {
  (): Promise<unknown>;
}

async function callHook(
  moduleName: string,
  hookName: "onBoot" | "onShutdown",
  hook: LifecycleHook,
): Promise<void> {
  try {
    await hook();
  } catch (err) {
    console.error(
      `[lifecycle] ${moduleName}.${hookName} failed:`,
      (err as Error).message,
    );
  }
}

/** Run every module's onBoot in registration order (dependencies
 *  already came first per topoSort in loader.ts). */
export async function runOnBoot(): Promise<{ ran: string[] }> {
  const ran: string[] = [];
  for (const entry of listEntries()) {
    const hook = entry.manifest.lifecycle?.onBoot;
    if (!hook) continue;
    await callHook(entry.manifest.name, "onBoot", hook as LifecycleHook);
    ran.push(entry.manifest.name);
  }
  if (ran.length > 0) {
    console.log(`[lifecycle] onBoot ran: ${ran.join(", ")}`);
  }
  return { ran };
}

/** Run every module's onShutdown in REVERSE registration order so
 *  dependents stop before their deps. Time-bounded — if a module's
 *  shutdown hangs the whole shutdown shouldn't. */
export async function runOnShutdown(): Promise<{ ran: string[] }> {
  const ran: string[] = [];
  const entries = [...listEntries()].reverse();
  for (const entry of entries) {
    const hook = entry.manifest.lifecycle?.onShutdown;
    if (!hook) continue;
    // Per-hook 2s cap so one slow module doesn't block the rest.
    const timeout = new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error("onShutdown timed out (2s)")), 2_000),
    );
    try {
      await Promise.race([hook(), timeout]);
      ran.push(entry.manifest.name);
    } catch (err) {
      console.error(
        `[lifecycle] ${entry.manifest.name}.onShutdown failed:`,
        (err as Error).message,
      );
    }
  }
  return { ran };
}

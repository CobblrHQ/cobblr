import { localFetch, allowLocalAccess } from "@cobblr/platform-web";
export interface DesktopBridgeStatus { desktop: boolean; version: string }
export interface LightBurnChecks { api: { ready: boolean; fix: string }; paired: { ready: boolean; fix: string }; udp: { ready: boolean; fix: string } }
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const invoke = (): Invoke | undefined => (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
export async function desktopBridgeAction(action: "status" | "pair" | "connect", code?: string): Promise<{ desktop?: boolean; version?: string; readiness?: LightBurnChecks; ok?: boolean }> {
  const native = invoke();
  if (native) {
    try { return await native(action === "status" ? "desktop_bridge_status" : action === "pair" ? "pair_lightburn" : "connect_desktop", code ? { code } : {}) as Awaited<ReturnType<typeof desktopBridgeAction>>; }
    catch (error) {
      if (!/not found|unknown command|not allowed|does not exist/i.test(String(error))) throw new Error(String(error));
      throw new Error("Update Cobblr Desktop to use LightBurn pairing, then try again. Check its App settings for updates."); }
  }
  if (action !== "status") allowLocalAccess(`desktop-bridge-${action}`);
  const response = await localFetch(`http://127.0.0.1:8077${action === "status" ? "/" : action === "pair" ? "/desktop/pair-lightburn" : "/desktop/connect"}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { accept: "application/json", ...(action !== "status" ? { "content-type": "application/json" } : {}) },
    ...(action !== "status" ? { body: JSON.stringify(code ? { code } : {}) } : {}),
    signal: AbortSignal.timeout(action === "pair" ? 45_000 : 20_000),
  });
  const result = await response.json() as { error?: string; desktop?: boolean; version?: string; readiness?: LightBurnChecks; ok?: boolean };
  if (!response.ok) throw new Error(result.error || "Open or update Cobblr Desktop on this computer, then try again.");
  return result;
}

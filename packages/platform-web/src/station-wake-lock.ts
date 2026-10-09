import { useEffect } from "react";
type Sentinel = Pick<WakeLockSentinel, "released" | "release">;
export function stationWakeLock(request: () => Promise<Sentinel>, visible: () => boolean) {
  let stopped = false, pending = false, lock: Sentinel | undefined;
  return {
    async acquire() {
      if (stopped || pending || lock && !lock.released || !visible()) return;
      pending = true;
      try { const next = await request(); if (stopped) await next.release(); else lock = next; } catch { /* Staying awake may be unavailable or denied. */ } finally { pending = false; }
    },
    stop() { stopped = true; void lock?.release(); },
  };
}
export function useStationWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !navigator.wakeLock) return;
    const station = stationWakeLock(() => navigator.wakeLock.request("screen"), () => document.visibilityState === "visible");
    const acquire = () => { void station.acquire(); };
    acquire(); document.addEventListener("visibilitychange", acquire);
    return () => { document.removeEventListener("visibilitychange", acquire); station.stop(); };
  }, [active]);
}

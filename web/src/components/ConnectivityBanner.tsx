// One calm app-wide bar shown when the API is unreachable — instead of every
// query surfacing its own raw "Failed to fetch" / "Non-JSON response (502)".
// Driven by the connectivity signal in lib/api: a fetch rejection or a gateway
// 5xx marks us down; the next successful response clears it. While down we poll
// /healthz so the bar auto-dismisses on recovery even if the user is idle.
//
// Offline (#4226) it says so, and says how old what is on screen is: the
// service worker answers with the reads this device kept, each marked with
// when it was fetched, and the earliest of those is "as of" here, so a kept
// copy is never taken for live. Back online, everything is fetched again at
// once rather than waiting for each query's own timer.
//
// What waits to be sent is counted, never just promised (#7928): "Waiting to
// send (2)" is the edits and creates kept on this device plus any of this
// page's own the device could not keep, so a change is "saved" only once the
// server has answered it.
import { productName, subscribeWaitingWrites, waitingWriteCount } from "@cobblr/platform-web";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { FloatingChrome } from "@cobblr/platform-web";
import { getToken, subscribeConnectivity, subscribeOfflineCopies, pingHealth } from "../lib/api";
import { asOfWords } from "../lib/offline";

export function ConnectivityBanner() {
  const qc = useQueryClient();
  const [down, setDown] = useState(false);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const wasDown = useRef(false);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => subscribeConnectivity(setDown), []);
  useEffect(() => {
    const count = () => {
      const token = getToken();
      const kept = waitingWriteCount(token ? `Bearer ${token}` : null);
      const paused = qc.getMutationCache().getAll().filter((m) => m.state.isPaused).length;
      setWaiting(Math.max(kept, paused));
    };
    count();
    const offStore = subscribeWaitingWrites(count);
    const offCache = qc.getMutationCache().subscribe(count);
    return () => {
      offStore();
      offCache();
    };
  }, [qc]);
  useEffect(() => subscribeOfflineCopies(setAsOf), []);

  useEffect(() => {
    const on = () => {
      setOffline(false);
      void pingHealth();
    };
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Back: everything on screen was fetched before, or kept; fetch it again.
  useEffect(() => {
    if (wasDown.current && !down) void qc.invalidateQueries();
    wasDown.current = down;
  }, [down, qc]);

  useEffect(() => {
    if (!down) return;
    const id = setInterval(() => {
      void pingHealth();
    }, 5000);
    return () => clearInterval(id);
  }, [down]);

  if (!down && !offline) return null;
  const isOffline = offline || asOf !== null;
  return (
    <FloatingChrome
      anchor="top"
      reserveTop
      yields={false}
      role="alert"
      aria-live="assertive"
      data-testid="connectivity-banner"
      data-offline={isOffline ? "true" : "false"}
      className="z-[200] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-ember-600 px-4 py-2 text-center text-sm font-medium text-white shadow-md"
    >
      <WifiOff size={15} aria-hidden />
      {isOffline ? (
        <span>
          You're offline.{" "}
          {asOf !== null ? <>Showing what you had as of {asOfWords(asOf)}. </> : null}
          {waiting > 0 ? <>Waiting to send ({waiting}).</> : <>Changes wait until you're back.</>}
        </span>
      ) : (
        <span>Can't reach {productName()} - reconnecting…</span>
      )}
      <button
        type="button"
        onClick={() => void pingHealth()}
        className="inline-flex items-center gap-1 rounded border border-white/60 px-2 py-0.5 text-xs font-semibold hover:bg-white/10"
      >
        <RefreshCw size={12} aria-hidden /> Retry
      </button>
    </FloatingChrome>
  );
}

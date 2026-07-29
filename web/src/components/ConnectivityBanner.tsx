// One calm app-wide bar shown when the API is unreachable — instead of every
// query surfacing its own raw "Failed to fetch" / "Non-JSON response (502)".
// Driven by the connectivity signal in lib/api: a fetch rejection or a gateway
// 5xx marks us down; the next successful response clears it. While down we poll
// /healthz so the bar auto-dismisses on recovery even if the user is idle.
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { subscribeConnectivity, pingHealth } from "../lib/api";

export function ConnectivityBanner() {
  const [down, setDown] = useState(false);
  useEffect(() => subscribeConnectivity(setDown), []);

  useEffect(() => {
    if (!down) return;
    const id = setInterval(() => {
      void pingHealth();
    }, 5000);
    return () => clearInterval(id);
  }, [down]);

  if (!down) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-ember-600 px-4 py-2 text-center text-sm font-medium text-white shadow-md"
    >
      <WifiOff size={15} aria-hidden />
      <span>Can't reach Cobblr - reconnecting…</span>
    </div>
  );
}

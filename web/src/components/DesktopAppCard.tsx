// The Cobblr desktop app, if it is running on THIS computer.
//
// It appears here — under Configuration → Connections → Devices — rather than in
// a native settings window of its own, because this is where someone goes
// looking for the physical things a workspace reaches. Capabilities hidden in a
// separate app window are capabilities nobody finds; that is a product split,
// not a UI detail.
//
// Reached over plain HTTP rather than any desktop-only channel, so this same
// component works in an ordinary browser and inside the app's own webview, one
// code path. Absent app = the probe fails and this renders nothing, which is the
// common case and must stay silent.

import { useQuery, useMutation } from "@tanstack/react-query";
import { Laptop, Bluetooth, Loader2 } from "lucide-react";

/** The desktop app's local surface.
 *
 *  NOT the bridge's port: the app stands down when a standalone bridge is
 *  already serving, and still has things to say about itself either way. Kept in
 *  step with `APP_PORT` in the desktop app (src-tauri/src/appsurface.rs) — the
 *  two repos cannot share a constant, so the contract is written down in
 *  docs/architecture/edge-bridge-relay.md. */
const APP = "http://127.0.0.1:8079";

interface DesktopApp {
  app: string;
  version: string;
  platform: string;
  bluetooth: boolean;
}
interface AppPrinter {
  id: string;
  name: string;
  mac: string;
  unpair_first: boolean;
}

/** Inside the Cobblr desktop app, talk to it directly.
 *
 *  The HTTP surface below works in a BROWSER on the same computer and never
 *  inside the app itself: the app loads this page over https, and WKWebView
 *  blocks an https page from calling http://127.0.0.1 as mixed content. No
 *  socket is opened, so the card silently rendered nothing in the one place it
 *  is most obviously wanted. The app grants this origin exactly the two commands
 *  used here.
 *
 *  Typed loosely on purpose: this page is served to ordinary browsers too, where
 *  none of it exists, so nothing may be imported from a Tauri package. */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
function appInvoke(): Invoke | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } };
  return w.__TAURI_INTERNALS__?.invoke ?? null;
}

async function probeApp(): Promise<DesktopApp | null> {
  const invoke = appInvoke();
  if (invoke) {
    try {
      // The same fields GET /app answers with, from one source of truth in the
      // app — so the card cannot describe the app differently depending on which
      // transport reached it.
      const j = (await invoke("app_info")) as DesktopApp;
      return j?.app === "cobblr-desktop" ? j : null;
    } catch {
      // In the app, but it did not grant this page — an older build. Fall through
      // to HTTP, which will fail too, and the card stays hidden.
    }
  }
  try {
    const r = await fetch(`${APP}/app`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const j = (await r.json()) as DesktopApp;
    return j.app === "cobblr-desktop" ? j : null;
  } catch {
    // No app, or a browser that refuses the private-network request. Both mean
    // "nothing to show" rather than an error worth reporting.
    return null;
  }
}

/** Shared so the card and the page's empty-state cannot disagree about whether
 *  a desktop app is here — one query key, one answer. */
export function useDesktopApp() {
  return useQuery({
    queryKey: ["desktop-app"],
    queryFn: probeApp,
    // Slow: a local probe that mostly returns nothing, and a tight interval
    // would knock on a port every few seconds for every user forever.
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: false,
  });
}

export function DesktopAppCard() {
  const app = useDesktopApp();

  const printers = useQuery({
    queryKey: ["desktop-app-printers"],
    queryFn: async (): Promise<AppPrinter[]> => {
      const invoke = appInvoke();
      if (invoke) return ((await invoke("bt_printers")) as AppPrinter[]) ?? [];
      const r = await fetch(`${APP}/app/printers`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return [];
      return (await r.json()).printers ?? [];
    },
    enabled: !!app.data?.bluetooth,
    staleTime: 20_000,
    retry: false,
  });

  const probe = useMutation({
    mutationFn: async (p: AppPrinter) => {
      type Res = { ok: boolean; channel?: number; replyBytes?: number; error?: string };
      const invoke = appInvoke();
      if (invoke) {
        try {
          return (await invoke("bt_probe", { mac: p.mac, unpairFirst: p.unpair_first })) as Res;
        } catch (e) {
          // A refused connect is an ANSWER, not a transport failure — same shape
          // the HTTP surface returns, so the UI below needs no second branch.
          return { ok: false, error: String(e) } satisfies Res;
        }
      }
      const r = await fetch(`${APP}/app/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mac: p.mac, unpairFirst: p.unpair_first }),
      });
      return (await r.json()) as Res;
    },
  });

  if (!app.data) return null;

  const invoke = appInvoke();
  const busy = probe.isPending;
  const res = probe.data;

  return (
    <li className="rounded-lg border border-line dark:border-slate-800 px-3 py-2 text-sm space-y-2">
      <div className="flex items-center gap-3">
        <Laptop size={15} className="text-accent shrink-0" />
        <span className="font-medium text-content dark:text-mortar-100">Cobblr desktop app</span>
        <span className="text-[10px] uppercase tracking-wider text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded-full px-2 py-0.5">
          this computer
        </span>
        <span className="text-xs text-faint dark:text-slate-400 flex-1">
          v{app.data.version} · {app.data.platform}
          {app.data.bluetooth ? " · Bluetooth Classic" : " · no Bluetooth helper"}
        </span>
        {/* The app's OWN settings — which Cobblr it loads, and updates.
            Reachable from here because that is where someone looks for the
            things this computer does, and because on a phone the app is a single
            window: without this the only route was a link on the launch splash,
            which is exactly the screen that should disappear as fast as it can.
            Opens the native surface rather than editing here, so a workspace
            cannot silently re-point the app at another Cobblr. */}
        {invoke && (
          <button
            type="button"
            onClick={() => void invoke("open_app_settings").catch(() => {})}
            className="shrink-0 text-xs text-accent hover:underline"
          >
            App settings
          </button>
        )}
      </div>

      {(printers.data ?? []).length > 0 && (
        <ul className="space-y-1 pl-6">
          {printers.data!.map((p) => (
            <li key={p.mac} className="flex items-center gap-2 text-xs">
              <Bluetooth size={12} className="text-faint shrink-0" />
              <span className="text-content dark:text-mortar-100">{p.name}</span>
              <span className="text-faint dark:text-slate-500 font-mono">{p.mac}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => probe.mutate(p)}
                className="text-accent hover:underline disabled:opacity-50 inline-flex items-center gap-1"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : null}
                Test connection
              </button>
            </li>
          ))}
        </ul>
      )}

      {res && (
        <p className="text-xs pl-6 text-faint dark:text-slate-400">
          {res.ok
            ? res.replyBytes
              ? `Connected on channel ${res.channel} — the printer answered with ${res.replyBytes} bytes.`
              : `Connected on channel ${res.channel}, but the printer sent nothing back. A bridge already holding this printer will do that.`
            : res.error}
        </p>
      )}

      {app.data.bluetooth && (
        <p className="text-[11px] pl-6 text-faint dark:text-slate-500">
          A test opens the link once and hangs up, so macOS asks permission each time. A bridge
          that holds the link open asks once instead.
        </p>
      )}
    </li>
  );
}

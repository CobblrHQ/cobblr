// Step 2 of setting up a bridge, shared by every screen that sets one up: a
// one-line install with a pairing code (the default, nothing secret pasted),
// or Docker with the bridge's token. One component, so the two ways stay the
// same everywhere a bridge is installed.
import { bridgeInstallCommands, bridgeOneLineInstall, bridgeTokenName } from "@cobblr/platform-contract/edge-channel";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LightBurnPairing, type BridgeInstallOS } from "./LightBurnPairing";
import { desktopBridgeAction } from "../lib/desktop-bridge";
import { api, ApiError } from "../lib/api";
import { SegmentedChoice, useToast } from "@cobblr/platform-web";
import { randomId } from "@cobblr/platform-contract/random-id";

const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

export function BridgeInstallMethod({
  slug,
  label,
  bridgeId,
  onStarted,
  lightBurn = false,
}: {
  slug: string;
  /** What the person named the bridge (step 1). */
  label: string;
  /** Normalised bridge id, "" for the workspace's first bridge. */
  bridgeId: string;
  /** Called once a code or a token exists, so the caller can watch for the box. */
  onStarted?: (bridgeId: string) => void;
  lightBurn?: boolean;
}) {
  const toast = useToast();
  const [nonce] = useState(() => randomId().slice(0, 8));
  const bid = methodIdentity(bridgeId, label, nonce);
  const [token, setToken] = useState<string | null>(null);
  const [cmdMode, setCmdMode] = useState<"run" | "compose">("compose");
  const [method, setMethod] = useState<BridgeInstallOS>("code");
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const relayUrl = `${window.location.origin}/api/v1/orgs/${slug}/edge`;

  const pair = useMutation({
    mutationFn: () => api.createEdgePairingCode(slug, label.trim(), method === "desktop" ? null : bid),
    onSuccess: (r) => {
      setPairing(r);
      onStarted?.(method === "desktop" ? "" : bid);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't make a code."),
  });
  const oneLine = pairing && method === "windows" ? `& ([scriptblock]::Create((Invoke-RestMethod "${window.location.origin}/api/v1/edge/install-windows.ps1"))) -Code ${pairing.code}` : pairing ? bridgeOneLineInstall(window.location.origin, pairing.code).replace("/install.sh", method === "mac" ? "/install-mac.sh" : "/install.sh") : "";

  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: bridgeTokenName(label), scopes: ["devices:edge"] }),
    onSuccess: (r) => {
      setToken(r.token);
      onStarted?.(method === "desktop" ? "" : bid);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });
  const tok = token ?? "<generate the token first>";
  const { run: cmd, compose } = bridgeInstallCommands({ relayUrl, token: tok, bridgeId: bid });
  const snippet = cmdMode === "compose" ? compose : cmd;

  return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <span className={lbl}>2 · Install the bridge</span>
          <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]" role="tablist" aria-label="How to install">
            {(["code", "mac", "windows", "desktop", "docker"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => { setMethod(m); setPairing(null); }}
                disabled={pair.isPending || mint.isPending}
                className={"px-1.5 py-0.5 " + (method === m ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}
              >
                {m === "code" ? "One line" : m === "mac" ? "macOS" : m === "windows" ? "Windows" : m === "desktop" ? "Desktop" : "Docker"}
              </button>
            ))}
          </div>
        </div>
        {method !== "docker" ? (
          !pairing ? (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => pair.mutate()}
                disabled={pair.isPending || !label.trim()}
                className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5"
              >
                {pair.isPending ? "Making a code…" : "Get an install code"}
              </button>
              <p className="text-[11px] text-faint">{method === "mac" ? "Native Mac bridge. Starts at login, without an administrator password." : method === "windows" ? "Windows x64 or ARM64 bridge. Starts when you sign in, without an administrator password." : method === "desktop" ? "Use Cobblr Desktop on this computer. Its bridge updates automatically." : "For Linux x64 or ARM64, and Raspberry Pi OS on ARM64 or ARMv7."}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-muted">Your code</span>
                <code data-testid="pairing-code" className="text-lg font-mono tracking-widest text-content dark:text-mortar-100">{pairing.code}</code>
                <span className="text-[11px] text-faint">works once, until {new Date(pairing.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </div>
              {method !== "desktop" && <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted">Run this on the computer that will be the bridge:</span>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(oneLine); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">
                  Copy
                </button>
              </div>}
              {method === "desktop" ? <DesktopConnect code={pairing.code} /> : <pre data-testid="one-line-install" className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{oneLine}</pre>}
              <p className="text-[11px] text-faint">
                {method === "desktop" ? "Connect this Desktop bridge to your workspace, then pair LightBurn below." : method === "windows" ? "It keeps this bridge's key on your computer and installs a startup task for your account. It downloads the native Windows x64 or ARM64 bridge and keeps its code up to date." : method === "mac" ? "It trades the code for this bridge's own key, which stays on your Mac, installs a native service that starts at login, and keeps its code up to date." : <>It trades the code for this bridge's own key, which stays on that box, installs it as a service that starts at boot, and keeps it up to date. Add <code>--system</code> to install it for the whole machine, or <code>--docker</code> for a network-only Linux bridge. USB machines need the native installer.</>}
              </p>
              <button type="button" onClick={() => pair.mutate()} className="text-[11px] text-accent hover:underline">
                Make a new code
              </button>
            </div>
          )
        ) : (
          <>
            {token && (
              <div className="flex items-center justify-end gap-2 mb-1">
                <SegmentedChoice
                  label="How to start the bridge"
                  value={cmdMode}
                  onChange={setCmdMode}
                  options={[
                    { value: "run", label: "docker run" },
                    { value: "compose", label: "compose" },
                  ]}
                />
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">
                  Copy
                </button>
              </div>
            )}
            {!token ? (
              <button
                type="button"
                onClick={() => mint.mutate()}
                disabled={mint.isPending || !label.trim()}
                className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5"
              >
                {mint.isPending ? "Generating…" : "Generate token & command"}
              </button>
            ) : (
              <>
                <pre className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{snippet}</pre>
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                  Run this on a box at your site. Token shown once - it can <strong>only</strong> run this bridge (scope <code>devices:edge</code>).
                </p>
                <p className="text-[11px] text-faint mt-0.5">
                  Stock public image - the bridge fetches its code from this Cobblr (sha-verified) and keeps itself
                  updated automatically. Nothing to pull from a registry, ever.
                </p>
              </>
            )}
          </>
        )}
        {lightBurn && <div className="mt-2"><LightBurnPairing method={method} /></div>}
        {(method === "mac" || method === "windows" || method === "code") && <div className="mt-2 text-[11px] text-muted">
          <p>To remove the bridge:</p>
          <pre className="overflow-x-auto whitespace-pre rounded bg-subtle p-2">{uninstallCommand(method === "windows" ? "windows" : method === "mac" ? "mac" : "linux")}</pre>
        </div>}
        <BridgeTrust />
      </div>
  );
}

/** The command that removes the bridge from the computer it runs on. */
export function uninstallCommand(os: "linux" | "mac" | "windows"): string {
  if (os === "windows") return `& ([scriptblock]::Create((Invoke-RestMethod "${window.location.origin}/api/v1/edge/install-windows.ps1"))) -Uninstall`;
  return `curl -fsSL ${window.location.origin}/api/v1/edge/${os === "mac" ? "install-mac.sh" : "install.sh"} | sh -s -- uninstall`;
}

/** What a bridge can and cannot do, said before anyone installs one. Every
 *  line here is a promise the code keeps: the bridge only dials out, its key
 *  is scoped to the bridge wire, BRIDGE_ALLOW is enforced on the box, updates
 *  are sha-checked, and Disconnect revokes the key. */
export function BridgeTrust() {
  return (
    <details data-testid="bridge-trust" className="mt-2 rounded border border-line dark:border-slate-700 px-2 py-1.5 text-[11px] text-muted dark:text-slate-400">
      <summary className="cursor-pointer text-content dark:text-mortar-200">What a bridge can and cannot do</summary>
      <BridgeTrustList />
    </details>
  );
}

/** The same promises and how to remove it, once a bridge is running: they
 *  used to go with the install steps, so a connected bridge lost them (#5774). */
export function BridgeAbout() {
  return (
    <details data-testid="bridge-about" className="rounded border border-line dark:border-slate-700 px-2 py-1.5 text-[11px] text-muted dark:text-slate-400">
      <summary className="cursor-pointer text-content dark:text-mortar-200">About this bridge</summary>
      <BridgeTrustList />
      <p className="mt-2">To remove the bridge, run this on the computer it is on:</p>
      {(["linux", "mac", "windows"] as const).map((os) => (
        <div key={os} className="mt-1">
          <span className="text-faint">{os === "linux" ? "Linux" : os === "mac" ? "Mac" : "Windows (PowerShell)"}</span>
          <pre className="overflow-x-auto whitespace-pre rounded bg-subtle dark:bg-slate-950 p-2">{uninstallCommand(os)}</pre>
        </div>
      ))}
    </details>
  );
}

function BridgeTrustList() {
  return (
      <ul className="mt-1.5 ml-4 list-disc space-y-1">
        <li>
          It only calls out to this Cobblr. It opens no port on your network, and nothing outside can connect to it.
        </li>
        <li>
          It reaches the addresses you add in Cobblr, like a printer or a sync source, when Cobblr asks. To hold it to a
          fixed list whatever Cobblr asks, set <code>BRIDGE_ALLOW</code> on the machine (for example{" "}
          <code>BRIDGE_ALLOW=192.168.1.0/24,printer.local</code>).
        </li>
        <li>
          Its key can only run a bridge. It cannot read or change anything in your workspace.
        </li>
        <li>It updates itself from this Cobblr and checks each update's fingerprint before running it.</li>
        <li>
          <strong>Disconnect</strong> on the bridges page stops it at once: its key stops working and it is removed.
        </li>
      </ul>
  );
}

export function methodIdentity(id: string, name: string, nonce: string) {
  return id || `${name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "bridge"}-${nonce}`;
}
function DesktopConnect({ code }: { code: string }) {
  const connect = useMutation({ mutationFn: () => desktopBridgeAction("connect", code) });
  return <div className="space-y-1">
    <button type="button" onClick={() => connect.mutate()} disabled={connect.isPending || connect.isSuccess} className="rounded bg-cobble-600 text-white px-3 py-1.5 disabled:opacity-50">{connect.isSuccess ? "Desktop connected" : connect.isPending ? "Connecting Desktop…" : "Connect Cobblr Desktop"}</button>
    {connect.error && <p role="alert">{connect.error.message}</p>}
  </div>;
}

// Step 2 of setting up a bridge, shared by every screen that sets one up: a
// one-line install with a pairing code (the default, nothing secret pasted),
// or Docker with the bridge's token. One component, so the two ways stay the
// same everywhere a bridge is installed.
import { bridgeInstallCommands, bridgeOneLineInstall, bridgeTokenName } from "@cobblr/platform-contract/edge-channel";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useToast } from "@cobblr/platform-web";

const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

export function BridgeInstallMethod({
  slug,
  label,
  bridgeId,
  onStarted,
}: {
  slug: string;
  /** What the person named the bridge (step 1). */
  label: string;
  /** Normalised bridge id, "" for the workspace's first bridge. */
  bridgeId: string;
  /** Called once a code or a token exists, so the caller can watch for the box. */
  onStarted?: () => void;
}) {
  const toast = useToast();
  const bid = bridgeId;
  const [token, setToken] = useState<string | null>(null);
  const [cmdMode, setCmdMode] = useState<"run" | "compose">("compose");
  const [method, setMethod] = useState<"code" | "docker">("code");
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const relayUrl = `${window.location.origin}/api/v1/orgs/${slug}/edge`;

  const pair = useMutation({
    mutationFn: () => api.createEdgePairingCode(slug, label.trim(), bid || null),
    onSuccess: (r) => {
      setPairing(r);
      onStarted?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't make a code."),
  });
  const oneLine = pairing ? bridgeOneLineInstall(window.location.origin, pairing.code) : "";

  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: bridgeTokenName(label), scopes: ["devices:edge"] }),
    onSuccess: (r) => {
      setToken(r.token);
      onStarted?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });
  const tok = token ?? "<generate the token first>";
  const { run: cmd, compose } = bridgeInstallCommands({ relayUrl, token: tok, bridgeId: bid });
  const snippet = cmdMode === "compose" ? compose : cmd;

  return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={lbl}>2 · Install the bridge</span>
          <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]" role="tablist" aria-label="How to install">
            {(["code", "docker"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => setMethod(m)}
                className={"px-1.5 py-0.5 " + (method === m ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}
              >
                {m === "code" ? "One line" : "Docker"}
              </button>
            ))}
          </div>
        </div>
        {method === "code" ? (
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
              <p className="text-[11px] text-faint">For Linux, macOS and Raspberry Pi (including 32-bit Pi OS and a Pi Zero).</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] text-muted">Your code</span>
                <code data-testid="pairing-code" className="text-lg font-mono tracking-widest text-content dark:text-mortar-100">{pairing.code}</code>
                <span className="text-[11px] text-faint">works once, until {new Date(pairing.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted">Run this on the box that will be the bridge:</span>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(oneLine); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">
                  Copy
                </button>
              </div>
              <pre data-testid="one-line-install" className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{oneLine}</pre>
              <p className="text-[11px] text-faint">
                It trades the code for this bridge's own key, which stays on that box, installs it as a service that
                starts at boot, and keeps it up to date. Add <code>--system</code> to install it for the whole
                machine, or <code>--docker</code> to run it in Docker.
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
                <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]">
                  {(["run", "compose"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCmdMode(mode)}
                      className={"px-1.5 py-0.5 " + (cmdMode === mode ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}
                    >
                      {mode === "run" ? "docker run" : "compose"}
                    </button>
                  ))}
                </div>
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
        <BridgeTrust />
      </div>
  );
}

/** What a bridge can and cannot do, said before anyone installs one. Every
 *  line here is a promise the code keeps: the bridge only dials out, its key
 *  is scoped to the bridge wire, BRIDGE_ALLOW is enforced on the box, updates
 *  are sha-checked, and Disconnect revokes the key. */
export function BridgeTrust() {
  return (
    <details data-testid="bridge-trust" className="mt-2 rounded border border-line dark:border-slate-700 px-2 py-1.5 text-[11px] text-muted dark:text-slate-400">
      <summary className="cursor-pointer text-content dark:text-mortar-200">What a bridge can and cannot do</summary>
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
    </details>
  );
}

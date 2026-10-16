import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LightBurnReadiness } from "../features/digifab/lightburn-readiness";
import { desktopBridgeAction } from "../lib/desktop-bridge";
export type BridgeInstallOS = "code" | "mac" | "windows" | "desktop" | "docker";
const pairingCommands: Partial<Record<BridgeInstallOS, string>> = {
  mac: /* PRODUCT-NAME: The installed desktop bridge executable path is fixed across products. */ '"$HOME/Library/Application Support/Cobblr/bridge/cobblr-edge-bridge" pair-lightburn 127.0.0.1',
  windows: /* PRODUCT-NAME: The installed desktop bridge executable path is fixed across products. */ '& "$env:LOCALAPPDATA\\Cobblr\\bridge\\cobblr-edge-bridge.exe" pair-lightburn 127.0.0.1',
  code: 'BRIDGE_NODE=$(command -v node || printf \'%s\' "$HOME/.local/share/cobblr-bridge/node/bin/node"); "$BRIDGE_NODE" "$HOME/.local/share/cobblr-bridge/cache/bridge.cjs" pair-lightburn 127.0.0.1',
};
export function LightBurnPairing({ method }: { method?: BridgeInstallOS }) {
  const [selected, setSelected] = useState<BridgeInstallOS>(/CobblrDesktop/.test(navigator.userAgent) ? "desktop" : /Win/.test(navigator.platform) ? "windows" : /Mac/.test(navigator.platform) ? "mac" : "code");
  const os = method || selected;
  const status = useQuery({ queryKey: ["desktop-bridge-status"], queryFn: () => desktopBridgeAction("status"), enabled: os === "desktop", refetchInterval: 2_000, retry: false });
  const online = status.isSuccess && status.data?.desktop === true;
  const pair = useMutation({ mutationFn: () => desktopBridgeAction("pair") });
  return <div className="space-y-2 text-xs text-muted" aria-label="Pair LightBurn">
    <p>Run the bridge on the computer with LightBurn. Enable the API and UDP automation listener in LightBurn under Settings → Extensions, then leave LightBurn open.</p>
    {!method && <label className="block space-y-1"><span>LightBurn runs on</span><select value={selected} onChange={event => setSelected(event.target.value as BridgeInstallOS)} className="input">
      <option value="desktop">{productName()} Desktop</option><option value="mac">Native macOS bridge</option><option value="windows">Native Windows bridge</option><option value="code">One line bridge (Linux or macOS)</option>
    </select></label>}
    {os === "desktop" ? <>
      <button type="button" onClick={() => pair.mutate()} disabled={!online || pair.isPending} className="rounded bg-cobble-600 text-white px-3 py-1.5 disabled:opacity-50">{!online ? "Waiting for the bridge…" : pair.isPending ? "Approve the dialog in LightBurn…" : "Pair LightBurn"}</button>
      {pair.error && <p role="alert">{pair.error.message}</p>}
      {pair.data?.readiness && <LightBurnReadiness readiness={pair.data.readiness} />}
    </> : os === "docker" ? <p>Pair on the LightBurn computer with {productName()} Desktop or a native bridge. A Docker bridge needs LightBurn's network API enabled to reach it.</p> : <pre className="overflow-x-auto whitespace-pre rounded bg-subtle p-2">{pairingCommands[os]}</pre>}
    <p>Approve the dialog in LightBurn within 30 seconds. Pairing reloads automatically. Use host 127.0.0.1 when LightBurn runs on the bridge's computer.</p>
  </div>;
}

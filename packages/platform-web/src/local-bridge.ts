// Whether a printer prints from THIS browser through a bridge on the person's
// own machine. A printer whose settings carry a local bridge address is
// browser-driven whatever its nominal driver (cups, say): only this browser can
// reach that bridge, and the server's driver refuses it by design. Every path
// that sends to a printer asks here, so none of them hands such a printer to
// the server (#7607: the label queue did, and the server said the workspace had
// no bridge).
import type { BridgePrinterSettings } from "@cobblr/platform-contract/edge-bridge-client";

export function localBridgeOf(printer: { settings?: unknown } | null | undefined): BridgePrinterSettings | null {
  const bridge = ((printer?.settings ?? {}) as { bridge?: BridgePrinterSettings }).bridge;
  return bridge?.bridgeUrl ? bridge : null;
}

import { useEffect, useRef, useState } from "react";
import { createNfcReader, isWebNfcAvailable, nfcFailure, nfcUrl } from "@cobblr/platform-web";
import { typedVerdict } from "../lib/scanPayload";

export function NfcScanButton({ onCobblrQr, onOpenPath }: {
  onCobblrQr: (token: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); }, []);
  if (!isWebNfcAvailable()) return null;

  const stop = () => { operation.current?.abort(); operation.current = null; setListening(false); };
  const scan = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setListening(true);
    setError(null);
    try {
      const reader = createNfcReader();
      reader.onreadingerror = () => {
        if (!controller.signal.aborted) setError("Could not read the tag. Hold it still near your phone and try again.");
      };
      reader.onreading = (event) => {
        if (controller.signal.aborted) return;
        const url = nfcUrl(event.message.records);
        const verdict = url ? typedVerdict(url) : null;
        if (verdict?.action === "route-qr") { stop(); onCobblrQr(verdict.token); }
        else if (verdict?.action === "open") { stop(); onOpenPath(verdict.path); }
        else setError("This tag has no Cobblr label link. Try another tag.");
      };
      await reader.scan({ signal: controller.signal });
    } catch (e) {
      if (!controller.signal.aborted) { stop(); setError(nfcFailure(e)); }
    }
  };
  return <div className="text-center space-y-1">
    <button type="button" className="rounded-full bg-black/55 px-4 py-2 text-sm text-white" onClick={() => listening ? stop() : void scan()}>
      {listening ? "Cancel tag scan" : "Tap a tag"}
    </button>
    {listening && <p role="status" className="text-sm text-white">Hold a tag near your phone.</p>}
    {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
  </div>;
}

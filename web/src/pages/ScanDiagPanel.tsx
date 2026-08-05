// The diagnostics readout, on the phone that has the answers.
//
// A phone has no console, so the facts have to be legible on the glass and
// copyable in one tap. Deliberately ugly and monospaced: this is an instrument,
// not a surface — it exists to be read once on a shelf and then removed.

import { useEffect, useState } from "react";
import { Copy, RefreshCw, X } from "lucide-react";
import {
  collectCameraFacts,
  decodeStats,
  factsToText,
  resetDecodeStats,
  streamRecoveryCount,
  zoomDiag,
  torchDiag,
  type CameraFacts,
  type DecodeStats,
} from "../lib/scanDiag";

export function ScanDiagPanel({
  getTrack,
  onClose,
}: {
  getTrack: () => MediaStreamTrack | null;
  onClose: () => void;
}) {
  const [facts, setFacts] = useState<CameraFacts | null>(null);
  const [stats, setStats] = useState<DecodeStats>(decodeStats());
  const [copied, setCopied] = useState(false);

  const load = () => {
    void collectCameraFacts(getTrack()).then(setFacts);
  };

  // Facts once the track exists (it is acquired async, after mount).
  useEffect(() => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (getTrack() || tries > 20) {
        clearInterval(t);
        load();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timings tick while you aim at the barcode — that is the measurement.
  useEffect(() => {
    const t = setInterval(() => setStats(decodeStats()), 1000);
    return () => clearInterval(t);
  }, []);

  const row = (k: string, v: string) => (
    <div className="flex gap-2 leading-tight">
      <span className="w-[92px] shrink-0 text-cobble-300">{k}</span>
      <span className="min-w-0 flex-1 break-words text-white/90">{v}</span>
    </div>
  );

  return (
    <div className="max-w-md mx-auto rounded-xl border border-cobble-400/60 bg-black/90 backdrop-blur-md p-3 text-[10.5px] font-mono">
      <div className="flex items-center gap-2 pb-2">
        <span className="flex-1 text-cobble-300 font-semibold">scan diagnostics</span>
        <button
          type="button"
          onClick={() => { resetDecodeStats(); setStats(decodeStats()); load(); }}
          aria-label="Re-measure"
          className="p-1.5 rounded text-white/70 hover:text-white hover:bg-white/10"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!facts) return;
            const text = factsToText(facts, decodeStats());
            void navigator.clipboard?.writeText(text)
              .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); })
              .catch(() => {
                // Clipboard can be blocked; showing it is still better than nothing.
                window.prompt("copy this:", text);
              });
          }}
          aria-label="Copy the report"
          className="inline-flex items-center gap-1 rounded border border-cobble-400/60 px-2 py-1 text-cobble-200"
        >
          <Copy size={12} /> {copied ? "copied" : "copy"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close diagnostics"
          className="p-1.5 rounded text-white/70 hover:text-white hover:bg-white/10"
        >
          <X size={13} />
        </button>
      </div>

      {!facts ? (
        <div className="text-white/60">waiting for the camera…</div>
      ) : (
        <div className="space-y-1">
          {row("engine", facts.engine)}
          {facts.nativeFormats && row("native fmts", facts.nativeFormats.join(", "))}
          {row("lenses", `${facts.lenses.length}: ${facts.lenses.join(" | ")}`)}
          {row("resolution", `${String(facts.settings.width ?? "?")}x${String(facts.settings.height ?? "?")} @${String(facts.settings.frameRate ?? "?")}fps`)}
          {row("focus", facts.focus)}
          {row("zoom", facts.zoom)}
          {row("torch", facts.torch)}
          {row("caps", Object.keys(facts.capabilities).join(", ") || "(none)")}
          {row("tuning", facts.tuning)}
          <div className="pt-1.5 mt-1 border-t border-white/15">
            {row("torch auto", `${torchDiag().event} · luma ${torchDiag().luma ?? "?"} · falloff ${torchDiag().falloff ?? "?"} · fired ${torchDiag().autoOns}x`)}
            {row("stream", `re-acquired ${streamRecoveryCount()}x`)}
            {row("auto zoom", zoomDiag())}
            {row("decode", `${stats.attempts} tries, ${stats.hits} hits, ${stats.perSec}/s`)}
            {row("decode ms", `p50 ${stats.p50} · p95 ${stats.p95} · worst ${stats.worst}`)}
            {row("aimed", `${stats.rotAttempts} tries, ${stats.rotHits} hits${stats.lastAngle !== null ? ` · axis ${Math.round(stats.lastAngle)}°` : ""}`)}
          </div>
          <div className="pt-1 text-white/40 leading-snug">
            aim at the barcode for ~10s, then tap copy and paste it back.
          </div>
        </div>
      )}
    </div>
  );
}

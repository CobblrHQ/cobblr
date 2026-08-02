// "Pair phone" — a desktop affordance for the scan flow. A computer usually has
// no camera worth scanning with, so instead of opening the in-browser scanner
// we mint a short-lived QR pair-code: the user scans it with their phone, the
// phone is signed in to THIS workspace, and its camera scans flow into the same
// scan inbox the desktop is showing.
//
// Click → POST /auth/pair/start (for the active workspace) → render the code as
// a QR → poll /auth/pair/status → auto-close when the phone claims it.
//
// Rendered only on non-touch (desktop) devices; phones already have the direct
// camera, so the button stands down there.

import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Modal } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** True on phones/tablets (coarse pointer = touch-primary). Such devices have
 *  the direct camera scanner, so we hide the pair affordance there. */
function isTouchPrimary(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export function PairPhoneButton({
  className,
  dataTour,
  /** Render as a dropdown row instead of a standalone button, for headers that
   *  moved their rare actions into an overflow menu. Still returns null on
   *  touch devices, so the menu simply does not carry the row there. */
  asMenuItem,
  /** Called when the menu row is pressed, so the host can close itself. */
  onPaired,
}: {
  className?: string;
  dataTour?: string;
  asMenuItem?: boolean;
  onPaired?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Decide once on mount (SSR-safe-ish; this app is client-rendered).
  const [touch] = useState(isTouchPrimary);
  if (touch) return null;
  return (
    <>
      {asMenuItem ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(true);
            onPaired?.();
          }}
          className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <span className="mt-0.5 shrink-0 text-faint dark:text-slate-500">
            <Smartphone size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">Pair phone</span>
            <span className="block text-[11px] leading-snug text-faint dark:text-slate-500">
              Scan with your phone into this same inbox
            </span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          data-tour={dataTour}
          onClick={() => setOpen(true)}
          title="Scan with your phone instead"
          className={
            className ??
            "shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
          }
        >
          <Smartphone size={16} />
          <span className="hidden sm:inline">Pair phone</span>
        </button>
      )}
      {open && <PairPhoneModal onClose={() => setOpen(false)} />}
    </>
  );
}

type Phase = "loading" | "showing" | "claimed" | "expired";

function PairPhoneModal({ onClose }: { onClose: () => void }) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const [info, setInfo] = useState<{
    code: string;
    expires_at: string;
    claim_options: { label: string; url: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [addrIdx, setAddrIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const claimUrl = info ? info.claim_options[addrIdx]?.url ?? "" : "";

  // Mint a fresh pair code for the active workspace on open.
  useEffect(() => {
    if (!activeSlug) return;
    let cancelled = false;
    setPhase("loading");
    setError(null);
    api
      .pairStart({ org_slug: activeSlug })
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setAddrIdx(0);
        setPhase("showing");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Couldn't generate a pair code.");
        setPhase("expired");
      });
    return () => {
      cancelled = true;
    };
  }, [activeSlug]);

  // Render the QR; re-runs when the selected address changes.
  useEffect(() => {
    if (!claimUrl || !canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, claimUrl, {
      width: 264,
      // 4-module quiet zone — the spec minimum; tighter trips strict scanners.
      margin: 4,
      color: { dark: "#1e293b", light: "#ffffff" },
    }).catch(() => {
      /* canvas failed — the printed URL below is the fallback */
    });
  }, [claimUrl]);

  // Poll status until claimed or expired; tick the countdown.
  useEffect(() => {
    if (phase !== "showing" || !info) return;
    const expiresAtMs = new Date(info.expires_at).getTime();
    setSecondsLeft(Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000)));
    const tick = setInterval(async () => {
      const remaining = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(remaining);
      try {
        const status = await api.pairStatus(info.code);
        if (status.state === "claimed") {
          setPhase("claimed");
          clearInterval(tick);
          setTimeout(onClose, 1400);
        } else if (status.state === "expired" || remaining === 0) {
          setPhase("expired");
          clearInterval(tick);
        }
      } catch {
        /* transient — try again next tick */
      }
    }, 1500);
    return () => clearInterval(tick);
  }, [phase, info, onClose]);

  return (
    <Modal open onClose={onClose} title="Scan with your phone" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-muted dark:text-slate-400">
          Sign your phone in to{" "}
          <span className="font-medium text-content dark:text-mortar-100">
            {activeOrg?.name ?? "this workspace"}
          </span>{" "}
          and scan straight into its inbox. Open your phone camera and scan this
          code.
        </p>

        {phase === "loading" && (
          <div className="py-12 text-center text-sm text-faint dark:text-slate-500">
            Generating pair code…
          </div>
        )}

        {phase === "showing" && info && (
          <>
            <div className="bg-white border border-line dark:border-slate-700 rounded-lg p-3 grid place-items-center">
              <canvas ref={canvasRef} />
            </div>

            {info.claim_options.length > 1 && (
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium text-faint dark:text-slate-500">
                  Phone connects via
                </div>
                {info.claim_options.map((opt, i) => (
                  <button
                    key={opt.url}
                    type="button"
                    onClick={() => setAddrIdx(i)}
                    className={
                      "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs font-mono transition " +
                      (addrIdx === i
                        ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-500/15 text-cobble-700 dark:text-cobble-300"
                        : "border-line dark:border-slate-700 text-muted dark:text-slate-300 hover:border-cobble-300")
                    }
                  >
                    <span
                      className={
                        "w-2 h-2 rounded-full shrink-0 " +
                        (addrIdx === i ? "bg-cobble-500" : "bg-slate-300 dark:bg-slate-600")
                      }
                    />
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="text-xs text-muted dark:text-slate-400 text-center">
              Or open this on your phone:
              <div className="mt-1 font-mono text-[10px] break-all text-content dark:text-mortar-200">
                {claimUrl}
              </div>
            </div>
            <div className="text-[11px] text-faint dark:text-slate-500 text-center font-mono">
              Expires in {secondsLeft}s · single-use
            </div>
          </>
        )}

        {phase === "claimed" && (
          <div className="py-10 text-center">
            <div className="text-3xl mb-2">✅</div>
            <div className="text-sm font-medium text-content dark:text-mortar-100">Phone paired</div>
          </div>
        )}

        {phase === "expired" && (
          <div className="py-8 text-center space-y-3">
            <div className="text-sm font-medium text-content dark:text-mortar-100">
              {error ?? "Pair code expired."}
            </div>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setAddrIdx(0);
                setPhase("loading");
                api
                  .pairStart({ org_slug: activeSlug })
                  .then((r) => {
                    setInfo(r);
                    setPhase("showing");
                  })
                  .catch((e: unknown) => {
                    setError(e instanceof ApiError ? e.message : "Couldn't generate a pair code.");
                    setPhase("expired");
                  });
              }}
              className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5 transition"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

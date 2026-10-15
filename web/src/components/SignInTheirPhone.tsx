// "Sign in their phone": an admin shows a QR, the member scans it with their
// own phone, and that phone is signed in as them (#6692). The same pair code
// as Pair phone, minted for one named member; it lasts ten minutes, works
// once, and Cancel voids it. Only for someone who belongs to this workspace
// alone; the server says so in a sentence otherwise.
import { useEffect, useRef, useState } from "react";
import { Code, Modal } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";

type Phase = "minting" | "showing" | "claimed" | "over";

export function SignInTheirPhone({ slug, member, onClose }: { slug: string; member: { id: string; name: string }; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("minting");
  const [info, setInfo] = useState<{ code: string; claim_url: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.adminPhoneCode(slug, member.id)
      .then((r) => {
        if (cancelled) return;
        setInfo(r);
        setPhase("showing");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Couldn't make a sign-in code.");
        setPhase("over");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, member.id]);

  useEffect(() => {
    if (!info || !canvasRef.current) return;
    const canvas = canvasRef.current;
    void import("qrcode").then(({ default: QRCode }) =>
      QRCode.toCanvas(canvas, info.claim_url, { width: 264, margin: 4, color: { dark: "#1e293b", light: "#ffffff" } }).catch(() => {
        /* canvas failed — the printed URL below is the fallback */
      }),
    );
  }, [info]);

  useEffect(() => {
    if (phase !== "showing" || !info) return;
    const ends = new Date(info.expires_at).getTime();
    setSecondsLeft(Math.max(0, Math.round((ends - Date.now()) / 1000)));
    const tick = setInterval(async () => {
      const remaining = Math.max(0, Math.round((ends - Date.now()) / 1000));
      setSecondsLeft(remaining);
      try {
        const s = await api.pairStatus(info.code);
        if (s.state === "claimed") setPhase("claimed");
        else if (s.state === "expired" || remaining === 0) setPhase("over");
      } catch {
        /* quiet: a poll; it tries again next tick and the countdown shows */
      }
    }, 1500);
    return () => clearInterval(tick);
  }, [phase, info]);

  const cancel = async () => {
    if (phase === "showing") {
      await api.adminCancelPhoneCode(slug, member.id).catch(() => {
        /* quiet: closing still closes; an uncancelled code lapses in minutes on its own */
      });
    }
    onClose();
  };
  const mins = Math.floor(secondsLeft / 60), secs = String(secondsLeft % 60).padStart(2, "0");

  return (
    <Modal open onClose={() => void cancel()} title={`Sign in ${member.name}'s phone`} size="sm">
      <div className="space-y-3">
        {phase === "minting" && <p className="text-sm text-muted">Making a code…</p>}
        {phase === "showing" && info && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              {member.name} opens the camera on their own phone and scans this. The phone is signed in as them, with their role. It works once, for{" "}
              <span className="tabular-nums">{mins}:{secs}</span>.
            </p>
            <div className="flex justify-center">
              <canvas ref={canvasRef} aria-label={`Sign-in code for ${member.name}`} className="rounded-lg" />
            </div>
            <p className="break-all text-center text-[10px] text-faint"><Code className="select-all">{info.claim_url}</Code></p>
          </>
        )}
        {phase === "claimed" && <p role="status" className="text-sm text-content dark:text-mortar-100">{member.name}'s phone is signed in.</p>}
        {phase === "over" && (
          <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error ?? "That code ran out before it was scanned. Close this and make another."}</p>
        )}
        <button
          type="button"
          onClick={() => void cancel()}
          className="w-full rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 transition py-2"
        >
          {phase === "showing" ? "Cancel the code" : "Close"}
        </button>
      </div>
    </Modal>
  );
}

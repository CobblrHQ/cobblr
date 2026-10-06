import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";

export function SnapmakerPairing({ slug, connectionId, onPaired }: { slug: string; connectionId: string; onPaired: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const started = useRef(0);
  const callback = useRef(onPaired);
  callback.current = onPaired;
  const operation = useMutation({ mutationFn: async () => {
    if (working.current) return;
    if (!started.current) started.current = Date.now();
    working.current = true; setBusy(true); setError("");
    try {
      if (Date.now() - started.current > 120_000) throw new Error("Approval timed out. Pair again and approve on the machine's screen.");
      const result = await api.pairSnapmaker(slug, connectionId);
      if (result.state === "paired") { setWaiting(false); setPaired(true); callback.current(); }
      else setWaiting(true);
    } catch (e) { setWaiting(false); started.current = 0; setError(e instanceof ApiError || e instanceof Error ? e.message : "Pairing could not finish. Check the machine's screen."); }
    finally { working.current = false; setBusy(false); }
  } });
  const attempt = () => operation.mutateAsync();
  const poll = useRef(attempt);
  poll.current = attempt;
  useEffect(() => { if (!waiting) return; const timer = setInterval(() => void poll.current(), 5000); return () => clearInterval(timer); }, [waiting]);
  return <section aria-label="Snapmaker pairing" className="space-y-2 rounded border border-line p-3 text-sm text-content break-words">
    {paired ? <p role="status">Snapmaker paired.</p> : <>
      <p>Disconnect Luban first. Pairing asks for approval on the Snapmaker touchscreen.</p>
      {waiting && <p role="status">Approve on the machine's screen.</p>}
      {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      <button type="button" className="min-h-11 rounded bg-ember-600 px-3 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void attempt()}>{busy ? "Checking…" : waiting ? "Check approval" : "Pair Snapmaker"}</button>
    </>}
  </section>;
}

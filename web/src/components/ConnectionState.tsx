// The state of a saved key on its row, and the button that checks it again.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ApiError, type ConnectionVerification } from "../lib/api";
import { verificationBadge, verificationToast } from "../lib/connection-state";

const TONE: Record<"ok" | "bad" | "warn" | "muted", string> = {
  ok: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  bad: "bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  warn: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  muted: "bg-subtle text-faint border-line dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700",
};

export function VerificationBadge({ verification }: { verification: ConnectionVerification | null | undefined }) {
  const b = verificationBadge(verification);
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium border ${TONE[b.tone]}`} title={b.title} data-verification={verification?.state ?? "none"}>
      {b.text}
    </span>
  );
}

/** "Test connection": the same probe a save runs, on the stored key; the
 *  row's state follows what it said. */
export function TestConnectionButton({
  test,
  invalidate,
  className,
}: {
  test: () => Promise<{ verification?: ConnectionVerification }>;
  /** Query keys to refresh once the verdict is stored. */
  invalidate: unknown[][];
  className?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: test,
    onSuccess: (r) => {
      const t = verificationToast(r.verification, "tested");
      toast[t.kind](t.message);
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <button
      type="button"
      onClick={() => m.mutate()}
      disabled={m.isPending}
      className={className ?? "px-2 py-1 text-xs rounded border border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-60"}
    >
      {m.isPending ? "Testing…" : "Test connection"}
    </button>
  );
}

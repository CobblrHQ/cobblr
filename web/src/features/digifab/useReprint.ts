import { jobDisplayName } from "./jobDisplayName";
// "Print again", one implementation for every surface that offers it (the
// fleet cockpit's history and the print history section). A reprint is a
// physical print, so a second press within seconds is asked about rather than
// printed: the server refuses it with `just_reprinted`, and only a deliberate
// "Print another copy" sends `again`.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../../lib/api";

export function useReprint(slug: string, refresh: readonly (readonly unknown[])[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const reprint = useMutation({
    mutationFn: (v: { id: string; again?: boolean }) => api.reprintDigifabJob(slug, v.id, { again: v.again }),
    onSuccess: (r) => {
      toast[r.sent === false && !r.pooled ? "info" : "success"](
        r.pooled ? "Queued to the pool. It auto-assigns to a free printer" : r.sent ? "Sent, printing again" : `Queued. Send it from the print queue${r.reason ? ` (${r.reason})` : ""}`,
      );
      for (const key of refresh) void qc.invalidateQueries({ queryKey: [...key] });
    },
    onError: async (e, v) => {
      if (e instanceof ApiError && e.code === "just_reprinted") {
        const ok = await confirm({
          title: "Print another copy?",
          message: "You just reprinted this. Another copy starts a second physical print.",
          confirmLabel: "Print another copy",
          destructive: true,
        });
        if (ok) reprint.mutate({ id: v.id, again: true });
        return;
      }
      toast.error(e instanceof ApiError ? e.message : "Couldn't reprint");
    },
  });
  return async (r: { id: string; file_ref: string; metadata?: Record<string, unknown> }) => {
    const ok = await confirm({
      title: `Print "${jobDisplayName(r)}" again?`,
      message: "Clones the original job (same file, routing, material and build) and sends it to the printer. On a live farm this physically starts the print.",
      confirmLabel: "Print again",
      destructive: true,
    });
    if (ok) reprint.mutate({ id: r.id });
  };
}

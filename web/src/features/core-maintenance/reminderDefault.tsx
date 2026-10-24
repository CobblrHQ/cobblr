// The workspace's overdue-reminder cadence: how often an overdue service or
// renewal keeps reminding, unless its own schedule says otherwise. A section
// on Configuration → Notifications (contributes.panels, surface
// "configuration-section"); that page renders it without naming this module.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, type OverdueCadence } from "../../lib/api";
import type { ConfigSectionCtx } from "../../panels/types";
import { CadencePicker } from "./renewals";
import { useCan } from "../../lib/can";

const SAID = { day: "Daily", week: "Weekly", month: "Monthly", off: "Off" } as const;

export function ReminderDefaultSection({ ctx }: { ctx: ConfigSectionCtx }) {
  const toast = useToast();
  const qc = useQueryClient();
  const maySet = useCan("core-maintenance:reminder-default");
  const preferences = useQuery({ queryKey: ["maintenance-reminder-default", ctx.slug], queryFn: () => api.maintenanceReminderPreferences(ctx.slug), enabled: !!ctx.slug });
  const save = useMutation({
    mutationFn: (v: OverdueCadence) => api.setMaintenanceReminderPreferences(ctx.slug, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["maintenance-reminder-default", ctx.slug] });
      toast.success("Overdue reminder cadence saved.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save reminders"),
  });
  if (preferences.isError) return <p className="text-sm text-faint">The reminder cadence could not be read. Reload to try again.</p>;
  if (!preferences.data) return <p className="text-sm text-faint">Loading…</p>;
  return (
    <>
      <p className="text-sm text-muted dark:text-slate-400">After a service or renewal is overdue, keep reminding at this cadence. Each schedule can choose its own.</p>
      {maySet ? (
        <CadencePicker workspace value={preferences.data.overdue_every} onChange={(v) => { if (v) save.mutate(v); }} />
      ) : (
        <p className="text-sm">Overdue reminders: {SAID[preferences.data.overdue_every as keyof typeof SAID] ?? preferences.data.overdue_every}. An owner, an admin or an editor of this workspace sets it.</p>
      )}
    </>
  );
}

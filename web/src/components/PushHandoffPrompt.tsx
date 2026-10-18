// After push is turned on: which of the other channels to turn off (#7070).
//
// The owner turned push on and kept getting Discord messages, and push never
// fired: it was set for high and urgent only, and his updates are normal. He
// asked for a question, never an automatic switch. So this lists the other
// channels still carrying his workspace updates, each with "Turn off" (all
// left on), and asks whether normal updates should push too (yes by default).
// Nothing changes until Save; Not now leaves everything as it was. Asked once.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { api, type MePushHandoff } from "../lib/api";
import { deviceTimezone } from "../lib/push-device";

const button = "inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 disabled:opacity-60";
const quiet = "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-200 text-sm font-medium px-3 py-1.5 disabled:opacity-60";

export function PushHandoffPrompt({ handoff, onDone }: { handoff: MePushHandoff; onDone: () => void }) {
  const toast = useToast();
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [normalHere, setNormalHere] = useState(true);
  const answer = useMutation({
    mutationFn: () => api.answerPushHandoff({ turn_off: [...off], normal_here: handoff.normal_pushes || normalHere, timezone: deviceTimezone() }),
    onSuccess: () => {
      toast.success(off.size ? "Saved. Those updates come here now." : "Saved.");
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that"),
  });
  const skip = useMutation({ mutationFn: () => api.skipPushHandoff(), onSuccess: onDone, onError: onDone });

  return (
    <Modal open onClose={() => skip.mutate()} size="sm" title="Notifications are on here">
      <div className="space-y-4 text-sm" data-testid="push-handoff">
        {handoff.channels.length > 0 && (
          <div className="space-y-2">
            <p className="text-content dark:text-mortar-200">These still send you your workspace updates. Tick any you want to turn off:</p>
            <ul className="space-y-1.5">
              {handoff.channels.map((c) => (
                <li key={c.channel}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={off.has(c.channel)}
                      data-testid={`push-handoff-off-${c.channel}`}
                      onChange={(e) =>
                        setOff((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(c.channel);
                          else next.delete(c.channel);
                          return next;
                        })
                      }
                    />
                    <span className="text-content dark:text-mortar-100">{c.label}</span>
                    {c.daily && <span className="text-xs text-muted dark:text-slate-400">once a day</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!handoff.normal_pushes && (
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={normalHere} data-testid="push-handoff-normal" onChange={(e) => setNormalHere(e.target.checked)} />
            <span className="text-content dark:text-mortar-200">
              Send normal updates here too
              <span className="block text-xs text-muted dark:text-slate-400">Things going off, receipts to check, steps given to you. Without it, only high and urgent ones buzz this device.</span>
            </span>
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={quiet} disabled={skip.isPending || answer.isPending} onClick={() => skip.mutate()} data-testid="push-handoff-skip">
            Not now
          </button>
          <button type="button" className={button} disabled={answer.isPending || skip.isPending} onClick={() => answer.mutate()} data-testid="push-handoff-save">
            {answer.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

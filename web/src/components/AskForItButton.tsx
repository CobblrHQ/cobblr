// The button a surface shows in place of one the person may not press.
//
// A portal view hides "+ New" from a member without the create capability,
// and a worker app hides its create block the same way; both left the person
// with nothing, not even the knowledge that asking was possible. This asks the
// server for the same explanation a refusal would carry
// (/approval-requests/describe) and raises the one blocked-action sheet with
// it, so the ask is offered before the refusal rather than after (#3073).

import { useMutation } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import type { ApprovalRemedy } from "@cobblr/platform-contract/blocked-action";
import { api, ApiError } from "../lib/api";
import { raiseBlockedAction } from "../lib/blocked-action";

export function AskForItButton({
  slug,
  remedies,
  doing,
  subject,
  label = "Ask to add",
  className,
}: {
  slug: string;
  remedies: Array<{ kind: ApprovalRemedy["kind"]; key: string }>;
  /** The sentence's subject: "Adding here". */
  doing: string;
  /** Words for the request card: "Add records to Parts". */
  subject: string;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const ask = useMutation({
    mutationFn: async () => {
      const { blocked } = await api.describeBlockedAction(slug, remedies, doing);
      raiseBlockedAction({ blocked, refused: null, subject });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <button
      type="button"
      onClick={() => ask.mutate()}
      disabled={ask.isPending}
      title="You cannot do this yet; ask a workspace admin for it"
      className={
        className ??
        "inline-flex items-center gap-1.5 rounded-md border border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-500/80 dark:bg-amber-900/40 dark:text-amber-100 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
      }
    >
      {ask.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} {label}
    </button>
  );
}

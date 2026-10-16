// The sign-in address on the account's identity page, and the way to change
// it. A change is only asked for here: a link goes to the new address and
// nothing changes until it is used (api/src/platform/email-change.ts). An
// account managed by the central account service changes its address there.
import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PasswordInput, useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";

export function ChangeEmailSection({ email }: { email: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["me", "email"], queryFn: () => api.myEmail() });
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const [password, setPassword] = useState("");
  const ask = useMutation({
    mutationFn: () => api.requestEmailChange({ new_email: next.trim(), ...(hasPassword ? { current_password: password } : {}) }),
    onSuccess: (r) => {
      setOpen(false);
      setNext("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["me", "email"] });
      toast.success(`Check ${r.pending} for a link. Nothing changes until you open it.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't ask for the change"),
  });
  // A magic-link account has no password to ask for; a recent sign-in is
  // its proof, and the server says so plainly if it is not recent.
  const hasPassword = state.data?.has_password !== false;
  const pending = state.data?.pending ?? null;
  const managed = state.data?.managed_by_identity === true;
  return (
    <div className="block" data-testid="change-email">
      <div className="text-xs text-muted mb-1">Email</div>
      <div className="flex items-center gap-2">
        <input aria-label="Email"
          type="email"
          value={email}
          readOnly
          className="flex-1 min-w-0 px-2 py-1 text-sm border border-line dark:border-slate-700 rounded bg-subtle dark:bg-slate-800/40 text-muted"
        />
        {!managed && !open && (
          <button type="button" onClick={() => setOpen(true)} className="shrink-0 text-xs font-medium text-accent hover:underline">
            Change
          </button>
        )}
      </div>
      {managed && (
        <div className="text-[11px] text-faint mt-1">You sign in through your {productName()} account, so this address changes there.</div>
      )}
      {pending && !open && (
        <div className="text-[11px] text-faint mt-1">
          Waiting for you to open the link sent to <strong className="text-content dark:text-mortar-200">{pending.email}</strong>. Until
          then you still sign in with the address above.
        </div>
      )}
      {open && (
        <form
          className="mt-2 space-y-2 rounded-md border border-line dark:border-slate-700 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask.mutate();
          }}
        >
          <p className="text-xs text-faint">
            We send a link to the new address. Your address changes when you open it, every device is signed out, and
            the old address is told, with a way to undo it for 7 days.
          </p>
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="New address"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-700 rounded bg-surface dark:bg-slate-950"
          />
          {hasPassword ? (
            <PasswordInput
              autoComplete="current-password"
              placeholder="Current password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : (
            <p className="text-[11px] text-faint">Your account has no password, so a sign-in in the last 10 minutes is what proves it is you.</p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-line dark:border-slate-600 px-3 py-1 text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={ask.isPending || !next.trim() || (hasPassword && !password)}
              className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1 text-sm font-medium disabled:opacity-50"
            >
              {ask.isPending ? "Sending…" : "Send the link"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

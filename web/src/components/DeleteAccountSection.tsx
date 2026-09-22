// The person's door to deleting their account (#3276). Rendered on the
// account page inside a workspace, and on the no-workspace landing, which is
// exactly where somebody ends up after deleting their only workspace to get
// here; a door that needs a workspace to reach would strand them one step
// from the end.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../lib/api";

/** The door that did not exist (#3276): a person could delete their workspace
 *  and never their account. Confirmed with the password; refused with the
 *  list while they are the only owner of a live workspace, so a shared
 *  workspace never vanishes because one member left. An account that came
 *  through the central account service is sent there instead. */
export function DeleteAccountSection() {
  const { logout } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [soleOwner, setSoleOwner] = useState<Array<{ slug: string; name: string }> | null>(null);
  const [portal, setPortal] = useState<string | null>(null);
  // The same request with an empty password is the probe: the server answers
  // the refusals (only owner, managed upstream) before it checks the password,
  // so the modal opens on the right message without asking for it first. A
  // "wrong password" to the probe means: none of those, ask.
  const [probing, setProbing] = useState(false);
  const del = useMutation({
    mutationFn: (pw: string) => api.deleteMyAccount(pw),
    onSuccess: () => {
      toast.success("Your account is deleted.");
      logout();
      window.location.assign("/");
    },
    onError: (e, pw) => {
      if (e instanceof ApiError && e.code === "sole_owner") {
        const d = e.details as { workspaces?: Array<{ slug: string; name: string }> } | undefined;
        setSoleOwner(d?.workspaces ?? []);
        return;
      }
      if (e instanceof ApiError && e.code === "delete_at_identity") {
        const d = e.details as { portal?: string } | undefined;
        setPortal(d?.portal ?? null);
        return;
      }
      if (pw === "" && e instanceof ApiError && e.code === "bad_current_password") return;
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
    onSettled: () => setProbing(false),
  });
  return (
    <section className="rounded-xl border border-ember-300 dark:border-ember-800 bg-surface dark:bg-slate-900 p-4 space-y-2">
      <div className="text-sm font-medium text-content dark:text-mortar-100">Delete account</div>
      <div className="text-xs text-muted">
        Removes your account and everything that was yours: memberships, tokens, connections. Workspaces you share stay
        with their other owners; a workspace only you own has to be deleted or handed over first. This cannot be undone.
      </div>
      <button
        type="button"
        onClick={() => {
          setSoleOwner(null);
          setPortal(null);
          setPassword("");
          setProbing(true);
          setOpen(true);
          del.mutate("");
        }}
        className="px-3 py-1.5 text-sm rounded border border-ember-300 dark:border-ember-800 text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-950/40"
      >
        Delete my account
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete your account?" size="sm">
        <div className="space-y-3">
          {probing ? (
            <div className="text-sm text-muted">Checking…</div>
          ) : portal ? (
            <div className="space-y-2 text-sm text-content dark:text-mortar-100">
              <div>
                This account is managed by your Cobblr account, so it is deleted there and removed here too.{" "}
                <a href={portal} className="underline text-cobble-700 dark:text-cobble-300">
                  Open your Cobblr account
                </a>
              </div>
              {/* The portal's own delete is not shipped on every account
                  service yet, so this says the other route rather than leaving
                  somebody hunting for a button. True either way. */}
              <div className="text-xs text-muted">
                If you cannot find that option yet, ask whoever runs this instance to remove your account.
              </div>
            </div>
          ) : soleOwner ? (
            <div className="space-y-2 text-sm">
              <div className="text-content dark:text-mortar-100">You are the only owner of:</div>
              <ul className="list-disc pl-5">
                {soleOwner.map((w) => (
                  <li key={w.slug}>
                    <a href={`/w/${w.slug}/settings`} className="underline text-cobble-700 dark:text-cobble-300">
                      {w.name}
                    </a>
                  </li>
                ))}
              </ul>
              <div className="text-xs text-muted">Delete each one, or make somebody else an owner, then come back.</div>
            </div>
          ) : (
            <>
              <div className="text-sm text-muted">Type your password to confirm. Every device is signed out and nothing of yours is kept.</div>
              <input
                type="password"
                autoComplete="current-password"
                aria-label="Current password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600">
                  Keep my account
                </button>
                <button
                  type="button"
                  disabled={!password || del.isPending}
                  onClick={() => del.mutate(password)}
                  className="px-3 py-1.5 text-sm rounded bg-ember-600 hover:bg-ember-700 text-white disabled:opacity-50"
                >
                  {del.isPending ? "Deleting…" : "Delete my account"}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </section>
  );
}

// /me — user profile self-edit. Display name + password change.
// Email is read-only (changing it has identity implications that v0.1
// doesn't tackle).
//
// Reachable from the workspace switcher dropdown / display-name
// chip in the header. Distinct from /me/activity (the cross-
// workspace feed) — this is "edit who I am", that is "what have I
// been doing".

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, History, KeyRound, Monitor, Plug, UserCog } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../lib/api";
import { useToast, usePageTitle } from "@cobblr/platform-web";

export function MeProfilePage() {
  usePageTitle("Profile");
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <UserCog size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Your profile
        </h1>
      </div>

      {user && (
        <DisplayNameSection
          initial={user.display_name}
          email={user.email}
          onSaved={() => {
            // Refresh /me so AuthContext re-renders with new name.
            void qc.invalidateQueries({ queryKey: ["me"] });
            toast.success("Profile saved");
          }}
        />
      )}

      <PasswordSection
        onChanged={() => toast.success("Password updated — you stay signed in.")}
      />

      <div className="flex flex-col gap-2">
        <Link
          to="/me/activity"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <History size={14} />
          Your activity across all workspaces →
        </Link>
        <Link
          to="/me/communication"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <Bell size={14} />
          Communication preferences (in-app / Discord DM / email) →
        </Link>
        <Link
          to="/me/notification-channels"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <Bell size={14} />
          Notification channels (per-workspace Discord / Slack / email / SMS / webhook) →
        </Link>
        <Link
          to="/me/connections"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <Plug size={14} />
          Connections — BYO AI keys / edge bridge that follow you to your workspaces →
        </Link>
        <Link
          to="/me/drive"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <Monitor size={14} />
          Browser driving — let Claude drive the app you have open (per workspace, off by default) →
        </Link>
      </div>
    </div>
  );
}

function DisplayNameSection({
  initial,
  email,
  onSaved,
}: {
  initial: string;
  email: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial);
  const toast = useToast();
  const save = useMutation({
    mutationFn: (display_name: string) => api.updateMe({ display_name }),
    onSuccess: onSaved,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const dirty = name.trim() !== initial && name.trim().length > 0;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <h2 className="text-sm font-medium text-content dark:text-slate-300">
        Identity
      </h2>
      <label className="block">
        <div className="text-xs text-muted mb-1">Email</div>
        <input
          type="email"
          value={email}
          readOnly
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-700 rounded bg-subtle dark:bg-slate-800/40 text-muted cursor-not-allowed"
        />
        <div className="text-[11px] text-faint mt-1">
          Email changes go through a separate flow — not in v0.1.
        </div>
      </label>
      <label className="block">
        <div className="text-xs text-muted mb-1">Display name</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={() => save.mutate(name.trim())}
          disabled={!dirty || save.isPending}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {save.isPending ? "saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const toast = useToast();
  const change = useMutation({
    mutationFn: () =>
      api.changeMyPassword({ current_password: current, new_password: next }),
    onSuccess: () => {
      onChanged();
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 && next.length >= 8 && confirm === next && !change.isPending;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <h2 className="text-sm font-medium text-content dark:text-slate-300 flex items-center gap-2">
        <KeyRound size={14} /> Password
      </h2>
      <label className="block">
        <div className="text-xs text-muted mb-1">Current password</div>
        <input
          type="password"
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <label className="block">
        <div className="text-xs text-muted mb-1">New password (min 8 chars)</div>
        <input
          type="password"
          value={next}
          autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)}
          className={
            "w-full px-2 py-1 text-sm border rounded bg-surface dark:bg-slate-900 " +
            (tooShort
              ? "border-ember-400"
              : "border-line dark:border-slate-600")
          }
        />
        {tooShort && (
          <div className="text-[11px] text-ember-500 mt-1">
            Minimum 8 characters.
          </div>
        )}
      </label>
      <label className="block">
        <div className="text-xs text-muted mb-1">Confirm new password</div>
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          className={
            "w-full px-2 py-1 text-sm border rounded bg-surface dark:bg-slate-900 " +
            (mismatch
              ? "border-ember-400"
              : "border-line dark:border-slate-600")
          }
        />
        {mismatch && (
          <div className="text-[11px] text-ember-500 mt-1">
            Doesn't match the new password above.
          </div>
        )}
      </label>
      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={() => change.mutate()}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {change.isPending ? "updating…" : "Change password"}
        </button>
      </div>
    </section>
  );
}

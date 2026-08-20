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
import { Bell, History, KeyRound, Monitor, Moon, Plug, Sun, Unlock, UserCog } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError } from "../lib/api";
import { useTheme } from "../theme/ThemeContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

export function MeProfilePage() {
  usePageTitle("Your account");
  const { user } = useAuth();
  const { activeOrg } = useActiveOrg();
  // A locked managed app ("Cobblr for Yarn") hides the platform — so the profile
  // shows only what a single-app consumer needs (name + password + how they're
  // notified), not cross-workspace / BYO-AI / browser-driving platform settings.
  const appMode = !!activeOrg?.app_mode;
  const qc = useQueryClient();
  const toast = useToast();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <UserCog size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Your account
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
        onChanged={() => toast.success("Password updated - you stay signed in.")}
      />

      <AppearanceSection />

      <div className="flex flex-col gap-2">
        {/* Notifications stay — a consumer cares how they're reached. */}
        <Link
          to="/me/communication"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
        >
          <Bell size={14} />
          Communication preferences (in-app / Discord DM / email) →
        </Link>
        {/* Platform-level surfaces — hidden inside a locked managed app. */}
        {!appMode && (
          <>
            <Link
              to="/me/activity"
              className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
            >
              <History size={14} />
              Your activity across all workspaces →
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
              Connections - BYO AI keys / edge bridge that follow you to your workspaces →
            </Link>
            <Link
              to="/me/drive"
              className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent"
            >
              <Monitor size={14} />
              Browser driving - let Claude drive the app you have open (per workspace, off by default) →
            </Link>
          </>
        )}
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
          Email changes go through a separate flow - not in v0.1.
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

function ThemeChoiceRow<T extends string | null>({
  label,
  sub,
  options,
  value,
  onPick,
}: {
  label: string;
  sub: string;
  options: { value: T; label: string; icon: typeof Sun; hint: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs leading-tight">
        <span className="font-medium text-content dark:text-slate-300">{label}</span>{" "}
        <span className="text-faint">— {sub}</span>
      </div>
      <div className={"grid gap-1.5 " + (options.length >= 4 ? "grid-cols-4" : "grid-cols-3")}>
        {options.map((o) => {
          const selected = value === o.value;
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={selected}
              title={o.hint}
              onClick={() => onPick(o.value)}
              className={
                "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 transition " +
                (selected
                  ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-500/10 ring-1 ring-cobble-500"
                  : "border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800/60")
              }
            >
              <o.icon size={14} className={selected ? "text-cobble-600 dark:text-cobble-400" : "text-muted"} />
              <span className="text-xs text-content dark:text-slate-200">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { accountPref, deviceOverride, setAccountPref, setDeviceOverride } = useTheme();
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2.5">
      <h2 className="text-sm font-medium text-content dark:text-slate-300 flex items-center gap-2">
        <Moon size={14} /> Appearance
      </h2>

      <ThemeChoiceRow
        label="Account default"
        sub="Follows you to every workspace and device."
        value={accountPref}
        onPick={setAccountPref}
        options={[
          { value: null, label: "Match device", icon: Monitor, hint: "follow each device's OS" },
          { value: "light", label: "Light", icon: Sun, hint: "always light" },
          { value: "dark", label: "Dark", icon: Moon, hint: "always dark" },
        ]}
      />

      <ThemeChoiceRow
        label="This device only"
        sub="Overrides the account default on this browser — never synced."
        value={deviceOverride}
        onPick={setDeviceOverride}
        options={[
          { value: null, label: "Use default", icon: Unlock, hint: "follow the account default" },
          { value: "os", label: "Match OS", icon: Monitor, hint: "follow this device's OS" },
          { value: "light", label: "Light", icon: Sun, hint: "this device light" },
          { value: "dark", label: "Dark", icon: Moon, hint: "this device dark" },
        ]}
      />

      <p className="text-[11px] text-faint leading-tight">
        Precedence: <span className="font-medium">this device</span> → <span className="font-medium">account default</span> → the device's OS. This device can follow its own OS (Match OS) even when your account default is a fixed Light/Dark. The header toggle sets this device only; only you see it.
      </p>
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

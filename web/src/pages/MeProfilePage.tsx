// /me — "Your account": the hub, plus the identity / password / appearance
// leaves it used to stack on top of each other.
//
// It used to be three big open forms with five one-line links underneath. The
// forms took the whole screen for settings you change once a year, and the
// links — the things people actually came for — were small text at the bottom
// that nobody found ("no one knows they are there", 2026-08-20). Configuration
// had the same shape of problem and solved it with section cards you navigate
// into, so this is the same fix: the two halves of settings now work the same
// way.
//
// Sections + leaves live in lib/account-nav.ts, so the hub cannot drift from
// the routes.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { KeyRound, Monitor, Moon, Sun, Unlock, UserCog } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError } from "../lib/api";
import { accountSections } from "../lib/account-nav";
import { useTheme } from "../theme/ThemeContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

function AccountHead({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="border-b border-line dark:border-slate-700 pb-3">
      <div className="flex items-baseline gap-3">
        <UserCog size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">{title}</h1>
      </div>
      {blurb && <p className="mt-1 text-sm text-muted dark:text-slate-400">{blurb}</p>}
    </div>
  );
}

export function MeProfilePage() {
  usePageTitle("Your account");
  const { user } = useAuth();
  const { activeOrg } = useActiveOrg();
  const sections = accountSections({ appMode: !!activeOrg?.app_mode });

  return (
    <div className="space-y-4">
      <AccountHead title="Your account" />
      {user && (
        <p className="text-sm text-muted dark:text-slate-400">
          Signed in as <span className="text-content dark:text-mortar-200">{user.email}</span>.
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sections.map(({ id, meta, items }) => (
          <AccountCard key={id} to={`/me/s/${id}`} meta={meta} items={items} />
        ))}
      </div>
      <Link
        to="/configuration"
        className="flex items-center gap-2 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3 text-sm text-muted dark:text-slate-400 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
      >
        <Unlock size={15} className="text-accent shrink-0" />
        <span>
          Looking for <span className="font-medium text-content dark:text-mortar-200">this workspace</span> - modules, fields, members, integrations?
        </span>
        <span className="ml-auto text-faint">→</span>
      </Link>
    </div>
  );
}

/** One section card. Same shape as Configuration's, deliberately: the
 *  two settings hubs should be recognisably one design. */
function AccountCard({
  to,
  meta,
  items,
}: {
  to: string;
  meta: {
    label: string;
    blurb: string;
    icon: React.ComponentType<{ size?: number }>;
    action?: { label: string; to: string };
  };
  items: Array<{ label: string; to: string; description: string }>;
}) {
  const Icon = meta.icon;
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition">
      {/* The header and the blurb are the CARD's own link, to the section page.
          Pointing it at the first leaf instead would make "You" mean "Identity",
          which stays true only until somebody reorders the list. */}
      <div className="flex items-center gap-2.5">
        <Link to={to} className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent grid place-items-center shrink-0">
            <Icon size={18} />
          </span>
          <div className="font-medium text-content dark:text-mortar-100 truncate">{meta.label}</div>
        </Link>
        {/* Beside the title, amber, exactly as Configuration renders one. */}
        {meta.action && (
          <Link
            to={meta.action.to}
            className="shrink-0 rounded-md bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-500/30 px-2 py-0.5 text-xs font-medium transition"
          >
            {meta.action.label}
          </Link>
        )}
        <span className="ml-auto text-[11px] font-mono text-faint dark:text-slate-500 shrink-0">
          {items.length}
        </span>
      </div>
      <Link to={to} className="block">
        <p className="mt-2 text-sm text-content dark:text-mortar-200">{meta.blurb}</p>
      </Link>
      <div className="mt-2.5 text-xs text-faint dark:text-slate-500 leading-relaxed">
        {items.map((l, i) => (
          <span key={l.to}>
            {i > 0 && " · "}
            <Link to={l.to} title={l.description} className="hover:text-accent hover:underline">
              {l.label}
            </Link>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Identity, password and appearance are DESTINATIONS now, not forms stacked on
 *  the hub. Each is the same component that used to render inline. */
/** Name, address and password on ONE page. They were briefly two, which split
 *  "who you are" from "how you prove it" across a click for no reason: both are
 *  short forms, you arrive for one and often do the other, and two cards that
 *  each hold one field is the thin-page smell. */
export function MeIdentityPage() {
  usePageTitle("Identity & password");
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <div className="space-y-4">
      <AccountHead
        title="Identity & password"
        blurb="Your display name, the address you sign in with, and the password you sign in with."
      />
      {user && (
        <DisplayNameSection
          initial={user.display_name}
          email={user.email}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["me"] });
            toast.success("Profile saved");
          }}
        />
      )}
      <PasswordSection onChanged={() => toast.success("Password updated - you stay signed in.")} />
    </div>
  );
}

export function MeAppearancePage() {
  usePageTitle("Appearance");
  return (
    <div className="space-y-4">
      <AccountHead title="Appearance" blurb="Light or dark - for your account everywhere, or just this device." />
      <AppearanceSection />
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
  const signOutAll = useMutation({
    mutationFn: () => api.signOutEverywhere(),
    onSuccess: () => toast.success("Signed out of all other devices. This one stays signed in."),
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
      <div className="border-t border-line dark:border-slate-700 pt-3 flex items-center justify-between gap-3">
        <div className="text-xs text-muted">
          Signed in somewhere you no longer trust? Sign out of every other device.
          This one stays signed in.
        </div>
        <button
          type="button"
          onClick={() => signOutAll.mutate()}
          disabled={signOutAll.isPending}
          className="shrink-0 px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 hover:bg-mist-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {signOutAll.isPending ? "signing out…" : "Sign out everywhere"}
        </button>
      </div>
    </section>
  );
}

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

import { useOfferedAccountFeatures } from "../lib/accountFeatures";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { KeyRound, Languages, Lock, Monitor, Moon, Sun, Unlock, UserCog , PanelLeft} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError } from "../lib/api";
import { thisPushEndpoint } from "../lib/push-device";
import { accountSections } from "../lib/account-nav";
import { useTheme } from "../theme/ThemeContext";
import { rovingRadio, useToast, usePageTitle, PasswordInput } from "@cobblr/platform-web";
import { NAV_LAYOUTS, setNavLayout, useNavLayout } from "../lib/nav-mode";
import { LayoutPreview } from "../components/LayoutPreview";
import { DownloadMyDataSection } from "../components/DownloadMyDataSection";
import { DeleteAccountSection } from "../components/DeleteAccountSection";
import { DeletedWorkspaceBackups } from "../components/DeletedWorkspaceBackups";
import { ChangeEmailSection } from "../components/ChangeEmailSection";
import { LinkedSignInsSection } from "../components/LinkedSignInsSection";
import { MetaParts } from "../components/MetaParts";
import {
  DEFAULT_TITLE_FORMAT,
  TITLE_FORMATS,
  TITLE_FORMAT_LABELS,
  formatTitleVariants,
  type TitleFormat,
} from "@cobblr/platform-contract/display-identity";

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
  const offered = useOfferedAccountFeatures();
  const sections = accountSections({ appMode: !!activeOrg?.app_mode, offered });

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
      <DeletedWorkspaceBackups />
      <Link
        to="/vault"
        className="flex items-center gap-2 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3 text-sm text-muted dark:text-slate-400 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
      >
        <Lock size={15} className="text-accent shrink-0" />
        <span>
          <span className="font-medium text-content dark:text-mortar-200">Your Vault</span>: personal documents, encrypted, opened only by the people you choose.
        </span>
        <span className="ml-auto text-faint">→</span>
      </Link>
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
        <MetaParts
          parts={items.map((l) => (
            <Link key={l.to} to={l.to} title={l.description} className="hover:text-accent hover:underline">
              {l.label}
            </Link>
          ))}
        />
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
  const { user, refreshMe } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  // The session user is what each section starts from, so a save refreshes it;
  // the ["me"] query alone left a section comparing against the name before the save.
  const saved = () => {
    void qc.invalidateQueries({ queryKey: ["me"] });
    void refreshMe();
  };
  return (
    <div className="space-y-4">
      {user && (
        <DisplayNameSection
          initial={user.display_name}
          email={user.email}
          onSaved={() => {
            saved();
            toast.success("Profile saved");
          }}
        />
      )}
      {user && (
        <UsernameSection
          initial={user.username ?? ""}
          hasEmail={user.has_email !== false}
          onSaved={(u) => {
            saved();
            toast.success(u ? `You can sign in as ${u} now.` : "Username removed. Sign in with your email.");
          }}
        />
      )}
      <PasswordSection onChanged={() => toast.success("Password updated - you stay signed in.")} />
      <DownloadMyDataSection />
      <DeleteAccountSection />
    </div>
  );
}

export function MeAppearancePage() {
  usePageTitle("Appearance");
  return (
    <div className="space-y-4">
      <AppearanceSection />
      <TitleFormatSection />
      <LayoutSection />
    </div>
  );
}

/** A name to sign in with beside the email (#6910): "demo" on a shared kiosk
 *  instead of an address. Lower-case letters, digits, dots, dashes and
 *  underscores; the server says why one is refused. */
function UsernameSection({ initial, hasEmail, onSaved }: { initial: string; hasEmail: boolean; onSaved: (u: string | null) => void }) {
  // DRAFT-OK: the person's own sign-in name on their own profile form; no action elsewhere moves it.
  const [name, setName] = useState(initial);
  const toast = useToast();
  const save = useMutation({
    mutationFn: (username: string | null) => api.updateMe({ username }),
    onSuccess: (_d, username) => onSaved(username),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const cleaned = name.trim().toLowerCase();
  const dirty = cleaned !== initial;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3" data-testid="username-section">
      <h2 className="text-sm font-medium text-content dark:text-slate-300">Username</h2>
      <p className="text-xs text-muted">
        {hasEmail
          ? "Optional. Sign in with it or with your email, whichever is easier to type on the device in front of you."
          : "This account has no email, so it signs in with its username. If you forget the password, an admin of your workspace resets it."}
      </p>
      <label className="block">
        <div className="text-xs text-muted mb-1">Username</div>
        <input
          type="text"
          value={name}
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="username"
          placeholder="e.g. demo"
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <div className="flex justify-end gap-2 pt-2">
        {initial && hasEmail && (
          <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-muted hover:text-content">
            Remove
          </button>
        )}
        <button
          type="button"
          onClick={() => save.mutate(cleaned || null)}
          disabled={!dirty || !cleaned || save.isPending}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {save.isPending ? "saving…" : "Save"}
        </button>
      </div>
    </section>
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
  // DRAFT-OK: the person's own display name on their own profile form; no action elsewhere moves it.
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
      <ChangeEmailSection email={email} />
      <LinkedSignInsSection />
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
  disabled = false,
}: {
  label: string;
  sub: string;
  options: { value: T; label: string; icon: typeof Sun; hint: string }[];
  value: T;
  onPick: (v: T) => void;
  disabled?: boolean;
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
              disabled={disabled}
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
  const toast = useToast();
  const save = useMutation({
    mutationFn: setAccountPref,
    onError: () => toast.error("Couldn't save your account theme. Try again."),
  });
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2.5">
      <h2 className="text-sm font-medium text-content dark:text-slate-300 flex items-center gap-2">
        <Moon size={14} /> Appearance
      </h2>

      <ThemeChoiceRow
        label="Account default"
        sub="Follows you to every workspace and device."
        value={accountPref}
        onPick={(value) => save.mutate(value)}
        disabled={save.isPending}
        options={[
          { value: null, label: "Match device", icon: Monitor, hint: "follow each device's OS" },
          { value: "light", label: "Light", icon: Sun, hint: "always light" },
          { value: "dark", label: "Dark", icon: Moon, hint: "always dark" },
        ]}
      />

      {save.isPending && <p role="status" className="text-xs text-muted">Saving account theme…</p>}

      <ThemeChoiceRow
        label="This device only"
        sub="Overrides the account default on this browser (never synced)."
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

/** A sample with all three variants so every option previews as the real
 *  formatter would render it; a title missing a variant falls back the same
 *  way on a real row. */
const TITLE_SAMPLE = {
  original: { title: "Синяя книга", language: "ru" },
  translation: { title: "The Blue Book", language: "en" },
  transliteration: { title: "Sinyaya kniga" },
};

/** How a scanned title that has an original, a translation and a
 *  transliteration reads. Stored on the account like the theme, read by the
 *  server when it composes a row's title, so every surface shows one shape. */
function TitleFormatSection() {
  const { user, refreshMe } = useAuth();
  const toast = useToast();
  const current: TitleFormat = user?.title_pref ?? DEFAULT_TITLE_FORMAT;
  const save = useMutation({
    mutationFn: (title_pref: TitleFormat) => api.setTitlePref(title_pref === DEFAULT_TITLE_FORMAT ? null : title_pref),
    onSuccess: () => void refreshMe(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
        <Languages size={14} /> Titles in another language
      </h2>
      <p className="text-xs text-muted dark:text-slate-400">
        When a scan knows a title's original, its translation and how it is pronounced, this is how the name reads. Nothing is ever invented: a title missing a variant shows what it has.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Title format">
        {TITLE_FORMATS.map((f, i) => {
          const selected = current === f;
          return (
            <button
              key={f}
              type="button"
              {...rovingRadio(i, TITLE_FORMATS.indexOf(current))}
              role="radio"
              aria-checked={selected}
              data-testid={`title-format-${f}`}
              disabled={save.isPending}
              onClick={() => save.mutate(f)}
              className={
                "flex flex-col gap-0.5 rounded-lg border p-3 text-left transition " +
                (selected
                  ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-500/10 ring-1 ring-cobble-500 text-cobble-700 dark:text-cobble-300"
                  : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/60")
              }
            >
              <span className={"text-sm font-medium " + (selected ? "" : "text-content dark:text-mortar-100")}>
                {TITLE_FORMAT_LABELS[f]}
                {f === DEFAULT_TITLE_FORMAT && <span className="ml-1 text-[11px] font-normal text-faint">default</span>}
              </span>
              <span className="text-[12px] leading-snug text-faint dark:text-slate-400" lang="ru">{formatTitleVariants(TITLE_SAMPLE, f)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The desktop nav layout syncs to the account like the theme does. Until this
 *  section existed it was settable only through unlabeled icons in the shell,
 *  and the third state (no top bar at all) existed only as a 13px icon inside
 *  the sidebar, so a person looking for it in settings found two options and a
 *  dead end. Phones ignore all of it (the sidebar is `hidden md:block`), which
 *  is why the section says desktop. */
function LayoutSection() {
  const navLayout = useNavLayout();
  const toast = useToast();
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
        <PanelLeft size={14} /> Layout (desktop)
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Desktop layout">
        {NAV_LAYOUTS.map((o, i) => {
          const selected = navLayout === o.value;
          return (
            <button
              key={o.value}
              type="button"
              {...rovingRadio(i, NAV_LAYOUTS.findIndex((x) => x.value === navLayout))}
              role="radio"
              aria-checked={selected}
              onClick={() => setNavLayout(o.value)}
              className={
                "flex items-start gap-3 rounded-lg border p-3 text-left transition " +
                (selected
                  ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-500/10 ring-1 ring-cobble-500 text-cobble-700 dark:text-cobble-300"
                  : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/60")
              }
            >
              <LayoutPreview layout={o.value} />
              <span className="min-w-0">
                <span className={"block text-sm font-medium " + (selected ? "" : "text-content dark:text-mortar-100")}>{o.label}</span>
                <span className="block text-[11px] leading-snug text-faint dark:text-slate-400 mt-0.5">{o.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            void api
              .setNavPref(null)
              .then(() => toast.info("Layout no longer syncs - each desktop keeps its own."))
              .catch(() => toast.error("Couldn't update - try again."));
          }}
          className="text-xs text-muted dark:text-slate-400 hover:text-accent underline-offset-2 hover:underline"
          title="Clear the synced preference; every desktop keeps whatever it currently shows"
        >
          Stop syncing across desktops
        </button>
      </div>
      <p className="text-[11px] text-faint leading-tight">
        Follows your account to every desktop, like the theme. Pinned or auto-hiding is the
        sidebar's own pin, up at its top right; phones keep the mobile menu regardless.
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
    mutationFn: async () => api.signOutEverywhere(await thisPushEndpoint()),
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
        <PasswordInput
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <label className="block">
        <div className="text-xs text-muted mb-1">New password (min 8 chars)</div>
        <PasswordInput
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
        <PasswordInput
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
          className="shrink-0 px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {signOutAll.isPending ? "signing out…" : "Sign out everywhere"}
        </button>
      </div>
    </section>
  );
}

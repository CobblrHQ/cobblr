// /configuration/general — how the workspace behaves day to day.
//
// Simple mode used to be a card floating on top of the /configuration hub,
// above the tile wall, which made it read as an announcement rather than a
// setting you could come back and change. It is a workspace setting, so it
// lives on a workspace settings page.

import { useAuth } from "../auth/AuthContext";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, LogOut, Trash2 } from "lucide-react";
import { CurrencyPicker, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { displaySlug } from "../lib/workspaceSlug";
import { api, isFocused, setFocused } from "../lib/api";
import { untilDate } from "../components/WorkspaceStateBar";
import { useKeepWorkspace, useWorkspaceDeletion, workspaceStateKey } from "../components/WorkspaceDeletionBar";

export function GeneralSettingsPage() {
  usePageTitle("General");
  const { activeOrg, activeSlug } = useActiveOrg();
  const canFocus = roleSatisfies(activeOrg?.role, ["owner", "admin"]);

  return (
    <div className="space-y-5">

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Identity</h2>
        <dl className="text-sm">
          <div className="flex gap-3 py-1">
            <dt className="text-faint w-24 shrink-0">Name</dt>
            <dd className="text-content dark:text-mortar-200">{activeOrg?.name ?? "—"}</dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="text-faint w-24 shrink-0">Address</dt>
            <dd className="font-mono text-xs text-content dark:text-mortar-200">
              /w/{displaySlug(activeSlug)}
            </dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="text-faint w-24 shrink-0">Your role</dt>
            <dd className="text-content dark:text-mortar-200">{activeOrg?.role ?? "—"}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-faint pt-1">
          Renaming a workspace changes its address, so it is not editable here yet.
        </p>
      </section>

      {activeOrg && <CurrencyCard slug={activeSlug} editable={canFocus} />}
      {canFocus && <FocusedModeCard slug={activeSlug} focused={!!activeOrg?.focused} />}
      {activeOrg && <LeaveWorkspaceCard slug={activeSlug} name={activeOrg.name} />}
      {activeOrg?.role === "owner" && <DeleteWorkspaceCard slug={activeSlug} name={activeOrg.name} />}
    </div>
  );
}

/** Owner/admin control to flip the workspace into (or out of) FOCUSED mode —
 *  hides the builder chrome (marketplace / modules / Configuration / the AI
 *  builder / "+ New thing") so the workspace reads as a finished app. */
function FocusedModeCard({ slug, focused }: { slug: string; focused: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try {
      const turningOn = !focused;
      await setFocused(slug, turningOn);
      // Turning ON hides the builder chrome — so land on the workspace HOME,
      // not back on this (now-hidden) page.
      window.location.assign(turningOn ? "/" : window.location.pathname);
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Couldn't change simple mode");
    }
  };
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <Eye size={18} className="mt-0.5 shrink-0 text-accent dark:text-cobble-300" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-content dark:text-mortar-100">
              Simple mode {focused ? "is on" : "is off"}
            </div>
            <p className="mt-0.5 text-xs text-faint dark:text-slate-400">
              {focused
                ? "The platform's build-it chrome (marketplace, modules, Configuration, the AI builder) is hidden, leaving a calm, everyday view of just your data. Turn it off whenever you want to tinker; it's all still here."
                : "Hide the platform's build-it chrome (marketplace, modules, Configuration, the AI builder) for a calmer, everyday view of just your data. Nothing is removed; flip it back anytime from the account menu."}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={flip}
          disabled={busy}
          className={
            "shrink-0 self-end sm:self-auto rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 " +
            (focused
              ? "border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800"
              : "bg-cobble-600 text-white hover:bg-cobble-700")
          }
        >
          {busy ? "…" : focused ? "Turn off" : "Turn on"}
        </button>
      </div>
    </section>
  );
}

/** Owner only. Deleting a workspace is a request with a date, not an instant
 *  drop: a backup first, a grace period in which every member sees the date and
 *  an owner can keep it, then the database is dropped (CLAUDE.md section 7). */
function DeleteWorkspaceCard({ slug, name }: { slug: string; name: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { dueAt, loading } = useWorkspaceDeletion(slug);
  const keep = useKeepWorkspace(slug);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const schedule = async () => {
    setBusy(true);
    try {
      await api.scheduleWorkspaceDeletion(slug, typed);
      setTyped("");
      await qc.invalidateQueries({ queryKey: workspaceStateKey(slug) });
      toast.success("This workspace is set to be deleted. You can keep it until the day it goes.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete the workspace");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="rounded-xl border border-ember-300 dark:border-ember-800 bg-surface dark:bg-slate-900 p-4 space-y-3"
      data-testid="delete-workspace"
    >
      <div className="flex items-start gap-3">
        <Trash2 size={18} className="mt-0.5 shrink-0 text-ember-600 dark:text-ember-400" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Delete this workspace</h2>
          {loading ? null : dueAt != null ? (
            <p className="text-xs text-faint dark:text-slate-400">
              It will be deleted on <strong className="text-content dark:text-mortar-100">{untilDate(dueAt)}</strong>, with
              everything in it. Until then it works as usual and everyone in it sees the date. A full backup is taken just
              before it goes, and every owner can download it from Your account for 30 days.
            </p>
          ) : (
            <p className="text-xs text-faint dark:text-slate-400">
              Everything in it goes: records, photos, files and history, for everyone in it. It is not deleted at once:
              everyone sees the date, and any owner can keep it until then. A full backup is taken just before it goes and
              kept for 30 days under Your account.{" "}
              <Link to="/configuration/backup" className="underline">
                Download a backup
              </Link>{" "}
              now as well if you want one in hand.
            </p>
          )}
        </div>
      </div>
      {loading ? null : dueAt != null ? (
        <button
          type="button"
          onClick={() => keep.mutate()}
          disabled={keep.isPending}
          className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
        >
          {keep.isPending ? "Keeping…" : "Keep this workspace"}
        </button>
      ) : (
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="flex-1 min-w-0">
            <span className="sr-only">Type the workspace's name to delete it</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Type ${name} to confirm`}
              autoComplete="off"
              className="w-full rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-950 px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={schedule}
            disabled={!matches || busy}
            className="shrink-0 rounded-md bg-ember-600 hover:bg-ember-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-40"
          >
            {busy ? "…" : "Delete workspace"}
          </button>
        </div>
      )}
    </section>
  );
}

export { isFocused };

/** Anyone may leave a workspace; an owner only once somebody else is one too
 *  (the api says so in words when they are not). Their things stay, named as
 *  somebody who has left, never silently unowned. */
function LeaveWorkspaceCard({ slug, name }: { slug: string; name: string }) {
  const toast = useToast();
  const { user } = useAuth();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.removeMember(slug, user.id);
      window.location.assign("/");
    } catch (e) {
      setBusy(false);
      setAsking(false);
      toast.error(e instanceof Error ? e.message : "Couldn't leave the workspace");
    }
  };
  return (
    <section
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4"
      data-testid="leave-workspace"
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <LogOut size={18} className="mt-0.5 shrink-0 text-faint" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-content dark:text-mortar-100">Leave this workspace</div>
            <p className="mt-0.5 text-xs text-faint dark:text-slate-400">
              You stop seeing {name}; everything in it stays for the people who remain. To come back, somebody has to
              invite you again.
            </p>
          </div>
        </div>
        {asking ? (
          <div className="flex gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={busy}
              className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-subtle"
            >
              Stay
            </button>
            <button
              type="button"
              onClick={leave}
              disabled={busy}
              className="rounded-md bg-ember-600 hover:bg-ember-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "…" : "Leave"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAsking(true)}
            className="shrink-0 self-end sm:self-auto rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-subtle"
          >
            Leave…
          </button>
        )}
      </div>
    </section>
  );
}

function CurrencyCard({ slug, editable }: { slug: string; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["workspace-currency", slug], queryFn: () => api.workspaceCurrency(slug) });
  const change = async (currency: string) => {
    setBusy(true);
    try {
      await api.setWorkspaceCurrency(slug, currency);
      await qc.invalidateQueries();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Couldn't change currency"); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
    <h2 className="text-sm font-semibold">Main currency</h2>
    <CurrencyPicker value={query.data?.currency || "USD"} disabled={!editable || busy || query.isLoading} onChange={(c) => void change(c)} label="Main currency" />
    <p className="text-sm text-muted">Totals use this currency at the purchase-date rate, or the entry-date rate when no purchase date is recorded. Older prices with no currency read as this currency. Prices with no known rate are left out and listed beside the total.</p>
  </section>;
}

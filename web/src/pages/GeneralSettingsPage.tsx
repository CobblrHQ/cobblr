// /configuration/general — how the workspace behaves day to day.
//
// Simple mode used to be a card floating on top of the /configuration hub,
// above the tile wall, which made it read as an announcement rather than a
// setting you could come back and change. It is a workspace setting, so it
// lives on a workspace settings page.

import { useState } from "react";
import { Eye } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { isFocused, setFocused } from "../lib/api";

export function GeneralSettingsPage() {
  usePageTitle("General");
  const { activeOrg, activeSlug } = useActiveOrg();
  const canFocus = activeOrg?.role === "owner" || activeOrg?.role === "admin";

  return (
    <div className="space-y-5">

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <h2 className="text-sm font-medium text-content dark:text-mortar-100">Identity</h2>
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

      {canFocus && <FocusedModeCard slug={activeSlug} focused={!!activeOrg?.focused} />}
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

export { isFocused };

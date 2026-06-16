// The "grow door" out of a managed app ("Cobblr for Yarn"). A locked app hides
// the workspace switcher to feel like a standalone product — so this modal is
// the one deliberate exit: it lists the user's other workspaces (switch to any)
// and lets them start a FULL Cobblr workspace (a fresh business workspace, on
// the platform plan). See business-models/docs/18-managed-vertical-apps.md
// (the ingress funnel: graduation = add alongside, not convert-in-place).

import { useState } from "react";
import { ArrowRight, Check, Plus } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { CreateWorkspaceModal } from "./WorkspaceSwitcher";

export function GrowModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgs } = useAuth();
  const { activeSlug, activeOrg, setActiveSlug } = useActiveOrg();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  // Default ON — most people graduating want their data to come with them.
  const [bringData, setBringData] = useState(true);
  const [working, setWorking] = useState(false);
  // The app's short name for the "bring my <x> over" copy (e.g. "yarn").
  const appName = activeOrg?.app_mode?.app ?? "data";

  // Other workspaces the user already has — the "get back to my business" exit.
  const others = orgs.filter((o) => o.slug !== activeSlug);

  // After a full workspace is created: optionally copy this app's data over,
  // then land in the new workspace. Import failure is non-fatal (the workspace
  // exists; the user can retry) — we just toast and still navigate.
  async function afterCreate(newSlug: string) {
    if (bringData) {
      setWorking(true);
      try {
        const r = await api.importApp(newSlug, activeSlug);
        toast.success(`Brought ${r.imported} item${r.imported === 1 ? "" : "s"} into your new workspace.`);
      } catch {
        toast.error("Couldn't bring your data over — your new workspace is ready; you can import later.");
      }
    }
    window.location.assign(`/w/${newSlug}/dashboard`);
  }

  return (
    <>
      <Modal open={open && !createOpen} onClose={onClose} title="Do more with Cobblr" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted dark:text-slate-400">
            This app is one corner of Cobblr. When you're ready to run a whole
            business — customers, orders, purchasing, and more — start a full
            workspace. Your app stays exactly as it is.
          </p>

          {others.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
                Your other workspaces
              </div>
              <ul className="border border-line dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
                {others.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => { setActiveSlug(o.slug); onClose(); }}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-subtle dark:hover:bg-slate-800 transition"
                    >
                      <Check size={12} className="text-transparent shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-content dark:text-mortar-100 truncate">{o.name}</span>
                        <span className="block text-[10px] font-mono text-faint dark:text-slate-500 truncate">{displaySlug(o.slug)}</span>
                      </span>
                      <ArrowRight size={13} className="text-faint dark:text-slate-500 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-100 select-none">
            <input type="checkbox" checked={bringData} onChange={(e) => setBringData(e.target.checked)} className="h-4 w-4 accent-cobble-600" />
            Bring my {appName} over (a copy — this app keeps its data)
          </label>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white transition"
          >
            <Plus size={15} /> Start a full Cobblr workspace
          </button>
          <p className="text-[11px] text-faint dark:text-slate-500 text-center">
            A fresh, separate workspace on the full platform. Your app stays exactly as it is.
          </p>
        </div>
      </Modal>

      <CreateWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(slug) => { void afterCreate(slug); }}
      />

      {working && (
        <Modal open onClose={() => {}} title="Setting up" size="sm">
          <p className="text-sm text-muted dark:text-slate-400">Bringing your {appName} into the new workspace…</p>
        </Modal>
      )}
    </>
  );
}

// Header workspace chip + popover. Click the active workspace name
// to open a popover listing every org the user belongs to (active
// one checkmarked) plus a "Create new workspace" footer that
// launches the CreateWorkspaceModal.

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Plus, Users } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { Modal, useToast } from "@cobblr/platform-web";
import { MembersModal } from "./MembersModal";

export function WorkspaceSwitcher() {
  const { orgs } = useAuth();
  const { activeOrg, activeSlug, setActiveSlug } = useActiveOrg();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageSlug, setManageSlug] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body> so the header's `overflow-x-clip` (which
  // also clips vertically per spec) + backdrop-blur don't hide it. Positioned
  // with `fixed` from the button's rect.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) {
        // Clamp so the 288px (w-72) menu stays on-screen on narrow phones.
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 288 - 8));
        setPos({ top: r.bottom + 4, left });
      }
    };
    place();
    // Reposition on scroll/resize so it stays anchored to the button.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click (button OR the portaled menu).
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function pick(slug: string) {
    setActiveSlug(slug);
    setOpen(false);
  }

  function openCreate() {
    setOpen(false);
    setCreateOpen(true);
  }

  function handleCreated(slug: string) {
    setCreateOpen(false);
    // Navigate straight into the new workspace. We can't use setActiveSlug here:
    // it looks the slug up in useAuth().orgs, which hasn't refreshed with the
    // just-created workspace yet, so it silently no-ops and you're stranded on
    // the old workspace (the reported bug). The full slug resolves as a URL
    // handle on the fresh load, where auth re-fetches orgs incl. the new one.
    window.location.assign(`/w/${slug}/dashboard`);
  }

  // min-w-0 here AND on the button so the name actually truncates to the space
  // left after the icons — otherwise on a narrow (mobile) header the full
  // workspace name renders and the action icons overlap it.
  return (
    <div className="relative min-w-0">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition min-w-0 max-w-full"
        title={activeOrg ? `${activeOrg.name} · ${displaySlug(activeOrg.slug)}` : "Pick a workspace"}
      >
        <span className="truncate max-w-[10rem]">{activeOrg?.name ?? "—"}</span>
        <ChevronDown size={12} className="text-faint shrink-0" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-[100] overflow-hidden"
        >
          <ul className="max-h-80 overflow-y-auto">
            {(() => {
              const owned = orgs.filter((o) => o.role === "owner");
              const shared = orgs.filter((o) => o.role !== "owner");
              const header = (label: string, border: boolean) => (
                <li
                  className={
                    "px-3 pt-2 pb-1 text-[9px] font-mono uppercase tracking-widest text-muted dark:text-slate-500 " +
                    (border ? "border-t border-line dark:border-slate-800 mt-1" : "")
                  }
                >
                  {label}
                </li>
              );
              const row = (o: (typeof orgs)[number]) => {
                // Only owners/admins manage members — editors/members can't.
                const canManage = o.role === "owner" || o.role === "admin";
                return (
                  <li key={o.id} className="group flex items-stretch hover:bg-subtle dark:hover:bg-slate-800 transition">
                    <button
                      onClick={() => pick(o.slug)}
                      className="flex-1 text-left px-3 py-2 flex items-center gap-2 min-w-0"
                    >
                      <Check
                        size={12}
                        className={o.slug === activeSlug ? "text-accent dark:text-cobble-300" : "text-transparent"}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-content dark:text-mortar-100 truncate flex items-center gap-1.5">
                          <span className="truncate">{o.name}</span>
                          {/* On a workspace you don't own, your role is the key
                              signal ("I'm an editor here") — show it as a badge. */}
                          {o.role !== "owner" && (
                            <span className="shrink-0 text-[9px] font-mono uppercase tracking-wide px-1 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
                              {o.role}
                            </span>
                          )}
                        </div>
                        {/* On a workspace you don't own, name the owner — that's
                            what resolves "whose 'Yarn' is this?". The unique slug
                            disambiguates further. */}
                        <div className="text-[10px] font-mono text-faint dark:text-slate-500 truncate">
                          {o.role !== "owner" && o.owner_name ? `owner: ${o.owner_name} · ` : ""}
                          {displaySlug(o.slug)}
                        </div>
                      </div>
                    </button>
                    {canManage && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          setManageSlug(o.slug);
                        }}
                        className="px-3 text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                        title={`Manage members + invites for ${o.name}`}
                      >
                        <Users size={13} />
                      </button>
                    )}
                  </li>
                );
              };
              return (
                <>
                  {owned.length > 0 && header("your workspaces", false)}
                  {owned.map(row)}
                  {shared.length > 0 && header("shared with you", owned.length > 0)}
                  {shared.map(row)}
                </>
              );
            })()}
          </ul>
          <button
            onClick={openCreate}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-accent dark:text-cobble-300"
          >
            <Plus size={13} />
            Create new workspace
          </button>
        </div>,
        document.body,
      )}
      <CreateWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <MembersModal
        open={!!manageSlug}
        onClose={() => setManageSlug(null)}
        slug={manageSlug ?? ""}
      />
    </div>
  );
}

function CreateWorkspaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const toast = useToast();

  // Reset the form whenever the modal re-opens.
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.createOrg(name.trim()),
    onSuccess: (r) => {
      toast.success(`Workspace "${r.org.name}" created.`);
      onCreated(r.slug);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create workspace.");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="new workspace"
      subtitle="separate tenant DB · separate data · same login"
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Workspace name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lego hoard"
            className="input"
            autoFocus
            maxLength={120}
          />
        </label>
        <p className="text-xs text-muted dark:text-slate-400">
          Cobblr will provision a fresh tenant Postgres database, enable
          all installed modules, and seed default wires. Inventory in
          this workspace is invisible to your other workspaces.
        </p>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

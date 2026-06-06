// Header workspace chip + popover. Click the active workspace name
// to open a popover listing every org the user belongs to (active
// one checkmarked) plus a "Create new workspace" footer that
// launches the CreateWorkspaceModal.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Plus, Users } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug } from "../lib/workspaceSlug";
import { Modal, useToast } from "@cobblr/platform-web";
import { MembersModal } from "./MembersModal";

export function WorkspaceSwitcher() {
  const { orgs, setOrgs } = useAuth();
  const { activeOrg, activeSlug, setActiveSlug } = useActiveOrg();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageSlug, setManageSlug] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
    // Refresh org list from server + flip to the new one.
    void api.listOrgs().then((r) => {
      setOrgs(r.items);
      setActiveSlug(slug);
    });
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
        title={activeOrg ? `${activeOrg.name} · ${displaySlug(activeOrg.slug)}` : "Pick a workspace"}
      >
        <span className="truncate max-w-[10rem]">{activeOrg?.name ?? "—"}</span>
        <ChevronDown size={12} className="text-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 w-72 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-line dark:border-slate-700 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
            workspaces
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {orgs.map((o) => {
              const canManage = o.role === "owner" || o.role === "admin";
              return (
                <li key={o.id} className="group flex items-stretch hover:bg-subtle dark:hover:bg-slate-800 transition">
                  {/* Main row → switch active workspace */}
                  <button
                    onClick={() => pick(o.slug)}
                    className="flex-1 text-left px-3 py-2 flex items-center gap-2 min-w-0"
                  >
                    <Check
                      size={12}
                      className={
                        o.slug === activeSlug
                          ? "text-accent dark:text-cobble-300"
                          : "text-transparent"
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-content dark:text-mortar-100 truncate">
                        {o.name}
                      </div>
                      <div className="text-[10px] font-mono text-faint dark:text-slate-500 truncate">
                        {displaySlug(o.slug)} · {o.role}
                      </div>
                    </div>
                  </button>
                  {/* Per-workspace manage affordance — only for owner/admin.
                      Opens the members modal for THIS workspace (no need
                      to switch active org first). */}
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
            })}
          </ul>
          <button
            onClick={openCreate}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-accent dark:text-cobble-300"
          >
            <Plus size={13} />
            Create new workspace
          </button>
        </div>
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

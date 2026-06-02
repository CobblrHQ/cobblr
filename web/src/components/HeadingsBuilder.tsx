// Nav-builder #2b-2 — the in-app editor for user-defined navbar
// headings. Create a heading, drop modules / instances under it
// (cross-module), remove them, delete the heading. Org-wide; writes via
// /orgs/:slug/nav-headings. Rendered on /configuration/presentation.
//
// An entry lives in at most one heading (server-enforced), so the
// "add" picker only offers entries not already grouped.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Plus, Trash2, X } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, useConfirm } from "@cobblr/platform-web";

interface Candidate {
  target_kind: "module" | "instance";
  target_id: string;
  label: string;
}

export function HeadingsBuilder() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [newName, setNewName] = useState("");

  const headings = useQuery({
    queryKey: ["nav-headings", activeSlug],
    queryFn: () => api.listNavHeadings(activeSlug),
    enabled: !!activeSlug,
  });
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
  });
  const instances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["nav-headings", activeSlug] });
  };
  const onErr = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : "Something went wrong");

  const createHeading = useMutation({
    mutationFn: (name: string) => api.createNavHeading(activeSlug, { name }),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: onErr,
  });
  const deleteHeading = useMutation({
    mutationFn: (id: string) => api.deleteNavHeading(activeSlug, id),
    onSuccess: invalidate,
    onError: onErr,
  });
  const addMember = useMutation({
    mutationFn: (v: { headingId: string; target_kind: "module" | "instance"; target_id: string }) =>
      api.addNavHeadingMember(activeSlug, v.headingId, {
        target_kind: v.target_kind,
        target_id: v.target_id,
      }),
    onSuccess: invalidate,
    onError: onErr,
  });
  const removeMember = useMutation({
    mutationFn: (v: { target_kind: string; target_id: string }) =>
      api.removeNavHeadingMember(activeSlug, v.target_kind, v.target_id),
    onSuccess: invalidate,
    onError: onErr,
  });

  const headingList = headings.data?.items ?? [];

  // Label lookups for rendering members + the picker.
  const moduleLabel = new Map(
    (modules.data?.items ?? [])
      .filter((m) => m.enabled && !m.name.startsWith("core-"))
      .map((m) => [m.name, m.displayName]),
  );
  const instanceLabel = new Map(
    (instances.data?.items ?? [])
      .filter((i) => !i.is_default)
      .map((i) => [i.instance_name, i.display_name]),
  );

  // Every entry already grouped (across all headings) — excluded from
  // the add picker (one heading per entry).
  const grouped = new Set(
    headingList.flatMap((h) =>
      h.members.map((m) => `${m.target_kind}:${m.target_id}`),
    ),
  );
  const candidates: Candidate[] = [
    ...[...moduleLabel].map(([id, label]) => ({
      target_kind: "module" as const,
      target_id: id,
      label,
    })),
    ...[...instanceLabel].map(([id, label]) => ({
      target_kind: "instance" as const,
      target_id: id,
      label: `${label} (instance)`,
    })),
  ].filter((c) => !grouped.has(`${c.target_kind}:${c.target_id}`));

  const labelFor = (kind: string, id: string) =>
    kind === "module"
      ? moduleLabel.get(id) ?? id
      : (instanceLabel.get(id) ?? id) + " (instance)";

  return (
    <section className="space-y-3">
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // navigation headings
        </div>
        <p className="text-xs text-muted dark:text-slate-400 mt-1">
          Group nav entries under your own headings — e.g. a{" "}
          <span className="font-mono">Motorcycle</span> heading holding both
          Motorcycle Parts (inventory) and Motorcycles (assets). Each shows as
          a dropdown in the navbar. Org-wide.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) createHeading.mutate(newName.trim());
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New heading name (e.g. Motorcycle)"
          className="flex-1 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          data-testid="new-heading-name"
        />
        <button
          type="submit"
          disabled={!newName.trim() || createHeading.isPending}
          className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm"
          data-testid="create-heading"
        >
          <FolderPlus size={14} /> Add heading
        </button>
      </form>

      {headingList.length === 0 && (
        <div className="text-xs text-faint italic">
          No headings yet. Create one above, then add modules / instances to it.
        </div>
      )}

      <div className="space-y-2">
        {headingList.map((h) => (
          <div
            key={h.id}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3"
            data-heading-id={h.id}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-content dark:text-mortar-100">
                {h.name}
              </span>
              <span className="text-[10px] font-mono text-faint">
                {h.members.length} item{h.members.length === 1 ? "" : "s"}
              </span>
              <div className="flex-1" />
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete "${h.name}"?`,
                    message:
                      "The heading is removed; its members return to their normal nav position.",
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) deleteHeading.mutate(h.id);
                }}
                className="text-faint hover:text-ember-500 transition p-0.5"
                title="Delete heading"
              >
                <Trash2 size={14} />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2">
              {h.members.map((m) => (
                <span
                  key={`${m.target_kind}:${m.target_id}`}
                  className="inline-flex items-center gap-1 text-xs rounded-full border border-line dark:border-slate-700 pl-2 pr-1 py-0.5 bg-subtle dark:bg-slate-800/60"
                >
                  {labelFor(m.target_kind, m.target_id)}
                  <button
                    onClick={() =>
                      removeMember.mutate({
                        target_kind: m.target_kind,
                        target_id: m.target_id,
                      })
                    }
                    className="text-faint hover:text-ember-500"
                    title="Remove from heading"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {h.members.length === 0 && (
                <span className="text-xs text-faint italic">empty</span>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs text-muted">
              <Plus size={12} />
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const [kind, id] = e.target.value.split("::");
                  addMember.mutate({
                    headingId: h.id,
                    target_kind: kind as "module" | "instance",
                    target_id: id!,
                  });
                }}
                className="text-sm rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1"
                data-testid={`add-member-${h.id}`}
              >
                <option value="">add module / instance…</option>
                {candidates.map((c) => (
                  <option
                    key={`${c.target_kind}:${c.target_id}`}
                    value={`${c.target_kind}::${c.target_id}`}
                  >
                    {c.label}
                  </option>
                ))}
              </select>
              {candidates.length === 0 && (
                <span className="italic text-faint">
                  everything's already grouped
                </span>
              )}
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

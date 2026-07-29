// /configuration/permissions — admin-only. Two related controls:
//
//  1. Capability matrix (components/CapabilityMatrix): rows = capabilities
//     grouped by owning module, columns = the holders — owners/admins as one
//     implicit column, then each custom role, then each remaining member.
//     See that file for why it's oriented this way.
//
//  2. Field visibility (H2): mark any field of any kind sensitive and
//     bind it to a capability, per workspace. The field is hidden in the
//     portal / views / app SDK for anyone who lacks the capability
//     (admins/owners always see it). This is a beta tester defining his own
//     tiers — e.g. gate `notes` behind `inventory:view-notes` — on top
//     of whatever the module manifest already gates. Setting a scope
//     auto-registers the capability, so it appears as a new column in
//     the matrix above.

import { useState } from "react";
import { AreaTabs, ACCESS_TABS } from "../components/AreaTabs";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Plus, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { CapabilityMatrix } from "../components/CapabilityMatrix";

export function PermissionsPage() {
  usePageTitle("Permissions");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const matrixQ = useQuery({
    queryKey: ["permissions-matrix", activeSlug],
    queryFn: () => api.listPermissionMatrix(activeSlug),
  });
  const actionsQ = useQuery({
    queryKey: ["grantable-actions", activeSlug],
    queryFn: () => api.listGrantableActions(activeSlug),
  });
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
  });
  const scopesQ = useQuery({
    queryKey: ["field-scopes", activeSlug],
    queryFn: () => api.listFieldScopes(activeSlug),
  });
  // Who-can-do-what overview (2026-07 audit: access control spans four UIs —
  // stock roles in the Members modal, custom roles, direct grants here, field
  // scopes below — with no single place that answers "what can THIS member
  // do". The overview reads it all together; each piece still edits where it
  // lives, via the links.)
  const customRolesQ = useQuery({
    queryKey: ["custom-roles", activeSlug],
    queryFn: () => api.listCustomRoles(activeSlug),
  });

  const members = matrixQ.data?.members ?? [];
  const actions = actionsQ.data?.items ?? [];

  // ── Field-visibility add form ──────────────────────────────────────
  const kinds = kindsQ.data?.items ?? [];
  const scopes = scopesQ.data?.items ?? [];
  const [newKind, setNewKind] = useState("");
  const [newField, setNewField] = useState("");
  const [newCap, setNewCap] = useState("");

  const selectedKind = kinds.find((k) => k.id === newKind);
  const scopedFieldsForKind = new Set(
    scopes.filter((s) => s.kind === newKind).map((s) => s.field),
  );
  // Only fields that aren't already gated for this kind.
  const availableFields = (selectedKind?.fields ?? []).filter(
    (f) => f.name !== "id" && !scopedFieldsForKind.has(f.name),
  );

  function pickKind(id: string) {
    setNewKind(id);
    const kind = kinds.find((k) => k.id === id);
    const firstField =
      (kind?.fields ?? []).find(
        (f) =>
          f.name !== "id" &&
          !scopes.some((s) => s.kind === id && s.field === f.name),
      )?.name ?? "";
    setNewField(firstField);
    setNewCap(suggestCap(kind?.module_name, firstField));
  }
  function pickField(name: string) {
    setNewField(name);
    setNewCap(suggestCap(selectedKind?.module_name, name));
  }

  const setScope = useMutation({
    mutationFn: () =>
      api.setFieldScope(activeSlug, {
        kind: newKind,
        field: newField,
        capability: newCap.trim(),
      }),
    onSuccess: () => {
      toast.success(`${newField} now requires ${newCap.trim()}`);
      setNewKind("");
      setNewField("");
      setNewCap("");
      void qc.invalidateQueries({ queryKey: ["field-scopes", activeSlug] });
      // a fresh capability becomes grantable → refresh the matrix columns
      void qc.invalidateQueries({ queryKey: ["grantable-actions", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't gate field"),
  });

  const delScope = useMutation({
    mutationFn: (s: { kind: string; field: string }) =>
      api.deleteFieldScope(activeSlug, s.kind, s.field),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["field-scopes", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["grantable-actions", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove"),
  });

  const kindLabel = (id: string) =>
    kinds.find((k) => k.id === id)?.display_name ?? id;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <AreaTabs tabs={ACCESS_TABS} area="access" />
      <div className="border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          permissions
        </h1>
        <span className="page-subtitle">
          what each role and member can do, plus field visibility. owners /
          admins have everything implicitly.
        </span>
      </div>

      {members.length > 0 && (
        <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // members &amp; roles
            </span>
            <span className="text-xs text-faint dark:text-slate-400">
              stock role (set in <Link className="underline hover:text-accent" to="/configuration?open=members">Members</Link>) ·
              custom roles (<Link className="underline hover:text-accent" to="/configuration/roles">manage</Link>) ·
              direct grants (the matrix below)
            </span>
          </div>
          <ul className="divide-y divide-line dark:divide-slate-800">
            {members.map((m) => {
              const roleNames = (m.custom_role_ids ?? [])
                .map((id) => (customRolesQ.data?.items ?? []).find((r) => r.id === id)?.name)
                .filter(Boolean) as string[];
              const adminish = m.role === "owner" || m.role === "admin" || m.role === "editor";
              return (
                <li key={m.id} className="py-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium text-content dark:text-mortar-100 min-w-0 truncate">
                    {m.display_name || m.email}
                  </span>
                  <span className={
                    "inline-flex rounded-full px-2 py-0.5 text-[11px] font-mono " +
                    (adminish
                      ? "bg-accent/10 text-accent"
                      : "border border-line dark:border-slate-600 text-content dark:text-mortar-200")
                  }>
                    {m.role}
                  </span>
                  {roleNames.map((n) => (
                    <span key={n} className="inline-flex rounded-full border border-cobble-300 dark:border-cobble-700 px-2 py-0.5 text-[11px] text-content dark:text-mortar-200">
                      {n}
                    </span>
                  ))}
                  <span className="text-xs text-faint dark:text-slate-400 flex-1 min-w-0 truncate">
                    {adminish
                      ? "everything, implicitly"
                      : m.grants.length + roleNames.length === 0
                        ? "read-only — no grants"
                        : (m.grants.length > 0 ? `${m.grants.length} direct grant${m.grants.length === 1 ? "" : "s"}` : "") +
                          (m.grants.length > 0 && roleNames.length > 0 ? " + " : "") +
                          (roleNames.length > 0 ? `${roleNames.length} role${roleNames.length === 1 ? "" : "s"}` : "")}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {actions.length === 0 && (
        <div className="text-xs text-faint italic">
          No grantable actions registered yet.
        </div>
      )}

      {actions.length > 0 && members.length > 0 && (
        <CapabilityMatrix
          slug={activeSlug}
          actions={actions}
          members={members}
          roles={customRolesQ.data?.items ?? []}
        />
      )}

      {/* ── Field visibility (H2) ──────────────────────────────────── */}
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
        <div className="px-4 py-3 border-b border-line dark:border-slate-800">
          <div className="flex items-center gap-2">
            <EyeOff size={14} className="text-accent" />
            <h2 className="font-display text-sm font-bold text-content dark:text-mortar-100 page-title">
              field visibility
            </h2>
          </div>
          <span className="text-[10px] font-mono text-faint dark:text-slate-500">
            hide a field unless the viewer holds a capability. members without
            it see the record but not the field. admins always see it.
          </span>
        </div>

        <div className="divide-y divide-line dark:divide-slate-800">
          {scopes.length === 0 && (
            <div className="px-4 py-3 text-xs text-faint italic">
              No fields gated yet - every exposable field is visible to all
              members. Module-declared scopes (e.g. cost) still apply.
            </div>
          )}
          {scopes.map((s) => (
            <div
              key={`${s.kind}.${s.field}`}
              className="px-4 py-2.5 flex items-center gap-3"
              data-scope-kind={s.kind}
              data-scope-field={s.field}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm text-content dark:text-mortar-100 font-mono">
                  {kindLabel(s.kind)}
                  <span className="text-faint dark:text-slate-600">.</span>
                  {s.field}
                </span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
                {s.capability}
              </span>
              <button
                type="button"
                onClick={() => delScope.mutate({ kind: s.kind, field: s.field })}
                className="text-faint hover:text-rose-500 dark:text-slate-600 dark:hover:text-rose-400 transition"
                title="Remove - field becomes visible to all members again"
                aria-label={`Remove ${s.field} gate`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* add row */}
        <div className="px-4 py-3 border-t border-line dark:border-slate-800 bg-subtle/50 dark:bg-slate-800/20">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                kind
              </span>
              <select
                value={newKind}
                onChange={(e) => pickKind(e.target.value)}
                className="text-sm rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-content dark:text-mortar-100"
                data-testid="scope-kind"
              >
                <option value="">select…</option>
                {kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                field
              </span>
              <select
                value={newField}
                onChange={(e) => pickField(e.target.value)}
                disabled={!newKind}
                className="text-sm rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-content dark:text-mortar-100 disabled:opacity-40"
                data-testid="scope-field"
              >
                {availableFields.length === 0 && (
                  <option value="">
                    {newKind ? "all fields gated" : "—"}
                  </option>
                )}
                {availableFields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[160px]">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                capability
              </span>
              <input
                value={newCap}
                onChange={(e) => setNewCap(e.target.value)}
                placeholder="module:view-field"
                className="text-sm font-mono rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-content dark:text-mortar-100"
                data-testid="scope-capability"
              />
            </label>
            <button
              type="button"
              disabled={
                !newKind || !newField || !newCap.trim() || setScope.isPending
              }
              onClick={() => setScope.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 disabled:opacity-40 disabled:hover:bg-cobble-600 text-white text-sm font-medium px-3 py-1.5 transition"
              data-testid="scope-add"
            >
              <Plus size={14} />
              gate field
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// `inventory:view-costs`-style default; admin can override.
function suggestCap(moduleName: string | undefined, field: string): string {
  if (!moduleName || !field) return "";
  return `${moduleName}:view-${field}`;
}

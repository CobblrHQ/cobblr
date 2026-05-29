// /configuration/permissions — admin-only. Two related controls:
//
//  1. Capability matrix: rows = workspace members, columns = actions
//     that have opted into being portal-grantable (manifest flag, today
//     returned by GET /permissions/grantable-actions). Admins / owners
//     are shown with "implicit" badges — they already have every
//     capability and grants can't be added/removed for them.
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Plus, Shield, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

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

  const toggle = useMutation({
    mutationFn: ({
      user_id,
      action_id,
      grant,
    }: {
      user_id: string;
      action_id: string;
      grant: boolean;
    }) =>
      grant
        ? api.grantCapability(activeSlug, user_id, action_id)
        : api.revokeCapability(activeSlug, user_id, action_id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permissions-matrix", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't update"),
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
    <div className="space-y-6 max-w-5xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          permissions
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          per-member capability grants + field visibility. admins / owners have
          everything implicitly.
        </span>
      </div>

      {actions.length === 0 && (
        <div className="text-xs text-slate-400 italic">
          No grantable actions registered yet.
        </div>
      )}

      {actions.length > 0 && members.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-mortar-50 dark:bg-slate-800/40">
              <tr>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 px-3 py-2">
                  Member
                </th>
                {actions.map((a) => (
                  <th
                    key={a.action_id}
                    className="text-center text-[10px] font-mono text-cobble-600 dark:text-cobble-300 px-3 py-2"
                    title={a.description}
                  >
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {members.map((m) => {
                const isAdmin = m.role === "owner" || m.role === "admin";
                return (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      <div className="text-sm text-slate-700 dark:text-mortar-100">
                        {m.display_name}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
                        {m.email} · {m.role}
                      </div>
                    </td>
                    {actions.map((a) => {
                      const granted = m.grants.includes(a.action_id);
                      if (isAdmin) {
                        return (
                          <td
                            key={a.action_id}
                            className="text-center px-3 py-2"
                            title="Admins have every capability implicitly."
                          >
                            <Shield
                              size={12}
                              className="inline text-cobble-500"
                            />
                          </td>
                        );
                      }
                      return (
                        <td key={a.action_id} className="text-center px-3 py-2">
                          <button
                            type="button"
                            onClick={() =>
                              toggle.mutate({
                                user_id: m.id,
                                action_id: a.action_id,
                                grant: !granted,
                              })
                            }
                            className={
                              "w-6 h-6 rounded inline-flex items-center justify-center transition " +
                              (granted
                                ? "bg-cobble-600 text-white hover:bg-cobble-700"
                                : "border border-slate-300 dark:border-slate-600 text-slate-300 dark:text-slate-600 hover:border-cobble-400")
                            }
                            title={granted ? "Revoke" : "Grant"}
                            data-action-id={a.action_id}
                            data-granted={granted}
                          >
                            {granted && <Check size={12} />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Field visibility (H2) ──────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <EyeOff size={14} className="text-cobble-500" />
            <h2 className="font-display text-sm font-bold text-slate-700 dark:text-mortar-100 lowercase">
              field visibility
            </h2>
          </div>
          <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
            hide a field unless the viewer holds a capability. members without
            it see the record but not the field. admins always see it.
          </span>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {scopes.length === 0 && (
            <div className="px-4 py-3 text-xs text-slate-400 italic">
              No fields gated yet — every exposable field is visible to all
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
                <span className="text-sm text-slate-700 dark:text-mortar-100 font-mono">
                  {kindLabel(s.kind)}
                  <span className="text-slate-300 dark:text-slate-600">.</span>
                  {s.field}
                </span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-300">
                {s.capability}
              </span>
              <button
                type="button"
                onClick={() => delScope.mutate({ kind: s.kind, field: s.field })}
                className="text-slate-300 hover:text-rose-500 dark:text-slate-600 dark:hover:text-rose-400 transition"
                title="Remove — field becomes visible to all members again"
                aria-label={`Remove ${s.field} gate`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* add row */}
        <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 bg-mortar-50/50 dark:bg-slate-800/20">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                kind
              </span>
              <select
                value={newKind}
                onChange={(e) => pickKind(e.target.value)}
                className="text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5 text-slate-700 dark:text-mortar-100"
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
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                field
              </span>
              <select
                value={newField}
                onChange={(e) => pickField(e.target.value)}
                disabled={!newKind}
                className="text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5 text-slate-700 dark:text-mortar-100 disabled:opacity-40"
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
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                capability
              </span>
              <input
                value={newCap}
                onChange={(e) => setNewCap(e.target.value)}
                placeholder="module:view-field"
                className="text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5 text-slate-700 dark:text-mortar-100"
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

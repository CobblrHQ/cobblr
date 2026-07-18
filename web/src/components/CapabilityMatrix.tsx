// The who-can-do-what grid, transposed.
//
// ORIENTATION: capabilities are ROWS, holders are COLUMNS — the opposite of
// the original. The capability axis is unbounded (it grows with every module
// installed, plus one auto-generated "View <field>" cap per gated field), while
// the holder axis is one to maybe ten, forever. The unbounded axis has to be
// the one that scrolls vertically. It also reads better: these labels are
// sentences ("Apply a device event to its linked entity") — fine as a row
// label, a six-line vertical noodle as a column header.
//
// COLUMNS, in the order you reason about access:
//   1. Owners & admins — everything, implicitly. One column, not one per person.
//   2. Each custom role — the reusable answer. Editable here (this is the same
//      capability set the Roles page edits; both write updateCustomRole).
//   3. Each remaining member — the exception. Editable direct grants.
//
// PROVENANCE: a person's cell says WHERE the access comes from — implicit from
// their stock role, inherited from a custom role they hold, or a direct grant.
// Before this, access was spread over four screens with no single place that
// answered "what can this person actually do".
//
// DISCLOSURE: groups start collapsed unless something in them is configured,
// and the whole grid collapses to a sentence when every member is an
// owner/admin and no custom roles exist (nothing to configure — the grid would
// be a wall of implicit shields, which is what it used to render).

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Shield, Users } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type CustomRole, type GrantableAction, type PermissionsMember } from "../lib/api";

/** Stock roles that carry every capability without being granted anything. */
function isImplicit(role: PermissionsMember["role"]): boolean {
  return role === "owner" || role === "admin";
}

/** "core-devices" → "Devices", "digifab" → "Digifab". Only a fallback: the
 *  module's own displayName wins when the workspace has it enabled. */
function prettyModule(name: string): string {
  const base = name.replace(/^core-/, "").replace(/[-_]/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** The owning module of a capability. The server sends it, but web and api roll
 *  independently — during a deploy this page can be served by a new web against
 *  an api that predates the field. Capability ids are namespaced
 *  `<module>:<verb>`, so derive rather than crash. */
function moduleOf(a: GrantableAction): string {
  return a.module || a.action_id.split(":")[0] || "platform";
}

type Column =
  | { key: string; kind: "implicit"; label: string; sublabel: string; count: number }
  | { key: string; kind: "role"; label: string; sublabel: string; role: CustomRole }
  | {
      key: string;
      kind: "person";
      label: string;
      sublabel: string;
      member: PermissionsMember;
      /** Capabilities this person gets from the custom roles they hold. */
      inherited: Map<string, string>;
    };

export function CapabilityMatrix({
  slug,
  actions,
  members,
  roles,
}: {
  slug: string;
  actions: GrantableAction[];
  members: PermissionsMember[];
  roles: CustomRole[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean> | null>(null);
  const [forceShow, setForceShow] = useState(false);

  // Module display names, from the same cached query the nav uses — free.
  const modulesQ = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    staleTime: 30_000,
  });
  const moduleLabel = (name: string) =>
    (modulesQ.data?.items ?? []).find((m) => m.name === name)?.displayName ?? prettyModule(name);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["permissions-matrix", slug] });
    void qc.invalidateQueries({ queryKey: ["custom-roles", slug] });
  };

  const grant = useMutation({
    mutationFn: ({ user_id, action_id, on }: { user_id: string; action_id: string; on: boolean }) =>
      on ? api.grantCapability(slug, user_id, action_id) : api.revokeCapability(slug, user_id, action_id),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update"),
  });

  // A role's capability set is replaced wholesale (the endpoint's contract),
  // so toggling one capability means sending the whole list back.
  const roleCap = useMutation({
    mutationFn: ({ role, action_id, on }: { role: CustomRole; action_id: string; on: boolean }) =>
      api.updateCustomRole(slug, role.id, {
        capabilities: on
          ? [...new Set([...role.capabilities, action_id])]
          : role.capabilities.filter((c) => c !== action_id),
      }),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update the role"),
  });

  const implicitMembers = members.filter((m) => isImplicit(m.role));
  const otherMembers = members.filter((m) => !isImplicit(m.role));

  const columns: Column[] = useMemo(() => {
    const cols: Column[] = [];
    if (implicitMembers.length > 0) {
      cols.push({
        key: "__implicit__",
        kind: "implicit",
        label: "Owners & admins",
        sublabel: `${implicitMembers.length} ${implicitMembers.length === 1 ? "person" : "people"}`,
        count: implicitMembers.length,
      });
    }
    for (const r of roles) {
      cols.push({
        key: `role:${r.id}`,
        kind: "role",
        label: r.name,
        sublabel: `role · ${r.member_count} ${r.member_count === 1 ? "member" : "members"}`,
        role: r,
      });
    }
    for (const m of otherMembers) {
      const inherited = new Map<string, string>();
      for (const rid of m.custom_role_ids ?? []) {
        const r = roles.find((x) => x.id === rid);
        for (const c of r?.capabilities ?? []) inherited.set(c, r!.name);
      }
      cols.push({
        key: `user:${m.id}`,
        kind: "person",
        label: m.display_name || m.email,
        sublabel: m.role,
        member: m,
        inherited,
      });
    }
    return cols;
  }, [implicitMembers, otherMembers, roles]);

  // Rows, grouped by owning module.
  const groups = useMemo(() => {
    const byModule = new Map<string, GrantableAction[]>();
    for (const a of actions) {
      const key = moduleOf(a);
      const list = byModule.get(key) ?? [];
      list.push(a);
      byModule.set(key, list);
    }
    return [...byModule.entries()]
      .map(([module, items]) => ({
        module,
        items: items.sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => moduleLabel(a.module).localeCompare(moduleLabel(b.module)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, modulesQ.data]);

  /** Is anything actually configured for this capability? Drives which groups
   *  open by default — a workspace that has never granted anything opens none. */
  const configured = (actionId: string) =>
    roles.some((r) => r.capabilities.includes(actionId)) ||
    otherMembers.some((m) => m.grants.includes(actionId));

  const groupOpen = (module: string, items: GrantableAction[]) =>
    openGroups?.[module] ?? items.some((a) => configured(a.action_id));

  // Nothing to configure: everyone is an owner/admin and there are no roles.
  const nothingToConfigure = otherMembers.length === 0 && roles.length === 0;
  if (nothingToConfigure && !forceShow) {
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
        <div className="flex items-start gap-3">
          <Users size={16} className="text-accent shrink-0 mt-0.5" />
          <div className="min-w-0 space-y-1">
            <div className="text-sm text-content dark:text-mortar-100">
              Everyone here is an owner or admin, so everyone can already do everything.
            </div>
            <div className="text-xs text-muted dark:text-slate-400">
              Invite someone as a member, or create a custom role, and this becomes a grid of who
              can do what.{" "}
              <button
                type="button"
                onClick={() => setForceShow(true)}
                className="underline hover:text-accent"
              >
                Show the {actions.length} capabilities anyway
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const cellBase = "w-9 text-center px-2 py-1.5 border-b border-line dark:border-slate-800";

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="px-4 py-3 border-b border-line dark:border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // who can do what
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-faint dark:text-slate-500">
          <Shield size={11} className="text-accent" /> implicit
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-faint dark:text-slate-500">
          <span className="w-3.5 h-3.5 rounded bg-cobble-600 inline-flex items-center justify-center">
            <Check size={9} className="text-white" />
          </span>
          granted here
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-faint dark:text-slate-500">
          <span className="w-3.5 h-3.5 rounded border border-cobble-400 text-cobble-500 inline-flex items-center justify-center">
            <Check size={9} />
          </span>
          via a role
        </span>
      </div>

      {/* A bounded scroll BOX, not a page-length table. Declaring overflow on
          one axis makes the other a scroll container too, so a page-level
          sticky header can never work here — the header row would scroll away
          exactly when a long capability list makes it matter. Own the scroll,
          and both the header row and the capability column can stick. */}
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 bg-subtle dark:bg-slate-800 border-b border-line dark:border-slate-700 text-left text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 px-3 py-2 min-w-[16rem]">
                Capability
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="sticky top-0 z-20 bg-subtle dark:bg-slate-800 border-b border-line dark:border-slate-700 px-2 py-2 align-bottom"
                >
                  <div className="text-xs font-medium text-content dark:text-mortar-100 whitespace-nowrap">
                    {c.label}
                  </div>
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 whitespace-nowrap">
                    {c.sublabel}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => {
            const open = groupOpen(g.module, g.items);
            const activeCount = g.items.filter((a) => configured(a.action_id)).length;
            return (
              <tbody key={g.module}>
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="sticky left-0 bg-subtle/70 dark:bg-slate-800/40 border-y border-line dark:border-slate-800 px-3 py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setOpenGroups((prev) => ({ ...(prev ?? {}), [g.module]: !open }))
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-content dark:text-mortar-100 hover:text-accent"
                    >
                      <ChevronRight
                        size={13}
                        className={"transition-transform " + (open ? "rotate-90" : "")}
                      />
                      {moduleLabel(g.module)}
                      <span className="text-[10px] font-mono text-faint">
                        {g.items.length}
                        {activeCount > 0 ? ` · ${activeCount} in use` : ""}
                      </span>
                    </button>
                  </td>
                </tr>
                {open &&
                  g.items.map((a) => (
                    <tr key={a.action_id} className="hover:bg-subtle/40 dark:hover:bg-slate-800/20">
                      <td className="sticky left-0 z-10 bg-surface dark:bg-slate-900 border-b border-line dark:border-slate-800 px-3 py-1.5 min-w-[16rem]">
                        <div className="text-sm text-content dark:text-mortar-100">{a.label}</div>
                        {a.description && (
                          <div className="text-[11px] text-faint dark:text-slate-500 line-clamp-1" title={a.description}>
                            {a.description}
                          </div>
                        )}
                      </td>
                      {columns.map((c) => {
                        if (c.kind === "implicit") {
                          return (
                            <td key={c.key} className={cellBase} title="Owners and admins have every capability implicitly.">
                              <Shield size={12} className="inline text-accent" />
                            </td>
                          );
                        }
                        if (c.kind === "role") {
                          const on = c.role.capabilities.includes(a.action_id);
                          return (
                            <td key={c.key} className={cellBase}>
                              <button
                                type="button"
                                disabled={roleCap.isPending}
                                onClick={() => roleCap.mutate({ role: c.role, action_id: a.action_id, on: !on })}
                                title={on ? `Remove from ${c.role.name}` : `Add to ${c.role.name}`}
                                data-action-id={a.action_id}
                                data-granted={on}
                                className={
                                  "w-6 h-6 rounded inline-flex items-center justify-center transition disabled:opacity-50 " +
                                  (on
                                    ? "bg-cobble-600 text-white hover:bg-cobble-700"
                                    : "border border-line dark:border-slate-600 text-faint dark:text-slate-600 hover:border-accent")
                                }
                              >
                                {on && <Check size={12} />}
                              </button>
                            </td>
                          );
                        }
                        const viaRole = c.inherited.get(a.action_id);
                        if (viaRole) {
                          return (
                            <td
                              key={c.key}
                              className={cellBase}
                              title={`Inherited from the "${viaRole}" role — edit it in that column.`}
                            >
                              <span className="w-6 h-6 rounded border border-cobble-400 dark:border-cobble-600 text-cobble-500 dark:text-cobble-400 inline-flex items-center justify-center">
                                <Check size={12} />
                              </span>
                            </td>
                          );
                        }
                        const granted = c.member.grants.includes(a.action_id);
                        return (
                          <td key={c.key} className={cellBase}>
                            <button
                              type="button"
                              disabled={grant.isPending}
                              onClick={() =>
                                grant.mutate({ user_id: c.member.id, action_id: a.action_id, on: !granted })
                              }
                              title={granted ? "Revoke this direct grant" : `Grant to ${c.label} directly`}
                              data-action-id={a.action_id}
                              data-granted={granted}
                              className={
                                "w-6 h-6 rounded inline-flex items-center justify-center transition disabled:opacity-50 " +
                                (granted
                                  ? "bg-cobble-600 text-white hover:bg-cobble-700"
                                  : "border border-line dark:border-slate-600 text-faint dark:text-slate-600 hover:border-accent")
                              }
                            >
                              {granted && <Check size={12} />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            );
          })}
        </table>
      </div>
      {roles.length > 0 && (
        <div className="px-4 py-2 border-t border-line dark:border-slate-800 text-[11px] text-faint dark:text-slate-500">
          Editing a role column changes it for everyone who holds that role. A person&apos;s own
          column only shows direct grants — the exceptions on top of their roles.
        </div>
      )}
    </section>
  );
}

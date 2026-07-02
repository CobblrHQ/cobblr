// /configuration/users — admin-only. Mint new workspace members
// with a temp password they reset on first login. No-email
// onboarding flow per docs/operations/PRODUCTION_DEPLOY.md.
//
// After create, the response carries the plaintext temp password
// ONCE. We render it in a "copy this and hand it off" card the
// admin can leave open until they've shared it.

import { useState, type FormEvent } from "react";
import { AreaTabs, ACCESS_TABS } from "../components/AreaTabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Plus, RefreshCw } from "lucide-react";
import { useToast, usePageTitle, Modal } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

type Role = "owner" | "admin" | "member" | "guest";

interface TempPasswordResult {
  email?: string;
  display_name?: string;
  user_id: string;
  temp_password: string;
}

export function UsersPage() {
  usePageTitle("Users");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [roleInput, setRoleInput] = useState<Role>("member");
  const [tempPassword, setTempPassword] = useState<TempPasswordResult | null>(null);

  const members = useQuery({
    queryKey: ["permissions-matrix", activeSlug],
    queryFn: () => api.listPermissionMatrix(activeSlug),
  });

  const create = useMutation({
    mutationFn: () =>
      api.adminCreateUser(activeSlug, {
        email: emailInput.trim(),
        display_name: nameInput.trim(),
        role: roleInput,
      }),
    onSuccess: (res) => {
      setTempPassword({
        email: res.user.email,
        display_name: res.user.display_name,
        user_id: res.user.id,
        temp_password: res.temp_password,
      });
      void qc.invalidateQueries({ queryKey: ["permissions-matrix", activeSlug] });
      setEmailInput("");
      setNameInput("");
      setRoleInput("member");
      setOpen(false);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't create"),
  });

  const regen = useMutation({
    mutationFn: (user_id: string) => api.adminRegenPassword(activeSlug, user_id),
    onSuccess: (res, user_id) => {
      const m = (members.data?.members ?? []).find((x) => x.id === user_id);
      setTempPassword({
        email: m?.email,
        display_name: m?.display_name,
        user_id,
        temp_password: res.temp_password,
      });
      toast.success("Temp password generated.");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't reset"),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!emailInput.trim() || !nameInput.trim()) return;
    create.mutate();
  }

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <AreaTabs tabs={ACCESS_TABS} area="access" />
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            users
          </h1>
          <span className="page-subtitle">
            mint workspace accounts with a temp password. user resets on first login. no email required.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition"
        >
          <Plus size={14} /> New user
        </button>
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-subtle/50 dark:bg-slate-800/40">
            <tr>
              <th className="text-left text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2">
                Member
              </th>
              <th className="text-left text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2">
                Role
              </th>
              <th className="text-left text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2">
                Grants
              </th>
              <th className="text-right text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {(members.data?.members ?? []).map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2">
                  <div className="text-sm text-content dark:text-mortar-100">
                    {m.display_name}
                  </div>
                  <div className="text-[10px] font-mono text-faint">{m.email}</div>
                </td>
                <td className="px-3 py-2">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
                    {m.role}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted">
                  {m.grants.length === 0 ? "—" : `${m.grants.length} grant${m.grants.length === 1 ? "" : "s"}`}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={regen.isPending}
                    onClick={() => regen.mutate(m.id)}
                    className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-accent transition inline-flex items-center gap-1"
                    title="Generate a new temp password for this user"
                  >
                    <RefreshCw size={11} /> reset pwd
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New user" size="sm">
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
              Email
            </span>
            <input
              type="email"
              required
              autoFocus
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
              Display name
            </span>
            <input
              type="text"
              required
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
              Role
            </span>
            <select
              value={roleInput}
              onChange={(e) => setRoleInput(e.target.value as Role)}
              className="input"
            >
              <option value="member">Member (default — read-only, grant edit verbs separately)</option>
              <option value="admin">Admin (configures the workspace)</option>
              <option value="guest">Guest (read-only, never grantable)</option>
              <option value="owner">Owner (full power)</option>
            </select>
          </label>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 transition py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
            >
              {create.isPending ? "Creating…" : "Create + mint temp password"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!tempPassword}
        onClose={() => setTempPassword(null)}
        title="Temp password — copy this NOW"
        size="md"
      >
        {tempPassword && (
          <div className="space-y-3">
            <div className="text-xs text-muted dark:text-mortar-200">
              The user will be forced to reset this on first login. We don't
              store the plaintext — close this dialog and it's gone.
            </div>
            {(tempPassword.display_name || tempPassword.email) && (
              <div className="text-[11px] font-mono text-faint">
                {tempPassword.display_name} · {tempPassword.email}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/20 p-3">
              <code className="font-mono text-lg flex-1 text-content dark:text-mortar-100 select-all">
                {tempPassword.temp_password}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(tempPassword.temp_password);
                  toast.success("Copied.");
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
              >
                <ClipboardCopy size={12} /> Copy
              </button>
            </div>
            <button
              type="button"
              onClick={() => setTempPassword(null)}
              className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition"
            >
              I've copied it — done
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}

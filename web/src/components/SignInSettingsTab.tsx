// Operator console → Sign-in (#4492): the instance's own OpenID Connect
// providers (Authentik, Authelia, Keycloak, Pocket ID…), and whether password
// sign-in stays on. The client secret is write-only: it is sent, stored
// encrypted, and never shown again (the page says "set" instead).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";
import { INVITABLE_ORG_ROLES } from "@cobblr/platform-contract/org-roles";
import { SecretInput, useConfirm, useToast } from "@cobblr/platform-web";
import { ApiError, api, type OidcGroupRole, type OidcProvider, type OidcProviderInput } from "../lib/api";

const input = "w-full px-2 py-1 text-sm border border-line dark:border-slate-700 rounded bg-surface dark:bg-slate-950";
const label = "block text-xs text-muted mb-1";

const blank: OidcProviderInput = {
  slug: "",
  display_name: "",
  issuer: "",
  client_id: "",
  client_secret: "",
  scopes: "openid email profile groups",
  email_claim: "email",
  groups_claim: "groups",
  allow_signup: false,
  signup_groups: [],
  group_roles: [],
  allow_http: false,
  enabled: true,
};

export function SignInSettingsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["super-admin", "sign-in"], queryFn: () => api.signInSettings() });
  const [editing, setEditing] = useState<{ id: string | null; form: OidcProviderInput } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["super-admin", "sign-in"] });
  const err = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);

  const save = useMutation({
    mutationFn: async () => {
      const { id, form } = editing!;
      // An empty secret box on an edit leaves the stored one alone.
      const body: Partial<OidcProviderInput> = { ...form };
      if (id && !form.client_secret) delete body.client_secret;
      return id ? api.updateOidcProvider(id, body) : api.createOidcProvider(form);
    },
    onSuccess: () => {
      setEditing(null);
      refresh();
      toast.success("Saved.");
    },
    onError: (e) => err(e, "Could not save the provider."),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testOidcProvider(id),
    onSuccess: (r) =>
      r.ok
        ? toast.success(`It answers as ${r.issuer}. Scopes: ${r.scopes.join(", ") || "not listed"}.${r.end_session ? " It supports sign-out." : ""}`)
        : toast.error(`It did not answer: ${r.message}`),
    onError: (e) => err(e, "Could not test the provider."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteOidcProvider(id),
    onSuccess: () => {
      refresh();
      toast.success("Removed.");
    },
    onError: (e) => err(e, "Could not remove the provider."),
  });
  const password = useMutation({
    mutationFn: (on: boolean) => api.setPasswordSignIn(on),
    onSuccess: (r) => {
      refresh();
      toast.success(r.password_signin ? "Password sign-in is on." : "Password sign-in is off. People sign in through your provider.");
    },
    onError: (e) => err(e, "Could not change password sign-in."),
  });

  const d = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{q.error instanceof ApiError ? q.error.message : "The sign-in settings did not load."}</p>;
  if (!d) return <p className="text-sm text-muted">Loading…</p>;
  const set = (patch: Partial<OidcProviderInput>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <div className="space-y-6" data-testid="sign-in-settings">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-content">Your sign-in provider</h2>
        <p className="text-xs text-muted">
          People sign in through Authentik, Authelia, Keycloak, Pocket ID or any OpenID Connect provider. Register this redirect URL with it:
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate rounded bg-subtle px-2 py-1 text-xs">{d.redirect_uri}</code>
          <button title="Copy the redirect URL" type="button" aria-label="Copy the redirect URL" onClick={() => void navigator.clipboard.writeText(d.redirect_uri).then(() => toast.success("Copied."))} className="shrink-0 text-muted hover:text-content">
            <Copy size={14} />
          </button>
        </div>
        <ul className="divide-y divide-line dark:divide-slate-700 rounded-md border border-line dark:border-slate-700">
          {d.providers.length === 0 && <li className="p-3 text-sm text-muted">None yet.</li>}
          {d.providers.map((p: OidcProvider) => (
            <li key={p.id} className="p-3 flex flex-wrap items-center gap-2 text-sm" data-testid="oidc-provider-row">
              <span className="flex-1 min-w-0">
                <strong>{p.display_name}</strong> <span className="text-xs text-faint">{p.issuer}</span>
                {!p.enabled && <span className="ml-2 text-xs text-faint">off</span>}
                {p.from_env && <span className="ml-2 text-xs text-faint">from COBBLR_OIDC_*</span>}
              </span>
              <button type="button" onClick={() => test.mutate(p.id)} className="text-xs text-accent hover:underline">
                Test
              </button>
              <button type="button" onClick={() => setEditing({ id: p.id, form: { ...p, client_secret: "" } })} className="text-xs text-accent hover:underline">
                Edit
              </button>
              <button
                title={`Remove ${p.display_name}`}
                type="button"
                aria-label={`Remove ${p.display_name}`}
                onClick={async () => {
                  if (await confirm({ title: `Remove ${p.display_name}?`, message: "Everyone who signs in with it will need another way in.", confirmLabel: "Remove", destructive: true })) remove.mutate(p.id);
                }}
                className="text-muted hover:text-ember-600"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        {!editing && (
          <button type="button" data-testid="add-oidc-provider" onClick={() => setEditing({ id: null, form: { ...blank } })} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            <Plus size={14} /> Add a provider
          </button>
        )}
      </section>

      {editing && (
        <form
          className="space-y-3 rounded-md border border-line dark:border-slate-700 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label>
              <span className={label}>Name on the button</span>
              <input className={input} required value={editing.form.display_name} onChange={(e) => set({ display_name: e.target.value })} placeholder="Authentik" />
            </label>
            <label>
              <span className={label}>Short name (lowercase)</span>
              <input className={input} required disabled={!!editing.id} value={editing.form.slug} onChange={(e) => set({ slug: e.target.value })} placeholder="sso" />
            </label>
            <label className="sm:col-span-2">
              <span className={label}>Issuer URL</span>
              <input className={input} required type="url" value={editing.form.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://auth.example.com/application/o/cobblr/" />
            </label>
            <label>
              <span className={label}>Client ID</span>
              <input className={input} required value={editing.form.client_id} onChange={(e) => set({ client_id: e.target.value })} />
            </label>
            <label>
              <span className={label}>{editing.id ? "Client secret (leave empty to keep it)" : "Client secret"}</span>
              <SecretInput secret value={editing.form.client_secret ?? ""} onChange={(e) => set({ client_secret: e.target.value })} />
            </label>
            <label>
              <span className={label}>Scopes</span>
              <input className={input} value={editing.form.scopes} onChange={(e) => set({ scopes: e.target.value })} />
            </label>
            <label>
              <span className={label}>Groups claim</span>
              <input className={input} value={editing.form.groups_claim} onChange={(e) => set({ groups_claim: e.target.value })} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!editing.form.allow_signup} onChange={(e) => set({ allow_signup: e.target.checked })} />
            Make an account for someone new (a verified address nobody here uses)
          </label>
          {editing.form.allow_signup && (
            <label className="block">
              <span className={label}>Only for these groups (comma-separated; empty: anyone the provider signs in)</span>
              <input className={input} value={(editing.form.signup_groups ?? []).join(", ")} onChange={(e) => set({ signup_groups: e.target.value.split(",").map((g) => g.trim()).filter(Boolean) })} />
            </label>
          )}
          <GroupRolesEditor rows={editing.form.group_roles ?? []} onChange={(group_roles) => set({ group_roles })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!editing.form.allow_http} onChange={(e) => set({ allow_http: e.target.checked })} />
            The provider is on plain http (a home network without TLS)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={editing.form.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />
            On
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-line dark:border-slate-600 px-3 py-1 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={save.isPending} className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1 text-sm font-medium disabled:opacity-50">
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-content">Password sign-in</h2>
        <p className="text-xs text-muted">
          {d.password_signin
            ? "On: people can also sign in with a password or an emailed link. Turn it off once a platform admin has signed in through your provider, so nobody is locked out."
            : "Off: everyone signs in through your provider. From the server, node dist/cli/password-sign-in.js on turns it back on."}
        </p>
        {d.password_signin && d.admins_signed_in_through_a_provider === 0 && d.providers.length > 0 && (
          <p className="text-xs text-faint">Sign in through your provider as a platform admin first (link it on Your account → Identity & password).</p>
        )}
        <button
          type="button"
          data-testid="password-sign-in-toggle"
          disabled={password.isPending}
          onClick={() => password.mutate(!d.password_signin)}
          className="rounded-md border border-line dark:border-slate-600 px-3 py-1 text-sm"
        >
          {d.password_signin ? "Turn password sign-in off" : "Turn password sign-in on"}
        </button>
      </section>
    </div>
  );
}

function GroupRolesEditor({ rows, onChange }: { rows: OidcGroupRole[]; onChange: (rows: OidcGroupRole[]) => void }) {
  const put = (i: number, patch: Partial<OidcGroupRole>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <span className={label}>Groups to roles (applied at each sign-in; a role set by hand only rises, unless the row says lower)</span>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input className={`${input} w-32 flex-1`} placeholder="group" value={r.group} onChange={(e) => put(i, { group: e.target.value })} />
          <input className={`${input} w-32 flex-1`} placeholder="workspace short name" value={r.org_slug} onChange={(e) => put(i, { org_slug: e.target.value })} />
          <select aria-label="Role" className={`${input} w-28`} value={r.role} onChange={(e) => put(i, { role: e.target.value as OidcGroupRole["role"] })}>
            {INVITABLE_ORG_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={!!r.lower} onChange={(e) => put(i, { lower: e.target.checked })} /> lower
          </label>
          <button title="Remove this row" type="button" aria-label="Remove this row" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-muted hover:text-ember-600">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { group: "", org_slug: "", role: "member" }])} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
        <Plus size={12} /> Add a row
      </button>
    </div>
  );
}

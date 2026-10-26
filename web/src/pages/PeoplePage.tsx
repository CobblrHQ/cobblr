// /configuration/people — who a workspace's things can belong to (#3787).
//
// Members are listed from their accounts (a name changes in their own
// settings); everyone else was added by name, from here or from a person
// picker's "Someone else…". An admin can invite someone on the list to become
// a member, and when they accept, everything that was theirs stays theirs.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Mail, Package, UserPlus } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { api, ApiError, type WorkspacePerson } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PeoplePage() {
  usePageTitle("People");
  const { activeSlug, activeOrg } = useActiveOrg();
  const slug = activeSlug ?? "";
  const role = activeOrg?.role;
  const canWrite = !!role && role !== "guest";
  // role-gate: exact — inviting is governance, the members page's bar.
  const isAdmin = role === "owner" || role === "admin";
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({ queryKey: ["platform-people", slug], queryFn: () => api.listPeople(slug), enabled: !!slug });
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["platform-people", slug] });

  const add = useMutation({
    mutationFn: () => api.addPerson(slug, { name: name.trim() }),
    onSuccess: (p) => {
      setName("");
      void refresh();
      toast.success(`${p.name} is on the list. Pick them as the owner of anything that is theirs.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add them."),
  });

  const items = people.data?.items ?? [];
  const members = items.filter((p) => p.member);
  const others = items.filter((p) => !p.member);

  return (
    <div className="space-y-6">
      {/* The settings shell draws the heading and description; this is the one
          thing it does not say. */}
      <p className="text-xs text-faint">Names stay in this workspace; they are never shared or sent anywhere.</p>

      {canWrite && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name"
            aria-label="Their name"
            className="input flex-1 min-w-0"
            data-testid="people-add-name"
          />
          <button type="submit" disabled={!name.trim() || add.isPending} className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50 inline-flex items-center gap-1" data-testid="people-add">
            <UserPlus size={14} /> Add
          </button>
        </form>
      )}

      <Link to="/people/me" className="inline-flex items-center gap-1 text-sm text-accent hover:underline" data-testid="people-my-things">
        <Package size={14} /> My things
      </Link>

      <Section title={`Members (${members.length})`}>
        {members.map((p) => (
          <Row key={p.id} person={p} />
        ))}
      </Section>

      <Section title={`Other people (${others.length})`}>
        {others.length === 0 ? (
          <p className="text-xs italic text-faint">Nobody yet. Add someone above, or from any owner field.</p>
        ) : (
          others.map((p) => (
            <Row key={p.id} person={p} slug={slug} canWrite={canWrite} isAdmin={isAdmin} onChanged={refresh} everyone={items} />
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-widest text-muted">{`${title}`}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  person,
  slug,
  canWrite,
  isAdmin,
  onChanged,
  everyone = [],
}: {
  person: WorkspacePerson;
  slug?: string;
  canWrite?: boolean;
  isAdmin?: boolean;
  onChanged?: () => void;
  /** Who their things can be handed to. */
  everyone?: WorkspacePerson[];
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.name);
  const [draftEmail, setDraftEmail] = useState(person.email ?? "");
  const [draftPhone, setDraftPhone] = useState(person.phone ?? "");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState(person.email ?? "");
  const [handing, setHanding] = useState(false);
  const [handTo, setHandTo] = useState("");
  const handOff = useMutation({
    mutationFn: () => api.handOffPerson(slug!, person.id, handTo),
    onSuccess: (r) => {
      setHanding(false);
      onChanged?.();
      const to = everyone.find((p) => p.id === handTo)?.name ?? "them";
      toast.success(
        `${r.moved} thing${r.moved === 1 ? "" : "s"} handed to ${to}${r.kept.length ? `; ${r.kept.length} could not be and stay ${person.name}'s` : ""}.`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't hand them on."),
  });

  const rename = useMutation({
    mutationFn: () => api.updatePerson(slug!, person.id, { name: draft.trim(), email: draftEmail.trim(), phone: draftPhone.trim() }),
    onSuccess: () => {
      setEditing(false);
      onChanged?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save their details."),
  });
  const invite = useMutation({
    mutationFn: () => api.invitePerson(slug!, person.id, email.trim() ? { email: email.trim() } : {}),
    onSuccess: async (inv) => {
      setInviting(false);
      onChanged?.();
      const link = `${window.location.origin}/invite/${inv.token}`;
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        /* the toast still says what to do */
      }
      toast.success(
        inv.emailed
          ? `Invite emailed to ${email.trim()}. When ${person.name} joins, everything that is theirs stays theirs.`
          : `Invite link copied. Send it to ${person.name}; when they join, everything that is theirs stays theirs.`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't make the invite."),
  });

  return (
    <div className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 text-sm" data-testid="people-row">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-0">
          {editing ? (
            <input value={draft} onChange={(e) => setDraft(e.target.value)} className="input w-full" aria-label="Name" autoFocus />
          ) : (
            <>
              <Link to={`/people/${person.id}`} className="block truncate text-content dark:text-mortar-100 hover:underline" title="What is theirs">
                {person.name}
                {person.left && <span className="ml-2 text-[11px] text-faint">left the workspace</span>}
              </Link>
              {!person.member && (person.email || person.phone) && (
                <p className="truncate text-xs text-muted" data-testid="people-contact">
                  {[person.email, person.phone].filter(Boolean).join(" · ")}
                </p>
              )}
            </>
          )}
        </div>
        {person.member && !person.left && <span className="text-[10px] uppercase tracking-widest text-muted">member</span>}
        {!person.member && !person.user_id && canWrite && !editing && (
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setEditing(true)} data-testid="people-edit">
            Edit
          </button>
        )}
        {editing && (
          <button type="button" className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-xs px-2 py-1 transition disabled:opacity-50" disabled={!draft.trim() || rename.isPending} onClick={() => rename.mutate()} data-testid="people-edit-save">
            Save
          </button>
        )}
        {person.left && isAdmin && !handing && (
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setHanding(true)} data-testid="people-hand-off">
            Hand on their things
          </button>
        )}
        {!person.member && !person.left && isAdmin && !editing && !inviting && (
          <button type="button" className="text-xs text-accent hover:underline inline-flex items-center gap-1" onClick={() => setInviting(true)} data-testid="people-invite">
            <Mail size={12} /> Invite to join
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input type="email" value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} placeholder="Email (optional)" aria-label="Email" className="input min-w-0" data-testid="people-edit-email" />
          <input type="tel" value={draftPhone} onChange={(e) => setDraftPhone(e.target.value)} placeholder="Phone, with the country code (+1 …)" aria-label="Phone" className="input min-w-0" data-testid="people-edit-phone" />
          <p className="sm:col-span-2 text-xs text-faint">An automation can email or text them only once an owner or admin allows it, under Configuration, Email.</p>
        </div>
      )}
      {handing && (
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <select value={handTo} onChange={(e) => setHandTo(e.target.value)} className="input flex-1 min-w-0" aria-label="Hand to">
            <option value="">Hand to…</option>
            {everyone
              .filter((p) => p.id !== person.id && !p.left)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
            disabled={!handTo || handOff.isPending}
            onClick={() => handOff.mutate()}
          >
            Hand on
          </button>
        </div>
      )}
      {inviting && (
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Their email (optional)"
            aria-label="Their email"
            className="input flex-1 min-w-0"
          />
          <button type="button" className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5 transition disabled:opacity-50" disabled={invite.isPending} onClick={() => invite.mutate()} data-testid="people-invite-send">
            Make invite
          </button>
        </div>
      )}
    </div>
  );
}

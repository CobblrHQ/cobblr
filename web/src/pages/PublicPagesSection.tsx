// Settings → Sharing → Public pages (#4502; docs/design-decisions/share-scope.md).
//
// A public page is which records and what of them (the same editor a share
// uses), seen by strangers only through its links. Each link has its own
// label, its own detail ("this one shows prices") and its own end, counts its
// visits, and can be revoked or given a new address. Private until a link
// exists; nothing on a page is a workspace id.

import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Globe, Plus } from "lucide-react";
import { DragInput, Modal, useConfirm, useToast } from "@cobblr/platform-web";
import { EMPTY_SCOPE, VISIBILITY_NONE, type VisibilityDef } from "@cobblr/platform-contract/share-scope";
import { api, type PublicPageItem } from "../lib/api";
import { ScopeEditor } from "./ShareWhatEditor";

const DETAIL: Array<{ key: "prices" | "private_notes" | "places"; label: string }> = [
  { key: "prices", label: "Prices" },
  { key: "private_notes", label: "Private notes" },
  { key: "places", label: "Places" },
];

const sayDetail = (v: VisibilityDef) => {
  const on = DETAIL.filter((d) => v[d.key]).map((d) => d.label.toLowerCase());
  return on.length ? `shows ${on.join(", ")}` : "names, photos and plain fields";
};

export function PublicPagesSection({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["public-pages", slug];
  const list = useQuery({ queryKey: key, queryFn: () => api.listPublicPages(slug), enabled: !!slug });
  const [editing, setEditing] = useState<PublicPageItem | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createPublicPage(slug, { name: name.trim() }),
    onSuccess: (made) => {
      setNaming(false);
      setName("");
      setEditing({ ...made, scope: EMPTY_SCOPE, visibility: VISIBILITY_NONE, layout: "gallery", links: [] });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pages = list.data?.items ?? [];
  return (
    <section className="space-y-2" data-testid="public-pages">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-content">Public pages</h2>
        <button type="button" data-testid="public-page-new" onClick={() => setNaming(true)} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600">
          <Plus size={12} aria-hidden /> New public page
        </button>
      </div>
      {pages.length === 0 ? (
        <p className="text-sm text-muted">A page anyone with its link can open: your printers for a trade show, a listing. Nothing is public until you make a link.</p>
      ) : (
        <ul className="space-y-2">
          {pages.map((p) => (
            <PublicPageRow key={p.id} slug={slug} page={p} onEdit={() => setEditing(p)} />
          ))}
        </ul>
      )}
      <Modal open={naming} onClose={() => setNaming(false)} title="New public page" size="sm">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input autoFocus data-testid="public-page-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="What it is, e.g. My 3D printers" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm" />
          <div className="flex justify-end">
            <button type="submit" disabled={!name.trim() || create.isPending} data-testid="public-page-create" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
              Next: what it shows
            </button>
          </div>
        </form>
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`What ${editing?.name ?? "the page"} shows`} size="md">
        {editing && (
          <ScopeEditor
            slug={slug}
            who="visitors"
            onDone={() => setEditing(null)}
            source={{
              key: ["public-page-what", slug, editing.id],
              load: async () => ({ scope: editing.scope, visibility: editing.visibility, gated_fields: (await api.scopeFields(slug)).gated_fields }),
              save: async (b) => {
                await api.updatePublicPage(slug, editing.id, { scope: b.scope, visibility: b.visibility });
                return (await api.previewScope(slug, b.scope)).count;
              },
              editMode: false,
              saved: (n) => `${editing.name} shows ${n} thing${n === 1 ? "" : "s"}.`,
              refresh: [key],
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function PublicPageRow({ slug, page, onEdit }: { slug: string; page: PublicPageItem; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [setting, setSetting] = useState(false);
  const [looking, setLooking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["public-pages", slug] });
  const act = useMutation({
    mutationFn: async ({ id, what }: { id: string; what: "revoke" | "regenerate" | "delete" }) =>
      what === "revoke" ? api.revokePublicLink(slug, id) : what === "regenerate" ? api.regeneratePublicLink(slug, id) : api.deletePublicPage(slug, id),
    onSuccess: (_r, v) => {
      toast.success(v.what === "revoke" ? "That link no longer works." : v.what === "regenerate" ? "New address made; the old one no longer works." : "Page deleted.");
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const btn = "rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600";
  return (
    <li className="space-y-2 rounded-lg border border-line bg-surface p-3 dark:border-slate-600" data-testid="public-page">
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={14} className="text-muted" aria-hidden />
        <span className="mr-auto font-medium text-content">{page.name}</span>
        <button type="button" onClick={onEdit} data-testid="public-page-what" className={btn}>
          What it shows
        </button>
        <button type="button" onClick={() => setSetting(true)} data-testid="public-page-settings" className={btn}>
          Settings
        </button>
        <button type="button" onClick={() => setLooking(true)} data-testid="public-page-look" className={btn}>
          Look
        </button>
        <button type="button" onClick={() => setAdding(true)} data-testid="public-link-new" className={btn}>
          New link
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await confirm({ title: `Delete ${page.name}?`, message: "Every link to it stops working. Your things stay as they are.", confirmLabel: "Delete", destructive: true })) act.mutate({ id: page.id, what: "delete" });
          }}
          className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-ember-400 hover:text-ember-600 dark:border-slate-600"
        >
          Delete
        </button>
      </div>
      {page.label_door && (page.label_scans_week ?? 0) > 0 && (
        <p className="text-xs text-muted" data-testid="public-page-scans">
          Its labels were opened {page.label_scans_today ?? 0} time{page.label_scans_today === 1 ? "" : "s"} today, {page.label_scans_week} this week.
        </p>
      )}
      {(page.label_door || page.public_until) && (
        <p className="text-xs text-muted" data-testid="public-page-doors">
          {page.label_door ? "Its things' labels open it for strangers." : ""}
          {page.label_door && page.public_until ? " " : ""}
          {page.public_until ? (new Date(page.public_until).getTime() > Date.now() ? `Public until ${new Date(page.public_until).toLocaleString()}.` : "Its time is up: private again.") : ""}
        </p>
      )}
      {page.links.length === 0 ? (
        <p className="text-xs text-muted">No links yet, so nobody can open it.</p>
      ) : (
        <ul className="divide-y divide-line rounded border border-line dark:divide-slate-700 dark:border-slate-600">
          {page.links.map((l) => {
            const url = `${window.location.origin}${l.url}`;
            const ended = !!l.expires_at && new Date(l.expires_at).getTime() <= Date.now();
            return (
              <li key={l.id} className="space-y-1 px-2 py-2 text-sm" data-testid="public-link">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-content">{l.label}</span>
                  <span className="text-xs text-muted">
                    {sayDetail(l.visibility)} · {l.visits} visit{l.visits === 1 ? "" : "s"} · {ended ? "ended" : l.expires_at ? `until ${new Date(l.expires_at).toLocaleString()}` : "no end"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input readOnly aria-label="Public link" value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border border-line bg-subtle px-2 py-1 text-xs text-content dark:border-slate-600" data-testid="public-link-url" />
                  <button
                    type="button"
                    className={btn}
                    aria-label={copied === l.id ? "Copied" : "Copy link"}
                    title={copied === l.id ? "Copied" : "Copy link"}
                    onClick={async () => {
                      await navigator.clipboard?.writeText(url).catch(() => undefined);
                      setCopied(l.id);
                    }}
                  >
                    {copied === l.id ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                  </button>
                  {l.named ? (
                    // Ended by emptying the address in the page's settings, so it cannot be left half on.
                    <span className="text-xs text-muted">Turn off in Settings</span>
                  ) : (
                    <>
                      <button type="button" className={btn} onClick={() => act.mutate({ id: l.id, what: "regenerate" })}>
                        New address
                      </button>
                      <button type="button" data-testid="public-link-revoke" className={btn} onClick={() => act.mutate({ id: l.id, what: "revoke" })}>
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={setting} onClose={() => setSetting(false)} title={`${page.name}: settings`} size="sm">
        {setting && (
          <PageSettingsForm
            slug={slug}
            page={page}
            onCancel={() => setSetting(false)}
            onSave={async (body) => {
              await api.updatePublicPage(slug, page.id, body);
              setSetting(false);
              toast.success("Saved.");
              void refresh();
            }}
          />
        )}
      </Modal>
      <Modal open={looking} onClose={() => setLooking(false)} title={`How ${page.name} looks`} size="md">
        {looking && (
          <PageLookForm
            slug={slug}
            page={page}
            onCancel={() => setLooking(false)}
            onSave={async (body) => {
              await api.updatePublicPage(slug, page.id, body);
              setLooking(false);
              toast.success("Saved.");
              void refresh();
            }}
          />
        )}
      </Modal>
      <Modal open={adding} onClose={() => setAdding(false)} title={`A link to ${page.name}`} size="sm">
        {adding && (
          <NewLinkForm
            page={page}
            onCancel={() => setAdding(false)}
            onMake={async (body) => {
              await api.createPublicLink(slug, page.id, body);
              setAdding(false);
              toast.success(`Link "${body.label}" made.`);
              void refresh();
            }}
          />
        )}
      </Modal>
    </li>
  );
}

/** How a page looks: which fields a record shows and in what order (Tier A),
 *  a few words and addresses with every record, or the owner's own HTML
 *  (Tier B), which is only ever handed the record as the page shows it. */
function PageLookForm({
  slug,
  page,
  onCancel,
  onSave,
}: {
  slug: string;
  page: PublicPageItem;
  onCancel: () => void;
  onSave: (b: { show_fields: string[] | null; about: string | null; links: Array<{ label: string; url: string }>; skin_html: string | null; accent: string | null }) => Promise<void>;
}) {
  const choices = useQuery({ queryKey: ["public-page-fields", slug, page.id], queryFn: () => api.publicPageFields(slug, page.id) });
  const [picked, setPicked] = useState<string[] | null>(page.show_fields ?? null);
  const [about, setAbout] = useState(page.about ?? "");
  const [links, setLinks] = useState<Array<{ label: string; url: string }>>(page.out_links ?? []);
  const [skin, setSkin] = useState(page.skin_html ?? "");
  const [accent, setAccent] = useState<string | null>(page.accent ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = choices.data?.fields ?? [];
  const on = (name: string) => (picked === null ? true : picked.includes(name));
  const toggle = (name: string) => {
    const base = picked ?? all.map((f) => f.name);
    setPicked(base.includes(name) ? base.filter((n) => n !== name) : [...base, name]);
  };
  const box = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm";
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ show_fields: picked, about: about.trim() || null, links: links.filter((l) => l.label.trim() && l.url.trim()), skin_html: skin.trim() || null, accent });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-content">Fields a thing shows</h3>
        <p className="text-xs text-muted">Only fewer than What it shows allows, never more. In the order you tick them.</p>
        {choices.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : all.length === 0 ? (
          <p className="text-sm text-muted">No fields to choose from yet.</p>
        ) : (
          all.map((f) => (
            <label key={f.name} className="flex items-center gap-2 text-sm text-content">
              <input type="checkbox" data-testid="public-look-field" checked={on(f.name)} onChange={() => toggle(f.name)} className="accent-cobble-500" />
              {f.label}
            </label>
          ))
        )}
        {picked !== null && (
          <button type="button" onClick={() => setPicked(null)} className="text-xs text-accent hover:underline">
            Show every field again
          </button>
        )}
      </section>
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-content">About</span>
        {/* vocab-lint-ok: a public page holds records of any kind, so "thing" is the neutral word */}
        <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={3} placeholder="A few words shown with every thing" className={box} />
      </label>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-content">Links</h3>
        {links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <input value={l.label} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Label" className={`${box} max-w-[40%]`} />
            <input value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="https://…" className={box} />
            <button type="button" aria-label="Remove" onClick={() => setLinks(links.filter((_, j) => j !== i))} className="px-2 text-muted hover:text-ember-600">
              ×
            </button>
          </div>
        ))}
        {links.length < 10 && (
          <button type="button" onClick={() => setLinks([...links, { label: "", url: "" }])} className="text-xs text-accent hover:underline">
            Add a link
          </button>
        )}
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-content">Colour</h3>
        <p className="text-xs text-muted">The page wears your workspace&apos;s brand (Configuration, the dashboard&apos;s theme). An accent of its own goes over it.</p>
        <div className="flex items-center gap-2">
          <DragInput control="color" aria-label="Accent" data-testid="public-look-accent" value={accent ?? "#3b82f6"} onPreview={setAccent} onCommit={setAccent} className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent p-0 dark:border-slate-600" />
          {accent ? (
            <button type="button" onClick={() => setAccent(null)} className="text-xs text-accent hover:underline">
              Use the brand&apos;s own
            </button>
          ) : (
            <span className="text-xs text-muted">The brand&apos;s own accent</span>
          )}
        </div>
      </section>
      <label className="block space-y-1">
        <span className="text-sm font-semibold text-content">Your own look (HTML)</span>
        {/* vocab-lint-ok: a public page holds records of any kind, so "thing" is the neutral word */}
        <textarea value={skin} onChange={(e) => setSkin(e.target.value)} rows={5} spellCheck={false} placeholder="Optional. Read the thing from cobblr.record (title, photo, fields)." className={`${box} font-mono`} data-testid="public-look-skin" />
        <span className="block text-xs text-muted">It runs on its own with no internet, and is handed only what this page shows. Empty: the standard card.</span>
      </label>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy} data-testid="public-look-save" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** The page's other doors: its things' printed labels, booth mode, a way to
 *  get in touch, and the footer. */
function PageSettingsForm({ slug, page, onCancel, onSave }: { slug: string; page: PublicPageItem; onCancel: () => void; onSave: (b: { label_door: boolean; public_until: string | null; contact: string | null; footer: boolean; indexable: boolean; address: string | null }) => Promise<void> }) {
  const local = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
  const [labelDoor, setLabelDoor] = useState(!!page.label_door);
  const [until, setUntil] = useState(local(page.public_until));
  const [contact, setContact] = useState(page.contact ?? "");
  const [footer, setFooter] = useState(page.footer !== false);
  const [indexable, setIndexable] = useState(!!page.indexable);
  const [address, setAddress] = useState(page.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ label_door: labelDoor, public_until: until ? new Date(until).toISOString() : null, contact: contact.trim() || null, footer, indexable, address: address.trim() || null });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex items-start gap-2 text-sm text-content">
        <input type="checkbox" data-testid="public-page-label-door" checked={labelDoor} onChange={(e) => setLabelDoor(e.target.checked)} className="mt-1 accent-cobble-500" />
        <span>
          Its things&apos; labels open it
          <span className="block text-xs text-muted">Someone who scans the label on one of its things, without being in this workspace, sees that thing as this page shows it. You and your members still get the full record.</span>
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Public until</span>
        <input type="datetime-local" data-testid="public-page-until" value={until} onChange={(e) => setUntil(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm" />
        <span className="block text-xs text-muted">Booth mode: the page, its links and its labels go private again on their own at this time. Empty: no end.</span>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Get in touch</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="https://your-site or mailto:you@example.com" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm" />
        <span className="block text-xs text-muted">A button visitors can press. Nothing about them is collected.</span>
      </label>
      <label className="flex items-center gap-2 text-sm text-content">
        <input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} className="accent-cobble-500" />
        Show &quot;Made with {productName()}&quot;
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Memorable address</span>
        <span className="flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-2 text-base text-content focus-within:border-accent dark:border-slate-600 sm:text-sm">
          <span className="shrink-0 text-muted">/p/{slug}/</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="my-printers"
            maxLength={40}
            data-testid="public-page-address"
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </span>
        <span className="block text-xs text-muted">Optional, off when empty. An address people can remember and type; it shows what the page shows. Your other links keep working.</span>
      </label>
      <label className="flex items-start gap-2 text-sm text-content">
        <input type="checkbox" data-testid="public-page-indexable" checked={indexable} onChange={(e) => setIndexable(e.target.checked)} className="mt-1 accent-cobble-500" />
        <span>
          Search engines may list it
          <span className="block text-xs text-muted">Off: only people you give a link to, or who scan a label, find it.</span>
        </span>
      </label>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy} data-testid="public-page-settings-save" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function NewLinkForm({ page, onCancel, onMake }: { page: PublicPageItem; onCancel: () => void; onMake: (b: { label: string; visibility?: VisibilityDef; expires_at?: string | null }) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [own, setOwn] = useState(false);
  const [vis, setVis] = useState<VisibilityDef>(page.visibility ?? VISIBILITY_NONE);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onMake({ label: label.trim(), ...(own ? { visibility: vis } : {}), expires_at: until ? new Date(until).toISOString() : null });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Who it is for</span>
        <input autoFocus data-testid="public-link-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Trade show, eBay listing…" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm" />
      </label>
      <label className="flex items-center gap-2 text-sm text-content">
        <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} data-testid="public-link-own" className="accent-cobble-500" />
        Its own detail (else what the page shows: {sayDetail(page.visibility)})
      </label>
      {own &&
        DETAIL.map((d) => (
          <label key={d.key} className="ml-6 flex items-center gap-2 text-sm text-content">
            <input type="checkbox" data-testid={`public-link-show-${d.key}`} checked={vis[d.key]} onChange={(e) => setVis({ ...vis, [d.key]: e.target.checked })} className="accent-cobble-500" />
            {d.label}
          </label>
        ))}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Ends</span>
        <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content dark:border-slate-600 sm:text-sm" />
        <span className="block text-xs text-muted">Empty: it lasts until you revoke it. A time: it stops working then, by itself (booth mode).</span>
      </label>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy || !label.trim()} data-testid="public-link-make" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Making…" : "Make the link"}
        </button>
      </div>
    </form>
  );
}

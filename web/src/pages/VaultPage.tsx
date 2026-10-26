// /vault and /vault/:folderId: the Vault (#5242, docs/design-decisions/vault.md).
// Folders of personal documents, encrypted, each opened only by the people
// its owner named. A workspace admin not on a folder's list sees nothing of
// it here or anywhere else; the server decides, this page only shows it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Lock } from "lucide-react";
import { downloadBlob, raisePersonalDocument, useConfirm, useFieldDraft, useLater, usePageTitle, usePasteImage, useToast, OnceQuiet } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { api, type VaultEvent, type VaultFile, type VaultFolder } from "../lib/api";
import { ReadPersonalDocumentModal } from "../components/PersonalDocumentReader";

const btn = "rounded-md border border-line px-3 py-2 text-sm min-h-10 disabled:opacity-50";
const card = "rounded-xl border border-line bg-surface p-4";

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ACTIONS: Record<string, string> = {
  folder_created: "made the folder",
  folder_renamed: "renamed the folder",
  access_changed: "changed who can open it",
  file_added: "added",
  file_opened: "opened",
  file_downloaded: "downloaded",
  file_moved_in: "moved in",
  file_moved_out: "moved out",
  file_renamed: "renamed",
  file_linked: "linked to a record",
  file_unlinked: "unlinked from its record",
  file_removed: "removed",
};

function said(e: VaultEvent): string {
  const who = e.who?.name ?? "Someone no longer here";
  const what = ACTIONS[e.action] ?? e.action;
  if (e.action === "access_changed") {
    const added = (e.detail.added as string[] | undefined) ?? [];
    const removed = (e.detail.removed as string[] | undefined) ?? [];
    return `${who} ${what}${added.length ? `: added ${added.join(", ")}` : ""}${removed.length ? `${added.length ? ";" : ":"} removed ${removed.join(", ")}` : ""}`;
  }
  return `${who} ${what}${e.file ? ` ${e.file}` : ""}`;
}

export function VaultPage() {
  const { folderId } = useParams();
  usePageTitle("Vault");
  return folderId ? <OnceQuiet key={folderId}><FolderView folderId={folderId} /></OnceQuiet> : <FolderList />;
}

function Explainer() {
  return (
    <p className="text-sm text-muted">
      Documents in the Vault are encrypted, and only the people a folder names can open them. A workspace admin who is not on a folder's list cannot see it, its documents or how many there are. Cobb can file a document into your own folders but can never read one.
    </p>
  );
}

function FolderList() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [reading, setReading] = useState(false);
  const folders = useQuery({ queryKey: ["vault-folders", activeSlug], queryFn: () => api.vaultFolders(activeSlug), enabled: !!activeSlug });
  const make = useMutation({
    mutationFn: () => api.vaultCreateFolder(activeSlug, name.trim()),
    onSuccess: (f) => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["vault-folders", activeSlug] });
      navigate(`/vault/${f.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const items = folders.data?.items ?? [];
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex flex-wrap items-center gap-2">
        <Lock size={18} className="text-accent" aria-hidden />
        <h1 className="text-2xl font-semibold">Vault</h1>
        {/* The Vault's main action: read a registration, a bill of sale or
            insurance on the personal path (the same reader as the scan
            inbox's ⋯ menu); its card can then keep it in a folder. */}
        <button type="button" className="ml-auto rounded-md bg-accent px-3 py-2 text-sm font-medium text-white min-h-10" onClick={() => setReading(true)}>Read a personal document</button>
      </div>
      <ReadPersonalDocumentModal open={reading} onClose={() => setReading(false)} />
      <Explainer />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) make.mutate();
        }}
      >
        <label className="sr-only" htmlFor="vault-new-folder">New folder name</label>
        <input id="vault-new-folder" value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder, e.g. Car papers" className="flex-1 min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <button type="submit" className={btn} disabled={!name.trim() || make.isPending}>{make.isPending ? "Making…" : "New folder"}</button>
      </form>
      <p className="text-xs text-muted">A new folder opens only for you until you add people to it.</p>
      {folders.isLoading ? (
        <p role="status">Loading your Vault…</p>
      ) : folders.isError ? (
        <p role="alert">{folders.error.message}</p>
      ) : items.length === 0 ? (
        <p>You have no Vault folders yet. Make one to keep a document only you, or the people you choose, can open.</p>
      ) : (
        <ul className="space-y-3" aria-label="Vault folders">
          {items.map((f) => (
            <li key={f.id}>
              <Link to={`/vault/${f.id}`} className={`${card} block hover:border-accent`}>
                <h2 className="text-sm font-semibold break-words">{f.name}</h2>
                <p className="text-sm text-muted break-words">
                  {f.file_count === 1 ? "1 document" : `${f.file_count} documents`} · {f.mine ? "Yours" : `${f.owner?.name ?? "Its owner"}'s`}
                  {f.people.length ? ` · also open to ${f.people.map((p) => p.name).join(", ")}` : f.mine ? " · only you" : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FolderView({ folderId }: { folderId: string }) {
  const { activeSlug } = useActiveOrg();
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const later = useLater();
  const generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [activeSlug, folderId]);
  const key = ["vault-folder", activeSlug, folderId];
  const folder = useQuery({ queryKey: key, queryFn: () => api.vaultFolder(activeSlug, folderId), enabled: !!activeSlug, retry: false });
  const all = useQuery({ queryKey: ["vault-folders", activeSlug], queryFn: () => api.vaultFolders(activeSlug), enabled: !!activeSlug });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["vault-folders", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["vault-history", activeSlug, folderId] });
  };
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try {
      await work();
      if (done) toast.success(done);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const open = (f: VaultFile, how: "open" | "download") =>
    run(f.id, async () => {
      const blob = await api.vaultFileBlob(activeSlug, f.id, how);
      if (how === "download") downloadBlob(blob, f.name);
      else {
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener");
        later.after(`revoke-${f.id}`, 60_000, () => URL.revokeObjectURL(url));
      }
    });
  const add = (file: File) => void run("upload", async () => {
    const current = generation.current;
    if (file.type === "application/pdf" || file.type.startsWith("image/")) {
      const read = await api.readPersonalDocument(activeSlug, file);
      if (current !== generation.current) return;
      if (read.kind === "registration" || read.renewalType) {
        raisePersonalDocument({ orgSlug: activeSlug, read, file, ...(folder.data?.mine ? { folder: folderId } : {}) });
        return;
      }
    }
    if (current !== generation.current) return;
    await api.vaultUpload(activeSlug, folderId, file);
    toast.success(`${file.name} is in the Vault.`);
  });
  // A document pasted onto the folder (a screenshot of a letter) goes in the
  // same way as one chosen with Add a document.
  usePasteImage(page, { accept: "*", onFiles: (files) => files[0] && add(files[0]) });

  if (folder.isLoading) return <p role="status">Opening the folder…</p>;
  if (folder.isError)
    return (
      <div className="space-y-3">
        <p role="alert">This folder is not in your Vault.</p>
        <Link to="/vault" className="text-accent underline">Back to your Vault</Link>
      </div>
    );
  if (!folder.data) return null;
  const f = folder.data;
  const others = (all.data?.items ?? []).filter((x) => x.id !== f.id);
  return (
    <div ref={page} className="space-y-4 max-w-3xl">
      <Link to="/vault" className="text-sm text-accent hover:underline">← Vault</Link>
      <div className="flex flex-wrap items-center gap-2">
        <Lock size={18} className="text-accent" aria-hidden />
        <h1 className="text-2xl font-semibold break-words">{f.name}</h1>
      </div>
      <p className="text-sm text-muted break-words">
        {f.mine ? "Your folder" : `${f.owner?.name ?? "Its owner"}'s folder`}. Open to {[f.mine ? "you" : (f.owner?.name ?? "its owner"), ...f.people.map((p) => p.name)].join(", ")}.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label="Choose a document to add"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) add(file);
          }}
        />
        <button type="button" className={btn} disabled={busy !== null} onClick={() => input.current?.click()}>{busy === "upload" ? "Reading…" : "Add a document"}</button>
      </div>
      {f.files.length === 0 ? (
        <p>No documents in this folder yet.</p>
      ) : (
        <ul className="space-y-3" aria-label="Documents">
          {f.files.map((file) => (
            <li key={file.id} className={`${card} space-y-2`}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold break-words">{file.name}</h2>
                <p className="text-sm text-muted break-words">
                  {size(file.size_bytes)} · added {new Date(file.created_at).toLocaleDateString()}
                  {file.added_by ? ` by ${file.added_by.name}` : ""}
                  {file.record ? " · belongs to a record" : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} disabled={busy !== null} onClick={() => void open(file, "open")}>Open</button>
                <button type="button" className={btn} disabled={busy !== null} onClick={() => void open(file, "download")}>Download</button>
                {others.length > 0 && (
                  <select
                    aria-label={`Move ${file.name} to`}
                    className={btn}
                    disabled={busy !== null}
                    value=""
                    onChange={(e) => {
                      const to = others.find((o) => o.id === e.target.value);
                      if (to) void run(file.id, () => api.vaultUpdateFile(activeSlug, file.id, { folder_id: to.id }), `Moved to ${to.name}.`);
                    }}
                  >
                    <option value="">Move to…</option>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                )}
                {(f.mine || (!!user && file.added_by?.id === user.id)) && (
                  <button
                    type="button"
                    className={`${btn} text-red-600 dark:text-red-400`}
                    disabled={busy !== null}
                    onClick={async () => {
                      if (!(await confirm({ title: `Remove ${file.name}?`, message: "It is removed from the Vault for everyone on this folder. This cannot be undone.", confirmLabel: "Remove", destructive: true }))) return;
                      void run(file.id, () => api.vaultDeleteFile(activeSlug, file.id), "Removed.");
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {f.mine && <OwnerPanel folder={f} onChanged={refresh} onDeleted={() => {
        void qc.invalidateQueries({ queryKey: ["vault-folders", activeSlug] });
        navigate("/vault");
      }} />}
    </div>
  );
}

function OwnerPanel({ folder, onChanged, onDeleted }: { folder: VaultFolder & { files: VaultFile[] }; onChanged: () => void; onDeleted: () => void }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const members = useQuery({ queryKey: ["members", activeSlug], queryFn: () => api.listMembers(activeSlug), enabled: !!activeSlug });
  const history = useQuery({ queryKey: ["vault-history", activeSlug, folder.id], queryFn: () => api.vaultHistory(activeSlug, folder.id), enabled: !!activeSlug });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const name = useFieldDraft(folder.name);
  const chosen = picked ?? new Set(folder.people.map((p) => p.id));
  const self = members.data?.self.user_id;
  const save = useMutation({
    mutationFn: (people: string[]) => api.vaultUpdateFolder(activeSlug, folder.id, { people }),
    onSuccess: () => {
      setPicked(null);
      toast.success("Saved who can open this folder.");
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-4">
      <section className={`${card} space-y-3`} aria-labelledby="vault-people">
        <h2 id="vault-people" className="text-sm font-semibold">Who can open this folder</h2>
        <p className="text-sm text-muted">You always can. Anyone you tick here can open, download and add documents; nobody else in the workspace can see the folder, including its admins.</p>
        {members.data && members.data.items.filter((m) => m.user_id !== self).length === 0 && (
          <p className="text-sm">Nobody else is in this workspace yet. Invite people from Configuration, Members, and you can add them here.</p>
        )}
        <ul className="space-y-2">
          {(members.data?.items ?? [])
            .filter((m) => m.user_id !== self)
            .map((m) => (
              <li key={m.user_id}>
                <label className="flex items-center gap-2 text-sm min-h-10">
                  <input
                    type="checkbox"
                    checked={chosen.has(m.user_id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(m.user_id);
                      else next.delete(m.user_id);
                      setPicked(next);
                    }}
                  />
                  <span className="break-words">{m.display_name || m.email}</span>
                </label>
              </li>
            ))}
        </ul>
        <button type="button" className={btn} disabled={!picked || save.isPending} onClick={() => save.mutate([...chosen])}>{save.isPending ? "Saving…" : "Save"}</button>
      </section>
      <section className={`${card} space-y-3`} aria-labelledby="vault-folder-settings">
        <h2 id="vault-folder-settings" className="text-sm font-semibold">Folder</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.vaultUpdateFolder(activeSlug, folder.id, { name: name.draft.trim() });
              name.committed(name.draft);
              toast.success("Renamed.");
              onChanged();
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          <label className="sr-only" htmlFor="vault-folder-name">Folder name</label>
          <input id="vault-folder-name" value={name.draft} onChange={(e) => name.setDraft(e.target.value)} className="flex-1 min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm" />
          <button type="submit" className={btn} disabled={!name.draft.trim() || name.draft.trim() === folder.name}>Rename</button>
        </form>
        <button
          type="button"
          className={`${btn} text-red-600 dark:text-red-400`}
          onClick={async () => {
            const n = folder.files.length;
            const what = n === 0 ? "It has no documents." : `${n === 1 ? "Its document" : `All ${n} of its documents`} (${folder.files.map((x) => x.name).join(", ")}) will be deleted with it.`;
            if (!(await confirm({ title: `Delete ${folder.name}?`, message: `${what} This cannot be undone.`, confirmLabel: "Delete folder", destructive: true }))) return;
            try {
              await api.vaultDeleteFolder(activeSlug, folder.id);
              toast.success(`${folder.name} deleted.`);
              onDeleted();
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          Delete folder
        </button>
      </section>
      <section className={`${card} space-y-2`} aria-labelledby="vault-history">
        <h2 id="vault-history" className="text-sm font-semibold">History</h2>
        <p className="text-sm text-muted">Every open, download, move and change of who can open this folder. Only you see this.</p>
        {history.isLoading ? (
          <p role="status">Loading…</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(history.data?.items ?? []).map((e, i) => (
              <li key={`${e.at}-${i}`} className="break-words">
                <span className="text-muted">{new Date(e.at).toLocaleString()}</span> · {said(e)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

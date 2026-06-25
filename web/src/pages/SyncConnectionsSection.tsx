// Sync connections — mirror an external system's records into this workspace.
// Lives in the Integrations page. Each connection picks a registered connector
// (companion app to start), holds an encrypted credential + a base URL, exposes a
// live webhook URL, and lets you toggle + reconcile each entity type.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, JsonField, useToast, useConfirm } from "@cobblr/platform-web";
import { api, ApiError, type SyncConnectorDef, type SyncConnection, type SyncSourceDef, type ImportPlanItem, type ModuleInstance } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { BridgePicker } from "../components/BridgePicker";

type PlanAction = "create" | "update" | "link" | "unchanged" | "delete";
const ACTION_LABEL: Record<PlanAction, string> = {
  create: "create",
  link: "merge",
  update: "update",
  unchanged: "unchanged",
  delete: "remove",
};
const ACTION_BADGE: Record<PlanAction, string> = {
  create: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  link: "border-blue-500/50 text-blue-700 dark:text-blue-400",
  update: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  unchanged: "border-line dark:border-slate-700 text-faint dark:text-slate-500",
  delete: "border-ember-500/50 text-ember-700 dark:text-ember-400",
};
const ACTION_TEXT: Record<PlanAction, string> = {
  create: "text-emerald-600 dark:text-emerald-400",
  link: "text-blue-600 dark:text-blue-400",
  update: "text-amber-600 dark:text-amber-400",
  unchanged: "text-faint dark:text-slate-500",
  delete: "text-ember-600 dark:text-ember-400",
};

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Closest existing instance to a (mistyped) slug — by shared prefix or
 *  containment after stripping punctuation. "lasers" → "laser-cutters". */
function suggestInstance(slug: string, candidates: string[]): string | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(slug);
  if (!n) return null;
  let best: string | null = null;
  let bestScore = 3; // need at least a 4-char overlap to bother suggesting
  for (const c of candidates) {
    const cn = norm(c);
    let p = 0;
    while (p < n.length && p < cn.length && n[p] === cn[p]) p++;
    const score = cn.includes(n) || n.includes(cn) ? Math.max(p, n.length, 4) : p;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Sanity-check a section's parsed JSON. `errors` block save (the section is
 *  structurally broken); `warnings` inform but don't block (e.g. an instance slug
 *  that doesn't match any real instance — the exact bug that silently shipped
 *  lasers to a non-existent "lasers" instance). */
function validateSection(
  section: unknown,
  instances: ModuleInstance[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = section as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    errors.push("Section must be a JSON object.");
    return { errors, warnings };
  }
  if (typeof s.key !== "string" || !s.key) errors.push('Missing "key" (the section id).');
  if (typeof s.targetKind !== "string" || !s.targetKind) errors.push('Missing "targetKind" (e.g. "machines:machine").');
  if (!(s.list as { path?: string })?.path) warnings.push('No "list.path" — nothing will be fetched.');
  if (!s.idField) warnings.push('No "idField" — rows need a stable external id (e.g. "$.id").');
  if (!s.map || typeof s.map !== "object") warnings.push('No "map" — no fields will be written.');

  // Instance existence — the high-value check.
  const allNames = new Set(instances.map((i) => i.instance_name));
  const moduleOf = typeof s.targetKind === "string" ? s.targetKind.split(":")[0] : "";
  const moduleInstances = instances.filter((i) => i.module_name === moduleOf).map((i) => i.instance_name);
  const checkInstance = (slug: unknown, where: string) => {
    if (typeof slug !== "string" || !slug) return;
    if (allNames.has(slug)) return;
    const sug = suggestInstance(slug, moduleInstances.length ? moduleInstances : [...allNames]);
    warnings.push(
      `${where} "${slug}" isn't an instance in this workspace${sug ? ` — did you mean "${sug}"?` : ""}.` +
        (moduleInstances.length ? ` Available: ${moduleInstances.join(", ")}.` : " Create it first, or fix the slug."),
    );
  };
  checkInstance(s.targetInstance, "targetInstance");
  const ib = s.instanceBy as { map?: Record<string, unknown>; default?: unknown } | undefined;
  if (ib && typeof ib === "object") {
    for (const v of Object.values(ib.map ?? {})) checkInstance(v, "instanceBy →");
    checkInstance(ib.default, "instanceBy default");
    if (s.targetInstance) warnings.push("Both targetInstance and instanceBy are set — instanceBy wins per row.");
  }
  return { errors, warnings };
}

/** Render block for a section validator's findings. */
function SectionIssues({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <div className="space-y-1">
      {errors.map((e, i) => (
        <p key={`e${i}`} className="text-[11px] text-ember-600 dark:text-ember-400">⛔ {e}</p>
      ))}
      {warnings.map((w, i) => (
        <p key={`w${i}`} className="text-[11px] text-amber-600 dark:text-amber-400">⚠️ {w}</p>
      ))}
    </div>
  );
}

// A key/value view of a record's fields (name omitted — it's the row title).
function FieldList({ fields, dim }: { fields: Record<string, unknown>; dim?: boolean }) {
  const entries = Object.entries(fields).filter(([k]) => k !== "name");
  if (entries.length === 0) return <p className="text-[10px] text-faint italic">— just the name</p>;
  return (
    <dl className="space-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1.5 text-[10px] leading-snug">
          <dt className="font-mono text-faint dark:text-slate-500 shrink-0">{k}</dt>
          <dd className={`min-w-0 break-words ${dim ? "text-muted dark:text-slate-400" : "text-content dark:text-mortar-200"}`}>{fmtVal(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

// One preview row. Click to expand: the source data coming over and, for a
// merge/update, the existing entity it links into — so you can verify both sides.
function PlanRow({ it }: { it: ImportPlanItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!it.fields || !!it.match?.fields;
  return (
    <div className="border-b border-line/40 dark:border-slate-700/40 last:border-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`flex items-center gap-2 w-full text-left px-2.5 py-1 text-xs ${hasDetail ? "hover:bg-line/20 dark:hover:bg-slate-700/20" : "cursor-default"}`}
      >
        <span className={`text-[9px] font-mono uppercase w-16 shrink-0 ${ACTION_TEXT[it.action]}`}>
          {ACTION_LABEL[it.action]}
        </span>
        <span className="text-content dark:text-mortar-100 truncate flex-1">{it.name}</span>
        {it.action === "link" && it.match && (
          <span className="text-[10px] text-faint dark:text-slate-500 shrink-0 truncate max-w-[45%]">→ {it.match.name}</span>
        )}
        {hasDetail && <span className="text-faint dark:text-slate-500 shrink-0 w-3 text-center">{open ? "−" : "+"}</span>}
      </button>
      {open && hasDetail && (
        <div className="px-2.5 pb-2 grid grid-cols-2 gap-3">
          {it.fields && (
            <div className="min-w-0">
              <div className="text-[9px] font-mono uppercase tracking-widest text-accent mb-1">
                {it.action === "create" ? "New entity" : "Coming over"}
              </div>
              <FieldList fields={it.fields} />
            </div>
          )}
          {it.match?.fields ? (
            <div className="min-w-0">
              <div className="text-[9px] font-mono uppercase tracking-widest text-faint mb-1 truncate">
                Currently · {it.match.name}
              </div>
              <FieldList fields={it.match.fields} dim />
            </div>
          ) : it.action === "create" ? (
            <div className="text-[10px] text-faint italic self-center">no existing match — created fresh</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function SyncConnectionsSection() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [editingSource, setEditingSource] = useState<SyncSourceDef | null>(null);

  const connectorsQ = useQuery({
    queryKey: ["sync-connectors", activeSlug],
    queryFn: () => api.listSyncConnectors(activeSlug),
    enabled: !!activeSlug,
  });
  const sourcesQ = useQuery({
    queryKey: ["sync-sources", activeSlug],
    queryFn: () => api.listSyncSources(activeSlug),
    enabled: !!activeSlug,
  });
  const connectionsQ = useQuery({
    queryKey: ["sync-connections", activeSlug],
    queryFn: () => api.listSyncConnections(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sync-connections", activeSlug] });
  };
  const invalidateSources = () => {
    void qc.invalidateQueries({ queryKey: ["sync-sources", activeSlug] });
    // Installed sources show up in the connection picker — refresh it too.
    void qc.invalidateQueries({ queryKey: ["sync-connectors", activeSlug] });
  };

  const connectors = connectorsQ.data?.items ?? [];
  const connections = connectionsQ.data?.items ?? [];
  const sources = sourcesQ.data?.installed ?? [];

  // A connection is built on a source (connector_id === source_id); group them so
  // each source renders ONCE with its connections nested — no duplicate section
  // list. Orphans (source manifest missing) fall through to a standalone card.
  const connsBySource = new Map<string, SyncConnection[]>();
  for (const c of connections) {
    const arr = connsBySource.get(c.connector_id) ?? [];
    arr.push(c);
    connsBySource.set(c.connector_id, arr);
  }
  const orphanConns = connections.filter((c) => !sources.some((s) => s.source_id === c.connector_id));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-mono uppercase tracking-widest text-accent">// Live sync</h2>
          <p className="text-[11px] text-muted dark:text-slate-400 mt-0.5">
            Mirror records from another system into this workspace — they arrive instantly via webhook, with a reconcile that backstops anything missed.
          </p>
        </div>
        {connectors.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs px-2.5 py-1 rounded bg-cobble-600 text-white hover:bg-cobble-700 transition shrink-0"
          >
            + Add connection
          </button>
        )}
      </div>

      {/* Installed sources — the declarative manifests connections are built on.
          Install one (paste its manifest JSON), then add a connection through it. */}
      <div className="rounded-lg border border-line dark:border-slate-700 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint">Sources</span>
          <button
            type="button"
            onClick={() => setInstalling(true)}
            className="text-[11px] px-2 py-0.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:border-accent transition shrink-0"
          >
            + Install a source
          </button>
        </div>
        {sources.length === 0 && orphanConns.length === 0 ? (
          <p className="text-[11px] text-faint italic">
            No sources installed. Install one (paste its manifest) to connect an external system.
          </p>
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => (
              <SourceRow
                key={s.source_id}
                source={s}
                connections={connsBySource.get(s.source_id) ?? []}
                onChange={() => {
                  invalidateSources();
                  invalidate();
                }}
                onEditRaw={() => setEditingSource(s)}
                onAddConnection={() => setAdding(true)}
              />
            ))}
            {orphanConns.map((c) => (
              <SyncConnectionCard key={c.id} conn={c} onChange={invalidate} />
            ))}
          </ul>
        )}
      </div>

      {adding && (
        <AddSyncConnectionModal
          connectors={connectors}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            invalidate();
            toast.success("Connection added — enable a sync to start mirroring.");
          }}
        />
      )}

      {(installing || editingSource) && (
        <InstallSourceModal
          initial={editingSource?.manifest}
          onClose={() => {
            setInstalling(false);
            setEditingSource(null);
          }}
          onInstalled={() => {
            const wasEdit = !!editingSource;
            setInstalling(false);
            setEditingSource(null);
            invalidateSources();
            // an edit can add/remove entity types — refresh open connections too.
            void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug] });
            toast.success(
              wasEdit ? "Source updated — connections pick up the change." : "Source installed — add a connection through it.",
            );
          }}
        />
      )}
    </section>
  );
}

// A source = a CONTAINER (defined once: id, name, auth, base-url) holding SECTIONS
// (entity types). Expand to manage sections: add another (paste its JSON), remove
// one, or edit the whole container JSON. All persist by re-installing (upsert).
type Section = { key: string; label?: string; targetKind?: string };
function SourceRow({
  source,
  connections,
  onChange,
  onEditRaw,
  onAddConnection,
}: {
  source: SyncSourceDef;
  connections: SyncConnection[];
  onChange: () => void;
  onEditRaw: () => void;
  onAddConnection: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true); // expanded by default — sections are the point
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Section | null>(null);
  // Real workspace instances — so the editor can flag a targetInstance/instanceBy
  // slug that doesn't exist (same cache key the nav uses).
  const instancesQ = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const instances = instancesQ.data?.items ?? [];

  const sections: Section[] = Array.isArray((source.manifest as { entityTypes?: unknown }).entityTypes)
    ? ((source.manifest as { entityTypes: Section[] }).entityTypes)
    : [];

  // Persist a new sections list by re-installing the container (upsert on id).
  const saveSections = useMutation({
    mutationFn: (next: unknown[]) =>
      api.installSyncSource(activeSlug, { ...(source.manifest as object), entityTypes: next } as Record<string, unknown>),
    onSuccess: () => {
      onChange();
      void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug] }); // open connections re-offer types
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const uninstall = useMutation({
    mutationFn: () => api.uninstallSyncSource(activeSlug, source.source_id),
    onSuccess: () => {
      onChange();
      toast.success(`Removed "${source.name}".`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const removeSection = async (s: Section) => {
    if (sections.length <= 1) {
      toast.error("A source needs at least one section — remove the whole source instead.");
      return;
    }
    if (await confirm({ title: `Remove the "${s.label ?? s.key}" section?`, message: "Connections stop offering it; already-mirrored data stays." }))
      saveSections.mutate(sections.filter((e) => e.key !== s.key));
  };

  return (
    <li className="text-xs border border-line/60 dark:border-slate-700/60 rounded">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 min-w-0 text-left">
          <span className="text-faint w-3 shrink-0 text-center">{open ? "−" : "+"}</span>
          <span className="text-content dark:text-mortar-100 font-medium truncate">{source.name}</span>
          <span className="text-faint dark:text-slate-500 font-mono text-[10px] shrink-0">{source.source_id}</span>
          <span className="text-faint dark:text-slate-500 shrink-0">· {sections.length} section{sections.length === 1 ? "" : "s"}</span>
          {connections.length > 0 && (
            <span className="text-faint dark:text-slate-500 shrink-0">· {connections.length} connection{connections.length === 1 ? "" : "s"}</span>
          )}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await confirm({ title: `Remove "${source.name}"?`, message: "Every connection built on it stops resolving." }))
              uninstall.mutate();
          }}
          className="text-[11px] text-faint hover:text-ember-600 dark:hover:text-ember-400 transition shrink-0"
        >
          Remove
        </button>
      </div>
      {open && (
        <div className="px-2.5 pb-2 pt-2 space-y-1.5 border-t border-line/40 dark:border-slate-700/40">
          <ul className="space-y-1">
            {sections.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-content dark:text-mortar-200">{s.label ?? s.key}</span>
                  {s.targetKind && <span className="text-faint dark:text-slate-500 ml-1.5 font-mono text-[10px]">→ {s.targetKind}</span>}
                </span>
                <span className="flex items-center gap-2.5 shrink-0">
                  <button type="button" onClick={() => setEditing(s)} className="text-[11px] text-faint hover:text-content dark:hover:text-mortar-200 transition">
                    edit
                  </button>
                  <button type="button" onClick={() => removeSection(s)} className="text-[11px] text-faint hover:text-ember-600 dark:hover:text-ember-400 transition">
                    remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 pt-0.5">
            <button type="button" onClick={() => setAdding(true)} className="text-[11px] text-accent hover:underline">
              + Add section
            </button>
            <button type="button" onClick={onEditRaw} className="text-[11px] text-faint hover:text-content dark:hover:text-mortar-200 transition">
              Edit JSON
            </button>
          </div>

          {/* Connections built on this source — nested here so the sections are
              defined ONCE above and each connection just carries its sync state,
              instead of a second duplicate list. */}
          <div className="pt-2 mt-1 border-t border-line/40 dark:border-slate-700/40">
            <div className="text-[9px] font-mono uppercase tracking-widest text-faint mb-1.5">Connections</div>
            {connections.length > 0 ? (
              <ul className="space-y-1.5">
                {connections.map((c) => (
                  <SyncConnectionCard key={c.id} conn={c} onChange={onChange} nested />
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-faint">
                No connection yet.{" "}
                <button type="button" onClick={onAddConnection} className="text-accent hover:underline">
                  Add a connection →
                </button>
              </p>
            )}
          </div>
        </div>
      )}
      {adding && (
        <AddSectionModal
          existingKeys={sections.map((s) => s.key)}
          instances={instances}
          onClose={() => setAdding(false)}
          onAdd={(section) => {
            setAdding(false);
            saveSections.mutate([...sections, section]);
          }}
        />
      )}
      {editing && (
        <EditSectionModal
          // `sections` IS entityTypes (narrowly typed) — pass the full object.
          section={editing as unknown as Record<string, unknown>}
          otherKeys={sections.filter((s) => s.key !== editing.key).map((s) => s.key)}
          instances={instances}
          onClose={() => setEditing(null)}
          onSave={(updated) => {
            const origKey = editing.key;
            setEditing(null);
            saveSections.mutate(
              (sections as unknown as Record<string, unknown>[]).map((s) =>
                (s as { key?: string }).key === origKey ? updated : s,
              ),
            );
          }}
        />
      )}
    </li>
  );
}

// Install a declarative sync-source CONTAINER, or (with `initial`) edit its raw
// JSON. The container is defined once — id, name, auth, base-url labels + its
// sections (entity types). Day-to-day you add SECTIONS, not re-paste this.
function InstallSourceModal({
  initial,
  onClose,
  onInstalled,
}: {
  initial?: Record<string, unknown>;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const editing = !!initial;
  const [manifest, setManifest] = useState<unknown>(initial);
  const [valid, setValid] = useState(editing);
  const install = useMutation({
    mutationFn: () => api.installSyncSource(activeSlug, manifest as Record<string, unknown>),
    onSuccess: onInstalled,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <Modal open onClose={onClose} title={editing ? "Edit source JSON" : "Install a sync source"} size="md">
      <div className="space-y-3">
        <p className="text-[11px] text-muted dark:text-slate-400">
          {editing
            ? "The whole source manifest (container + its sections). Re-installing updates it in place; connections pick up the change. To just add another thing to sync, use Add section instead."
            : "Paste a sync-source manifest (JSON) — the container that declares how to read an external API and map it into Cobblr entities. Install once, then add sections + connections. Nothing source-specific is baked into Cobblr."}
        </p>
        <JsonField
          value={manifest}
          onChange={(v, m) => {
            setValid(m.valid && !!v && typeof v === "object");
            if (m.valid) setManifest(v);
          }}
          rows={16}
          placeholder={'{\n  "id": "companion app",\n  "name": "companion app",\n  "entityTypes": [ … ]\n}'}
          hint="The full SyncSourceManifest. Grammar: docs/modules/sync-sources.md."
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || install.isPending}
            onClick={() => install.mutate()}
            className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 transition"
          >
            {install.isPending ? "Saving…" : editing ? "Save changes" : "Install"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Add ONE section (entity type) to an existing source — paste just that section's
// JSON. This is the day-to-day "sync another thing from companion app" path.
function AddSectionModal({
  existingKeys,
  instances,
  onClose,
  onAdd,
}: {
  existingKeys: string[];
  instances: ModuleInstance[];
  onClose: () => void;
  onAdd: (section: Record<string, unknown>) => void;
}) {
  const [section, setSection] = useState<unknown>(undefined);
  const [valid, setValid] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const issues = section && typeof section === "object" ? validateSection(section, instances) : { errors: [], warnings: [] };
  const submit = () => {
    const s = section as { key?: string } | null;
    if (!s || typeof s !== "object" || typeof s.key !== "string" || !s.key) {
      setErr('A section needs a "key".');
      return;
    }
    if (existingKeys.includes(s.key)) {
      setErr(`This source already has a "${s.key}" section — remove it first, or use a different key.`);
      return;
    }
    if (issues.errors.length) {
      setErr("Fix the blocking issues above first.");
      return;
    }
    onAdd(section as Record<string, unknown>);
  };
  return (
    <Modal open onClose={onClose} title="Add a section" size="md">
      <div className="space-y-3">
        <p className="text-[11px] text-muted dark:text-slate-400">
          Paste one entity-type definition (JSON) — e.g. 3D printers — to sync another kind of thing from this
          source. It's appended to the source; connections then offer it to preview + import.
        </p>
        <JsonField
          value={section}
          onChange={(v, m) => {
            setValid(m.valid && !!v && typeof v === "object");
            if (m.valid) {
              setSection(v);
              setErr(null);
            }
          }}
          rows={14}
          placeholder={
            '{\n  "key": "printers",\n  "label": "3D printers",\n  "targetKind": "machines:machine",\n  "list": { "method": "GET", "path": "/api/v1/printers", "arrayPath": "$.items" },\n  "idField": "$.id",\n  "map": { "name": "$.name" }\n}'
          }
          hint="One SyncEntityTypeManifest. Grammar: docs/modules/sync-sources.md."
        />
        <SectionIssues errors={issues.errors} warnings={issues.warnings} />
        {err && <p className="text-[11px] text-ember-600 dark:text-ember-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || issues.errors.length > 0}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 transition"
          >
            Add section
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Edit ONE section's JSON in place (mapping, references, images, targetInstance…)
// without re-pasting the whole container. Pre-filled from the current section;
// saving re-installs the source with just that entity-type replaced.
function EditSectionModal({
  section: initial,
  otherKeys,
  instances,
  onClose,
  onSave,
}: {
  section: Record<string, unknown>;
  otherKeys: string[];
  instances: ModuleInstance[];
  onClose: () => void;
  onSave: (section: Record<string, unknown>) => void;
}) {
  const [section, setSection] = useState<unknown>(initial);
  const [valid, setValid] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const label = (initial as { label?: string; key?: string }).label ?? (initial as { key?: string }).key ?? "section";
  const issues = section && typeof section === "object" ? validateSection(section, instances) : { errors: [], warnings: [] };
  const submit = () => {
    const s = section as { key?: string } | null;
    if (!s || typeof s !== "object" || typeof s.key !== "string" || !s.key) {
      setErr('A section needs a "key".');
      return;
    }
    if (otherKeys.includes(s.key)) {
      setErr(`Another section already uses the key "${s.key}".`);
      return;
    }
    if (issues.errors.length) {
      setErr("Fix the blocking issues above first.");
      return;
    }
    onSave(section as Record<string, unknown>);
  };
  return (
    <Modal open onClose={onClose} title={`Edit section — ${label}`} size="md">
      <div className="space-y-3">
        <p className="text-[11px] text-muted dark:text-slate-400">
          Edit just this section's JSON — map, references, images, targetInstance. Saving re-installs the source;
          open connections pick up the change on the next preview / sync.
        </p>
        <JsonField
          value={section}
          onChange={(v, m) => {
            setValid(m.valid && !!v && typeof v === "object");
            if (m.valid) {
              setSection(v);
              setErr(null);
            }
          }}
          rows={18}
          hint="One SyncEntityTypeManifest. Grammar: docs/modules/sync-sources.md."
        />
        <SectionIssues errors={issues.errors} warnings={issues.warnings} />
        {err && <p className="text-[11px] text-ember-600 dark:text-ember-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-line dark:border-slate-600 text-content dark:text-mortar-200">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || issues.errors.length > 0}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 transition"
          >
            Save section
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SyncConnectionCard({ conn, onChange, nested }: { conn: SyncConnection; onChange: () => void; nested?: boolean }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ["sync-connection", activeSlug, conn.id],
    queryFn: () => api.getSyncConnection(activeSlug, conn.id),
    enabled: !!activeSlug,
    refetchInterval: 10_000, // pick up sync status as the worker runs
  });
  const detail = detailQ.data;

  const test = useMutation({
    mutationFn: () => api.testSyncConnection(activeSlug, conn.id),
    onSuccess: (r) => (r.ok ? toast.success("Connection OK") : toast.error(r.error ?? "Test failed")),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const configure = useMutation({
    mutationFn: (v: { entityType: string; enabled: boolean }) =>
      api.configureSync(activeSlug, conn.id, v.entityType, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const run = useMutation({
    mutationFn: (entityType: string) => api.runSync(activeSlug, conn.id, entityType),
    onSuccess: (r) => {
      if (r.ok && r.result) {
        const { created, updated, tombstoned } = r.result;
        toast.success(`Synced — ${created} new, ${updated} updated, ${tombstoned} removed`);
        setPreviewKey(null); // sync was launched from the preview — close it
      } else toast.error(r.error ?? "Sync failed");
      void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const del = useMutation({
    mutationFn: () => api.deleteSyncConnection(activeSlug, conn.id),
    onSuccess: () => {
      toast.success("Connection removed");
      onChange();
    },
  });

  // First-import preview/approve flow (per entity type).
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const previewQ = useQuery({
    queryKey: ["sync-preview", activeSlug, conn.id, previewKey],
    queryFn: () => api.previewSyncImport(activeSlug, conn.id, previewKey!),
    enabled: !!activeSlug && !!previewKey,
  });
  const doImport = useMutation({
    mutationFn: (entityType: string) => api.runSyncImport(activeSlug, conn.id, entityType),
    onSuccess: (r) => {
      if (r.ok && r.result) {
        const { created, linked, updated } = r.result;
        toast.success(`Imported — ${created} created, ${linked} merged, ${updated} updated. Live sync is on.`);
        setPreviewKey(null);
        void qc.invalidateQueries({ queryKey: ["sync-connection", activeSlug, conn.id] });
      } else toast.error(r.error ?? "Import failed");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const previewLabel = detail?.entity_types?.find((t) => t.key === previewKey)?.label ?? previewKey ?? "";
  // A live (already-imported) type previews-then-syncs; a new one previews-then-imports.
  const previewApproved = !!detail?.syncs?.find((s) => s.entity_type === previewKey)?.import_approved_at;

  const webhookUrl = detail?.webhook_path ? `${window.location.origin}${detail.webhook_path}` : null;

  return (
    <li
      className={
        nested
          ? "rounded border border-line/50 dark:border-slate-700/50 bg-subtle/60 dark:bg-slate-800/40 p-2.5 space-y-2"
          : "rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-3 space-y-2.5"
      }
    >
      <div className="flex items-center gap-2">
        {/* Nested under its source card → the source already shows the name, so
            lead with the base URL (what differs between connections). */}
        {!nested && <span className="text-sm font-medium text-content dark:text-mortar-100">{conn.label}</span>}
        {!nested && <span className="text-[10px] font-mono text-faint">{conn.connector_id}</span>}
        <span className="text-[11px] font-mono text-muted dark:text-slate-400 truncate">{conn.config.base_url}</span>
        <div className="flex-1" />
        <button onClick={() => test.mutate()} disabled={test.isPending} className="text-[11px] text-accent hover:underline">
          {test.isPending ? "Testing…" : "Test"}
        </button>
        <button
          onClick={async () => {
            if (await confirm({ title: "Remove connection?", message: "Mirrored records stay; the link stops." })) del.mutate();
          }}
          className="text-[11px] text-ember-600 dark:text-ember-400 hover:underline"
        >
          Remove
        </button>
      </div>

      {/* Per-entity-type sync rows */}
      <div className="space-y-1.5">
        {(detail?.entity_types ?? []).map((t) => {
          const state = detail?.syncs?.find((s) => s.entity_type === t.key);
          const approved = !!state?.import_approved_at;
          const enabled = !!state?.enabled;
          // Before the first import is approved: preview-then-import. After: the
          // live toggle + sync-now.
          if (!approved) {
            return (
              <div key={t.key} className="flex items-center gap-2 text-xs">
                <span className="text-content dark:text-mortar-100">{t.label}</span>
                <span className="text-[9px] font-mono uppercase tracking-wider text-faint dark:text-slate-500 border border-line dark:border-slate-700 rounded px-1 py-px">
                  not imported
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setPreviewKey(t.key)}
                  className="text-[11px] text-accent hover:underline shrink-0"
                >
                  Preview import →
                </button>
              </div>
            );
          }
          return (
            <div key={t.key} className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => configure.mutate({ entityType: t.key, enabled: e.target.checked })}
                />
                <span className="text-content dark:text-mortar-100">{t.label}</span>
                <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  {enabled ? "live" : "paused"}
                </span>
              </label>
              <div className="flex-1" />
              {state?.last_run_at && (
                <span className={`text-[10px] ${state.last_status === "error" ? "text-ember-500" : "text-faint"}`}>
                  {state.last_status === "error"
                    ? `error: ${state.last_error ?? "?"}`
                    : `${state.last_synced_count ?? 0} synced`}
                </span>
              )}
              <button
                onClick={() => setPreviewKey(t.key)}
                className="text-[11px] text-accent hover:underline shrink-0"
              >
                Preview &amp; sync →
              </button>
            </div>
          );
        })}
      </div>

      {/* The live webhook URL — paste into the source system. */}
      {webhookUrl && (
        <div className="text-[10px] text-faint">
          <span className="uppercase tracking-widest">Live webhook</span>{" "}
          <code className="font-mono text-muted dark:text-slate-400 break-all">{webhookUrl}</code>{" "}
          <button onClick={() => void navigator.clipboard.writeText(webhookUrl).then(() => toast.success("Copied"))} className="text-accent hover:underline">
            copy
          </button>
        </div>
      )}

      {/* Preview before committing: what a pull WOULD do — for the first import
          AND for every later re-sync, so a mapping edit is reviewed before it writes. */}
      {previewKey && (
        <Modal open onClose={() => setPreviewKey(null)} title={`${previewApproved ? "Sync" : "Import"} preview — ${previewLabel}`} size="md">
          {previewQ.isFetching && !previewQ.data && (
            <div className="text-sm text-muted dark:text-slate-400 py-6 text-center">Pulling from the source…</div>
          )}
          {previewQ.data && !previewQ.data.ok && (
            <div className="text-sm text-ember-600 dark:text-ember-400 py-4">Preview failed: {previewQ.data.error}</div>
          )}
          {previewQ.data?.plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {(["create", "link", "update", "unchanged", "delete"] as const)
                  .filter((a) => previewQ.data!.plan!.counts[a] > 0)
                  .map((a) => (
                    <span key={a} className={`text-[11px] px-2 py-0.5 rounded border ${ACTION_BADGE[a]}`}>
                      {previewQ.data!.plan!.counts[a]} {ACTION_LABEL[a]}
                    </span>
                  ))}
                {previewQ.data.plan.counts.total === 0 && (
                  <span className="text-[11px] text-muted dark:text-slate-400">Nothing to {previewApproved ? "sync" : "import"} — the source is empty.</span>
                )}
              </div>
              <div className="max-h-72 overflow-auto rounded-lg border border-line dark:border-slate-700">
                {previewQ.data.plan.items.map((it) => (
                  <PlanRow key={`${it.action}:${it.externalId}`} it={it} />
                ))}
              </div>
              <p className="text-[11px] text-muted dark:text-slate-400">
                <strong>Merge</strong> links a source record to a same-name item already in this workspace instead of
                duplicating it.{!previewApproved && " After import, this entity type keeps syncing live."}
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setPreviewKey(null)}
                  className="text-xs px-3 py-1.5 rounded border border-line dark:border-slate-700 text-muted hover:text-content"
                >
                  Cancel
                </button>
                <button
                  onClick={() => (previewApproved ? run.mutate(previewKey) : doImport.mutate(previewKey))}
                  disabled={doImport.isPending || run.isPending || previewQ.data.plan.counts.total === 0}
                  className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-60"
                >
                  {previewApproved
                    ? run.isPending
                      ? "Syncing…"
                      : "Apply sync"
                    : doImport.isPending
                      ? "Importing…"
                      : "Approve & import"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </li>
  );
}

function AddSyncConnectionModal({
  connectors,
  onClose,
  onCreated,
}: {
  connectors: SyncConnectorDef[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const [label, setLabel] = useState(connectors[0]?.label ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [credsJsonMode, setCredsJsonMode] = useState(false);
  const [credsValid, setCredsValid] = useState(true);
  const [transport, setTransport] = useState<"direct" | "edge">("direct");
  const [bridge, setBridge] = useState<string | null>(null);

  const def = connectors.find((c) => c.id === connectorId);
  // A JSON Schema for the connector's credentials, derived from its descriptor —
  // so the "paste JSON" mode validates shape (right keys, all strings) inline.
  const credsSchema = def
    ? {
        type: "object",
        properties: Object.fromEntries(Object.keys(def.credentials).map((k) => [k, { type: "string" }])),
        required: Object.keys(def.credentials),
        additionalProperties: false,
      }
    : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.createSyncConnection(activeSlug, {
        connector_id: connectorId,
        label: label.trim() || (def?.label ?? "Connection"),
        base_url: baseUrl.trim(),
        credentials: creds,
        transport,
        bridge: transport === "edge" && bridge && bridge.trim() ? bridge.trim() : null,
      }),
    onSuccess: onCreated,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Add a sync connection" size="sm">
      <div className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Connector</span>
          <select
            value={connectorId}
            onChange={(e) => {
              setConnectorId(e.target.value);
              const d = connectors.find((c) => c.id === e.target.value);
              if (d && !label) setLabel(d.label);
            }}
            className="input"
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="input" placeholder={def?.label} />
        </label>
        {def && Object.entries(def.config).map(([key, cfg]) => (
          <label key={key} className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">{cfg.label}</span>
            <input
              value={key === "base_url" ? baseUrl : ""}
              onChange={(e) => key === "base_url" && setBaseUrl(e.target.value)}
              className="input font-mono"
              placeholder={cfg.placeholder}
            />
          </label>
        ))}
        {/* Transport: direct (cloud fetches the URL) vs edge (a local bridge does). */}
        <div>
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">How does Cobblr reach it?</span>
          <div className="flex gap-2">
            {(["direct", "edge"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTransport(t)}
                className={
                  "text-xs px-2.5 py-1.5 rounded border transition " +
                  (transport === t
                    ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/40 text-content dark:text-mortar-100"
                    : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content")
                }
              >
                {t === "direct" ? "Direct" : "Via edge bridge"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
            {transport === "direct"
              ? "The cloud fetches the URL itself. On the hosted service this only works for public URLs — a LAN address won't be reachable."
              : "A local edge bridge on your network fetches the URL and relays it up — the way to connect a LAN source (like companion app) to hosted Cobblr."}
          </p>
          {transport === "edge" && (
            <div className="mt-2">
              <BridgePicker slug={activeSlug} value={bridge} onChange={setBridge} />
            </div>
          )}
        </div>
        {def && Object.keys(def.credentials).length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint">Credentials</span>
              <button
                type="button"
                onClick={() => setCredsJsonMode((m) => !m)}
                className="text-[10px] text-accent hover:underline"
              >
                {credsJsonMode ? "← fields" : "paste JSON →"}
              </button>
            </div>
            {credsJsonMode ? (
              <JsonField
                value={creds}
                onChange={(v, m) => {
                  setCredsValid(m.valid);
                  if (m.valid) setCreds((v as Record<string, string>) ?? {});
                }}
                schema={credsSchema}
                rows={5}
                placeholder={`{\n  ${Object.keys(def.credentials).map((k) => `"${k}": ""`).join(",\n  ")}\n}`}
                hint="Paste the credentials object — validated against the connector's shape."
              />
            ) : (
              <div className="space-y-2">
                {Object.entries(def.credentials).map(([key, c]) => (
                  <label key={key} className="block">
                    <span className="block text-[10px] font-mono text-faint mb-0.5">{c.label}</span>
                    <input
                      type={c.secret ? "password" : "text"}
                      value={creds[key] ?? ""}
                      onChange={(e) => setCreds((p) => ({ ...p, [key]: e.target.value }))}
                      className="input font-mono"
                      autoComplete="off"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs text-muted dark:text-slate-400">Cancel</button>
          <button
            onClick={() => create.mutate()}
            disabled={!connectorId || !baseUrl.trim() || (credsJsonMode && !credsValid) || create.isPending}
            className="text-xs px-3 py-1.5 rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 transition"
          >
            {create.isPending ? "Adding…" : "Add connection"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// /configuration/scan-rules — the external QR resolver redirect table.
//
// Teach the scanner to read FOREIGN QR labels (an external-system URL, a bare Homebox
// number, …) and resolve them to the matching Cobblr item, so labels printed by
// another system keep working without a reprint. A rule is match → extract →
// resolve; on a hit the scan behaves exactly like a native one. Opt-in: with no
// rules the scanner is unchanged.
//
// See docs/design-decisions/external-qr-resolver.md.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Pencil, Trash2, ArrowRight, ClipboardPaste } from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type ScanQrRule, type ScanResolveOutcome } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

type RuleDraft = Omit<ScanQrRule, "id" | "created_at" | "updated_at">;

const TRANSFORMS = ["trim", "strip_leading_zeros", "lowercase"] as const;

function Pill({ text, tone = "slate" }: { text: string; tone?: "slate" | "ember" }) {
  const cls =
    tone === "ember"
      ? "bg-ember-100 text-ember-700 dark:bg-ember-950 dark:text-ember-300"
      : "bg-mortar-100 text-muted dark:bg-slate-800 dark:text-mortar-200";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${cls}`}>{text}</span>;
}

function emptyDraft(): RuleDraft {
  return {
    name: "",
    enabled: true,
    position: 0,
    // Default to the "base URL + path children" model — one host, several kinds.
    match: { type: "url_base", value: "" },
    extract: {},
    resolve: { key_field: "ext_id", type_map: {} },
  };
}

export function ScanRulesPage() {
  usePageTitle("External QR rules");
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = activeOrg?.role === "owner" || activeOrg?.role === "admin";

  const list = useQuery({
    queryKey: ["scan-qr-rules", activeSlug],
    queryFn: () => api.scanQrRules(activeSlug),
    enabled: !!activeSlug,
  });
  const rules = useMemo(() => list.data?.rules ?? [], [list.data]);

  const [editing, setEditing] = useState<ScanQrRule | "new" | null>(null);
  const [pasting, setPasting] = useState(false);

  const save = useMutation({
    mutationFn: (d: { id?: string; body: RuleDraft }) =>
      d.id ? api.updateScanQrRule(activeSlug, d.id, d.body) : api.createScanQrRule(activeSlug, d.body),
    onSuccess: () => {
      toast.success("Rule saved.");
      setEditing(null);
      setPasting(false);
      void qc.invalidateQueries({ queryKey: ["scan-qr-rules", activeSlug] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't save the rule."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteScanQrRule(activeSlug, id),
    onSuccess: () => {
      toast.success("Rule deleted.");
      void qc.invalidateQueries({ queryKey: ["scan-qr-rules", activeSlug] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const toggle = useMutation({
    mutationFn: (r: ScanQrRule) => api.updateScanQrRule(activeSlug, r.id, { enabled: !r.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-qr-rules", activeSlug] }),
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update."),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = rules.findIndex((r) => r.id === active.id);
    const to = rules.findIndex((r) => r.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(rules, from, to);
    qc.setQueryData(["scan-qr-rules", activeSlug], { rules: next });
    api.reorderScanQrRules(activeSlug, next.map((r) => r.id)).catch(() => {
      toast.error("Couldn't save the new order.");
      void qc.invalidateQueries({ queryKey: ["scan-qr-rules", activeSlug] });
    });
  }

  async function onDelete(r: ScanQrRule) {
    if (await confirm({ title: `Delete “${r.name}”?`, message: "Labels matching this rule will stop resolving.", confirmLabel: "Delete", destructive: true })) {
      remove.mutate(r.id);
    }
  }

  return (
    <div className="space-y-6">

      <TestBox slug={activeSlug} hasRules={rules.some((r) => r.enabled)} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-mono uppercase tracking-widest text-faint dark:text-slate-500">
            Rules {rules.length > 0 && `(${rules.length})`}
          </h2>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPasting(true)}
                title="Create a rule by pasting its JSON"
                className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800"
              >
                <ClipboardPaste size={15} /> Paste JSON
              </button>
              <button
                onClick={() => setEditing("new")}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cobble-700"
              >
                <Plus size={15} /> Add rule
              </button>
            </div>
          )}
        </div>

        {list.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted dark:text-mortar-300">
            No rules yet. {isAdmin ? "Add one to teach the scanner a foreign label format." : "An admin can add rules."}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {rules.map((r) => (
                  <RuleCard
                    key={r.id}
                    rule={r}
                    isAdmin={isAdmin}
                    onEdit={() => setEditing(r)}
                    onDelete={() => void onDelete(r)}
                    onToggle={() => toggle.mutate(r)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </section>

      {editing && (
        <RuleModal
          rule={editing === "new" ? null : editing}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={(body) => save.mutate({ id: editing === "new" ? undefined : editing.id, body })}
        />
      )}
      {pasting && (
        <PasteRuleModal
          saving={save.isPending}
          onClose={() => setPasting(false)}
          onCreate={(body) => save.mutate({ body })}
        />
      )}
    </div>
  );
}

// ─────────────────────── paste a rule as JSON ───────────────────────
// Faster than the form when someone hands you a ready-made rule (a support
// answer, a docs snippet). Parses leniently, validates the essentials client-
// side, and lets the server schema be the final word.
const PASTE_EXAMPLE = JSON.stringify(
  {
    name: "Storage stickers",
    match: { type: "url_prefix", value: "https://workshop.example.com/storage/" },
    resolve: { key_field: "ext_id", target_kind: "core-locations:location" },
  },
  null,
  2,
);

function PasteRuleModal({
  saving,
  onClose,
  onCreate,
}: {
  saving: boolean;
  onClose: () => void;
  onCreate: (body: RuleDraft) => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setErr("That isn't valid JSON — check for a stray comma or quote.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setErr("Expected a single rule object { name, match, resolve }.");
      return;
    }
    const p = parsed as Record<string, unknown>;
    if (!p.name || !p.match || !p.resolve) {
      setErr("A rule needs at least name, match, and resolve.");
      return;
    }
    // `extract` is optional for the author but required by the schema → default {}.
    onCreate({ enabled: true, ...(p as object), extract: (p.extract as object) ?? {} } as RuleDraft);
  }

  return (
    <Modal open onClose={onClose} title="Paste a rule" subtitle="External QR resolver" size="lg">
      <div className="space-y-3">
        <p className="text-sm text-muted dark:text-mortar-300">
          Paste a rule as JSON - <code>name</code>, <code>match</code>, <code>resolve</code> (optional{" "}
          <code>extract</code>, <code>enabled</code>, <code>position</code>). Quicker than filling the form when
          you've been handed a ready rule.
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setErr(null);
          }}
          rows={12}
          spellCheck={false}
          placeholder={PASTE_EXAMPLE}
          className="w-full rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 p-2 font-mono text-xs text-content dark:text-mortar-100"
        />
        {err && <p className="text-xs text-ember-600">{err}</p>}
        <button type="button" onClick={() => setText(PASTE_EXAMPLE)} className="text-xs text-accent hover:underline">
          Fill with an example
        </button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-content dark:hover:text-mortar-100">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={saving || !text.trim()}
          className="rounded-md bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create rule"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────── rule card ───────────────────────────

function RuleCard({
  rule,
  isAdmin,
  onEdit,
  onDelete,
  onToggle,
}: {
  rule: ScanQrRule;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });
  const target = rule.resolve.target_kind || Object.values(rule.resolve.type_map ?? {}).join(" / ") || "—";
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`rounded-md border bg-surface dark:bg-slate-900 ${rule.enabled ? "border-line dark:border-slate-700" : "border-dashed border-line dark:border-slate-700 opacity-70"}`}
    >
      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-line dark:border-slate-800 px-2 py-1.5">
        {isAdmin && (
          <button {...attributes} {...listeners} className="cursor-grab text-faint hover:text-muted" aria-label="Reorder">
            <GripVertical size={16} />
          </button>
        )}
        <span className="font-medium text-content dark:text-mortar-100 truncate">{rule.name}</span>
        <Pill text={rule.match.type} tone="slate" />
        {!rule.enabled && <Pill text="disabled" tone="ember" />}
        <div className="ml-auto flex items-center gap-1">
          {isAdmin && (
            <label className="flex items-center gap-1 text-[11px] text-muted mr-1 select-none">
              <input type="checkbox" checked={rule.enabled} onChange={onToggle} className="accent-cobble-500" />
              on
            </label>
          )}
          {isAdmin && (
            <>
              <button onClick={onEdit} className="rounded p-1 text-muted hover:bg-mortar-100 dark:hover:bg-slate-800" aria-label="Edit">
                <Pencil size={14} />
              </button>
              <button onClick={onDelete} className="rounded p-1 text-muted hover:bg-mortar-100 dark:hover:bg-slate-800" aria-label="Delete">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      {/* nested sub-boxes: match → resolve */}
      <div className="flex flex-wrap items-center gap-2 p-2 text-xs">
        <SubBox label="match">
          <code className="text-content dark:text-mortar-200">{rule.match.value || rule.match.type}</code>
        </SubBox>
        <ArrowRight size={14} className="text-faint" />
        <SubBox label="resolve">
          <code className="text-content dark:text-mortar-200">{target}</code>
          <span className="text-faint"> · by </span>
          <code className="text-content dark:text-mortar-200">{rule.resolve.key_field || "—"}</code>
        </SubBox>
      </div>
    </div>
  );
}

function SubBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-800 bg-mortar-50 dark:bg-slate-950 px-2 py-1">
      <span className="text-[9px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{label}</span>
      <span>{children}</span>
    </span>
  );
}

// ─────────────────────────── test box ───────────────────────────

function TestBox({ slug, hasRules }: { slug: string; hasRules: boolean }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<ScanResolveOutcome | null>(null);
  const test = useMutation({
    mutationFn: () => api.scanResolveExternal(slug, value.trim()),
    onSuccess: (out) => setResult(out),
    onError: () => setResult(null),
  });
  return (
    <section className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        Test a payload
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && test.mutate()}
          placeholder="Paste a scanned URL or number (tests your saved rules)"
          className="input flex-1"
        />
        <button
          onClick={() => value.trim() && test.mutate()}
          disabled={!value.trim() || test.isPending}
          className="rounded-md border border-line dark:border-slate-700 px-3 py-1.5 text-sm text-content dark:text-mortar-100 hover:bg-mortar-100 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          Test
        </button>
      </div>
      {!hasRules && (
        <p className="text-xs text-muted">No enabled rules - a scan like this would fall through to the normal routine.</p>
      )}
      {result && (
        <div className="text-xs">
          {result.outcome === "resolved" ? (
            <div className="flex items-center gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10 p-2.5">
              <span className="text-base leading-none text-emerald-600 dark:text-emerald-400">✓</span>
              <div className="min-w-0 flex-1">
                <Link
                  to={result.detail_path}
                  className="block truncate font-medium text-content dark:text-mortar-100 underline-offset-2 hover:text-accent hover:underline"
                >
                  {result.entity_label}
                </Link>
                <div className="text-[11px] text-muted dark:text-slate-400">
                  matched by <span className="text-content dark:text-mortar-200">{result.rule_name}</span> ·{" "}
                  <code className="text-faint">{result.entity_kind}</code>
                </div>
              </div>
              <Link
                to={result.detail_path}
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline"
              >
                Open <ArrowRight size={13} />
              </Link>
            </div>
          ) : result.outcome === "recognized_no_match" ? (
            <p className="text-amber-600 dark:text-amber-400">
              Recognised by <span className="font-medium">{result.rule_name}</span> (key <code>{result.key}</code>),
              but no {result.target_kind ?? "item"} here matches it yet.
            </p>
          ) : (
            <p className="text-muted">No rule matched - this scan would go through the normal barcode/identify routine.</p>
          )}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────── edit modal ───────────────────────────

function RuleModal({
  rule,
  saving,
  onClose,
  onSave,
}: {
  rule: ScanQrRule | null;
  saving: boolean;
  onClose: () => void;
  onSave: (body: RuleDraft) => void;
}) {
  const [d, setD] = useState<RuleDraft>(() =>
    rule ? { name: rule.name, enabled: rule.enabled, position: rule.position, match: rule.match, extract: rule.extract, resolve: rule.resolve } : emptyDraft(),
  );
  const set = (patch: Partial<RuleDraft>) => setD((p) => ({ ...p, ...patch }));
  const isBase = d.match.type === "url_base";
  const isRegex = d.match.type === "regex";
  const base = (d.match.value ?? "").replace(/\/+$/, "") || "https://example.com";
  const canSave =
    d.name.trim() &&
    d.resolve.key_field.trim() &&
    (isBase
      ? Object.keys(d.resolve.type_map ?? {}).length > 0
      : d.resolve.target_kind?.trim() || Object.keys(d.resolve.type_map ?? {}).length > 0) &&
    (d.match.type === "bare" || d.match.value?.trim());

  // Form ↔ JSON: editing the JSON keeps the form draft in sync on every valid
  // parse, so you can flip between them and Save from either.
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  function showJson() {
    setJsonText(JSON.stringify(d, null, 2));
    setJsonErr(null);
    setMode("json");
  }
  function editJson(t: string) {
    setJsonText(t);
    try {
      const parsed = JSON.parse(t);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      setD(parsed as RuleDraft);
      setJsonErr(null);
    } catch {
      setJsonErr("Invalid JSON — the form keeps the last valid version.");
    }
  }

  const tabCls = (on: boolean) =>
    "rounded px-2.5 py-1 " + (on ? "bg-surface dark:bg-slate-700 text-content dark:text-mortar-100 shadow-sm" : "text-muted hover:text-content dark:hover:text-mortar-100");

  return (
    <Modal open onClose={onClose} title={rule ? "Edit rule" : "New rule"} subtitle="External QR resolver" size="lg">
      <div className="space-y-5">
        <div className="flex w-fit gap-0.5 rounded-md bg-subtle dark:bg-slate-800 p-0.5 text-xs">
          <button type="button" onClick={() => setMode("form")} className={tabCls(mode === "form")}>Form</button>
          <button type="button" onClick={showJson} className={tabCls(mode === "json")}>JSON</button>
        </div>
        {mode === "json" ? (
          <div className="space-y-1">
            <textarea value={jsonText} onChange={(e) => editJson(e.target.value)} rows={16} spellCheck={false} className="input w-full font-mono text-xs" />
            {jsonErr ? (
              <p className="text-xs text-ember-600">{jsonErr}</p>
            ) : (
              <p className="text-xs text-muted dark:text-mortar-300">Edit the rule directly - name, match, extract, resolve (+ optional enabled, position).</p>
            )}
          </div>
        ) : (
        <>
        <Field label="Name">
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Storage labels" className="input" autoFocus />
        </Field>

        {/* MATCH */}
        <Section title="Match - recognise the label format">
          <Field label="Type">
            <select value={d.match.type} onChange={(e) => set({ match: { type: e.target.value as ScanQrRule["match"]["type"], value: d.match.value } })} className="input">
              <option value="url_base">Base URL + path children (one host, several kinds)</option>
              <option value="url_prefix">URL prefix (one kind)</option>
              <option value="regex">Regex (advanced)</option>
              <option value="bare">Bare value (a plain number/text)</option>
            </select>
          </Field>
          <Field label={isBase ? "Base URL" : d.match.type === "bare" ? "Guard pattern (optional regex the value must match)" : isRegex ? "Regex" : "URL prefix"}>
            <input
              value={d.match.value ?? ""}
              onChange={(e) => set({ match: { type: d.match.type, value: e.target.value } })}
              placeholder={isBase ? "https://example.com" : d.match.type === "url_prefix" ? "https://example.com/inventory/" : isRegex ? "^https?://example\\.com/(?<type>[^/]+)/(?<key>[^/]+)" : "^\\d+$"}
              className="input font-mono text-sm"
            />
          </Field>
          {isBase && (
            <p className="text-xs text-muted dark:text-mortar-300">
              A label like <code className="text-content dark:text-mortar-200">{base}/printers/4</code> → the segment <code className="text-content dark:text-mortar-200">printers</code> picks the kind, <code className="text-content dark:text-mortar-200">4</code> is the key.
            </p>
          )}
          {(d.match.type === "url_prefix" || d.match.type === "bare") && (
            <Field label="Transforms on the key (optional)">
              <div className="flex flex-wrap gap-3">
                {TRANSFORMS.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm text-content dark:text-mortar-200">
                    <input
                      type="checkbox"
                      checked={(d.extract.transform ?? []).includes(t)}
                      onChange={(e) => {
                        const cur = new Set(d.extract.transform ?? []);
                        if (e.target.checked) cur.add(t);
                        else cur.delete(t);
                        set({ extract: { ...d.extract, transform: [...cur] } });
                      }}
                      className="accent-cobble-500"
                    />
                    {t}
                  </label>
                ))}
              </div>
            </Field>
          )}
        </Section>

        {/* EXTRACT — regex only (url_base/url_prefix derive the key by position) */}
        {isRegex && (
          <Section title="Extract - pull the key from the payload">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Key group (name or index)">
                <input value={String(d.extract.group ?? "")} onChange={(e) => set({ extract: { ...d.extract, group: e.target.value || undefined } })} placeholder="key" className="input" />
              </Field>
              <Field label="Type group (optional → type_map)">
                <input value={String(d.extract.type_from ?? "")} onChange={(e) => set({ extract: { ...d.extract, type_from: e.target.value || undefined } })} placeholder="type" className="input" />
              </Field>
            </div>
          </Section>
        )}

        {/* RESOLVE */}
        {isBase ? (
          <Section title="Children - one /segment/ → kind row per entity type">
            <ChildrenEditor base={base} value={d.resolve.type_map ?? {}} onChange={(m) => set({ resolve: { ...d.resolve, type_map: m } })} />
            <Field label="Key field - the entity field holding the foreign id (a native column or metadata key)">
              <input value={d.resolve.key_field} onChange={(e) => set({ resolve: { ...d.resolve, key_field: e.target.value } })} placeholder="ext_id" className="input font-mono text-sm" />
            </Field>
          </Section>
        ) : (
          <Section title="Resolve - find the Cobblr entity">
            <Field label="Target kind">
              <input value={d.resolve.target_kind ?? ""} onChange={(e) => set({ resolve: { ...d.resolve, target_kind: e.target.value } })} placeholder="inventory:part" className="input font-mono text-sm" />
            </Field>
            <TypeMapEditor value={d.resolve.type_map ?? {}} onChange={(m) => set({ resolve: { ...d.resolve, type_map: Object.keys(m).length ? m : undefined } })} />
            <Field label="Key field - the entity field holding the foreign key (native column or metadata key)">
              <input value={d.resolve.key_field} onChange={(e) => set({ resolve: { ...d.resolve, key_field: e.target.value } })} placeholder="ext_id" className="input font-mono text-sm" />
            </Field>
          </Section>
        )}
        </>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-line dark:border-slate-700 px-4 py-2 text-sm text-content dark:text-mortar-100 hover:bg-mortar-100 dark:hover:bg-slate-800">
          Cancel
        </button>
        <button onClick={() => onSave(d)} disabled={!canSave || saving || (mode === "json" && !!jsonErr)} className="rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-50">
          {saving ? "Saving…" : "Save rule"}
        </button>
      </div>
    </Modal>
  );
}

function TypeMapEditor({ value, onChange }: { value: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  return (
    <Field label="Type map (optional - extracted type → kind, for /<type>/<slug> URLs)">
      <div className="space-y-1.5">
        {rows.map(([t, k], i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={t} onChange={(e) => { const m = { ...value }; delete m[t]; if (e.target.value) m[e.target.value] = k; onChange(m); }} placeholder="printers" className="input font-mono text-sm flex-1" />
            <ArrowRight size={14} className="text-faint" />
            <input value={k} onChange={(e) => onChange({ ...value, [t]: e.target.value })} placeholder="machines:machine" className="input font-mono text-sm flex-1" />
            <button onClick={() => { const m = { ...value }; delete m[t]; onChange(m); }} className="rounded p-1 text-muted hover:bg-mortar-100 dark:hover:bg-slate-800"><Trash2 size={13} /></button>
          </div>
        ))}
        <button onClick={() => onChange({ ...value, "": "" })} className="text-xs text-cobble-600 hover:underline">+ add mapping</button>
      </div>
    </Field>
  );
}

const COMMON_KINDS = ["machines:machine", "inventory:part", "assets:asset", "core-locations:location"];

// The base+children editor — one row per `/segment/ → kind` child under the base
// host (the base-host model). Stored as the rule's resolve.type_map.
function ChildrenEditor({ base, value, onChange }: { base: string; value: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const host = base.replace(/^https?:\/\//, "").split("/")[0] || "example.com";
  const rows = Object.entries(value);
  return (
    <div className="space-y-1.5">
      <datalist id="qr-target-kinds">
        {COMMON_KINDS.map((k) => <option key={k} value={k} />)}
      </datalist>
      {rows.map(([seg, kind], i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-faint dark:text-slate-500 whitespace-nowrap">{host}/</span>
          <input value={seg} onChange={(e) => { const m = { ...value }; delete m[seg]; m[e.target.value] = kind; onChange(m); }} placeholder="printers" className="input font-mono text-sm w-28" />
          <span className="text-[11px] font-mono text-faint dark:text-slate-500">/</span>
          <ArrowRight size={14} className="text-faint shrink-0" />
          <input list="qr-target-kinds" value={kind} onChange={(e) => onChange({ ...value, [seg]: e.target.value })} placeholder="machines:machine" className="input font-mono text-sm flex-1" />
          <button onClick={() => { const m = { ...value }; delete m[seg]; onChange(m); }} className="rounded p-1 text-muted hover:bg-mortar-100 dark:hover:bg-slate-800"><Trash2 size={13} /></button>
        </div>
      ))}
      <button onClick={() => onChange({ ...value, "": "" })} className="text-xs text-cobble-600 hover:underline">+ add child</button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-md border border-line dark:border-slate-700 p-3 space-y-3">
      <legend className="px-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-muted dark:text-mortar-300 mb-1">{label}</span>
      {children}
    </label>
  );
}

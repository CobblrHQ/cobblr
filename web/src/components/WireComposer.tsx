// The no-code wire composer — a guided "When X → Do Y" builder that emits the
// same createBinding payload as the old flat form. Pure logic (RRULE, tokens,
// preview) lives in ../lib/wire-composer; this is the UI shell.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Check } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type PlatformBinding } from "../lib/api";
import {
  TRIGGER_OPTIONS,
  WEEKDAYS,
  DEFAULT_RECURRENCE,
  buildRRule,
  parseRRule,
  describeWire,
  insertToken,
  type TriggerType,
  type Recurrence,
  type WireTarget,
} from "../lib/wire-composer";

const L = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

// `editing` switches the composer to edit-an-existing-wire mode: state prefills
// from the binding and Save PATCHes it (preserving id + firing history) instead
// of creating a new one. Mount with key={wire.id} so the prefill re-runs per wire.
export function WireComposer({
  slug,
  onCreated,
  editing,
  onCancel,
}: {
  slug: string;
  onCreated: () => void;
  editing?: PlatformBinding | null;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ed = editing ?? null;

  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), enabled: !!slug });
  const wireEvents = useQuery({ queryKey: ["wire-events", slug], queryFn: () => api.listWireEvents(slug), enabled: !!slug });

  const [triggerType, setTriggerType] = useState<TriggerType>(ed?.trigger_type ?? "on-create");
  const [triggerEvent, setTriggerEvent] = useState(ed?.trigger_event ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(
    ed?.trigger_schedule ? parseRRule(ed.trigger_schedule) : DEFAULT_RECURRENCE,
  );
  const [sourceKind, setSourceKind] = useState(ed?.source_kind ?? "");
  const [actionId, setActionId] = useState(ed?.action_id ?? "");
  const [template, setTemplate] = useState(ed?.template ?? "");
  const [target, setTarget] = useState<WireTarget>(ed?.target && ed.target !== "self" ? ed.target : "self");
  const [showTarget, setShowTarget] = useState(!!(ed?.target && ed.target !== "self"));
  // B7 — conditions: {all:[{path,op,value}]} evaluated per firing against the
  // same data templates see (target fields + event.*). AND-joined; empty = fire always.
  type Cond = { path: string; op: string; value: string };
  const initialConds: Cond[] = (() => {
    const f = ed?.filter as { all?: Array<{ path?: string; op?: string; value?: unknown }> } | null | undefined;
    return Array.isArray(f?.all)
      ? f!.all!.map((c) => ({ path: String(c.path ?? ""), op: String(c.op ?? "eq"), value: c.value === undefined ? "" : String(c.value) }))
      : [];
  })();
  const [conditions, setConditions] = useState<Cond[]>(initialConds);
  const [showConds, setShowConds] = useState(initialConds.length > 0);
  const COND_OPS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "not_contains", "empty", "not_empty"] as const;
  const builtFilter = (): { all: Array<{ path: string; op: string; value?: string }> } | null => {
    const rows = conditions
      .filter((c) => c.path.trim() !== "")
      .map((c) => (c.op === "empty" || c.op === "not_empty" ? { path: c.path.trim(), op: c.op } : { path: c.path.trim(), op: c.op, value: c.value }));
    return rows.length > 0 ? { all: rows } : null;
  };
  const [err, setErr] = useState<string | null>(null);
  // Structured action args (per the action's argsSchema): each value is a
  // literal or a {{token}}. The field picker inserts into whichever field
  // (an arg input or the template) is focused.
  const [args, setArgs] = useState<Record<string, string>>(
    ed?.args && typeof ed.args === "object"
      ? Object.fromEntries(Object.entries(ed.args as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {},
  );
  const activeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const activeField = useRef<string>("__template__"); // "__template__" or an arg name
  const templateRef = useRef<HTMLTextAreaElement>(null);

  function insertIntoActive(fieldName: string) {
    const el = activeRef.current;
    const caret = el?.selectionStart ?? undefined;
    if (activeField.current === "__template__") {
      setTemplate((t) => insertToken(t, fieldName, caret));
    } else {
      const arg = activeField.current;
      setArgs((a) => ({ ...a, [arg]: insertToken(a[arg] ?? "", fieldName, caret) }));
    }
    el?.focus();
  }

  const actionsForKind = useQuery({
    queryKey: ["actions-for-kind", slug, sourceKind],
    queryFn: () => api.listActions(slug, sourceKind),
    enabled: !!slug && !!sourceKind,
  });

  const kind = kinds.data?.items.find((k) => k.id === sourceKind);
  const action = actionsForKind.data?.items.find((a) => a.id === actionId);
  const needs = TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.needs ?? "none";

  const preview = describeWire({
    triggerType,
    triggerEvent,
    recurrence: triggerType === "schedule" ? recurrence : null,
    sourceLabel: kind?.display_name ?? "",
    actionLabel: action?.label ?? "(an action)",
    target,
  });

  const filledArgs = (): Record<string, string> | undefined => {
    const out = Object.fromEntries(Object.entries(args).filter(([, v]) => v.trim() !== ""));
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const create = useMutation({
    mutationFn: () => {
      const payload = {
        source_kind: sourceKind,
        action_id: actionId,
        trigger_type: triggerType,
        trigger_event: triggerType === "event" ? triggerEvent || null : null,
        trigger_schedule: triggerType === "schedule" ? buildRRule(recurrence) : null,
        template: template.trim() || null,
        // null (not undefined) so editing CLEARS removed args/target, not "leave as-is".
        filter: builtFilter(),
        args: filledArgs() ?? null,
        target: target === "self" ? "self" : target,
      } as Partial<PlatformBinding>;
      return ed ? api.updateBinding(slug, ed.id, payload) : api.createBinding(slug, payload);
    },
    onSuccess: () => {
      toast.success(ed ? "Wire updated." : "Wire created.");
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      setErr(null);
      if (ed) {
        onCreated();
        onCancel?.();
        return;
      }
      setActionId("");
      setArgs({});
      setTriggerEvent("");
      setTemplate("");
      setTarget("self");
      setShowTarget(false);
      onCreated();
    },
    onError: (e: unknown) => setErr(e instanceof ApiError ? e.message : ed ? "Couldn't save" : "Couldn't create"),
  });

  const ready =
    !!sourceKind &&
    !!actionId &&
    (needs !== "event" || !!triggerEvent) &&
    (needs !== "schedule" || buildRRule(recurrence).length > 0);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-4"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">{ed ? "// edit wire" : "// new wire"}</div>

      {/* live plain-language preview — a read-only summary of the wire, not an
          editable field; styled as a left-accent callout so it doesn't read like
          the inputs below it. */}
      <div className="rounded-lg border-l-2 border-accent/40 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2">
        <span className={L}>Preview</span>
        <p className="text-sm italic text-muted dark:text-slate-300">{preview}</p>
      </div>

      {/* WHEN */}
      <div>
        <span className={L}>When…</span>
        <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)} className="input">
          {TRIGGER_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {needs === "event" && (
          <div className="mt-2">
            <input
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              placeholder="pick or type an event — e.g. inventory.stock.changed"
              list="wire-events-list"
              className="input font-mono text-xs"
            />
            <datalist id="wire-events-list">
              {(wireEvents.data?.items ?? []).map((e) => (
                <option key={e.event} value={e.event}>{e.module}</option>
              ))}
            </datalist>
          </div>
        )}

        {needs === "schedule" && <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />}
      </div>

      {/* ON */}
      <div>
        <span className={L}>On which records…</span>
        <select
          value={sourceKind}
          onChange={(e) => { setSourceKind(e.target.value); setActionId(""); }}
          className="input"
        >
          <option value="">— pick a kind —</option>
          {kinds.data?.items.map((k) => (
            <option key={k.id} value={k.id}>{k.display_name} ({k.id})</option>
          ))}
        </select>
      </div>

      {/* DO */}
      <div>
        <span className={L}>Do…</span>
        <select value={actionId} onChange={(e) => { setActionId(e.target.value); setArgs({}); }} className="input" disabled={!sourceKind}>
          <option value="">— pick an action —</option>
          {actionsForKind.data?.items.map((a) => (
            <option key={a.id} value={a.id}>{a.label} ({a.id})</option>
          ))}
        </select>
        {action?.description && (
          <p className="mt-1 text-[11px] text-faint dark:text-slate-500">{action.description}</p>
        )}
      </div>

      {/* WITH — structured args (from the action's argsSchema) + message/template.
          The field picker inserts {{tokens}} into whichever field is focused. */}
      <div className="space-y-3">
        {action?.args_schema && Object.keys(action.args_schema).length > 0 && (
          <div>
            <span className={L}>With these settings</span>
            <div className="space-y-2">
              {Object.entries(action.args_schema).map(([name, spec]) => (
                <label key={name} className="block">
                  <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">{spec.label}</span>
                  <input
                    value={args[name] ?? ""}
                    onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}
                    onFocus={(e) => { activeRef.current = e.currentTarget; activeField.current = name; }}
                    placeholder={spec.type === "number" ? "a number or {{token}}" : "a value or {{token}}"}
                    className="input font-mono text-xs"
                  />
                </label>
              ))}
            </div>
          </div>
        )}
        <div>
          <span className={L}>
            Message / template <span className="normal-case tracking-normal">(optional)</span>
          </span>
          <textarea
            ref={templateRef}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onFocus={(e) => { activeRef.current = e.currentTarget; activeField.current = "__template__"; }}
            placeholder={'e.g. {{name}} is low — only {{qty}} {{unit}} left'}
            rows={2}
            className="input font-mono text-xs"
          />
        </div>
        {kind && kind.fields.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-[10px] font-mono text-faint dark:text-slate-500 mr-1">
              insert a field into the focused box:
            </span>
            {kind.fields.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => insertIntoActive(f.name)}
                className="px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-[10px] font-mono text-accent hover:bg-cobble-100 dark:hover:bg-cobble-800 transition"
              >
                {`{{${f.name}}}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CONDITIONS — B7: "only fire when …" */}
      <div>
        <button
          type="button"
          onClick={() => setShowConds((v) => !v)}
          className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 hover:text-accent transition"
        >
          {showConds ? "▾" : "▸"} only when {conditions.filter((c) => c.path.trim()).length > 0 ? `${conditions.filter((c) => c.path.trim()).length} condition${conditions.filter((c) => c.path.trim()).length === 1 ? "" : "s"} hold` : "… (conditions, optional)"}
        </button>
        {showConds && (
          <div className="mt-2 space-y-2 rounded-lg border border-line dark:border-slate-700 p-3">
            <p className="text-xs text-muted dark:text-slate-400">
              Fire only when ALL of these hold. Paths read the same data as the template —
              a field name (<span className="font-mono">qty</span>, <span className="font-mono">material</span>)
              or <span className="font-mono">event.*</span> (<span className="font-mono">event.newQty</span>,{" "}
              <span className="font-mono">event.delta</span>). Numbers compare numerically.
            </p>
            {conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={c.path}
                  onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                  placeholder="event.newQty"
                  className="input !py-1 !text-xs font-mono flex-1"
                />
                <select
                  value={c.op}
                  onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
                  className="input !py-1 !text-xs !w-auto"
                >
                  {COND_OPS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                {c.op !== "empty" && c.op !== "not_empty" && (
                  <input
                    value={c.value}
                    onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    placeholder="5"
                    className="input !py-1 !text-xs font-mono flex-1"
                  />
                )}
                <button
                  type="button"
                  aria-label="Remove condition"
                  onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
                  className="text-muted hover:text-ember-600 transition text-sm px-1"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setConditions((cs) => [...cs, { path: "", op: "eq", value: "" }])}
              className="text-xs text-accent hover:underline"
            >
              + add condition
            </button>
          </div>
        )}
      </div>

      {/* TARGET — advanced */}
      <div>
        <button
          type="button"
          onClick={() => setShowTarget((s) => !s)}
          className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 hover:text-accent transition"
        >
          {showTarget ? "▾" : "▸"} run on {target === "self" ? "the record itself" : "linked records"} (advanced)
        </button>
        {showTarget && (
          <div className="mt-2 space-y-2 rounded-lg border border-line dark:border-slate-700 p-3">
            <label className="flex items-center gap-2 text-xs">
              <input type="radio" checked={target === "self"} onChange={() => setTarget("self")} />
              the record the trigger fired on
            </label>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="radio"
                checked={target !== "self"}
                onChange={() => setTarget({ rel: "", dir: "out" })}
              />
              <span className="flex-1">
                records <em>linked</em> to it
                {target !== "self" && (
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    <input
                      value={target.rel}
                      onChange={(e) => setTarget({ ...target, rel: e.target.value })}
                      placeholder="relationship (e.g. matches)"
                      className="input text-xs col-span-2"
                    />
                    <select
                      value={target.dir ?? "out"}
                      onChange={(e) => setTarget({ ...target, dir: e.target.value as "out" | "in" })}
                      className="input text-xs"
                    >
                      <option value="out">it → linked</option>
                      <option value="in">linked → it</option>
                    </select>
                  </div>
                )}
              </span>
            </label>
            <p className="text-[10px] text-faint dark:text-slate-500">
              Linked records are discovered through entity pairings (the same relationships you create on a record's “linked” section).
            </p>
          </div>
        )}
      </div>

      {err && <div className="text-xs text-ember-500">{err}</div>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!ready || create.isPending}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
        >
          {ed ? <Check size={14} /> : <Plus size={14} />} {ed ? (create.isPending ? "Saving…" : "Save changes") : "Create wire"}
        </button>
        {ed && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-3 py-2 transition"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function RecurrenceBuilder({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence) => void }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line dark:border-slate-700 p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-faint">every</span>
        <input
          type="number"
          min={1}
          value={value.interval}
          onChange={(e) => onChange({ ...value, interval: Math.max(1, Number(e.target.value) || 1) })}
          className="input !w-16 text-xs"
        />
        <select
          value={value.freq}
          onChange={(e) => onChange({ ...value, freq: e.target.value as Recurrence["freq"] })}
          className="input !w-auto text-xs"
        >
          <option value="DAILY">day(s)</option>
          <option value="WEEKLY">week(s)</option>
          <option value="MONTHLY">month(s)</option>
        </select>
      </div>
      {value.freq === "WEEKLY" && (
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map((d) => {
            const on = value.byday.includes(d.code);
            return (
              <button
                key={d.code}
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    byday: on ? value.byday.filter((c) => c !== d.code) : [...value.byday, d.code],
                  })
                }
                className={
                  "px-2 py-0.5 rounded text-[10px] font-mono transition " +
                  (on ? "bg-cobble-600 text-white" : "bg-subtle dark:bg-slate-800 text-muted hover:text-accent")
                }
              >
                {d.label}
              </button>
            );
          })}
        </div>
      )}
      {value.freq === "MONTHLY" && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-faint">on the</span>
          <select
            value={value.bymonthday}
            onChange={(e) => onChange({ ...value, bymonthday: Number(e.target.value) })}
            className="input !w-auto text-xs"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
            <option value={-1}>last day</option>
          </select>
        </label>
      )}
    </div>
  );
}

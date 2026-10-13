// The no-code wire composer — a guided "When X → Do Y" builder that emits the
// same createBinding payload as the old flat form. Pure logic (RRULE, tokens,
// preview) lives in ../lib/wire-composer; this is the UI shell.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Check } from "lucide-react";
import { useToast, NumberField, SegmentedChoice } from "@cobblr/platform-web";
import { ApiError, api, WORKSPACE_SOURCE_KIND, type ActionArgSpec, type PlatformBinding } from "../lib/api";
import {
  STOCK_CHANGED_EVENT,
  readStockChange,
  readWireRecords,
  stockChangeConditions,
  stockChangePhrase,
  type NarrowingCondition,
  type StockChange,
  type WireRecords,
} from "@cobblr/platform-contract/wire-narrowing";
import { withArticle } from "@cobblr/platform-contract/plural";
import { StockChangePicker, WireRecordsPicker, wireRecordsReady } from "./WireNarrowing";
import {
  TRIGGER_OPTIONS,
  WEEKDAYS,
  DEFAULT_RECURRENCE,
  buildRRule,
  parseRRule,
  describeWire,
  insertToken,
  RECORDLESS_TRIGGERS,
  SERVICE_EVENT_TOKENS,
  buildServiceInput,
  serviceInputFields,
  serviceInputValues,
  type ServiceInputField,
  type TriggerType,
  type Recurrence,
  type WireTarget,
} from "../lib/wire-composer";

const L = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

// `editing` switches the composer to edit-an-existing-wire mode: state prefills
// from the binding and Save PATCHes it (preserving id + firing history) instead
// of creating a new one. Mount with key={wire.id} so the prefill re-runs per wire.
/** A new wire started from somewhere else ("When this runs out…" on a
 *  record, the assistant's escort): the trigger, the kind and the narrowing,
 *  already chosen. */
export interface WirePrefill {
  sourceKind?: string;
  triggerEvent?: string;
  change?: StockChange;
  records?: WireRecords | null;
  /** The record's name when `records.record` is set, to show instead of an id. */
  recordLabel?: string | null;
}

export function WireComposer({
  slug,
  onCreated,
  editing,
  onCancel,
  prefill,
}: {
  slug: string;
  onCreated: () => void;
  editing?: PlatformBinding | null;
  onCancel?: () => void;
  prefill?: WirePrefill | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ed = editing ?? null;

  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), enabled: !!slug });
  const wireEvents = useQuery({ queryKey: ["wire-events", slug], queryFn: () => api.listWireEvents(slug), enabled: !!slug });

  const pre = ed ? null : prefill ?? null;
  const [triggerType, setTriggerType] = useState<TriggerType>(ed?.trigger_type ?? (pre?.triggerEvent ? "event" : "on-create"));
  const [triggerEvent, setTriggerEvent] = useState(ed?.trigger_event ?? pre?.triggerEvent ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(
    ed?.trigger_schedule ? parseRRule(ed.trigger_schedule) : DEFAULT_RECURRENCE,
  );
  const [sourceKind, setSourceKind] = useState(ed?.source_kind ?? pre?.sourceKind ?? "");
  const [actionId, setActionId] = useState(ed?.action_id ?? "");
  const [template, setTemplate] = useState(ed?.template ?? "");
  // A button's own label, and the one thing it asks before it runs.
  const [buttonLabel, setButtonLabel] = useState(ed?.label ?? "");
  const [askArg, setAskArg] = useState(ed?.ask?.[0]?.arg ?? "");
  const [askLabel, setAskLabel] = useState(ed?.ask?.[0]?.label ?? "");
  const [target, setTarget] = useState<WireTarget>(ed?.target && ed.target !== "self" ? ed.target : "self");
  const [showTarget, setShowTarget] = useState(!!(ed?.target && ed.target !== "self"));
  // B7 — conditions: {all:[{path,op,value}]} evaluated per firing against the
  // same data templates see (target fields + event.*). AND-joined; empty = fire always.
  type Cond = { path: string; op: string; value: string; valuePath?: string };
  // A stock wire's change (ran out, fell below 3) and the records it is about
  // are their own choices (WireNarrowing.tsx, #6070); the conditions a person
  // added beside them stay rows here.
  const edFilter = ed?.filter as { all?: NarrowingCondition[]; in?: unknown } | null | undefined;
  const edRead = readStockChange(Array.isArray(edFilter?.all) ? edFilter!.all! : []);
  const [stockChange, setStockChange] = useState<StockChange>(ed ? (ed.trigger_event === STOCK_CHANGED_EVENT ? edRead.change : { kind: "any" }) : pre?.change ?? { kind: "any" });
  const [records, setRecords] = useState<WireRecords | null>(ed ? readWireRecords(edFilter?.in) : pre?.records ?? null);
  const initialConds: Cond[] = (ed?.trigger_event === STOCK_CHANGED_EVENT ? edRead.rest : Array.isArray(edFilter?.all) ? edFilter!.all! : []).map((c) => ({
    path: String(c.path ?? ""),
    op: String(c.op ?? "eq"),
    value: c.value === undefined ? "" : String(c.value),
    ...(c.valuePath ? { valuePath: c.valuePath } : {}),
  }));
  const [conditions, setConditions] = useState<Cond[]>(initialConds);
  const [showConds, setShowConds] = useState(initialConds.length > 0);
  const COND_OPS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "not_contains", "empty", "not_empty"] as const;
  const stockWire = triggerType === "event" && triggerEvent === STOCK_CHANGED_EVENT;
  const builtFilter = (): { all?: Array<{ path: string; op: string; value?: string | number | boolean; valuePath?: string }>; in?: WireRecords } | null => {
    const rows = [
      ...conditions
        .filter((c) => c.path.trim() !== "")
        .map((c) =>
          c.op === "empty" || c.op === "not_empty"
            ? { path: c.path.trim(), op: c.op }
            : c.valuePath
              ? { path: c.path.trim(), op: c.op, valuePath: c.valuePath }
              : { path: c.path.trim(), op: c.op, value: c.value },
        ),
      ...(stockWire ? stockChangeConditions(stockChange) : []),
    ];
    const recordsIn = !recordless && records && wireRecordsReady(records) ? records : null;
    if (!rows.length && !recordsIn) return null;
    return { ...(rows.length ? { all: rows } : {}), ...(recordsIn ? { in: recordsIn } : {}) };
  };
  const [err, setErr] = useState<string | null>(null);
  // Structured action args (per the action's argsSchema): each value is a
  // literal or a {{token}}. The field picker inserts into whichever field
  // (an arg input or the template) is focused.
  const [args, setArgs] = useState<Record<string, string>>(
    ed?.args && typeof ed.args === "object"
      ? Object.fromEntries(
          Object.entries(ed.args as Record<string, unknown>)
            .filter(([, v]) => v == null || typeof v !== "object")
            .map(([k, v]) => [k, String(v)]),
        )
      : {},
  );
  // A service's input, one text value per field its schema asks for; stored
  // on the wire as an object (the arg whose spec says `schema_from`).
  const [serviceValues, setServiceValues] = useState<Record<string, string>>(
    serviceInputValues((ed?.args as Record<string, unknown> | null | undefined)?.["input"]),
  );
  const activeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const activeField = useRef<string>("__template__"); // "__template__" or an arg name
  const templateRef = useRef<HTMLTextAreaElement>(null);

  function insertIntoActive(fieldName: string) {
    const el = activeRef.current;
    const caret = el?.selectionStart ?? undefined;
    if (activeField.current === "__template__") {
      setTemplate((t) => insertToken(t, fieldName, caret));
    } else if (activeField.current.startsWith("input.")) {
      const f = activeField.current.slice("input.".length);
      setServiceValues((v) => ({ ...v, [f]: insertToken(v[f] ?? "", fieldName, caret) }));
    } else {
      const arg = activeField.current;
      setArgs((a) => ({ ...a, [arg]: insertToken(a[arg] ?? "", fieldName, caret) }));
    }
    el?.focus();
  }

  // "No record": the wire acts on the workspace, once per event or tick, and
  // offers the actions that need no record (running a service).
  const recordless = sourceKind === WORKSPACE_SOURCE_KIND;
  const actionsForKind = useQuery({
    queryKey: ["actions-for-kind", slug, sourceKind],
    queryFn: () => api.listActions(slug, sourceKind),
    enabled: !!slug && !!sourceKind && !recordless,
  });
  const wireActions = useQuery({
    queryKey: ["wire-actions", slug],
    queryFn: () => api.listWireActions(slug),
    enabled: !!slug && recordless,
  });
  const actionChoices = recordless ? wireActions.data?.items : actionsForKind.data?.items;
  const argsSpec: Record<string, ActionArgSpec> | null | undefined = actionChoices?.find((a) => a.id === actionId)?.args_schema;
  const pickerArg = Object.entries(argsSpec ?? {}).find(([, s]) => s.picker === "service-capability")?.[0];
  const capabilities = useQuery({
    queryKey: ["service-capabilities", slug],
    queryFn: () => api.listServiceCapabilities(slug),
    enabled: !!slug && (!!pickerArg || (triggerType === "event" && triggerEvent.startsWith("services.job."))),
  });
  // "After which service": the condition on event.capability, offered as a
  // choice so a wire on a job's event does not follow every service there is.
  const afterIdx = conditions.findIndex((c) => c.path === "event.capability" && c.op === "eq");
  const afterCap = afterIdx >= 0 ? conditions[afterIdx]!.value : "";
  const setAfterCap = (cap: string) =>
    setConditions((cs) => {
      const rest = cs.filter((_, i) => i !== afterIdx);
      return cap ? [{ path: "event.capability", op: "eq", value: cap }, ...rest] : rest;
    });
  const inputFieldsFor = (spec: ActionArgSpec) => {
    const chosen = spec.schema_from ? args[spec.schema_from] : "";
    return serviceInputFields(capabilities.data?.items.find((c) => c.id === chosen)?.input_schema);
  };

  const kind = kinds.data?.items.find((k) => k.id === sourceKind);
  const action = actionChoices?.find((a) => a.id === actionId);
  const needs = TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.needs ?? "none";
  const eventTokens = recordless && triggerType === "event" && triggerEvent.startsWith("services.job.") ? SERVICE_EVENT_TOKENS : [];
  // Which "a record is created / updated / deleted" triggers this kind can
  // carry: a kind that says nothing at that moment would store a wire that
  // never runs, so the choice is offered only where it works.
  const lifecycle = useQuery({
    queryKey: ["wire-lifecycle", slug, sourceKind],
    queryFn: () => api.getWireLifecycle(slug, sourceKind),
    enabled: !!slug && !!sourceKind,
  });
  const lifecycleWhy = sourceKind ? lifecycle.data?.triggers[triggerType]?.why ?? null : null;

  const [recordName, setRecordName] = useState<string | null>(pre?.recordLabel ?? null);
  const preview = describeWire({
    triggerType,
    triggerEvent,
    recurrence: triggerType === "schedule" ? recurrence : null,
    sourceLabel: kind?.display_name ?? "",
    actionLabel: action?.label ?? "(an action)",
    target,
    recordless,
    stockPhrase: stockWire ? stockChangePhrase(stockChange) : null,
    whose: recordless ? null : whoseRecords(records, kind?.display_name ?? "record", recordName),
  });

  const filledArgs = (): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(args)) {
      if (argsSpec?.[name]?.type === "json") continue;
      if (v.trim() !== "") out[name] = v;
    }
    for (const [name, spec] of Object.entries(argsSpec ?? {})) {
      if (spec.type === "json" && spec.schema_from) out[name] = buildServiceInput(inputFieldsFor(spec), serviceValues);
    }
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
        target: recordless ? "none" : target === "self" ? "self" : target,
        // Only a button has a label or a question; null clears them.
        label: triggerType === "user-invoked" && buttonLabel.trim() ? buttonLabel.trim() : null,
        ask:
          triggerType === "user-invoked" && askArg.trim() && askLabel.trim()
            ? [{ arg: askArg.trim(), label: askLabel.trim(), ...(ed?.ask?.[0]?.kind ? { kind: ed.ask[0].kind } : {}) }]
            : null,
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
      setServiceValues({});
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
    !lifecycleWhy &&
    !!actionId &&
    (!recordless || RECORDLESS_TRIGGERS.includes(triggerType)) &&
    (!pickerArg || !!args[pickerArg]) &&
    (needs !== "event" || !!triggerEvent) &&
    (recordless || wireRecordsReady(records)) &&
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
        <select aria-label="When" value={triggerType} onChange={(e) => setTriggerType(e.target.value as TriggerType)} className="input">
          {TRIGGER_OPTIONS.filter((t) => !recordless || RECORDLESS_TRIGGERS.includes(t.value)).map((t) => {
            const off = !!sourceKind && lifecycle.data?.triggers[t.value]?.ok === false;
            return (
              <option key={t.value} value={t.value} disabled={off}>
                {t.label}
                {off ? " (not for these records)" : ""}
              </option>
            );
          })}
        </select>

        {needs === "event" && (
          <div className="mt-2">
            <input
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              placeholder="pick or type an event - e.g. inventory.stock.changed"
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

        {stockWire && <StockChangePicker value={stockChange} onChange={setStockChange} />}

        {needs === "event" && triggerEvent.startsWith("services.job.") && (
          <label className="mt-2 block">
            <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">After which service</span>
            <select value={afterCap} onChange={(e) => setAfterCap(e.target.value)} className="input text-sm" data-testid="wire-after-service">
              <option value="">any service</option>
              {capabilities.data?.items.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
              {afterCap && !capabilities.data?.items.some((c) => c.id === afterCap) && <option value={afterCap}>{afterCap}</option>}
            </select>
          </label>
        )}
        {lifecycleWhy && (
          <p className="mt-1 text-[11px] text-ember-600 dark:text-ember-400" data-testid="wire-trigger-why">
            {lifecycleWhy}
          </p>
        )}

        {needs === "schedule" && <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />}
      </div>

      {/* ON */}
      <div>
        <span className={L}>On which records…</span>
        <select aria-label="On which records"
          value={sourceKind}
          onChange={(e) => {
            const next = e.target.value;
            setSourceKind(next);
            setActionId("");
            if (next === WORKSPACE_SOURCE_KIND && !RECORDLESS_TRIGGERS.includes(triggerType)) setTriggerType("event");
          }}
          className="input"
        >
          <option value=""> - pick a kind - </option>
          <option value={WORKSPACE_SOURCE_KIND}>No record: once, for the workspace</option>
          {kinds.data?.items.map((k) => (
            <option key={k.id} value={k.id}>{k.display_name} ({k.id})</option>
          ))}
        </select>
        {!!sourceKind && !recordless && (
          <WireRecordsPicker
            slug={slug}
            kind={sourceKind}
            kindNoun={(kind?.display_name ?? "record").toLowerCase()}
            value={records}
            recordLabel={recordName}
            onChange={(r) => {
              setRecords(r);
              if (!r?.record) setRecordName(null);
            }}
            onRecordNamed={setRecordName}
          />
        )}
      </div>

      {/* DO */}
      <div>
        <span className={L}>Do…</span>
        <select aria-label="Do" value={actionId} onChange={(e) => { setActionId(e.target.value); setArgs({}); setServiceValues({}); }} className="input" disabled={!sourceKind}>
          <option value=""> - pick an action - </option>
          {actionChoices?.map((a) => (
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
              {Object.entries(action.args_schema).map(([name, spec]) =>
                spec.picker === "service-capability" ? (
                  <label key={name} className="block">
                    <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">{spec.label}</span>
                    <select
                      value={args[name] ?? ""}
                      onChange={(e) => { setArgs((a) => ({ ...a, [name]: e.target.value })); setServiceValues({}); }}
                      className="input text-sm"
                      data-testid="wire-service-picker"
                    >
                      <option value=""> - pick a service - </option>
                      {capabilities.data?.items.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                          {c.effect === "physical" ? " (asks a person first)" : c.effect === "spends" ? " (asks before it spends)" : ""}
                        </option>
                      ))}
                      {args[name] && !capabilities.data?.items.some((c) => c.id === args[name]) && <option value={args[name]}>{args[name]}</option>}
                    </select>
                    {capabilities.data && capabilities.data.items.length === 0 && (
                      <p className="mt-1 text-[11px] text-faint dark:text-slate-500">No services here yet. Add one under Connections.</p>
                    )}
                    {(() => {
                      const c = capabilities.data?.items.find((x) => x.id === args[name]);
                      return c ? <p className="mt-1 text-[11px] text-faint dark:text-slate-500">{c.summary}</p> : null;
                    })()}
                  </label>
                ) : spec.type === "boolean" ? (
                  // A yes-or-no setting (a message's reply link): asked as
                  // one, never a box to type "true" into.
                  <label key={name} className="block">
                    <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">{spec.label}</span>
                    <select
                      value={args[name] ?? ""}
                      onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}
                      className="input text-sm"
                      data-testid={`wire-arg-${name}`}
                    >
                      <option value="">no</option>
                      <option value="true">yes</option>
                    </select>
                  </label>
                ) : spec.choices?.length ? (
                  // A "who" (choicesFrom people) and any argument the server
                  // filled with choices: picked by name, never typed as an id.
                  <label key={name} className="block">
                    <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">{spec.label}</span>
                    <select
                      value={args[name] ?? ""}
                      onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}
                      className="input text-sm"
                      data-testid={`wire-arg-${name}`}
                    >
                      <option value=""> - pick one - </option>
                      {spec.choices.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                      {args[name] && !spec.choices.some((c) => c.value === args[name]) && <option value={args[name]}>{args[name]}</option>}
                    </select>
                  </label>
                ) : spec.type === "json" && spec.schema_from ? (
                  <ServiceInputForm
                    key={name}
                    label={spec.label}
                    fields={inputFieldsFor(spec)}
                    chosen={!!args[spec.schema_from]}
                    values={serviceValues}
                    onChange={setServiceValues}
                    onFocusField={(f, el) => { activeRef.current = el; activeField.current = `input.${f}`; }}
                  />
                ) : (
                <label key={name} className="block">
                  <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">{spec.label}</span>
                  <input
                    value={args[name] ?? ""}
                    onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}
                    onFocus={(e) => { activeRef.current = e.currentTarget; activeField.current = name; }}
                    placeholder={
                      spec.type === "number"
                        ? "a number or {{token}}"
                        : spec.type === "list"
                          ? "values separated by commas, or {{token}}"
                          : "a value or {{token}}"
                    }
                    className="input font-mono text-xs"
                  />
                </label>
                ),
              )}
            </div>
          </div>
        )}
        {triggerType === "user-invoked" && (
          <div className="space-y-2" data-testid="wire-button-options">
            <label className="block">
              <span className={L}>
                Button label <span className="normal-case tracking-normal">(optional, else the action's)</span>
              </span>
              <input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={40} placeholder={action?.label ?? "e.g. Open one"} className="input text-sm" />
            </label>
            <div>
              <span className={L}>
                Ask before running <span className="normal-case tracking-normal">(optional)</span>
              </span>
              <div className="flex gap-2">
                <select aria-label="Ask for" value={askArg} onChange={(e) => setAskArg(e.target.value)} className="input text-sm w-40">
                  <option value="">nothing</option>
                  {Object.entries(action?.args_schema ?? {}).map(([name, spec]) => (
                    <option key={name} value={name}>{spec.label}</option>
                  ))}
                  {askArg && !(action?.args_schema && askArg in action.args_schema) && <option value={askArg}>{askArg}</option>}
                </select>
                {askArg && (
                  <input value={askLabel} onChange={(e) => setAskLabel(e.target.value)} maxLength={80} placeholder="the question, e.g. Tasting note" className="input text-sm flex-1" />
                )}
              </div>
            </div>
          </div>
        )}
        {!recordless && (
        <div>
          <span className={L}>
            Message / template <span className="normal-case tracking-normal">(optional)</span>
          </span>
          <textarea
            ref={templateRef}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onFocus={(e) => { activeRef.current = e.currentTarget; activeField.current = "__template__"; }}
            placeholder={'e.g. {{name}} is low - only {{qty}} {{unit}} left'}
            rows={2}
            className="input font-mono text-xs"
          />
        </div>
        )}
        {eventTokens.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="wire-event-tokens">
            <span className="text-[10px] font-mono text-faint dark:text-slate-500 mr-1">
              insert from the job that finished (its answer is {"{{event.output.<field>}}"}):
            </span>
            {eventTokens.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => insertIntoActive(t)}
                className="px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-[10px] font-mono text-accent hover:bg-cobble-100 dark:hover:bg-cobble-800 transition"
              >
                {`{{${t}}}`}
              </button>
            ))}
          </div>
        )}
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
              Fire only when ALL of these hold. Paths read the same data as the template - 
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
                  className="input !py-1 text-xs font-mono flex-1"
                />
                <select aria-label="Condition"
                  value={c.op}
                  onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
                  className="input !py-1 text-xs !w-auto"
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
                    className="input !py-1 text-xs font-mono flex-1"
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

      {/* TARGET — advanced; a wire on no record has none */}
      {!recordless && (
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
            <SegmentedChoice
              label="Run on"
              value={target === "self" ? "self" : "linked"}
              onChange={(v) => setTarget(v === "self" ? "self" : { rel: "", dir: "out" })}
              options={[
                { value: "self", label: "the record the trigger fired on" },
                { value: "linked", label: "records linked to it" },
              ]}
            />
            {target !== "self" && (
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    <input
                      value={target.rel}
                      onChange={(e) => setTarget({ ...target, rel: e.target.value })}
                      placeholder="relationship (e.g. matches)"
                      className="input text-xs col-span-2"
                    />
                    <select aria-label="Direction"
                      value={target.dir ?? "out"}
                      onChange={(e) => setTarget({ ...target, dir: e.target.value as "out" | "in" })}
                      className="input text-xs"
                    >
                      <option value="out">it → linked</option>
                      <option value="in">linked → it</option>
                    </select>
                  </div>
                )}
            <p className="text-[10px] text-faint dark:text-slate-500">
              Linked records are discovered through entity pairings (the same relationships you create on a record's “linked” section).
            </p>
          </div>
        )}
      </div>
      )}

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

/** A service's input: one box per field its schema asks for. Each takes a
 *  literal or a {{token}}; a choice offers the service's own values. */
function ServiceInputForm({
  label,
  fields,
  chosen,
  values,
  onChange,
  onFocusField,
}: {
  label: string;
  fields: ServiceInputField[];
  chosen: boolean;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  onFocusField: (field: string, el: HTMLInputElement) => void;
}) {
  if (!chosen) return null;
  if (fields.length === 0)
    return <p className="text-[11px] text-faint dark:text-slate-500">This service asks for nothing more.</p>;
  const set = (name: string, v: string) => onChange({ ...values, [name]: v });
  return (
    <fieldset className="space-y-2 rounded-lg border border-line dark:border-slate-700 p-3" data-testid="wire-service-input">
      <legend className="px-1 text-[11px] text-muted dark:text-slate-400">{label}</legend>
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="block text-[11px] text-muted dark:text-slate-400 mb-0.5">
            {f.label}
            {f.required && <span className="text-ember-600 dark:text-ember-400"> *</span>}
          </span>
          {f.type === "choice" || f.type === "boolean" ? (
            <select value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} className="input text-sm">
              <option value="">{f.required ? " - pick one - " : "(the service's default)"}</option>
              {(f.type === "boolean" ? ["true", "false"] : f.options ?? []).map((o) => (
                <option key={o} value={o}>{f.type === "boolean" ? (o === "true" ? "yes" : "no") : o}</option>
              ))}
            </select>
          ) : (
            <input
              value={values[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
              onFocus={(e) => onFocusField(f.name, e.currentTarget)}
              placeholder={f.type === "number" ? "a number or {{token}}" : "a value or {{token}}"}
              inputMode={f.type === "number" ? "decimal" : undefined}
              className="input font-mono text-xs"
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}

function RecurrenceBuilder({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence) => void }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line dark:border-slate-700 p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-faint">every</span>
        <NumberField label="Every"
          min={1}
          integer
          value={value.interval}
          onChange={(n) => onChange({ ...value, interval: n })}
          className="input !w-16 text-xs"
        />
        <select aria-label="Frequency"
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
        <div role="group" aria-label="On these days" className="flex flex-wrap gap-1">
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
                aria-pressed={on}
                className={
                  "min-h-11 min-w-11 inline-flex items-center justify-center gap-1 px-3 rounded text-[10px] font-mono transition " +
                  (on ? "bg-cobble-600 text-white" : "bg-subtle dark:bg-slate-800 text-muted hover:text-accent")
                }
              >
                {on && <Check size={11} strokeWidth={2.5} aria-hidden />}
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

/** Which records a wire is about, as the preview says it. */
function whoseRecords(r: WireRecords | null, kindLabel: string, recordName: string | null): string | null {
  if (!r) return null;
  const noun = kindLabel.toLowerCase();
  if (r.record) return recordName ? `“${recordName}”` : `this ${noun}`;
  if (r.category) return `${withArticle(noun)} in “${r.category}”`;
  if (r.tag) return `${withArticle(noun)} tagged “${r.tag}”`;
  if (r.view) return `${withArticle(noun)} the saved view shows`;
  return null;
}

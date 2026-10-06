import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RecordFormModal, MoneyInput, useMoneyCurrency, usePhotoPick, useToast, usePasteImage } from "@cobblr/platform-web";
import { TermHistory, TermReferenceQuantity } from "./terms";
import { api, type MaintenanceSchedule, type MaintenanceReminder, type OverdueCadence } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";

const input = "w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-content dark:bg-slate-900 dark:border-slate-700";
function renewalDate(value: string, relative = false): string {
  const date = new Date(value.slice(0, 10) + "T12:00:00");
  if (relative) {
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "today";
    today.setDate(today.getDate() + 1);
    if (date.toDateString() === today.toDateString()) return "tomorrow";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const button = "rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-50";
export function ReminderPicker({ value, onChange }: { value: MaintenanceReminder | null; onChange: (r: MaintenanceReminder) => void }) {
  const [custom, setCustom] = useState(false);
  const selected = value && "on" in value ? "month_start" : value?.before === 1 && value.unit === "month" ? "month" : value?.before === 2 && value.unit === "week" ? "fortnight" : "custom";
  return <div className="space-y-2"><label className="block text-sm">Remind me<select className={input} aria-label="Remind me" value={custom ? "custom" : selected} onChange={(e) => {
    setCustom(e.target.value === "custom");
    onChange(e.target.value === "month_start" ? { on: "month_start" } : e.target.value === "month" ? { before: 1, unit: "month" } : e.target.value === "fortnight" ? { before: 2, unit: "week" } : { before: 7, unit: "day" });
  }}><option value="month">1 month before</option><option value="month_start">First day of that month</option><option value="fortnight">2 weeks before</option><option value="custom">Custom</option></select></label>
    {(custom || selected === "custom") && <div className="flex gap-2"><input className={input} aria-label="Reminder lead time" type="number" min="0" max="3650" value={value && "before" in value ? value.before : 7} onChange={(e) => onChange({ before: Number(e.target.value), unit: value && "unit" in value ? value.unit : "day" })} /><select className={input} aria-label="Reminder unit" value={value && "unit" in value ? value.unit : "day"} onChange={(e) => onChange({ before: value && "before" in value ? value.before : 7, unit: e.target.value as "day" | "week" | "month" })}><option value="day">Days before</option><option value="week">Weeks before</option><option value="month">Months before</option></select></div>}
  </div>;
}

export function CadencePicker({ value, onChange, workspace = false }: { value: OverdueCadence | null; onChange: (v: OverdueCadence | null) => void; workspace?: boolean }) {
  return <label className="block text-sm">Overdue reminders<select aria-label="Overdue reminders" className={input} value={value ?? "default"} onChange={(e) => onChange(e.target.value === "default" ? null : e.target.value as OverdueCadence)}>{!workspace && <option value="default">Workspace default</option>}<option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="off">Off</option></select></label>;
}

export function ReminderControls({ slug, occurrence, refresh }: { slug: string; occurrence: { id: string; nag_stopped_at: string | null; nag_snoozed_until: string | null }; refresh: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState("");
  const [chooseDate, setChooseDate] = useState(false);
  const change = useMutation({ mutationFn: (body: Parameters<typeof api.maintenanceReminders>[2]) => api.maintenanceReminders(slug, occurrence.id, body), onSuccess: () => { refresh(); setChooseDate(false); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't change reminders") });
  const stopped = !!occurrence.nag_stopped_at;
  const snoozed = !!occurrence.nag_snoozed_until && new Date(occurrence.nag_snoozed_until) > new Date();
  return <div className="space-y-2 text-xs">
    {(stopped || snoozed) ? <div className="flex flex-wrap gap-2 text-muted"><span>{stopped ? "Reminders off" : `Reminders snoozed until ${renewalDate(occurrence.nag_snoozed_until!)}`}</span><button type="button" disabled={change.isPending} className="text-accent underline" onClick={() => change.mutate({ mode: "resume" })}>Turn reminders back on</button></div> : <div className="flex flex-wrap gap-3 text-accent"><button type="button" disabled={change.isPending} onClick={() => change.mutate({ mode: "snooze", duration: "week" })}>Snooze 1 week</button><button type="button" disabled={change.isPending} onClick={() => change.mutate({ mode: "snooze", duration: "month" })}>Snooze 1 month</button><button type="button" onClick={() => setChooseDate(true)}>Snooze until a date</button><button type="button" disabled={change.isPending} onClick={() => change.mutate({ mode: "stop" })}>Stop reminding me</button></div>}
    {chooseDate && <div className="flex flex-wrap gap-2"><input type="date" aria-label="Snooze until" className={input} value={date} onChange={(e) => setDate(e.target.value)} /><button type="button" className={button} disabled={!date || change.isPending} onClick={() => change.mutate({ mode: "snooze", until: new Date(date + "T12:00:00").toISOString() })}>Snooze</button><button type="button" onClick={() => setChooseDate(false)}>Cancel</button></div>}
  </div>;
}

export function MaintenanceRenewalsPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const schedules = useQuery({ queryKey: ["maintenance-schedules", ctx.slug, ctx.entityId], queryFn: () => api.listMaintenanceSchedules(ctx.slug, ctx.entityId), meta: { kinds: ctx.kind ? [ctx.kind] : [] } });
  return <Renewals ctx={{ ...ctx, kind: typeof ctx.hints?.collection === "string" ? ctx.hints.collection : ctx.kind }} schedules={schedules.data?.items ?? []} />;
}

export function Renewals({ ctx, schedules }: { ctx: EntityDetailPanelCtx; schedules: MaintenanceSchedule[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ label: string; field?: string; value?: string | null; schedule?: MaintenanceSchedule } | null>(null);
  const [renewing, setRenewing] = useState<MaintenanceSchedule | null>(null);
  const fields = useQuery({ queryKey: ["renewal-fields", ctx.slug, ctx.kind, ctx.entityId], queryFn: () => api.maintenanceRenewalFields(ctx.slug, ctx.kind ?? "", ctx.entityId), enabled: !!ctx.kind, meta: { kinds: ctx.kind ? [ctx.kind] : [] } });
  const refresh = () => { void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(ctx.entityId) || q.queryKey.includes("maintenance") || q.queryKey.includes("attention") }); };
  const end = useMutation({ mutationFn: (id: string) => api.endMaintenanceRenewal(ctx.slug, id), onSuccess: refresh, onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't end renewal") });
  const cards = (fields.data?.fields ?? []).map((f) => ({ label: f.label, field: f.key, value: f.value, schedule: schedules.find((s) => s.expiry_field === f.key) }));
  for (const s of schedules.filter((s) => s.anchor && !cards.some((c) => c.schedule?.id === s.id))) cards.push({ label: s.name, field: s.expiry_field ?? "", value: s.current_expiry, schedule: s });
  return <div className="space-y-3" data-testid="renewals">
    {cards.map((c) => <section key={c.field || c.schedule?.id} className="rounded-xl border border-line p-3 space-y-2">
      <h3 className="text-sm font-semibold">{c.label}</h3>
      {c.schedule ? <><p className="text-sm">{c.schedule.ended_at ? "Didn't renew. Term ends" : c.schedule.renewal_status === "lapsed" ? "Lapsed on" : "Expires"} {c.schedule.current_expiry ? renewalDate(c.schedule.current_expiry) : "date needed"}</p>{!c.schedule.ended_at && <p className={`text-sm ${c.schedule.due.state === "overdue" ? "text-ember-700 dark:text-ember-400 font-medium" : "text-muted"}`}>{c.schedule.due.reason}</p>}<p className="text-xs text-muted">Next reminder: {c.schedule.next_reminder_at ? renewalDate(c.schedule.next_reminder_at, true) : "reminders off"}</p><div className="flex flex-wrap gap-3">{!c.schedule.ended_at && <><button type="button" className={button} onClick={() => setRenewing(c.schedule!)}>Renewed</button><button type="button" className="text-sm text-accent" disabled={end.isPending} onClick={() => end.mutate(c.schedule!.id)}>Didn't renew</button></>}<button type="button" className="text-sm text-accent" onClick={() => setEditing(c)}>Change renewal</button></div>{!c.schedule.ended_at && c.schedule.occurrence && c.schedule.due.state === "overdue" && <ReminderControls slug={ctx.slug} occurrence={c.schedule.occurrence} refresh={refresh} />}</> : <><p className="text-sm text-muted">{c.value ? `Expires ${renewalDate(c.value)}` : "No expiry set"}</p><button type="button" className={button} onClick={() => setEditing(c)}>Add {c.label.toLowerCase()}</button></>}
    </section>)}
    <TermHistory slug={ctx.slug} entityId={ctx.entityId} refresh={refresh} />
    <button type="button" className="text-sm text-accent" onClick={() => setEditing({ label: "Renewal" })}>Add a renewal</button>
    {editing && <RenewalSetup ctx={ctx} initial={editing} close={() => setEditing(null)} refresh={refresh} />}
    {renewing && <RenewalDialog slug={ctx.slug} schedule={renewing} close={() => setRenewing(null)} refresh={refresh} />}
  </div>;
}

function RenewalSetup({ ctx, initial, close, refresh }: { ctx: EntityDetailPanelCtx; initial: { label: string; field?: string; value?: string | null; schedule?: MaintenanceSchedule }; close: () => void; refresh: () => void }) {
  const toast = useToast();
  const s = initial.schedule;
  const [name, setName] = useState(initial.label);
  const [expiry, setExpiry] = useState((s?.current_expiry ?? initial.value)?.slice(0, 10) ?? "");
  const [repeat, setRepeat] = useState(s && (s.every_n !== 1 || s.every_unit !== "year") ? "custom" : s?.anchor && typeof s.anchor !== "string" ? "last" : "same");
  const [lastDay, setLastDay] = useState(!!s?.anchor && typeof s.anchor !== "string");
  const [n, setN] = useState(s?.every_n ?? 1);
  const [unit, setUnit] = useState<"year" | "month">(s?.every_unit === "month" ? "month" : "year");
  const [remind, setRemind] = useState<MaintenanceReminder>(s?.remind ?? { before: 1, unit: "month" });
  const [cadence, setCadence] = useState<OverdueCadence | null>(s?.overdue_every ?? null);
  const save = useMutation({ mutationFn: async () => {
    const rule = { name, current_expiry: expiry, anchor: repeat === "last" || (repeat === "custom" && lastDay) ? { month: Number(expiry.slice(5, 7)), last_day: true as const } : expiry.slice(5), every_n: repeat === "custom" ? n : 1, every_unit: repeat === "custom" ? unit : "year" as const, remind, overdue_every: cadence };
    if (s) return api.updateMaintenanceSchedule(ctx.slug, s.id, rule);
    const [mod, type] = (ctx.kind ?? "").split(":");
    return api.createMaintenanceSchedule(ctx.slug, { ...rule, entity_module: mod!, entity_type: type!, entity_id: ctx.entityId, expiry_field: initial.field || null });
  }, onSuccess: () => { refresh(); close(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save renewal") });
  return <RecordFormModal open onClose={close} title={s ? `Change ${initial.label.toLowerCase()}` : `Add ${initial.label.toLowerCase()}`}><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    {!initial.field && <label className="block text-sm">Name<input className={input} aria-label="Renewal name" value={name} required onChange={(e) => setName(e.target.value)} /></label>}
    <label className="block text-sm">Expiry date<input className={input} aria-label="Expiry date" type="date" required value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
    <label className="block text-sm">Repeats<select className={input} aria-label="Repeats" value={repeat} onChange={(e) => setRepeat(e.target.value)}><option value="same">Same date every year</option><option value="last">Last day of the month every year</option><option value="custom">Custom</option></select></label>
    {repeat === "custom" && <div className="flex gap-2"><input className={input} type="number" min="1" max="1000" aria-label="Renewal interval" value={n} onChange={(e) => setN(Number(e.target.value))} /><select className={input} aria-label="Renewal unit" value={unit} onChange={(e) => setUnit(e.target.value as "year" | "month")}><option value="year">Years</option><option value="month">Months</option></select></div>}
    {repeat === "custom" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={lastDay} onChange={(e) => setLastDay(e.target.checked)} />Use the last day of the month</label>}
    <ReminderPicker value={remind} onChange={setRemind} /><CadencePicker value={cadence} onChange={setCadence} />
    <div className="flex gap-3"><button className={button} type="submit" disabled={save.isPending || !expiry || !name.trim()}>Save</button><button type="button" onClick={close}>Cancel</button></div>
  </form></RecordFormModal>;
}

function RenewalDialog({ slug, schedule, close, refresh }: { slug: string; schedule: MaintenanceSchedule; close: () => void; refresh: () => void }) {
  const main = useMoneyCurrency();
  const toast = useToast();
  const [expiry, setExpiry] = useState(schedule.next_expiry?.slice(0, 10) ?? "");
  const last = schedule.latest_term;
  const moneyHidden = !!last && (!Object.hasOwn(last, "cost_cents") || !Object.hasOwn(last, "currency"));
  const [cost, setCost] = useState<number | null>(moneyHidden ? null : last?.cost_cents ?? null);
  const [currencyChanged, setCurrencyChanged] = useState(false);
  const [start, setStart] = useState(schedule.current_expiry?.slice(0, 10) ?? "");
  const [currency, setCurrency] = useState(schedule.latest_term?.currency ?? main);
  const [reference, setReference] = useState("");
  const [quantity, setQuantity] = useState<number | null>(schedule.latest_term?.quantity == null ? null : Number(schedule.latest_term.quantity));
  const [file, setFile] = useState<File | null>(null);
  const photo = usePhotoPick((files) => setFile(files[0] ?? null), { title: `${schedule.name} document`, label: "Choose document photo" });
  const receiptRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  usePasteImage(formRef, { accept: "image/*,application/pdf", onFiles: (files) => setFile(files[0] ?? null) });
  const save = useMutation({ mutationFn: async () => {
    const uploaded = file ? await api.uploadFile(slug, file) : null;
    // Hidden prefills stay with the server until the person enters a new value.
    const keepMoney = moneyHidden && cost === null && !currencyChanged;
    const keepQuantity = !!last && !Object.hasOwn(last, "quantity") && quantity === null;
    return api.renewMaintenanceSchedule(slug, schedule.id, { new_expiry: expiry, term_start: start,
      ...(keepMoney ? {} : { cost_cents: cost, currency }), reference: reference || null,
      ...(keepQuantity ? {} : { quantity }), file_id: uploaded?.id });
  }, onSuccess: () => { refresh(); close(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save renewal") });
  return <RecordFormModal open onClose={close} title={`${schedule.name} renewed`}><form ref={formRef} className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    <label className="block text-sm">Term start<input className={input} type="date" aria-label="Term start" required min={schedule.current_expiry?.slice(0, 10)} value={start} onChange={(e) => setStart(e.target.value)} /></label>
    <label className="block text-sm">New expiry<input className={input} type="date" aria-label="New expiry" required min={start} value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
    <div className="text-sm">Cost (optional)<MoneyInput value={cost} storage="cents" currency={currency} onCurrencyChange={(value) => { setCurrency(value); setCurrencyChanged(true); }} live onCommit={setCost} ariaLabel="Cost" /></div>
    <TermReferenceQuantity reference={reference} quantity={quantity} onReference={setReference} onQuantity={setQuantity} />
    <div className="space-y-2 text-sm"><p>Document photo or receipt (optional)</p><div className="flex flex-wrap gap-3">
      <button type="button" className="rounded-md border border-line px-3 py-2 text-accent" onClick={photo.pick}>Add photo</button>
      <button type="button" className="rounded-md border border-line px-3 py-2 text-accent" onClick={() => receiptRef.current?.click()}>Choose receipt</button>
    </div>{photo.input}<input ref={receiptRef} className="sr-only" tabIndex={-1} type="file" accept="image/*,application/pdf" aria-label="Choose receipt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
    {file && <p className="text-xs text-muted">{file.name}</p>}
    <div className="flex gap-3"><button type="submit" className={button} disabled={save.isPending || !expiry}>Save</button><button type="button" onClick={close}>Cancel</button></div>
  </form></RecordFormModal>;
}

// Print updates — the configurable "post a photo + status to Discord as the print
// runs" surface. Two layers, matching the data model: Channels (destinations,
// defined once) and Rules (scope → channel → cadence → message template).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Send, Bell, X, Copy } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api, ApiError, type DigifabChannel, type DigifabRule, type DigifabCadence, type DigifabStep } from "../lib/api";

const lbl = "text-[10px] font-mono uppercase tracking-widest text-faint";
const field = "px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 w-full";

export function PrintUpdatesPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({ queryKey: ["digifab-channels", slug], queryFn: () => api.listDigifabChannels(slug) });
  const rules = useQuery({ queryKey: ["digifab-rules", slug], queryFn: () => api.listDigifabRules(slug) });
  const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug) });
  const [editRule, setEditRule] = useState<DigifabRule | "new" | null>(null);
  const chans = channels.data?.items ?? [];
  // The per-printer scope options: "connId:serial" → name (matches the engine key).
  const printers = (fleet.data?.connections ?? []).flatMap((c) => c.devices.map((d) => ({ value: `${c.connection_id}:${d.id}`, label: d.name })));
  const dup = useMutation({
    mutationFn: (r: DigifabRule) => api.createDigifabRule(slug, {
      label: `${r.label} (copy)`, scope_type: r.scope_type, scope_value: r.scope_value, channel_id: r.channel_id,
      events: r.events, cadence: r.cadence, cap_minutes: r.cap_minutes, message: r.message,
      pre_actions: r.pre_actions, post_actions: r.post_actions, enabled: r.enabled,
    }),
    onSuccess: () => { toast.success("Rule duplicated - tweak the copy"); void qc.invalidateQueries({ queryKey: ["digifab-rules", slug] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't duplicate"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Bell size={14} className="text-accent" />
        <h2 className="text-sm font-display font-semibold text-content dark:text-mortar-100">Print updates</h2>
        <span className="text-xs text-faint"> - post a photo + status to Discord as prints run</span>
      </div>

      {/* Destinations */}
      <ChannelsSection slug={slug} channels={chans} />

      {/* Rules */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className={lbl}>Rules <span className="normal-case text-faint/70"> - which printer posts what, where, how often</span></div>
          <button
            type="button"
            onClick={() => setEditRule("new")}
            disabled={chans.length === 0}
            title={chans.length === 0 ? "Add a Discord channel first" : "Add a rule"}
            className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40 disabled:no-underline"
          >
            <Plus size={12} /> Add rule
          </button>
        </div>
        {rules.data && rules.data.items.length === 0 ? (
          <div className="text-xs text-muted dark:text-slate-400 italic border border-line dark:border-slate-700 rounded p-3">
            No rules yet. {chans.length === 0 ? "Add a Discord channel above, then" : "Click"} “Add rule” to post updates - e.g. every 10% or every 30 min, whichever comes first.
          </div>
        ) : (
          <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
            {(rules.data?.items ?? []).map((r) => (
              <li key={r.id} className="flex items-center hover:bg-subtle dark:hover:bg-slate-800">
                <button type="button" onClick={() => setEditRule(r)} className="flex-1 min-w-0 text-left px-3 py-2 flex items-center gap-2">
                  <span className={"w-1.5 h-1.5 rounded-full shrink-0 " + (r.enabled ? "bg-moss-500" : "bg-faint")} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-content dark:text-mortar-100 truncate">{r.label}</span>
                    <span className="block text-[11px] text-faint truncate">{ruleSummary(r, chans)}</span>
                  </span>
                </button>
                <button type="button" onClick={() => dup.mutate(r)} disabled={dup.isPending} title="Duplicate this rule" className="px-2.5 text-faint hover:text-accent shrink-0"><Copy size={13} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editRule && (
        <RuleEditor
          slug={slug}
          rule={editRule === "new" ? null : editRule}
          channels={chans}
          printers={printers}
          onClose={() => setEditRule(null)}
          onSaved={() => { void qc.invalidateQueries({ queryKey: ["digifab-rules", slug] }); setEditRule(null); }}
          onDeleted={() => { void qc.invalidateQueries({ queryKey: ["digifab-rules", slug] }); setEditRule(null); toast.success("Rule removed"); }}
        />
      )}
    </div>
  );
}

function ruleSummary(r: DigifabRule, chans: DigifabChannel[]): string {
  const scope = r.scope_type === "all" ? "All printers" : r.scope_type === "printer" ? "One printer" : r.scope_type;
  const ch = chans.find((c) => c.id === r.channel_id)?.label ?? "—";
  const cad = r.cadence.length ? r.cadence.map((c) => `every ${c.every} ${c.type === "minutes" ? "min" : c.type}`).join(" or ") : "lifecycle only";
  const cap = r.cap_minutes ? `, ≤1/${r.cap_minutes}min` : "";
  return `${scope} → ${ch} · ${cad}${cap}`;
}

function ChannelsSection({ slug, channels }: { slug: string; channels: DigifabChannel[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const inval = () => void qc.invalidateQueries({ queryKey: ["digifab-channels", slug] });
  const create = useMutation({
    mutationFn: () => api.createDigifabChannel(slug, { label: label.trim(), webhook_url: url.trim() }),
    onSuccess: () => { toast.success("Channel added"); setLabel(""); setUrl(""); setAdding(false); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add channel"),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDigifabChannel(slug, id),
    onSuccess: () => { toast.success("Channel removed"); inval(); },
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testDigifabChannel(slug, id),
    onSuccess: () => toast.success("Test sent - check the channel"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Test failed"),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className={lbl}>Discord channels <span className="normal-case text-faint/70"> - defined once, used by any rule</span></div>
        {!adding && <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> Add channel</button>}
      </div>
      {channels.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded mb-2">
          {channels.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="text-content dark:text-mortar-100 flex-1 truncate">{c.label}</span>
              <button type="button" onClick={() => test.mutate(c.id)} disabled={test.isPending} title="Send a test message" className="text-faint hover:text-accent"><Send size={13} /></button>
              <button type="button" onClick={() => del.mutate(c.id)} disabled={del.isPending} title="Remove" className="text-faint hover:text-ember-500"><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="border border-line dark:border-slate-700 rounded p-2 space-y-1.5">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name - e.g. #prints" className={field} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Discord webhook URL - https://discord.com/api/webhooks/…" className={field} />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => create.mutate()} disabled={create.isPending || !label.trim() || !url.trim()} className="px-2.5 py-1 text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{create.isPending ? "…" : "Save"}</button>
            <button type="button" onClick={() => setAdding(false)} className="text-xs text-faint hover:text-content">Cancel</button>
            <span className="text-[11px] text-faint">Discord → channel → Edit → Integrations → Webhooks → New.</span>
          </div>
        </div>
      )}
    </div>
  );
}

const CADENCE_TYPES: DigifabCadence["type"][] = ["percent", "minutes", "layers"];
const EVENTS: { key: keyof DigifabRule["events"]; label: string }[] = [
  { key: "started", label: "Started" },
  { key: "progress", label: "Progress" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function RuleEditor({
  slug, rule, channels, printers, onClose, onSaved, onDeleted,
}: {
  slug: string;
  rule: DigifabRule | null;
  channels: DigifabChannel[];
  printers: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(rule?.label ?? "Print updates");
  const [scopeType, setScopeType] = useState<DigifabRule["scope_type"]>(rule?.scope_type ?? "all");
  const [scopeValue, setScopeValue] = useState<string>(rule?.scope_value ?? (printers[0]?.value ?? ""));
  const [channelId, setChannelId] = useState(rule?.channel_id ?? channels[0]?.id ?? "");
  const [events, setEvents] = useState<DigifabRule["events"]>(rule?.events ?? { progress: true, completed: true, failed: true });
  const [cadence, setCadence] = useState<DigifabCadence[]>(rule?.cadence ?? [{ type: "percent", every: 10 }]);
  const [cap, setCap] = useState<string>(rule?.cap_minutes != null ? String(rule.cap_minutes) : "");
  const [title, setTitle] = useState(rule?.message.title ?? "");
  const [body, setBody] = useState(rule?.message.body ?? "");
  const [photo, setPhoto] = useState(rule?.message.photo !== false);
  const [pre, setPre] = useState<DigifabStep[]>(rule?.pre_actions ?? []);
  const [post, setPost] = useState<DigifabStep[]>(rule?.post_actions ?? []);

  const preview = useQuery({
    queryKey: ["digifab-rule-preview", slug, title, body],
    queryFn: () => api.previewDigifabRule(slug, { title: title || undefined, body: body || undefined }),
  });

  const body_ = () => ({
    label: label.trim() || "Print updates",
    scope_type: scopeType,
    scope_value: scopeType === "printer" ? scopeValue : null,
    channel_id: channelId,
    events,
    cadence,
    cap_minutes: cap.trim() ? Math.max(1, Math.round(Number(cap))) : null,
    message: { title: title.trim() || undefined, body: body.trim() || undefined, photo },
    pre_actions: pre,
    post_actions: post,
    enabled: rule?.enabled ?? true,
  });
  const save = useMutation({
    mutationFn: () => (rule ? api.patchDigifabRule(slug, rule.id, body_()) : api.createDigifabRule(slug, body_())),
    onSuccess: onSaved,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save rule"),
  });
  const del = useMutation({ mutationFn: () => api.deleteDigifabRule(slug, rule!.id), onSuccess: onDeleted });
  // Fire a real update right now against the chosen printer's live telemetry.
  const testFire = useMutation({
    mutationFn: () => api.testFireDigifabRule(slug, {
      channel_id: channelId,
      message: { title: title.trim() || undefined, body: body.trim() || undefined, photo },
      scope_type: scopeType, scope_value: scopeType === "printer" ? scopeValue : null,
      pre_actions: pre, post_actions: post,
    }),
    onSuccess: (r) => toast.success(`Sent to ${r.printer} — check the channel`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Test fire failed"),
  });

  const setCad = (i: number, patch: Partial<DigifabCadence>) => setCadence((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Modal open onClose={onClose} title={rule ? "Edit rule" : "New print-update rule"} size="lg">
      <div className="grid md:grid-cols-2 gap-4 text-sm">
        {/* Left — the rule */}
        <div className="space-y-3">
          <label className="block">
            <span className={lbl + " block mb-1"}>Name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
          </label>

          <div>
            <span className={lbl + " block mb-1"}>Which printers</span>
            <div className="flex gap-1.5">
              <select value={scopeType} onChange={(e) => setScopeType(e.target.value as DigifabRule["scope_type"])} className={field + " flex-1"}>
                <option value="all">All printers</option>
                <option value="printer">A specific printer</option>
              </select>
              {scopeType === "printer" && (
                <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className={field + " flex-1"}>
                  {printers.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              )}
            </div>
          </div>

          <label className="block">
            <span className={lbl + " block mb-1"}>Post to</span>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={field}>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>

          <div>
            <span className={lbl + " block mb-1"}>Send on</span>
            <div className="flex flex-wrap gap-2">
              {EVENTS.map((e) => (
                <label key={e.key} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={!!events[e.key]} onChange={(ev) => setEvents((x) => ({ ...x, [e.key]: ev.target.checked }))} />
                  {e.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className={lbl + " block mb-1"}>While printing, every <span className="normal-case text-faint/70"> - whichever comes first</span></span>
            <div className="space-y-1.5">
              {cadence.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input type="number" min={1} value={c.every} onChange={(e) => setCad(i, { every: Math.max(1, Number(e.target.value) || 1) })} className={field + " !w-20"} />
                  <select value={c.type} onChange={(e) => setCad(i, { type: e.target.value as DigifabCadence["type"] })} className={field + " !w-32"}>
                    {CADENCE_TYPES.map((t) => <option key={t} value={t}>{t === "minutes" ? "minutes" : t}</option>)}
                  </select>
                  {i > 0 && <span className="text-[10px] text-faint">or</span>}
                  <button type="button" onClick={() => setCadence((x) => x.filter((_, j) => j !== i))} className="text-faint hover:text-ember-500"><X size={13} /></button>
                </div>
              ))}
              <button type="button" onClick={() => setCadence((x) => [...x, { type: "minutes", every: 30 }])} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> add a condition</button>
            </div>
          </div>

          <label className="block">
            <span className={lbl + " block mb-1"}>But no more than once every</span>
            <div className="flex items-center gap-1.5">
              <input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="—" className={field + " !w-20"} />
              <span className="text-xs text-faint">minutes (optional cap)</span>
            </div>
          </label>
        </div>

        {/* Right — the message + preview */}
        <div className="space-y-3">
          <label className="block">
            <span className={lbl + " block mb-1"}>Title <span className="normal-case text-faint/70">— {`{{param}}`} ok</span></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="{{printer}} · Print {{event}}" className={field + " font-mono text-xs"} />
          </label>
          <label className="block">
            <span className={lbl + " block mb-1"}>Message</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder={"**{{model}}**\nProgress · {{percent}}\nRemaining · {{remaining}}\nElapsed · {{elapsed}}"} className={field + " font-mono text-xs"} />
          </label>
          <div className="text-[11px] text-faint leading-relaxed">
            Params: {"{{printer}} {{model}} {{percent}} {{remaining}} {{elapsed}} {{eta}} {{layer}} {{total_layers}} {{nozzle}} {{bed}} {{event}}"}. A line is shown only if at least one of its {"{{fields}}"} has a value - so a line that would come out all-empty (e.g. “Remaining · ” when the printer doesn’t report it) is hidden instead of left blank. Leave the whole box blank for the default message.
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} /> Attach the live camera photo
          </label>

          <div>
            <span className={lbl + " block mb-1"}>Before posting <span className="normal-case text-faint/70"> - e.g. light on, then settle</span></span>
            <StepEditor steps={pre} onChange={setPre} />
          </div>
          <div>
            <span className={lbl + " block mb-1"}>After posting <span className="normal-case text-faint/70"> - e.g. wait, light off</span></span>
            <StepEditor steps={post} onChange={setPost} />
          </div>

          <div className="rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-2">
            <div className={lbl + " mb-1"}>Preview</div>
            <div className="border-l-2 border-accent pl-2">
              <div className="text-sm font-semibold text-content dark:text-mortar-100">{preview.data?.title ?? "…"}</div>
              <div className="text-xs text-muted dark:text-slate-300 whitespace-pre-wrap">{preview.data?.body ?? ""}</div>
              {photo && <div className="mt-1.5 h-20 rounded bg-black/20 flex items-center justify-center text-[10px] text-faint">📷 live photo</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-line dark:border-slate-700">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !channelId} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{save.isPending ? "Saving…" : "Save rule"}</button>
        <button type="button" onClick={() => testFire.mutate()} disabled={testFire.isPending || !channelId} title="Send a real update right now from this printer's live telemetry" className="px-3 py-1.5 text-sm rounded border border-accent text-accent hover:bg-accent/10 disabled:opacity-50">{testFire.isPending ? "Firing…" : "Test fire now"}</button>
        <button type="button" onClick={onClose} className="text-sm text-faint hover:text-content">Cancel</button>
        <div className="flex-1" />
        {rule && <button type="button" onClick={() => del.mutate()} disabled={del.isPending} className="text-sm text-faint hover:text-ember-500">Delete</button>}
      </div>
    </Modal>
  );
}

// Pre/post hook step editor — a small list of "Light on/off" (the chamber
// light) + "Wait Ns".
// Maps to the engine's RuleStep ({control:"light",params:{on}} | {wait_ms}).
type StepKind = "light_on" | "light_off" | "wait";
function stepKind(s: DigifabStep): StepKind {
  if ("wait_ms" in s) return "wait";
  return (s.params as { on?: boolean })?.on === false ? "light_off" : "light_on";
}
function makeStep(kind: StepKind, seconds = 6): DigifabStep {
  if (kind === "wait") return { wait_ms: Math.max(0, Math.round(seconds * 1000)) };
  return { control: "light", params: { on: kind === "light_on" } };
}
function StepEditor({ steps, onChange }: { steps: DigifabStep[]; onChange: (s: DigifabStep[]) => void }) {
  const set = (i: number, s: DigifabStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  return (
    <div className="space-y-1.5">
      {steps.map((s, i) => {
        const kind = stepKind(s);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={kind}
              onChange={(e) => set(i, makeStep(e.target.value as StepKind, "wait_ms" in s ? s.wait_ms / 1000 : 6))}
              className={field + " !w-36"}
            >
              {/* Short labels so the on/off state can't be truncated away by a
                  narrow native <select> on mobile (the author: "cuts off on vs off"). */}
              <option value="light_on">Light on</option>
              <option value="light_off">Light off</option>
              <option value="wait">Wait</option>
            </select>
            {kind === "wait" && (
              <>
                <input
                  type="number"
                  min={0}
                  value={"wait_ms" in s ? s.wait_ms / 1000 : 0}
                  onChange={(e) => set(i, { wait_ms: Math.max(0, Math.round(Number(e.target.value) * 1000)) })}
                  className={field + " !w-16"}
                />
                <span className="text-xs text-faint">s</span>
              </>
            )}
            <button type="button" onClick={() => onChange(steps.filter((_, j) => j !== i))} className="text-faint hover:text-ember-500"><X size={13} /></button>
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...steps, makeStep("light_on")])} className="flex items-center gap-1 text-xs text-accent hover:underline"><Plus size={12} /> add a step</button>
    </div>
  );
}

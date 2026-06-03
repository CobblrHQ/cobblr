// /build — the AI App Builder (core-authoring, Phase 1: copy-paste).
//
// Describe what you want → the site compiles a prompt → you run it in your
// own ChatGPT/Claude → paste the manifest back → the kernel validates it
// (the SAME gate as /bundles/install, so a valid candidate is guaranteed
// installable) → preview → apply. Zero inference cost to us; the value
// loop proven on someone else's compute. See
// docs/modules/ai-bundle-builder.md.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wand2, Copy, Check, AlertTriangle } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type BundleValidation } from "../lib/api";

// Tolerant: pull the first {…} block out of a paste (handles "Here's your
// bundle: { … }" prose around the JSON).
function extractJson(raw: string): unknown {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return undefined;
  try {
    return JSON.parse(raw.slice(s, e + 1));
  } catch {
    return undefined;
  }
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Copied" : label}
    </button>
  );
}

export function BuildPage() {
  usePageTitle("Build");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [intent, setIntent] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [validation, setValidation] = useState<BundleValidation | null>(null);
  const [busy, setBusy] = useState<null | "compile" | "validate" | "apply" | "repair">(null);

  const kinds = useQuery({
    queryKey: ["build-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  const kindItems = kinds.data?.items ?? [];

  const toggleKind = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      else toast.error("Pick at most 3 kinds — fewer is more reliable.");
      return next;
    });

  async function buildPrompt() {
    if (!intent.trim()) return;
    setBusy("compile");
    setValidation(null);
    setPasteText("");
    try {
      const r = await api.authoringCompile(slug, { intent: intent.trim(), selected_kinds: [...selected] });
      setDraftId(r.draft_id);
      setPrompt(r.prompt);
      setWarnings(r.warnings ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the prompt.");
    } finally {
      setBusy(null);
    }
  }

  async function validate() {
    if (!draftId) return;
    const manifest = extractJson(pasteText);
    if (manifest === undefined) {
      toast.error("Couldn't find a JSON object in what you pasted.");
      return;
    }
    setBusy("validate");
    try {
      setValidation(await api.authoringCandidate(slug, draftId, manifest));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function copyRepairPrompt() {
    if (!draftId) return;
    setBusy("repair");
    try {
      const { prompt: rp } = await api.authoringRepairPrompt(slug, draftId);
      await navigator.clipboard.writeText(rp).catch(() => {});
      toast.success("Repair prompt copied — run it, then paste the fix back.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build a repair prompt.");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!draftId) return;
    setBusy("apply");
    try {
      await api.authoringApply(slug, draftId);
      toast.success("Applied — your fields/wires are live.");
      // reset for another build
      setValidation(null);
      setPrompt(null);
      setDraftId(null);
      setPasteText("");
      setIntent("");
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed.");
    } finally {
      setBusy(null);
    }
  }

  const preview = validation?.preview;
  const canApply = !!validation?.valid;
  const label = useMemo(() => (s: string) => s.split(":")[1] ?? s, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Wand2 size={20} className="text-accent" /> Build
        </h1>
        <p className="text-sm text-muted dark:text-slate-400 mt-1">
          Describe what you want to add. We'll write a prompt you run in any AI — paste the result back and we'll
          check it works before anything changes.
        </p>
      </div>

      {/* Step 1 — pick kinds + intent */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div>
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-2">
            What does this touch? (pick 1–3)
          </span>
          <div className="flex flex-wrap gap-2">
            {kindItems.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => toggleKind(k.id)}
                className={
                  "px-3 py-1 rounded-full text-sm border transition " +
                  (selected.has(k.id)
                    ? "bg-cobble-600 border-cobble-600 text-white"
                    : "border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:border-accent")
                }
                title={k.id}
              >
                {k.display_name}
              </button>
            ))}
            {kindItems.length === 0 && (
              <span className="text-xs text-faint italic">No entity kinds yet — enable a domain module first.</span>
            )}
          </div>
        </div>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
            What do you want to add?
          </span>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={3}
            placeholder="e.g. add a 'warranty expires' date to parts, and when one is low on stock, print a reorder label"
            className="w-full px-3 py-2 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <button
          type="button"
          onClick={buildPrompt}
          disabled={!intent.trim() || busy === "compile"}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
        >
          <Wand2 size={14} /> {busy === "compile" ? "Building…" : "Build prompt"}
        </button>
      </section>

      {/* Step 2 — the compiled prompt + paste-back */}
      {prompt && (
        <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
              1. Copy this prompt → run it in your AI
            </span>
            <CopyButton text={prompt} label="Copy prompt" />
          </div>
          <pre className="text-xs whitespace-pre-wrap bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-64 overflow-auto text-content dark:text-mortar-200">
            {prompt}
          </pre>
          {warnings.length > 0 && (
            <ul className="text-[11px] text-amber-600 dark:text-amber-400 space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}</li>
              ))}
            </ul>
          )}
          <div>
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
              2. Paste the result here
            </span>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={6}
              placeholder='{ "id": "cobblr.user.…", "field_defs": [ … ], "wires": [ … ] }'
              className="w-full px-3 py-2 text-xs font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </div>
          <button
            type="button"
            onClick={validate}
            disabled={!pasteText.trim() || busy === "validate"}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
          >
            {busy === "validate" ? "Checking…" : "Check it"}
          </button>
        </section>
      )}

      {/* Step 3 — preview (valid) or errors (repairable) */}
      {validation && (
        <section
          className={
            "rounded-xl border p-4 space-y-3 " +
            (validation.valid
              ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-900/10"
              : "border-ember-300 dark:border-ember-700 bg-ember-50/50 dark:bg-ember-900/10")
          }
        >
          {validation.valid && preview ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <Check size={16} /> Looks good — here's what it'll do:
              </div>
              {preview.fields_added.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Fields added</div>
                  <ul className="text-sm text-content dark:text-mortar-100 space-y-0.5">
                    {preview.fields_added.map((f, i) => (
                      <li key={i}>
                        <span className="font-medium">{f.display_label}</span>{" "}
                        <span className="text-faint font-mono text-xs">({label(f.entity_kind)} · {f.type})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.wires_added.length > 0 && (
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Automations</div>
                  <ul className="text-sm text-content dark:text-mortar-100 space-y-0.5">
                    {preview.wires_added.map((w, i) => (
                      <li key={i}>
                        <span className="font-mono text-xs">{label(w.source_kind)}</span> → <span className="font-medium">{w.action_id}</span>{" "}
                        <span className="text-faint text-xs">({w.trigger_type})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.modules_to_enable.length > 0 && (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  Will enable: {preview.modules_to_enable.join(", ")}
                </div>
              )}
              <button
                type="button"
                onClick={apply}
                disabled={!canApply || busy === "apply"}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                {busy === "apply" ? "Applying…" : "Apply"}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-ember-700 dark:text-ember-300">
                <AlertTriangle size={16} /> Not quite — a few things to fix:
              </div>
              <ul className="text-sm text-content dark:text-mortar-100 space-y-1">
                {validation.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ember-500">{e.code}</span>{" "}
                    {e.message}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={copyRepairPrompt}
                disabled={busy === "repair"}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
              >
                <Copy size={14} /> {busy === "repair" ? "…" : "Copy repair prompt"}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

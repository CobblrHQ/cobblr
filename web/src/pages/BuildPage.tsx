// /build — the AI App Builder (core-authoring, Phase 1: copy-paste).
//
// Describe what you want → the site compiles a prompt → you run it in your
// own ChatGPT/Claude → paste the manifest back → the kernel validates it
// (the SAME gate as /bundles/install, so a valid candidate is guaranteed
// installable) → preview → apply. Zero inference cost to us; the value
// loop proven on someone else's compute. See
// docs/modules/ai-bundle-builder.md.

import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiOffNotice, useAiStatus } from "../components/AiStatusNotice";
import { generateYourApp } from "../lib/generate-your-app";
import { suggestFeatured } from "../lib/suggest-featured";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Wand2, Copy, Check, AlertTriangle, Sparkles } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type BundleValidation } from "../lib/api";

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

// Collapsible raw view of the bundle the AI produced — transparency for the
// hosted path (where the user never typed/pasted it).
function BundleDetails({ candidate, label = "Show the generated bundle" }: { candidate: unknown; label?: string }) {
  if (!candidate || typeof candidate !== "object") return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-faint hover:text-accent select-none">{label}</summary>
      <pre className="mt-2 whitespace-pre-wrap bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-72 overflow-auto font-mono text-content dark:text-mortar-200">
        {JSON.stringify(candidate, null, 2)}
      </pre>
    </details>
  );
}

export function BuildPage() {
  usePageTitle("Build");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const toast = useToast();

  // "tweak" = add a field/wire to existing kinds (pick 1-3). "workspace" = the
  // architect: describe a whole app, the AI enables modules + builds the schema
  // from the full catalog (no kind picker, task=design-workspace).
  // Mode init: honor a ?mode= deep-link (the homepage funnel's "Describe what
  // you have" promises a whole-workspace setup → /build?mode=workspace). The
  // old default landed funnel users on the wrong task.
  const [searchParams] = useSearchParams();
  const aiStatus = useAiStatus();
  const aiOff = !!aiStatus && !aiStatus.available;
  const urlMode = searchParams.get("mode");
  const [mode, setMode] = useState<"tweak" | "workspace" | "app" | "app-custom">(
    urlMode === "workspace" || urlMode === "app" || urlMode === "app-custom" || urlMode === "tweak" ? urlMode : "tweak",
  );
  const navigate = useNavigate();
  // The compile/build body per mode: tweak → a bundle scoped to picked kinds;
  // workspace → a whole-workspace bundle; app → a worker app (structured blocks);
  // app-custom → a custom HTML app (design-app-custom).
  const buildArgs = () =>
    mode === "workspace"
      ? { intent: intent.trim(), task: "design-workspace" }
      : mode === "app"
        ? { intent: intent.trim(), task: "design-app" }
        : mode === "app-custom"
          ? { intent: intent.trim(), task: "design-app-custom" }
          : { intent: intent.trim(), selected_kinds: [...selected] };
  // Both app tasks create a WorkspaceApp + have no bundle diff/preview.
  const isAppMode = mode === "app" || mode === "app-custom";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [intent, setIntent] = useState("");
  // Ready-made catch: if the intent reads like a curated featured bundle
  // ("track Books" → Bookshelf), offer the refined install BEFORE burning AI
  // on a worse hand-rolled version (the templates-first cheap path).
  const liveInstances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const readyMade = useMemo(() => {
    if (intent.trim().length < 8) return null;
    const live = new Set((liveInstances.data?.items ?? []).map((i) => i.instance_name));
    return suggestFeatured(intent, live);
  }, [intent, liveInstances.data]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [validation, setValidation] = useState<BundleValidation | null>(null);
  const [candidate, setCandidate] = useState<unknown>(null);
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [seedCount, setSeedCount] = useState(0); // starter records apply will create
  const [refineText, setRefineText] = useState(""); // Phase 3: "now change X" on the current candidate
  const [busy, setBusy] = useState<null | "building" | "compile" | "validate" | "apply" | "repair">(null);

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

  // Hosted (Phase 2): the server calls AI itself + auto-repairs. ASYNC — /build
  // returns a "building" draft id immediately (a whole-workspace generation runs
  // ~150s, past any proxy timeout), so we poll the draft until it's done. Falls
  // back to the copy-paste prompt when the workspace has no AI.
  async function buildHosted() {
    if (!intent.trim()) return;
    setBusy("building");
    setValidation(null);
    setPasteText("");
    setPrompt(null);
    setCandidate(null);
    setInterpretation(null);
    setSeedCount(0);
    try {
      const r = await api.authoringBuild(slug, buildArgs());
      setDraftId(r.draft_id);

      const started = Date.now();
      while (Date.now() - started < 330_000) {
        await new Promise((res) => setTimeout(res, 3000));
        let d;
        try {
          d = await api.authoringDraft(slug, r.draft_id);
        } catch {
          continue; // transient — keep polling
        }
        if (d.status === "building") continue;
        if (d.status === "failed") {
          const err = d.validation?.errors?.[0];
          if (err?.code === "no_ai_provider") {
            toast.success("AI isn't enabled for this workspace — switching to the copy-paste prompt.");
            await buildPrompt();
            return;
          }
          toast.error(err?.message ?? "Build failed.");
          return;
        }
        setCandidate(d.candidate ?? null);
        setInterpretation(d.interpretation ?? null);
        setSeedCount((d.seed_plan ?? []).reduce((n, g) => n + (g.records?.length ?? 0), 0));
        if (d.validation) setValidation(d.validation);
        if (d.status === "validated") toast.success("Built it. Review and apply.");
        else toast.error("The AI's result didn't pass validation — see the errors below, or write a prompt to run yourself.");
        return;
      }
      toast.error("That took longer than expected — try again in a moment.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.success("AI isn't enabled for this workspace — switching to the copy-paste prompt.");
        await buildPrompt();
        return;
      }
      toast.error(e instanceof ApiError ? e.message : "Build failed.");
    } finally {
      setBusy(null);
    }
  }

  async function buildPrompt() {
    if (!intent.trim()) return;
    setBusy("compile");
    setValidation(null);
    setPasteText("");
    try {
      const r = await api.authoringCompile(slug, buildArgs());
      setDraftId(r.draft_id);
      setPrompt(r.prompt);
      setWarnings(r.warnings ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the prompt.");
    } finally {
      setBusy(null);
    }
  }

  // Phase 3 refine: revise the CURRENT candidate against a change request —
  // "now add a price column" — instead of re-describing from scratch. A new
  // draft (parent lineage) replaces the current one; same poll, same gate.
  // No AI provider → fall back to the copy-paste refine prompt.
  async function refine() {
    const change = refineText.trim();
    const parentId = draftId;
    if (!change || !parentId) return;
    setBusy("building");
    try {
      const r = await api.authoringRefine(slug, parentId, { intent: change, run: true });
      setDraftId(r.draft_id);
      setRefineText("");
      const started = Date.now();
      while (Date.now() - started < 330_000) {
        await new Promise((res) => setTimeout(res, 3000));
        let d;
        try {
          d = await api.authoringDraft(slug, r.draft_id);
        } catch {
          continue; // transient — keep polling
        }
        if (d.status === "building") continue;
        if (d.status === "failed") {
          const err = d.validation?.errors?.[0];
          if (err?.code === "no_ai_provider") {
            // Copy-paste path: fresh refine draft carrying the prompt.
            const p = await api.authoringRefine(slug, parentId, { intent: change, run: false });
            setDraftId(p.draft_id);
            setPrompt(p.prompt ?? null);
            setWarnings(p.warnings ?? []);
            toast.success("AI isn't enabled here — copy the refine prompt into your agent and paste the result back.");
            return;
          }
          toast.error(err?.message ?? "Refine failed.");
          return;
        }
        setCandidate(d.candidate ?? null);
        setInterpretation(d.interpretation ?? null);
        if (d.validation) setValidation(d.validation);
        if (d.status === "validated") toast.success("Refined — review and apply.");
        else toast.error("The refined result didn't pass validation — see the errors below.");
        return;
      }
      toast.error("That took longer than expected — try again in a moment.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refine failed.");
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
    setCandidate(manifest);
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
      const r = await api.authoringApply(slug, draftId);
      // design-app: a WorkspaceApp was created — open it.
      if (r.app) {
        toast.success(`App "${r.app.name}" created.`);
        navigate(`/app/${r.app.slug}`);
        return;
      }
      const created = r.seeded?.created ?? 0;
      toast.success(
        created > 0
          ? `Applied — your fields/wires are live, plus ${created} starter record${created === 1 ? "" : "s"} created.`
          : "Applied — your fields/wires are live.",
      );
      // reset for another build
      setValidation(null);
      setCandidate(null);
      setInterpretation(null);
      setSeedCount(0);
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
  const addsSomething =
    !!preview &&
    preview.fields_added.length +
      preview.wires_added.length +
      preview.modules_to_enable.length +
      (preview.instances_created?.length ?? 0) +
      (preview.nav_headings?.length ?? 0) >
      0;
  // Valid but empty = the AI couldn't turn the description into changes. Don't
  // pretend "looks good" — apply would be a no-op.
  // App apply just needs a valid definition (no bundle "preview"/diff exists for
  // an app). Bundle apply needs the diff to actually add something.
  const canApply = isAppMode ? !!validation?.valid : (!!validation?.valid && addsSomething);
  const label = useMemo(() => (s: string) => s.split(":")[1] ?? s, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Wand2 size={20} className="text-accent" /> Build
        </h1>
        <p className="text-sm text-muted dark:text-slate-400 mt-1">
          {mode === "app-custom" ? (
            <>
              Describe a <strong>custom app</strong> — the AI writes a small self-contained HTML/JS page that runs in a
              sandbox and reads/writes your workspace only through Cobblr's mediated bridge (so it can never exceed what
              you can do). For when the structured blocks aren't enough. We validate it before it goes live.
            </>
          ) : mode === "app" ? (
            <>
              Describe a <strong>page for your members</strong> — forms, action buttons and a scanner over
              your existing data. The AI assembles it from safe building blocks (no code), and we check it before it goes
              live. Or skip the prompt: <strong>Generate from my workspace</strong> builds one instantly from your
              trackers — no AI needed — and you can regenerate it any time they change.
            </>
          ) : mode === "workspace" ? (
            <>
              Describe your <strong>whole workspace</strong> in one go — the AI turns on the modules you need and builds
              the fields and automations for your entire workflow. <strong>Build it for me</strong> runs it and checks
              the result before anything changes.
            </>
          ) : (
            <>
              Describe what you want to add and <strong>Build it for me</strong> — we run the AI, fix it up, and check it
              works before anything changes. No AI on your workspace? <strong>Write a prompt instead</strong> hands you
              one to run yourself.
            </>
          )}
        </p>
      </div>

      {/* One shared AI-honesty pattern (redesign A1): the primary button needs
          AI — say so up front instead of failing silently. */}
      <AiOffNotice status={aiStatus}>
        <strong>AI isn't connected — "Build it for me" can't run here.</strong>{" "}
        Use <strong>Write a prompt instead</strong>: it hands you a complete prompt to run in any AI chat, and you paste
        the result back in — same outcome, your AI.{" "}
      </AiOffNotice>

      {mode === "app" && (
        <button
          type="button"
          onClick={() =>
            void generateYourApp(slug)
              .then((r) => {
                toast.success(`${r.created ? "Generated" : "Regenerated"} "Your app" — ${r.pages} pages from your trackers.`);
                navigate(`/app/${r.app.slug}`);
              })
              .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't generate the app"))
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
        >
          <Sparkles size={14} /> Generate from my workspace — no AI needed
        </button>
      )}

      {/* Mode — one tweak vs. design the whole workspace */}
      <div className="inline-flex rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-0.5 text-sm">
        {(["tweak", "workspace", "app", "app-custom"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={
              "px-3 py-1.5 rounded-md font-medium transition " +
              (mode === m
                ? "bg-cobble-600 text-white"
                : "text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-200")
            }
          >
            {/* User nouns, not platform jargon ("worker app" meant nothing
                to a new user — redesign A2). */}
            {m === "tweak"
              ? "Add to what I have"
              : m === "workspace"
                ? "Design my workspace"
                : m === "app"
                  ? "A page for members"
                  : "Custom page (HTML)"}
          </button>
        ))}
      </div>

      {/* Step 1 — pick kinds + intent */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        {mode === "tweak" && (
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
        )}
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
            {mode === "workspace"
              ? "Describe the workspace you want"
              : isAppMode
                ? "Describe the app you want"
                : "What do you want to add?"}
          </span>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={mode === "tweak" ? 3 : 6}
            placeholder={
              mode === "workspace"
                ? "e.g. A yarn & crochet tracker. I design patterns (wearables, toys, blankets), each links to a PDF or URL and lists the yarn and hook sizes it needs. Track yarn by colour, weight and metres left, and a hooks section with sizes 1–10mm and how many I own."
                : mode === "app-custom"
                  ? "e.g. a colour-coded wall board of my parts grouped by location, with a search box and a low-stock highlight — reading my live inventory."
                  : mode === "app"
                    ? "e.g. a quick intake page for the front desk: a short intro, a form to add a new part, a 'print label' button, and the barcode scanner."
                    : "e.g. add a 'warranty expires' date to parts, and when one is low on stock, print a reorder label"
            }
            className="w-full px-3 py-2 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          {readyMade && !isAppMode && (
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 px-3 py-2 text-sm">
              <span className="text-lg leading-none shrink-0">{readyMade.bundle.glyph}</span>
              <span className="flex-1 text-moss-800 dark:text-moss-200">
                There's a ready-made <strong>{readyMade.bundle.manifest.name}</strong> set-up for this ("{readyMade.matched}") —
                a refined bundle beats a generated one.
              </span>
              <Link
                to={`/bundles?open=${encodeURIComponent(readyMade.bundle.manifest.id)}`}
                className="shrink-0 rounded-md bg-moss-600 hover:bg-moss-700 text-white text-xs font-medium px-2.5 py-1"
              >
                View &amp; install
              </Link>
            </div>
          )}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {/* With no AI, the roles swap: the copy-paste prompt is the real
              path, so IT gets the primary style and "Build it for me" is
              disabled with a reason (not silently inert). */}
          <button
            type="button"
            onClick={buildHosted}
            disabled={!intent.trim() || busy !== null || aiOff}
            title={aiOff ? "Needs a connected AI provider" : undefined}
            className={
              "inline-flex items-center gap-1.5 rounded-md text-sm font-medium px-3 py-1.5 transition disabled:opacity-50 " +
              (aiOff
                ? "border border-line dark:border-slate-600 text-muted dark:text-slate-400"
                : "bg-cobble-600 hover:bg-cobble-700 text-white")
            }
          >
            <Sparkles size={14} /> {busy === "building" ? "Building…" : "Build it for me"}
          </button>
          <button
            type="button"
            onClick={buildPrompt}
            disabled={!intent.trim() || busy !== null}
            className={
              "inline-flex items-center gap-1.5 rounded-md text-sm font-medium px-3 py-1.5 transition disabled:opacity-50 " +
              (aiOff
                ? "bg-cobble-600 hover:bg-cobble-700 text-white"
                : "border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800")
            }
          >
            <Wand2 size={14} /> {busy === "compile" ? "Writing…" : "Write a prompt instead"}
          </button>
        </div>
        {busy === "building" && (
          <p className="text-xs text-faint dark:text-slate-500 flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
            {mode === "workspace"
              ? "Turning on the modules you need and building your fields + automations, then validating it. This takes a minute or two…"
              : "Running the AI, then checking the result against the validator (auto-retrying if needed). A few seconds…"}
          </p>
        )}
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
          {interpretation && (
            <div className="flex gap-2 text-sm text-content dark:text-mortar-100 bg-surface/70 dark:bg-slate-900/50 border border-line dark:border-slate-700 rounded-lg px-3 py-2">
              <Sparkles size={15} className="text-accent shrink-0 mt-0.5" />
              <span className="italic">{interpretation}</span>
            </div>
          )}
          {validation.valid && addsSomething && preview ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <Check size={16} /> Here's what it'll do:
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
              {(preview.instances_created ?? []).map((inst) => (
                <div key={inst.instance_name}>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
                    New section · <span className="text-emerald-600 dark:text-emerald-400">{inst.display_name}</span>
                    <span className="normal-case text-faint"> (a {inst.item_noun ?? "record"} tracker)</span>
                  </div>
                  <ul className="text-sm text-content dark:text-mortar-100 space-y-0.5">
                    {inst.fields.length === 0 ? (
                      <li className="text-faint text-xs">just the name to start</li>
                    ) : (
                      inst.fields.map((f, i) => (
                        <li key={i}>
                          <span className="font-medium">{f.display_label}</span>{" "}
                          <span className="text-faint font-mono text-xs">({f.type})</span>
                        </li>
                      ))
                    )}
                    {inst.wires > 0 && <li className="text-faint text-xs">+ {inst.wires} automation{inst.wires === 1 ? "" : "s"}</li>}
                  </ul>
                </div>
              ))}
              {(preview.nav_headings ?? []).map((h) => (
                <div key={h.name}>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Nav grouping</div>
                  <div className="text-sm text-content dark:text-mortar-100">
                    Group <span className="font-medium">{h.members.map((m) => m.target_id).join(", ")}</span> under a{" "}
                    <span className="font-medium">{h.name}</span> heading.
                  </div>
                </div>
              ))}
              {typeof (candidate as { install_featured?: unknown })?.install_featured === "string" && (
                <div className="text-xs text-moss-700 dark:text-moss-300 rounded border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 p-2">
                  Installs the ready-made{" "}
                  <strong>{String((candidate as { install_featured: string }).install_featured).split(".").pop()}</strong>{" "}
                  bundle, then adds only what's listed above on top of it.
                </div>
              )}
              {preview.modules_to_enable.length > 0 && (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  Will enable: {preview.modules_to_enable.join(", ")}
                </div>
              )}
              {seedCount > 0 && (
                <div className="text-xs text-content dark:text-mortar-200">
                  Plus <strong>{seedCount}</strong> starter record{seedCount === 1 ? "" : "s"} will be created.
                </div>
              )}
              <BundleDetails candidate={candidate} />
              <button
                type="button"
                onClick={apply}
                disabled={!canApply || busy === "apply"}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                {busy === "apply" ? "Applying…" : "Apply"}
              </button>
              {/* Phase 3 — react by ITERATING, not re-describing: refine the
                  current result with a change request before (or instead of)
                  applying. */}
              <div className="pt-3 mt-1 border-t border-line dark:border-slate-700">
                <div className="text-xs text-faint dark:text-slate-400 mb-1.5">
                  Not quite right? Describe a change and refine it:
                </div>
                <div className="flex gap-2">
                  <input
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void refine(); }}
                    placeholder='e.g. "also add a price column" or "drop the label wire"'
                    className="input !py-1.5 !text-sm flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => void refine()}
                    disabled={busy === "building" || !refineText.trim()}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 text-sm font-medium px-3 py-1.5 text-content dark:text-mortar-100 hover:border-accent hover:text-accent transition disabled:opacity-50"
                  >
                    {busy === "building" ? "Refining…" : "Refine"}
                  </button>
                </div>
              </div>
            </>
          ) : isAppMode && validation.valid ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                <Check size={16} /> Your app is ready
              </div>
              <BundleDetails candidate={candidate} label="Show the app definition" />
              <button
                type="button"
                onClick={apply}
                disabled={!canApply || busy === "apply"}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                {busy === "apply" ? "Creating…" : "Create app"}
              </button>
              {/* Phase 3 — apps refine too: same box as bundles, the route
                  picks refine-app from the parent draft's task. */}
              <div className="pt-3 mt-1 border-t border-line dark:border-slate-700">
                <div className="text-xs text-faint dark:text-slate-400 mb-1.5">
                  Not quite right? Describe a change and refine it:
                </div>
                <div className="flex gap-2">
                  <input
                    value={refineText}
                    onChange={(e) => setRefineText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void refine(); }}
                    placeholder='e.g. "add a scan block" or "make the intro friendlier"'
                    className="input !py-1.5 !text-sm flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => void refine()}
                    disabled={busy === "building" || !refineText.trim()}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 text-sm font-medium px-3 py-1.5 text-content dark:text-mortar-100 hover:border-accent hover:text-accent transition disabled:opacity-50"
                  >
                    {busy === "building" ? "Refining…" : "Refine"}
                  </button>
                </div>
              </div>
            </>
          ) : validation.valid ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle size={16} /> Nothing to apply
              </div>
              <p className="text-sm text-content dark:text-mortar-200">
                {interpretation
                  ? "No changes were generated — see why above. If that's not what you meant, try describing it more specifically (name the field, the kind it's on, and any automation)."
                  : "The AI didn't produce any concrete changes. Try describing it more specifically — e.g. \"add a 'warranty expires' date to parts, and print a reorder label when stock drops below the minimum.\""}
              </p>
              <BundleDetails candidate={candidate} label="Show what the AI returned" />
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
              <BundleDetails candidate={candidate} label="Show what the AI returned" />
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

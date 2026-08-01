// /build — the AI App Builder (core-authoring, Phase 1: copy-paste).
//
// Describe what you want → the site compiles a prompt → you run it in your
// own ChatGPT/Claude → paste the manifest back → the kernel validates it
// (the SAME gate as /bundles/install, so a valid candidate is guaranteed
// installable) → preview → apply. Zero inference cost to us; the value
// loop proven on someone else's compute. See
// docs/modules/ai-bundle-builder.md.

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiOffNotice, useAiStatus } from "../components/AiStatusNotice";
import { generateYourApp } from "../lib/generate-your-app";
import { suggestFeatured } from "../lib/suggest-featured";
import { suggestKinds } from "../lib/suggest-kinds";
import { useBundleDetail } from "../components/useBundleDetail";
import { useQuery } from "@tanstack/react-query";
import { Wand2, Copy, Check, AlertTriangle, Sparkles } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type BundleValidation } from "../lib/api";
import { Cobb } from "../components/Cobb";

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

/** Cobb at the bench, for any step that keeps you waiting.
 *
 *  One component rather than a copy per step: `busy` has five states and only
 *  `building` ever showed him, so the other four (writing the prompt, checking
 *  a paste, applying, writing a repair prompt) said nothing but a greyed button
 *  reading "Checking…". The pose IS the loading state — see
 *  docs/design-decisions/cobb-mascot-art.md — so a waiting state without him is
 *  a waiting state with no feedback. BuildPage.test.ts fails if a new `busy`
 *  state ships without one. */
function CobbAtWork({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 mt-2">
      <Cobb pose="working" size={54} className="shrink-0 cobb-lift" title="Cobb, at work" />
      <p className="text-xs text-faint dark:text-slate-500">{children}</p>
    </div>
  );
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
  // The ready-made callout opens its bundle HERE, so the intent you just typed
  // survives (house rule: a modal shows up on the page it was invoked from).
  const bundleDetail = useBundleDetail(slug);
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
          : { intent: intent.trim(), selected_kinds: effectiveScope };
  // Both app tasks create a WorkspaceApp + have no bundle diff/preview.
  const isAppMode = mode === "app" || mode === "app-custom";
  // Scope is DERIVED from the intent text (see suggest-kinds.ts). `manualScope`
  // is the escape hatch: null = "use what Cobblr worked out", a Set = the user
  // took over via Change. The old UI asked for this pick BEFORE the sentence,
  // as a chip per entity kind - the model's scope cap made the user's problem.
  const [manualScope, setManualScope] = useState<Set<string> | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const liveInstances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
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

  // What the sentence itself says it touches. Recomputed as you type; costs
  // nothing (pure string work over the kinds already fetched). Computed in BOTH
  // build modes, not just tweak: the tweak UI displays it, and both modes use
  // it to tell a MODIFICATION of what you have apart from a NEW thing (see
  // readyMade below).
  const derivedScope = useMemo(
    () => (isAppMode ? [] : suggestKinds(intent, kindItems)),
    [isAppMode, intent, kindItems],
  );
  // Ready-made catch: if the intent names something we already ship a refined
  // bundle for, offer THAT before burning AI on a worse hand-rolled version
  // (the templates-first cheap path).
  //
  // It fires in BOTH build modes and on a BARE NOUN. Typing "yarn" is the most
  // natural thing anyone does and it used to match nothing anywhere, because
  // the matcher demanded a "track/collect/…" verb AND an 8-character intent
  // (the author, 2026-08-01). What stops it hijacking a field tweak is no longer a
  // verb list but the workspace itself: a sentence that lands on kinds you
  // ALREADY HAVE is a modification ("add a warranty date to parts" → Part), so
  // there is no install to pitch. Landing on nothing means it is a new thing.
  const readyMade = useMemo(() => {
    if (isAppMode || intent.trim().length < 3 || derivedScope.length > 0) return null;
    const live = new Set((liveInstances.data?.items ?? []).map((i) => i.instance_name));
    return suggestFeatured(intent, live);
  }, [isAppMode, intent, derivedScope, liveInstances.data]);
  const effectiveScope = manualScope
    ? [...manualScope]
    : derivedScope.map((s) => s.kind.id);
  // Every word that put SOMETHING in scope, deduped - the "why", covering all
  // the chips rather than just the top one.
  const derivedWords = [...new Set(derivedScope.flatMap((s) => s.matched))];
  const scopeKinds = effectiveScope
    .map((id) => kindItems.find((k) => k.id === id))
    .filter((k): k is (typeof kindItems)[number] => !!k);

  const toggleKind = (id: string) =>
    setManualScope((prev) => {
      const next = new Set(prev ?? effectiveScope);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      else toast.error("Pick at most 3 kinds - fewer is more reliable.");
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
            toast.success("AI isn't enabled for this workspace - switching to the copy-paste prompt.");
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
        else toast.error("The AI's result didn't pass validation - see the errors below, or write a prompt to run yourself.");
        return;
      }
      toast.error("That took longer than expected - try again in a moment.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.success("AI isn't enabled for this workspace - switching to the copy-paste prompt.");
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
            toast.success("AI isn't enabled here - copy the refine prompt into your agent and paste the result back.");
            return;
          }
          toast.error(err?.message ?? "Refine failed.");
          return;
        }
        setCandidate(d.candidate ?? null);
        setInterpretation(d.interpretation ?? null);
        if (d.validation) setValidation(d.validation);
        if (d.status === "validated") toast.success("Refined - review and apply.");
        else toast.error("The refined result didn't pass validation - see the errors below.");
        return;
      }
      toast.error("That took longer than expected - try again in a moment.");
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
      toast.success("Repair prompt copied - run it, then paste the fix back.");
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
      setManualScope(null);
      setScopeOpen(false);
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

  // Cobb greets you only before you've actually run something (typing doesn't
  // dismiss him), so he and the mode picker share the whole setup phase — which
  // is why the picker can sit beside him instead of stranding dead space below.
  const greeting = !aiOff && !prompt && !validation && busy === null;
  const modeSelector = (
    // Two shapes, one control. Below lg: a 2x2 grid. The row's max-content is
    // 638px and the column beside Cobb only reaches that at ~770px wide, so
    // every phone AND every tablet would have had to scroll it sideways — which
    // hides half the modes behind a gesture nobody knows to make. From lg both
    // render sites have the room, so it's the segmented row.
    // The scroller belongs to the control, not the caller (the picker renders in
    // two places and only one had it once, so the standalone copy pushed the
    // whole page sideways). It should now never engage; it's the backstop for
    // browser font scaling.
    <div className="overflow-x-auto">
      <div className="grid grid-cols-2 lg:flex w-full lg:min-w-max rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-0.5 text-sm">
      {(["tweak", "workspace", "app", "app-custom"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={
            // In the grid a label may wrap (cells share a height, so a 2-line
            // label just makes both rows taller — no clipping, no page overflow
            // at 320px). In the row it must NOT: equal-width segments give
            // "Design my workspace" less room than its label needs, and a
            // wrapped label doubles the strip's height.
            "flex-1 text-center whitespace-normal lg:whitespace-nowrap px-2.5 py-1.5 rounded-md font-medium transition " +
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
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Wand2 size={20} className="text-accent" /> Build
        </h1>
        <p className="text-sm text-muted dark:text-slate-400 mt-1">
          {mode === "app-custom" ? (
            <>
              Describe a <strong>custom app</strong>  - the AI writes a small self-contained HTML/JS page that runs in a
              sandbox and reads/writes your workspace only through Cobblr's mediated bridge (so it can never exceed what
              you can do). For when the structured blocks aren't enough. We validate it before it goes live.
            </>
          ) : mode === "app" ? (
            <>
              Describe a <strong>page for your members</strong>  - forms, action buttons and a scanner over
              your existing data. The AI assembles it from safe building blocks (no code), and we check it before it goes
              live. Or skip the prompt: <strong>Generate from my workspace</strong> builds one instantly from your
              modules - no AI needed - and you can regenerate it any time they change.
            </>
          ) : mode === "workspace" ? (
            <>
              Describe your <strong>whole workspace</strong> in one go - the AI turns on the modules you need and builds
              the fields and automations for your entire workflow. <strong>Build it for me</strong> runs it and checks
              the result before anything changes.
            </>
          ) : (
            <>
              Describe what you want to add and <strong>Build it for me</strong>  - we run the AI, fix it up, and check it
              works before anything changes. No AI on your workspace? <strong>Write a prompt instead</strong> hands you
              one to run yourself.
            </>
          )}
        </p>
      </div>

      {/* Cobb greeting — the face of "just describe it". Only before you've
          started (no prompt/preview/build yet) and only when AI can actually do
          the work; he offers, he doesn't linger once you're going. */}
      {greeting && (
        // No card around the pair: Cobb stands on the PAGE and the copy is a
        // speech bubble at his side, so it reads as him talking. The mode picker
        // rides underneath the bubble, which is what stops his height from
        // becoming dead space (it used to sit stranded below a Cobb-tall box).
        // A grid, not nested flexes, so ONE picker serves both layouts: on a
        // phone it spans under Cobb and the bubble (full width, which is what
        // lets it be a 2x2 instead of a scroller); from sm it tucks into the
        // bubble's column. Rendering it twice behind `hidden`/`sm:hidden` would
        // put the same four buttons in the DOM twice.
        <div className="grid grid-cols-[auto_1fr] items-end gap-x-3 sm:gap-x-5 gap-y-3">
          {/* CSS height wins over the svg's height attribute, and w-auto lets the
              crop's aspect drive the width — so one element covers both sizes.
              The phone size is set by the bubble beside him: he's as tall as it
              is, and every px of him narrows it, so this is about as big as he
              goes before the copy starts stacking up. */}
          {/* lg:row-span-2 + self-end: in the row layout the picker sits in column
              2 UNDER the bubble, so Cobb has to span both rows to stand on the
              same baseline as it. Spanning only row 1 (the grid's default) left
              his feet level with the BOTTOM OF THE BUBBLE and the picker hanging
              below him, which is the misalignment the grid introduced. Below lg
              the picker spans both columns, so one row is correct there. */}
          <Cobb pose="idle" size={150} className="shrink-0 cobb-lift h-28 w-auto sm:h-[150px] lg:row-span-2 self-end" title="Cobb" />
          <div className="cobb-bubble relative min-w-0 rounded-xl border border-cobble-200 dark:border-slate-700 bg-mortar-50 dark:bg-slate-900 px-4 py-3 mb-1">
            <p className="text-base sm:text-lg font-semibold text-content dark:text-mortar-100">
              Tell me what you need.
            </p>
            <p className="text-sm text-muted dark:text-slate-400 mt-0.5">
              I'll cobble it together, verify it works, and leave it on the bench for you to look over.
            </p>
          </div>
          {/* In the row layout the picker reaches LEFT across the gap, right up
              to Cobb, while the bubble stays clear of him: the four nowrap labels
              want 638px and the column alone leaves 656px at full page width,
              which is closer than it looks. Below lg it spans both columns
              instead, which is the room that lets it be a 2x2. */}
          {/* min-w-0: a grid item defaults to min-width:auto, so without it the
              picker's own sm:min-w-max forces the 1fr column wider than the page
              and the whole page scrolls sideways (at ~640px, where the row is
              live but doesn't fit). The scroller can only do its job if the
              column is allowed to be narrower than its content. */}
          <div className="col-span-2 lg:col-span-1 lg:col-start-2 min-w-0 lg:-ml-5">{modeSelector}</div>
        </div>
      )}

      {/* One shared AI-honesty pattern (redesign A1): the primary button needs
          AI — say so up front instead of failing silently. */}
      <AiOffNotice status={aiStatus}>
        <strong>AI isn't connected - "Build it for me" can't run here.</strong>{" "}
        Use <strong>Write a prompt instead</strong>: it hands you a complete prompt to run in any AI chat, and you paste
        the result back in - same outcome, your AI.{" "}
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
          <Sparkles size={14} /> Generate from my workspace - no AI needed
        </button>
      )}

      {/* Mode — one tweak vs. design the whole workspace. While Cobb is greeting
          you it renders BESIDE him (above); on its own once he's gone. */}
      {!greeting && modeSelector}

      {/* Step 1 — pick kinds + intent */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
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
          {readyMade && (
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 px-3 py-2 text-sm">
              {/* `idea` is the SUGGEST pose, and this is the page's one suggest
                  moment: he's read what you typed and knows a better answer than
                  the one you asked for. The bundle's own glyph stays inline with
                  its name, where it identifies the bundle. */}
              <Cobb pose="idea" size={44} className="shrink-0 cobb-lift" title="Cobb has a suggestion" />
              <span className="flex-1 text-moss-800 dark:text-moss-200">
                There's a ready-made <span className="leading-none">{readyMade.bundle.glyph}</span>{" "}
                <strong>{readyMade.bundle.manifest.name}</strong> set-up for this ("{readyMade.matched}") - 
                a refined bundle beats a generated one.
              </span>
              <button
                type="button"
                onClick={() => bundleDetail.open(readyMade.bundle.manifest.id)}
                className="shrink-0 rounded-md bg-moss-600 hover:bg-moss-700 text-white text-xs font-medium px-2.5 py-1"
              >
                View &amp; install
              </button>
            </div>
          )}
        </label>

        {/* The scope, DERIVED and shown as a result rather than asked as the
            first question. It appears only once you've typed, says what it
            worked out and why, and hides the full kind picker behind "Change"
            for the rare miss (the author, 2026-08-01 - new-user-flow follow-up). */}
        {mode === "tweak" && intent.trim().length > 2 && kindItems.length > 0 && (
          <div className="text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {scopeKinds.length > 0 ? (
                <>
                  <span className="text-faint dark:text-slate-500">This will touch</span>
                  {scopeKinds.map((k) => (
                    <span
                      key={k.id}
                      title={k.id}
                      className="inline-flex items-center rounded-full border border-accent/50 bg-accent/5 text-accent px-2 py-0.5 font-medium"
                    >
                      {k.display_name}
                    </span>
                  ))}
                  {!manualScope && derivedWords.length > 0 && (
                    <span className="text-faint dark:text-slate-500">
                      (from &ldquo;{derivedWords.join("\u201d, \u201c")}&rdquo;)
                    </span>
                  )}
                </>
              ) : readyMade ? (
                // The ready-made banner above is already the better answer for
                // this sentence; don't argue with it from down here.
                <span className="text-faint dark:text-slate-500">Nothing here to change yet.</span>
              ) : (
                <span className="text-faint dark:text-slate-500">
                  Nothing in this workspace obviously matches, so Cobblr will look at everything. Naming what it
                  touches makes the result better.
                </span>
              )}
              <button
                type="button"
                onClick={() => setScopeOpen((v) => !v)}
                className="text-accent hover:underline font-medium"
              >
                {scopeOpen ? "Done" : scopeKinds.length > 0 ? "Change" : "Pick what it touches"}
              </button>
              {manualScope && !scopeOpen && (
                <button
                  type="button"
                  onClick={() => setManualScope(null)}
                  className="text-faint dark:text-slate-500 hover:text-accent"
                >
                  reset
                </button>
              )}
            </div>

            {scopeOpen && (
              <div className="mt-2 rounded-lg border border-line dark:border-slate-700 p-2.5">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                    // pick up to 3
                  </span>
                  <span className="text-[11px] text-faint dark:text-slate-500">
                    fewer is more reliable - the AI wires to the wrong thing when handed everything
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {kindItems.map((k) => {
                    const on = effectiveScope.includes(k.id);
                    return (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => toggleKind(k.id)}
                        title={k.id}
                        className={
                          "px-2.5 py-1 rounded-full text-xs border transition " +
                          (on
                            ? "bg-cobble-600 border-cobble-600 text-white"
                            : "border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:border-accent")
                        }
                      >
                        {k.display_name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
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
          <CobbAtWork>
            {mode === "workspace"
              ? "On the bench — turning on the modules you need, building your fields + automations, then verifying it. A minute or two…"
              : "On the bench — running it, then checking the result against the validator (auto-retrying if needed). A few seconds…"}
          </CobbAtWork>
        )}
        {busy === "compile" && (
          <CobbAtWork>Writing you a prompt to run in your own AI. Reading your workspace first, so it knows what you already have…</CobbAtWork>
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
          {busy === "validate" && (
            <CobbAtWork>Reading what you pasted and checking it against the validator, the same gate a bundle install goes through…</CobbAtWork>
          )}
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
              <div className="flex items-center gap-3">
                <Cobb pose="tada" size={52} className="shrink-0 cobb-lift" title="Cobb presents the build" />
                <div>
                  <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    Built it. Verified it.
                  </div>
                  <div className="text-xs text-muted dark:text-slate-400">
                    Take a look before it lands - here's what it'll do:
                  </div>
                </div>
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
                    <span className="normal-case text-faint"> (a table of {inst.item_noun ?? "record"}s)</span>
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
              {busy === "apply" && <CobbAtWork>Landing it on your workspace…</CobbAtWork>}
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
              <div className="flex items-center gap-3">
                <Cobb pose="tada" size={52} className="shrink-0 cobb-lift" title="Cobb presents the app" />
                <div>
                  <div className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    Built it. Verified it.
                  </div>
                  <div className="text-xs text-muted dark:text-slate-400">Your app is ready.</div>
                </div>
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
              {busy === "apply" && <CobbAtWork>Building your page…</CobbAtWork>}
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
                <AlertTriangle size={16} /> Not quite - a few things to fix:
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
              {busy === "repair" && <CobbAtWork>Writing a repair prompt with the errors above spelled out…</CobbAtWork>}
            </>
          )}
        </section>
      )}
      {bundleDetail.element}
    </div>
  );
}

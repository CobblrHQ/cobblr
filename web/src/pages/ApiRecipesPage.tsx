// /configuration/api-recipes — "Scripting". The human companion to the OpenAPI
// spec: ready-to-run curl / Python / Node / TypeScript for creating and reading
// records in THIS workspace, generated from the workspace's own entity kinds +
// fields. You tap-select one or more record types; that selection drives BOTH
// the code shown below and the scope of the token it mints (records:<target>:
// <action> + provenance) via the existing token surface.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, KeyRound, Info, Boxes, Terminal, Download } from "lucide-react";
import { QueryError } from "../components/QueryError";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { api, type PlatformEntityKind } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";

type Lang = "curl" | "python" | "node" | "ts";
type Action = "create" | "write" | "readwrite";
type Expiry = "90d" | "1y" | "never" | "custom";

const LANGS: { id: Lang; label: string }[] = [
  { id: "curl", label: "curl" },
  { id: "python", label: "Python" },
  { id: "node", label: "Node.js" },
  { id: "ts", label: "TypeScript" },
];

/** A realistic example value for a native field, by role/name/type. */
function egValue(f: { name: string; type: string; role?: string }): unknown {
  if (f.type === "number") return 1;
  if (f.type === "boolean") return true;
  if (f.type === "date") return new Date().toISOString().slice(0, 10);
  if (f.role === "title" || f.name === "name" || f.name === "title") return "Example item";
  if (f.name.includes("serial")) return "SN-0001";
  if (f.name.includes("url")) return "https://example.com";
  return `example ${f.name.replace(/_/g, " ")}`;
}
function tsType(t: string): string {
  return t === "number" ? "number" : t === "boolean" ? "boolean" : "string";
}
function typeName(label: string): string {
  return (label.replace(/[^a-z0-9]+/gi, " ").trim().split(" ").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || "Record").replace(/s$/, "");
}

// A kind routes one of two ways (from the registry, not guessed): an INSTANCE
// kind lives under /instances/<instance_name>, a MODULE kind under
// /modules/<module_name>. Both carry endpoints relative to that mount.
function mountBase(slug: string, k: PlatformEntityKind): string {
  return k.instance_name
    ? `/api/v1/orgs/${slug}/instances/${k.instance_name}`
    : `/api/v1/orgs/${slug}/modules/${k.module_name}`;
}
/** The collection segment, e.g. "/parts" → "parts", "/items/{id}" → "items". */
function collectionOf(k: PlatformEntityKind): string {
  const ep = k.endpoints ?? {};
  const raw = ep.create ?? ep.list ?? ep.get ?? ep.update ?? ep.delete ?? "";
  return raw.replace(/^\//, "").split("/")[0] ?? "";
}
/** The record scope target: an instance name, or "<module>/<collection>". */
function scopeTarget(k: PlatformEntityKind): string {
  return k.instance_name ? k.instance_name : `${k.module_name}/${collectionOf(k)}`;
}
/** The route the snippet hits, relative (no origin/org) — shown on the card. */
function routeHint(k: PlatformEntityKind): string {
  const ep = k.endpoints?.create ?? k.endpoints?.list ?? "";
  return k.instance_name ? `instances/${k.instance_name}${ep}` : `modules/${k.module_name}${ep}`;
}
function isInstanceKind(k: PlatformEntityKind): boolean {
  return !!k.instance_name;
}
/** Kinds a script can create or read — the scriptable slice of the registry. */
function isScriptable(k: PlatformEntityKind): boolean {
  return !!(k.endpoints?.create || k.endpoints?.list);
}

function nativeFieldsOf(k: PlatformEntityKind) {
  return (k.fields ?? []).filter((f) => f.role !== "system").slice(0, 8);
}

// The env-loading preamble for a language (imports + a comment showing where the
// token goes). Emitted once per on-screen snippet, and once at the top of a
// downloaded file — so the token is loaded, never inlined.
function langPreamble(lang: Lang, envToken: string): string[] {
  if (lang === "curl") return [`# Load your token from the env, never inline it:`, `#   export COBBLR_TOKEN="${envToken}"`];
  if (lang === "python") return [`# pip install requests python-dotenv  ·  .env: COBBLR_TOKEN=${envToken}`, "import os, requests", "from dotenv import load_dotenv", "load_dotenv()"];
  return [`// npm i dotenv  ·  .env (never commit it): COBBLR_TOKEN=${envToken}`, 'import "dotenv/config";'];
}
/** The create CALL only (no preamble/imports) — shared by the on-screen snippet
 *  and the combined download (which loads the token once at the top). */
function createCall(k: PlatformEntityKind, lang: Lang, url: string): string {
  const fields = nativeFieldsOf(k);
  const body: Record<string, unknown> = {};
  for (const f of fields) body[f.name] = egValue(f);
  const j = JSON.stringify(body, null, 2);
  if (lang === "curl") {
    return [`curl -X POST ${url} \\`, `  -H "Authorization: Bearer $COBBLR_TOKEN" \\`, `  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(body)}'`].join("\n");
  }
  if (lang === "python") {
    return ["requests.post(", `    "${url}",`, `    headers={"Authorization": f"Bearer {os.environ['COBBLR_TOKEN']}"},`, `    json=${j.replace(/\n/g, "\n    ")},`, ").raise_for_status()"].join("\n");
  }
  const fetchCall = [`await fetch("${url}", {`, `  method: "POST",`, `  headers: {`, "    Authorization: `Bearer ${process.env.COBBLR_TOKEN}`,", `    "Content-Type": "application/json",`, `  },`, `  body: JSON.stringify(BODY),`, `});`];
  if (lang === "ts") {
    const iface = [`interface ${typeName(k.display_name)}Create {`, ...fields.map((f) => `  ${f.name}${f.role === "title" ? "" : "?"}: ${tsType(f.type)};`), `}`].join("\n");
    return [iface, "", `const body: ${typeName(k.display_name)}Create = ${j};`, "", ...fetchCall.map((l) => l.replace("BODY", "body"))].join("\n");
  }
  return fetchCall.map((l) => l.replace("BODY", j)).join("\n");
}
/** The find/list CALL only (no preamble). */
function listCall(lang: Lang, url: string): string {
  const u = `${url}?limit=20`;
  if (lang === "curl") return [`curl "${u}" \\`, `  -H "Authorization: Bearer $COBBLR_TOKEN"`].join("\n");
  if (lang === "python") return ["r = requests.get(", `    "${u}",`, `    headers={"Authorization": f"Bearer {os.environ['COBBLR_TOKEN']}"},`, ").json()"].join("\n");
  return [`const r = await fetch("${u}", {`, "  headers: { Authorization: `Bearer ${process.env.COBBLR_TOKEN}` },", "}).then((r) => r.json());"].join("\n");
}
function buildCreate(k: PlatformEntityKind, lang: Lang, url: string, envToken: string): string {
  return [...langPreamble(lang, envToken), "", createCall(k, lang, url)].join("\n");
}
function buildList(lang: Lang, url: string, envToken: string): string {
  return [...langPreamble(lang, envToken), "", listCall(lang, url)].join("\n");
}
/** The update CALL only — PATCH a partial body to one record ({id} placeholder). */
function updateCall(k: PlatformEntityKind, lang: Lang, url: string): string {
  const body: Record<string, unknown> = {};
  for (const f of nativeFieldsOf(k).slice(0, 3)) body[f.name] = egValue(f);
  const j = JSON.stringify(body, null, 2);
  if (lang === "curl") {
    return [`curl -X PATCH ${url} \\`, `  -H "Authorization: Bearer $COBBLR_TOKEN" \\`, `  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(body)}'`].join("\n");
  }
  if (lang === "python") {
    return ["requests.patch(", `    "${url}",`, `    headers={"Authorization": f"Bearer {os.environ['COBBLR_TOKEN']}"},`, `    json=${j.replace(/\n/g, "\n    ")},`, ").raise_for_status()"].join("\n");
  }
  return [`await fetch("${url}", {`, `  method: "PATCH",`, `  headers: {`, "    Authorization: `Bearer ${process.env.COBBLR_TOKEN}`,", `    "Content-Type": "application/json",`, `  },`, `  body: JSON.stringify(${j}),`, `});`].join("\n");
}
function buildUpdate(k: PlatformEntityKind, lang: Lang, url: string, envToken: string): string {
  return [...langPreamble(lang, envToken), "", updateCall(k, lang, url)].join("\n");
}
/** All selected kinds as ONE file: token loaded once, then a labelled section per
 *  kind (fields as a comment reference, then its create + list calls). */
function buildFile(
  lang: Lang,
  items: { k: PlatformEntityKind; label: string; createUrl: string; listUrl: string; updateUrl: string }[],
): string {
  const cp = lang === "node" || lang === "ts" ? "//" : "#";
  // Never write a real token into a downloaded file — always the placeholder.
  const head = [`${cp} Cobblr API examples. One token, one env var.`, ...langPreamble(lang, "cblr_...your token here...")];
  const sections = items.map(({ k, label, createUrl, listUrl, updateUrl }) => {
    const fields = nativeFieldsOf(k).map((f) => `${f.name}${f.role === "title" ? "*" : ""}`).join(", ");
    const lines = ["", `${cp} ── ${label}  (${routeHint(k)})`];
    if (fields) lines.push(`${cp} Fields: ${fields}   (* required; custom fields go under metadata)`);
    if (createUrl) lines.push("", createCall(k, lang, createUrl));
    if (listUrl) lines.push("", listCall(lang, listUrl));
    if (updateUrl) lines.push("", updateCall(k, lang, updateUrl));
    return lines.join("\n");
  });
  return [head.join("\n"), ...sections].join("\n") + "\n";
}

const SECTION = "rounded-lg border border-line dark:border-slate-600 p-4";

export function ApiRecipesPage() {
  usePageTitle("Scripting");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();

  const kindsQ = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug!),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });

  // The whole registry, not just instances: every scriptable kind — Inventory,
  // Locations, Assets, and every named category — each routed by its own
  // endpoints. (Sorted so instances and modules interleave by display name.)
  const kinds = useMemo(
    () =>
      (kindsQ.data?.items ?? [])
        .filter(isScriptable)
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [kindsQ.data],
  );

  // Module display names (what the sidebar shows: inventory → "Inventory",
  // core-locations → "Locations"). A module kind's own display_name is the ITEM
  // noun ("Part"), which a user hunting for their sidebar entry won't recognise.
  const modulesQ = useQuery({
    queryKey: ["modules-registry"],
    queryFn: () => api.modules(),
    staleTime: 5 * 60_000,
  });
  const moduleName = useMemo(() => {
    const m = new Map<string, string>();
    for (const mod of modulesQ.data?.items ?? []) m.set(mod.name, mod.displayName);
    return m;
  }, [modulesQ.data]);
  /** The label a user recognises. Instance kinds keep their name (they match the
   *  sidebar). Module kinds are ALWAYS "Module · Kind" — uniform, so the grid
   *  never mixes bare "Inventory" with "Projects · Project" (confusing). */
  const kindLabel = (k: PlatformEntityKind): string => {
    if (isInstanceKind(k)) return k.display_name;
    const mod = moduleName.get(k.module_name) ?? k.module_name;
    return `${mod} · ${k.display_name}`;
  };
  /** The SHORT label for a token name: the module / instance the user recognises,
   *  without the "· Kind" suffix (so a default name reads "Locations script", not
   *  "Locations · Location script"). */
  const shortLabel = (k: PlatformEntityKind): string =>
    isInstanceKind(k) ? k.display_name : (moduleName.get(k.module_name) ?? k.module_name);

  // Nothing selected by default — you pick what your script touches.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState("");
  const [lang, setLang] = useState<Lang>("curl");
  const [wizDo, setWizDo] = useState<Action>("create");
  const [wizAllKinds, setWizAllKinds] = useState(false);
  const [wizExp, setWizExp] = useState<Expiry>("90d");
  const [customDays, setCustomDays] = useState("30");
  const [tokenName, setTokenName] = useState("");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const selectedKinds = useMemo(() => kinds.filter((k) => selectedIds.has(k.id)), [kinds, selectedIds]);
  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-cobblr";
  const envToken = token || "cblr_...your token here...";
  const urlFor = (k: PlatformEntityKind, ep?: string) => (ep ? `${origin}${mountBase(activeSlug!, k)}${ep}` : "");

  // Selection (or the all-kinds escape hatch) IS "which kinds it can touch".
  const targets = useMemo(
    () => (wizAllKinds ? ["*"] : [...new Set(selectedKinds.map(scopeTarget))]),
    [wizAllKinds, selectedKinds],
  );
  const scopes = useMemo(() => {
    const actions = wizDo === "create" ? ["create"] : wizDo === "write" ? ["write"] : ["read", "write"];
    return targets.flatMap((t) => actions.map((a) => `records:${t}:${a}`));
  }, [targets, wizDo]);

  const expDays =
    wizExp === "never" ? null
    : wizExp === "90d" ? 90
    : wizExp === "1y" ? 365
    : Number(customDays) > 0 ? Math.floor(Number(customDays)) : null;
  const expLabel = expDays === null ? "never expires" : expDays === 365 ? "expires in 1 year" : `expires in ${expDays} days`;
  // Which operations the CURRENT token scope authorizes vs. the ones shown but not
  // yet allowed (the examples always show all; this note ties scope to code).
  const coveredOps = wizDo === "create" ? "create" : wizDo === "write" ? "create and update" : "read, create, and update";
  const uncoveredOps = wizDo === "create" ? "read and update" : wizDo === "write" ? "read" : "";

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400);
  };

  const downloadAll = () => {
    const items = selectedKinds.map((k) => ({
      k,
      label: kindLabel(k),
      createUrl: urlFor(k, k.endpoints?.create),
      listUrl: urlFor(k, k.endpoints?.list),
      updateUrl: urlFor(k, k.endpoints?.update),
    }));
    const ext = lang === "python" ? "py" : lang === "curl" ? "sh" : lang === "ts" ? "ts" : "mjs";
    const blob = new Blob([buildFile(lang, items)], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `cobblr-examples.${ext}`;
    a.click();
    URL.revokeObjectURL(href);
  };

  const defaultName = () => {
    if (wizAllKinds) return "All-records script";
    if (selectedKinds.length === 0) return "API script";
    const first = shortLabel(selectedKinds[0]!);
    return selectedKinds.length > 1 ? `${first} +${selectedKinds.length - 1} script` : `${first} script`;
  };

  const mint = async () => {
    if (scopes.length === 0) return;
    setMinting(true);
    try {
      const name = (tokenName || defaultName()).trim();
      const expires_at = expDays ? new Date(Date.now() + expDays * 864e5).toISOString() : undefined;
      const res = await api.createApiToken({
        name,
        scopes,
        expires_at,
        source: "script-page",
        meta: { targets, action: wizDo, org: activeSlug },
      });
      setToken(res.token);
      toast.success(`Scoped token "${name}" created — copy it now, it won't be shown again.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't mint the token.");
    } finally {
      setMinting(false);
    }
  };

  const optBtn = (on: boolean) =>
    "rounded-md border px-3 py-1.5 text-sm transition " +
    (on
      ? "border-cobble-600 bg-cobble-600 text-white"
      : "border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 text-muted dark:text-slate-300 hover:text-content");

  // One selectable card; tap toggles membership (works on touch + desktop).
  const kindCard = (k: PlatformEntityKind) => {
    const Icon = moduleIcon(k.icon);
    const fam = isInstanceKind(k) ? "category" : "module";
    const on = selectedIds.has(k.id);
    return (
      <button
        key={k.id}
        type="button"
        onClick={() => toggle(k.id)}
        aria-pressed={on}
        className={
          "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition " +
          (on
            ? "border-cobble-500 bg-cobble-500/10 ring-1 ring-inset ring-cobble-500"
            : "border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 hover:border-cobble-400")
        }
      >
        <span className={"mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md " + (on ? "bg-cobble-600 text-white" : "bg-panel dark:bg-slate-900 text-cobble-500")}>
          {on ? <Check size={14} /> : <Icon size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-content dark:text-slate-100">{kindLabel(k)}</span>
            <span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[10px] " + (fam === "category" ? "bg-cobble-500/15 text-cobble-500" : "bg-amber-500/15 text-amber-500")}>{fam}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-faint dark:text-slate-500">{routeHint(k)}</span>
        </span>
      </button>
    );
  };

  const codeBlock = (id: string, title: string, code: string, resp: string) => (
    <div key={id}>
      <div className="mb-1.5 text-sm font-medium text-content dark:text-slate-200">{title}</div>
      <div className="relative">
        <button onClick={() => copy(id, code)} className="absolute right-2 top-2 z-10 rounded border border-line dark:border-slate-600 bg-panel/80 dark:bg-slate-900/80 px-2 py-1 text-xs text-muted hover:text-content">
          {copied === id ? "Copied" : "Copy"}
        </button>
        <pre className="overflow-x-auto rounded-md border border-line dark:border-slate-700 bg-slate-950 p-4 text-xs leading-relaxed text-slate-200"><code>{code}</code></pre>
      </div>
      <div className="mt-1 text-xs text-muted dark:text-slate-400">→ {resp}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {kindsQ.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {kindsQ.isError && <QueryError what="your entity kinds" onRetry={() => kindsQ.refetch()} />}
      {!kindsQ.isLoading && kinds.length === 0 && (
        <div className={SECTION + " text-sm text-muted dark:text-slate-400"}>
          {/* vocab-lint-ok: generic scripting empty state, not a per-kind surface */}
          Nothing to script against yet. Create a category (a named table) and it shows up here.
        </div>
      )}

      {kinds.length > 0 && (
        <>
          {/* 1 · pick one or more record types (tap toggles) */}
          <section className={SECTION + " space-y-3"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
                <Boxes size={15} className="text-cobble-500" /> Pick what it applies to
              </div>
              {selectedIds.size > 0 && (
                <button onClick={() => setSelectedIds(new Set())} className="text-xs text-muted hover:text-content">
                  {selectedIds.size} selected · Clear
                </button>
              )}
            </div>
            <p className="text-xs text-muted dark:text-slate-400">Tap the record types your script reads or writes. Pick as many as you need.</p>

            {kinds.length > 8 && (
              <input
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                placeholder="Filter…"
                className="w-full rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-3 py-2 text-sm text-content dark:text-slate-100"
              />
            )}
            <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
              {([["category", "Categories", (k: PlatformEntityKind) => isInstanceKind(k)], ["module", "Modules", (k: PlatformEntityKind) => !isInstanceKind(k)]] as const).map(([famKey, famLabel, pred]) => {
                const q = kindFilter.trim().toLowerCase();
                const group = kinds.filter((k) => pred(k) && `${kindLabel(k)} ${k.display_name}`.toLowerCase().includes(q));
                if (group.length === 0) return null;
                return (
                  <div key={famKey}>
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">{famLabel}</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {group.map((k) => kindCard(k))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 2 · authorize it (scope derives from the selection) */}
          <section className={SECTION + " space-y-3"}>
            <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
              <KeyRound size={15} className="text-cobble-500" /> Authorize it
            </div>
            <p className="text-xs text-muted dark:text-slate-400">The token is scoped to exactly the record types you picked, and nothing more.</p>
            {[
              { q: "What will the script do?", opts: [["create", "Create records"], ["write", "Create + update"], ["readwrite", "Full read + write"]] as const, val: wizDo, set: (v: string) => setWizDo(v as Action) },
              { q: "Which records?", opts: [["picked", "The ones I picked"], ["all", "All record types"]] as const, val: wizAllKinds ? "all" : "picked", set: (v: string) => setWizAllKinds(v === "all") },
            ].map((row) => (
              <div key={row.q} className="flex flex-wrap items-center gap-3">
                <span className="w-44 text-sm text-muted dark:text-slate-400">{row.q}</span>
                <div className="flex flex-wrap gap-1.5">
                  {row.opts.map(([v, label]) => (
                    <button key={v} onClick={() => row.set(v)} className={optBtn(row.val === v)}>{label}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-44 text-sm text-muted dark:text-slate-400">Expire the token?</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {([["90d", "90 days"], ["1y", "1 year"], ["never", "Never"], ["custom", "Custom"]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setWizExp(v)} className={optBtn(wizExp === v)}>{label}</button>
                ))}
                {wizExp === "custom" && (
                  <span className="inline-flex items-center gap-1.5">
                    <input
                      type="number"
                      min="1"
                      value={customDays}
                      onChange={(e) => setCustomDays(e.target.value)}
                      className="w-20 rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-2 py-1.5 text-sm text-content dark:text-slate-100"
                    />
                    <span className="text-sm text-muted dark:text-slate-400">days</span>
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-44 text-sm text-muted dark:text-slate-400">Name / purpose</span>
              <input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder={defaultName()}
                className="flex-1 min-w-[240px] rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-3 py-2 text-sm text-content dark:text-slate-100"
              />
            </div>

            <div className="rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">
                This token will be limited to{scopes.length ? ` (${scopes.length})` : ""}
              </div>
              {scopes.length === 0 ? (
                <div className="mb-2 text-xs text-amber-500">Pick at least one record type above.</div>
              ) : (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {scopes.map((s) => (
                    <span key={s} className="rounded border border-line dark:border-slate-600 bg-panel dark:bg-slate-900 px-2 py-0.5 font-mono text-xs text-cobble-500">{s}</span>
                  ))}
                </div>
              )}
              <div className="text-xs text-faint dark:text-slate-500">
                Recorded on the token: source = <span className="font-mono">script-page</span> · kinds = <span className="font-mono">{targets.join(", ") || "none"}</span> · {expLabel}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                readOnly
                value={token}
                placeholder="Your scoped token appears here (shown once)"
                className="flex-1 min-w-[280px] rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 px-3 py-2 font-mono text-sm text-content dark:text-slate-100"
              />
              <button onClick={() => void mint()} disabled={minting || scopes.length === 0} className="rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-60">
                {minting ? "Minting…" : "Generate scoped token"}
              </button>
              {token && (
                <button onClick={() => copy("tok", token)} className="rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm text-muted hover:text-content">
                  {copied === "tok" ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-faint dark:text-slate-500">
              <Info size={13} className="mt-0.5 shrink-0" />
              The token authenticates the script as you, but clamped to the scopes above. Shown once (only a hash is stored); the snippet reads it from COBBLR_TOKEN, never inlines it.
            </p>
          </section>

          {/* 3 · use it — a snippet group per selected kind; language lives here */}
          <section className={SECTION + " space-y-4"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
                <Terminal size={15} className="text-cobble-500" /> Use it
              </div>
              <div className="flex items-center gap-2">
                {selectedKinds.length > 0 && (
                  <button
                    onClick={downloadAll}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2.5 py-1.5 text-xs text-muted hover:text-content"
                  >
                    <Download size={13} /> Download all
                  </button>
                )}
                <div className="inline-flex rounded-md border border-line dark:border-slate-600 bg-subtle dark:bg-slate-800 p-0.5">
                  {LANGS.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => setLang(l.id)}
                      className={"rounded px-3 py-1.5 text-sm transition " + (lang === l.id ? "bg-cobble-600 text-white" : "text-muted dark:text-slate-300 hover:text-content")}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {selectedKinds.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line dark:border-slate-600 bg-subtle dark:bg-slate-950/50 px-6 py-12 text-center">
                <Terminal size={22} className="text-faint dark:text-slate-600" />
                <p className="text-sm font-medium text-muted dark:text-slate-300">Your code example will appear here</p>
                <p className="text-xs text-faint dark:text-slate-400">Pick one or more record types above, and a ready-to-run snippet shows up for each.</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted dark:text-slate-400">
                  {wizDo === "readwrite" ? (
                    <>Every operation is shown below, and your token will allow all of them.</>
                  ) : (
                    <>
                      Every operation is shown below. Your token will allow <span className="font-medium text-content dark:text-slate-200">{coveredOps}</span>; to run the {uncoveredOps} example{uncoveredOps.includes("and") ? "s" : ""}, give it a wider scope above.
                    </>
                  )}
                </p>
                {selectedKinds.map((k) => {
                  const createUrl = urlFor(k, k.endpoints?.create);
                  const listUrl = urlFor(k, k.endpoints?.list);
                  const updateUrl = urlFor(k, k.endpoints?.update);
                  return (
                    <div key={k.id} className="space-y-3 border-t border-line dark:border-slate-700 pt-4 first:border-0 first:pt-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-content dark:text-slate-100">
                        {kindLabel(k)}
                        <span className="font-mono text-[11px] font-normal text-faint dark:text-slate-500">{routeHint(k)}</span>
                      </div>
                      {createUrl && codeBlock(`create:${k.id}`, "Create a record", buildCreate(k, lang, createUrl, envToken), "201 Created — returns the new record with its id.")}
                      {listUrl && codeBlock(`list:${k.id}`, "Find / list records", buildList(lang, listUrl, envToken), "200 OK — { items: [ … ] }, newest first.")}
                      {updateUrl && codeBlock(`update:${k.id}`, "Update a record", buildUpdate(k, lang, updateUrl, envToken), "200 OK — the updated record. Replace {id} with a real record id.")}
                    </div>
                  );
                })}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// /configuration/api-recipes — "Use from a script". The human companion to the
// OpenAPI spec: ready-to-run curl / Python / Node / TypeScript for creating and
// reading records in THIS workspace, generated from the workspace's own entity
// kinds + fields. The auto-scoping wizard mints a record-scoped token
// (records:<instance>:<action> + provenance) via the existing token surface.
//
// UI is deliberately functional-first (per plan: build it, then tweak).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, KeyRound, Info } from "lucide-react";
import { QueryError } from "../components/QueryError";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { api, type PlatformEntityKind } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";

type Lang = "curl" | "python" | "node" | "ts";
type Action = "create" | "write" | "readwrite";
type KindsScope = "this" | "pick" | "all";
type Expiry = "90d" | "1y" | "never";

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
/** Is this an instance-backed ("category") kind or a module kind? */
function isInstanceKind(k: PlatformEntityKind): boolean {
  return !!k.instance_name;
}
/** Kinds a script can create or read — the scriptable slice of the registry. */
function isScriptable(k: PlatformEntityKind): boolean {
  return !!(k.endpoints?.create || k.endpoints?.list);
}

export function ApiRecipesPage() {
  usePageTitle("Use from a script");
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

  const [kindId, setKindId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("");
  const [lang, setLang] = useState<Lang>("curl");
  const [wizDo, setWizDo] = useState<Action>("create");
  const [wizKinds, setWizKinds] = useState<KindsScope>("this");
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [wizExp, setWizExp] = useState<Expiry>("90d");
  const [tokenName, setTokenName] = useState("");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const kind = kinds.find((k) => k.id === kindId) ?? kinds[0] ?? null;
  const target = kind ? scopeTarget(kind) : "";
  const nativeFields = (kind?.fields ?? []).filter((f) => f.role !== "system");

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-cobblr";
  // The kind's OWN create/list routes, from the registry — module or instance.
  const createEp = kind?.endpoints?.create;
  const listEp = kind?.endpoints?.list;
  const createUrl = kind && createEp ? `${origin}${mountBase(activeSlug!, kind)}${createEp}` : "";
  const listUrl = kind && listEp ? `${origin}${mountBase(activeSlug!, kind)}${listEp}` : "";

  const bodyObj = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const f of nativeFields.slice(0, 8)) o[f.name] = egValue(f);
    return o;
  }, [nativeFields]);

  const envToken = token || "cblr_...your token here...";

  const createSnippet = useMemo(() => {
    if (!kind) return "";
    const j = JSON.stringify(bodyObj, null, 2);
    if (lang === "curl") {
      return [
        "# Load your token from the shell env — never paste it into the script.",
        "# Add to ~/.zshrc, or a .env you source before running:",
        `#   export COBBLR_TOKEN="${envToken}"`,
        "",
        `curl -X POST ${createUrl} \\`,
        `  -H "Authorization: Bearer $COBBLR_TOKEN" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(bodyObj)}'`,
      ].join("\n");
    }
    if (lang === "python") {
      return [
        "# pip install requests python-dotenv",
        "# .env beside this script (add it to .gitignore):",
        `#   COBBLR_TOKEN=${envToken}`,
        "import os, requests",
        "from dotenv import load_dotenv",
        "load_dotenv()",
        "",
        "requests.post(",
        `    "${createUrl}",`,
        `    headers={"Authorization": f"Bearer {os.environ['COBBLR_TOKEN']}"},`,
        `    json=${j.replace(/\n/g, "\n    ")},`,
        ").raise_for_status()",
      ].join("\n");
    }
    const preamble = [
      "// npm i dotenv  —  load COBBLR_TOKEN from a .env you never commit:",
      `//   COBBLR_TOKEN=${envToken}`,
      'import "dotenv/config";',
      "",
    ];
    const fetchCall = [
      `await fetch("${createUrl}", {`,
      `  method: "POST",`,
      `  headers: {`,
      "    Authorization: `Bearer ${process.env.COBBLR_TOKEN}`,",
      `    "Content-Type": "application/json",`,
      `  },`,
      `  body: JSON.stringify(BODY),`,
      `});`,
    ];
    if (lang === "ts") {
      const iface = [
        `interface ${typeName(kind.display_name)}Create {`,
        ...nativeFields.slice(0, 8).map((f) => `  ${f.name}${f.role === "title" ? "" : "?"}: ${tsType(f.type)};`),
        `}`,
      ].join("\n");
      return [
        ...preamble,
        `// Generated from your ${kind.display_name} schema — typo a field and it won't compile.`,
        iface,
        "",
        `const body: ${typeName(kind.display_name)}Create = ${j};`,
        "",
        ...fetchCall.map((l) => l.replace("BODY", "body")),
      ].join("\n");
    }
    return [...preamble, ...fetchCall.map((l) => l.replace("BODY", j))].join("\n");
  }, [kind, lang, bodyObj, createUrl, envToken, nativeFields]);

  const listSnippet = useMemo(() => {
    if (!kind || !listUrl) return "";
    const u = `${listUrl}?limit=20`;
    if (lang === "curl") {
      return [`# Token from the env — export COBBLR_TOKEN="${envToken}"`, `curl "${u}" \\`, `  -H "Authorization: Bearer $COBBLR_TOKEN"`].join("\n");
    }
    if (lang === "python") {
      return ["import os, requests", "from dotenv import load_dotenv", "load_dotenv()", "", "r = requests.get(", `    "${u}",`, `    headers={"Authorization": f"Bearer {os.environ['COBBLR_TOKEN']}"},`, ").json()"].join("\n");
    }
    return ["// Node 18+ / TypeScript (global fetch)", `const r = await fetch("${u}", {`, "  headers: { Authorization: `Bearer ${process.env.COBBLR_TOKEN}` },", "}).then((r) => r.json());"].join("\n");
  }, [kind, lang, listUrl, envToken]);

  // The kinds this token will cover: just the shown one, a hand-picked set, or
  // everything (*). One token often needs several kinds (a script that logs
  // computers AND updates locations), so "pick" mints a scope per kind.
  const pickedTargets = useMemo(() => {
    if (wizKinds === "all") return ["*"];
    if (wizKinds === "this") return target ? [target] : [];
    return [...new Set(kinds.filter((k) => pickedIds.has(k.id)).map(scopeTarget))];
  }, [wizKinds, target, kinds, pickedIds]);

  const scopes = useMemo(() => {
    const actions = wizDo === "create" ? ["create"] : wizDo === "write" ? ["write"] : ["read", "write"];
    return pickedTargets.flatMap((t) => actions.map((a) => `records:${t}:${a}`));
  }, [pickedTargets, wizDo]);

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400);
  };

  const mint = async () => {
    if (!kind || scopes.length === 0) return;
    setMinting(true);
    try {
      const name = (tokenName || `${kind.display_name} script`).trim();
      const expires_at =
        wizExp === "never" ? undefined : new Date(Date.now() + (wizExp === "90d" ? 90 : 365) * 864e5).toISOString();
      const res = await api.createApiToken({
        name,
        scopes,
        expires_at,
        source: "script-page",
        meta: { kind: kind.id, targets: pickedTargets, action: wizDo, org: activeSlug },
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
      : "border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 text-muted dark:text-slate-300 hover:text-content");

  return (
    <div className="space-y-4">
      {kindsQ.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {kindsQ.isError && <QueryError what="your entity kinds" onRetry={() => kindsQ.refetch()} />}
      {!kindsQ.isLoading && kinds.length === 0 && (
        <div className="rounded-md border border-line dark:border-slate-700 p-4 text-sm text-muted dark:text-slate-400">
          {/* vocab-lint-ok: generic scripting empty state, not a per-kind surface */}
          Nothing to script against yet. Create a category (a named table) and it shows up here.
        </div>
      )}

      {kind && (
        <>
          {/* 1 · pick the kind (card grid, grouped by family) + language */}
          <section className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-faint dark:text-slate-500">Entity kind</span>
              <div className="inline-flex rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-0.5">
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

            {kinds.length > 8 && (
              <input
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                placeholder="Filter kinds…"
                className="w-full rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-3 py-2 text-sm text-content dark:text-slate-100"
              />
            )}

            {([["category", "Categories", (k: PlatformEntityKind) => isInstanceKind(k)], ["module", "Modules", (k: PlatformEntityKind) => !isInstanceKind(k)]] as const).map(([famKey, famLabel, pred]) => {
              const group = kinds.filter((k) => pred(k) && k.display_name.toLowerCase().includes(kindFilter.trim().toLowerCase()));
              if (group.length === 0) return null;
              return (
                <div key={famKey}>
                  <div className="mb-2 text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">{famLabel}</div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {group.map((k) => {
                      const Icon = moduleIcon(k.icon);
                      const on = k.id === kind.id;
                      return (
                        <button
                          key={k.id}
                          type="button"
                          onClick={() => setKindId(k.id)}
                          className={
                            "flex items-start gap-2.5 rounded-lg border p-3 text-left transition " +
                            (on
                              ? "border-cobble-500 bg-cobble-500/10 ring-1 ring-inset ring-cobble-500"
                              : "border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 hover:border-cobble-400")
                          }
                        >
                          <span className={"mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md " + (on ? "bg-cobble-600 text-white" : "bg-panel dark:bg-slate-900 text-cobble-500")}>
                            <Icon size={14} />
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-semibold text-content dark:text-slate-100">{k.display_name}</span>
                              <span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[10px] " + (famKey === "category" ? "bg-cobble-500/15 text-cobble-500" : "bg-amber-500/15 text-amber-500")}>{famKey}</span>
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-faint dark:text-slate-500">{routeHint(k)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>

          {/* 2 · auto-scope wizard */}
          <section className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-100">
              <KeyRound size={15} className="text-cobble-500" /> Authorize the script
            </div>
            <p className="text-xs text-muted dark:text-slate-400">Answer a few questions and the token is scoped to the minimum it needs.</p>
            {[
              { q: "What will the script do?", opts: [["create", "Create records"], ["write", "Create + update"], ["readwrite", "Full read + write"]] as const, val: wizDo, set: (v: string) => setWizDo(v as Action) },
              { q: "Which kinds can it touch?", opts: [["this", `Just ${kind.display_name}`], ["pick", "Pick kinds…"], ["all", "All kinds"]] as const, val: wizKinds, set: (v: string) => {
                const nv = v as KindsScope;
                setWizKinds(nv);
                if (nv === "pick" && pickedIds.size === 0) setPickedIds(new Set([kind.id]));
              } },
              { q: "Expire the token?", opts: [["90d", "90 days"], ["1y", "1 year"], ["never", "Never"]] as const, val: wizExp, set: (v: string) => setWizExp(v as Expiry) },
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

            {wizKinds === "pick" && (
              <div className="ml-0 sm:ml-44 max-h-56 overflow-y-auto rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-2">
                {kinds.map((k) => {
                  const on = pickedIds.has(k.id);
                  return (
                    <label key={k.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-content dark:text-slate-200 hover:bg-panel dark:hover:bg-slate-900">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setPickedIds((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(k.id);
                            else next.add(k.id);
                            return next;
                          })
                        }
                        className="accent-cobble-600"
                      />
                      <span>{k.display_name}</span>
                      <span className="ml-auto font-mono text-[11px] text-faint dark:text-slate-500">{scopeTarget(k)}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-44 text-sm text-muted dark:text-slate-400">Name / purpose</span>
              <input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder={`${kind.display_name} script`}
                className="flex-1 min-w-[240px] rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-3 py-2 text-sm text-content dark:text-slate-100"
              />
            </div>

            <div className="rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">
                This token will be limited to{scopes.length ? ` (${scopes.length})` : ""}
              </div>
              {scopes.length === 0 ? (
                <div className="mb-2 text-xs text-amber-500">Pick at least one kind above.</div>
              ) : (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {scopes.map((s) => (
                    <span key={s} className="rounded border border-line dark:border-slate-700 bg-panel dark:bg-slate-900 px-2 py-0.5 font-mono text-xs text-cobble-500">{s}</span>
                  ))}
                </div>
              )}
              <div className="text-xs text-faint dark:text-slate-500">
                Recorded on the token: source = <span className="font-mono">script-page</span> · kinds = <span className="font-mono">{wizKinds === "all" ? "all" : pickedTargets.join(", ") || "none"}</span> · {wizExp === "never" ? "never expires" : `expires in ${wizExp === "90d" ? "90 days" : "1 year"}`}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                readOnly
                value={token}
                placeholder="Your scoped token appears here (shown once)"
                className="flex-1 min-w-[280px] rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-3 py-2 font-mono text-sm text-content dark:text-slate-100"
              />
              <button onClick={() => void mint()} disabled={minting || scopes.length === 0} className="rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-60">
                {minting ? "Minting…" : "Generate scoped token"}
              </button>
              {token && (
                <button onClick={() => copy("tok", token)} className="rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm text-muted hover:text-content">
                  {copied === "tok" ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-faint dark:text-slate-500">
              <Info size={13} className="mt-0.5 shrink-0" />
              The token authenticates the script as you, but clamped to the scopes above. Shown once (only a hash is stored); the snippet reads it from COBBLR_TOKEN, never inlines it.
            </p>
          </section>

          {/* 3 · both snippets */}
          <section className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-4">
            <div className="text-sm font-medium text-content dark:text-slate-100">Copy into your script</div>
            {[
              createUrl && { id: "snip-create", title: "Create a record", code: createSnippet, resp: "201 Created — returns the new record with its id." },
              listUrl && { id: "snip-list", title: "Find / list records", code: listSnippet, resp: "200 OK — { items: [ … ] }, newest first." },
            ].filter((b): b is { id: string; title: string; code: string; resp: string } => !!b).map((b) => (
              <div key={b.id}>
                <div className="mb-1.5 text-sm font-medium text-content dark:text-slate-200">{b.title}</div>
                <div className="relative">
                  <button onClick={() => copy(b.id, b.code)} className="absolute right-2 top-2 z-10 rounded border border-line dark:border-slate-700 bg-panel/80 dark:bg-slate-900/80 px-2 py-1 text-xs text-muted hover:text-content">
                    {copied === b.id ? "Copied" : "Copy"}
                  </button>
                  <pre className="overflow-x-auto rounded-md border border-line dark:border-slate-700 bg-slate-950 p-4 text-xs leading-relaxed text-slate-200"><code>{b.code}</code></pre>
                </div>
                <div className="mt-1 text-xs text-muted dark:text-slate-400">→ {b.resp}</div>
              </div>
            ))}
          </section>

          {/* 4 · field reference */}
          <section className="rounded-lg border border-line dark:border-slate-700 p-4">
            <div className="mb-1 text-sm font-medium text-content dark:text-slate-100">Fields for {kind.display_name}</div>
            <p className="mb-2 text-xs text-muted dark:text-slate-400">
              These native field names come straight from your workspace. Your custom fields go under a <span className="font-mono">metadata</span> object.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">
                  <th className="py-1.5 pr-3">Field</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5">Role</th>
                </tr>
              </thead>
              <tbody>
                {nativeFields.map((f) => (
                  <tr key={f.name} className="border-t border-line dark:border-slate-800">
                    <td className="py-1.5 pr-3 font-mono text-content dark:text-slate-200">{f.name}</td>
                    <td className="py-1.5 pr-3 text-muted dark:text-slate-400">{f.type}</td>
                    <td className="py-1.5 text-muted dark:text-slate-400">{f.role ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

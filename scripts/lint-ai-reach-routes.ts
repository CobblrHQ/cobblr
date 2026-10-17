#!/usr/bin/env tsx
// AI-reach lint, ROUTE level: every mutating route is either reachable by the
// assistant, or says why not, AT THE ROUTE. Modules AND the kernel.
//
// The two coarser rules (scripts/lint-ai-reach.ts) already hold: every entity
// kind declares its CRUD routes or justifies the gap, and every module has a
// kind or an action or justifies having neither. What they cannot see is a
// module that has kinds AND actions and still serves a capability covered by
// neither. `POST /locations/reorder` was one: core-locations looked fully
// reachable, and ordering had no door at all. The assistant set `position`
// on twelve racks, the write was silently dropped, and only the user found out
// (2026-08-18). A day's audit then found nine more of the same shape, and the
// only tool for finding them was a script that reported candidates a person
// had to hand-check against each module's actions - a report, which is the
// weakest lever there is.
//
// So the judgement moves to the source, next to the route, where the person
// who wrote it knows the answer. Each mutating route (post/patch/put/delete on
// a router) in a module's api/ must be one of:
//
//   1. a kind's DECLARED CRUD endpoint (createEndpoint / updateEndpoint /
//      deleteEndpoint in the manifest), matched by verb AND path the way the
//      record tools call it (POST, PATCH, DELETE) - already reachable, nothing
//      to write. Matched by path alone, a kind with a create and no delete
//      passed its DELETE route too (tracking's measurements, #4199);
//   2. backed by a registered ACTION - annotate `// AI-ACTION: <action-id>`
//      within 6 lines above the route, and that action must exist in the
//      manifest;
//   3. reached by a workspace TOOL of its own - annotate `// AI-TOOL: <tool>`
//      within 6 lines above the route, and that tool must exist in
//      packages/workspace-tools (the registry Cobb and MCP are both built
//      from). For a door that has to answer in its own shape, the way an
//      agent's add runs the scan intake and returns what it found;
//   4. deliberately NOT reachable - annotate `// AI-REACH: <reason>` above the
//      route: an upload, the edge wire, connector credentials, an operator
//      probe, a financial deletion, an unshipped stub. The reason is for the
//      next reader.
//
// Anything else fails. The kernel's plumbing (register/poll/respond/webhooks)
// is recognised by path so nobody annotates the wire forty times.
//
// THE KERNEL IS IN SCOPE TOO (api/src/routes). It was not, and that is where
// the whole class hid: nav headings, presentation overrides, instances, fields
// - things a person changes on a settings screen and the assistant could only
// point at. Asked to group two sections under a parent, Cobb answered correctly
// and then printed "[Take user to Presentation configuration screen]", because
// signposting was the most he had. Nothing failed; he just said he could not.
//
// Turning it on names every one of those at once, which is why they are
// baselined in scripts/ai-reach-kernel-baseline.json rather than fixed in a
// single change: the baseline is the WORKLIST, it can only shrink, and a NEW
// kernel route cannot join it - it has to say which it is on the day it is
// written. Each entry says what door its route needs; an entry without one is
// a finding, because a bare list of gaps left whoever picked one up to
// re-derive what closing it would take. Kernel routes are matched to actions by the whole registry (any
// module's action may cover a kernel route), since the kernel has no manifest
// of its own.
//
//   cd <repo> && npx tsx scripts/lint-ai-reach-routes.ts
//
// Escape hatch: none beyond the two markers - they ARE the hatch, and they
// leave a sentence behind.

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODULES, WIRE_PATH, kernelRoutes, moduleRoutes, norm, walkTs as walk } from "./lib/mutating-routes.ts";
import { apiDirs, manifestSources } from "./lib/manifest-sources.ts";
const BASELINE_FILE = join("scripts", "ai-reach-kernel-baseline.json");
/** The method the assistant's record tools use for each declared endpoint. */
const CRUD_VERB: Record<string, string> = { create: "POST", update: "PATCH", delete: "DELETE" };
const REGISTRY_FILE = join("docs", "architecture", "ai-capability-registry.md");
const LOOKBACK = 6;
const ACTION_MARK = /AI-ACTION:\s*([a-z0-9-]+:[a-z0-9-]+)/;
const REACH_MARK = /AI-REACH:/;
const TOOL_MARK = /AI-TOOL:\s*([a-z0-9_]+)/;
/** The workspace tools by name: Cobb's chat and both MCP faces are built from this one list. */
const TOOL_NAMES = new Set(
  [...readFileSync(join("packages", "workspace-tools", "src", "tools.ts"), "utf8").matchAll(/^\s{4}name:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!),
);

/** WHO A ROUTE IS FOR, decided by family rather than one annotation at a time.
 *
 *  Turning this rule on the kernel named 185 routes at once, and hand-marking
 *  each would have been 185 chances to write "not for the assistant" about
 *  something that is. Most fall into a handful of families that are obviously
 *  nobody's workspace capability — an operator console, a person's own
 *  credentials, who may join. Naming the FAMILY once says it for all of them,
 *  in a sentence a reader can argue with.
 *
 *  Everything outside these families is workspace configuration: something a
 *  person does to their own workspace, which means Cobb should be able to do
 *  it too. Those show up automatically as the worklist — nobody has to notice
 *  them or remember to add them.
 */
const NO_DOOR: Array<{ file?: RegExp; path?: RegExp; why: string }> = [
  {
    file: /^(super-admin|admin-users|test-support)/,
    why: "the operator console: our surface for running the platform, not a capability inside anyone's workspace",
  },
  {
    file: /^(auth|sessions?)\b/,
    why: "signing in, passwords, tokens: an assistant must never be able to move an account's credentials",
  },
  {
    // connections.ts serves BOTH a person's own credentials (/me/connections)
    // and the workspace's sharing of them, so the path decides, not the file.
    file: /^me\b/,
    path: /^\/me\//,
    why: "a person's own account and their private connections: theirs to change, and not on behalf of a workspace",
  },
  {
    // By PATH as well as by file, because these live in more than one router:
    // portal.ts serves the grants for a shared portal, members.ts the workspace.
    file: /^(members|custom-roles|permissions)/,
    path: /\/permissions\//,
    why: "who may enter this workspace and what they may do: a decision about other people, taken by a person",
  },
  {
    file: /^(edge|inbound-email|discord-interactions|webhooks?|hooks|receipt-ingest|scan-drive)/,
    why: "the wire: a machine talking to us (a webhook, a forwarded email, a scanner posting a code), with no sentence behind it",
  },
  {
    file: /^desktop-updates/,
    why: "publishing a release of the desktop helper: instance-wide, ours to ship, and nothing to do with one workspace",
  },
  {
    file: /^feedback/,
    why: "reporting something to us, which changes nothing in the workspace",
  },
  {
    file: /^(backup|drive)/,
    why: "moving the whole workspace's data in or out, and authorising third-party storage: the one place a wrong call cannot be walked back from inside",
  },
];

/** The family this route belongs to, or null when it is workspace config. */
function noDoorFor(file: string, path: string): string | null {
  const base = file.replace(/^api\/src\/routes\//, "");
  return NO_DOOR.find((f) => f.file?.test(base) || f.path?.test(path))?.why ?? null;
}

/** Kernel wire and operator plumbing: never a capability a person asks the
 *  assistant for, so no annotation is demanded. Kept narrow on purpose. */
const PLUMBING = WIRE_PATH;

interface Finding {
  where: string;
  route: string;
  problem: string;
}

/** One mutating route and what it is, for the generated registry. */
interface Entry {
  area: string; // module name, or "kernel"
  file: string;
  route: string;
  status: "crud" | "action" | "tool" | "no-door" | "open";
  detail: string; // the action id, or the reason there is no door
}
const registry: Entry[] = [];

/** The sentence after `// AI-REACH:` — the reason, for the registry. Comment
 *  markers and the wrapped continuation lines are stripped so it reads as prose. */
function reachReason(above: string): string {
  const lines = above.split("\n");
  const at = lines.findIndex((l) => REACH_MARK.test(l));
  if (at < 0) return "stated at the route";
  const out: string[] = [];
  for (let i = at; i < lines.length; i++) {
    const raw = lines[i]!.replace(/^\s*\/\/\s?/, "");
    if (i > at && !/^\s*\/\//.test(lines[i]!)) break;
    // A screen's marker (lint-ui-reach) is the next sentence, not this one's.
    if (i > at && /UI-(REACH|SCREEN):/.test(lines[i]!)) break;
    out.push(raw.replace(/^AI-REACH:\s*/, "").trim());
  }
  return out.join(" ").trim() || "stated at the route";
}

const findings: Finding[] = [];
let checked = 0;

for (const mod of readdirSync(MODULES)) {
  const dir = join(MODULES, mod);
  const man = join(dir, "src", "module.ts");
  if (!existsSync(man) || apiDirs(dir).length === 0) continue;

  const manSrc = manifestSources(dir).map((f) => readFileSync(f, "utf8")).join("\n");
  // Keyed by VERB and path, as the assistant's tools call them: create is a
  // POST, update a PATCH, delete a DELETE. Keyed by path alone, a declared
  // GET covered every write on the same path, so `DELETE /measurements/:id`
  // passed for a kind that declares no delete at all (#4199).
  const declared = new Set(
    [...manSrc.matchAll(/(create|update|delete)Endpoint:\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${CRUD_VERB[m[1]!]} ${norm(m[2]!)}`),
  );
  const actionIds = new Set([...manSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)].map((m) => m[1]!));

  for (const r of moduleRoutes(mod, LOOKBACK)) {
    const f = r.file;
    const full = r.path;
    const where = `${f}:${r.line}`;
    const route = `${r.verb} ${full}`;
    checked++;

    if (declared.has(route)) {
      registry.push({ area: mod, file: f, route, status: "crud", detail: "a record kind's own create/update/delete" });
      continue; // a kind's CRUD endpoint
    }
    if (PLUMBING.test(full)) continue; // the wire, operator plumbing

    const above = r.above;
    const act = above.match(ACTION_MARK);
    if (act) {
      if (!actionIds.has(act[1]!)) {
        findings.push({ where, route, problem: `AI-ACTION names "${act[1]}", which ${mod}'s manifest does not declare` });
      }
      registry.push({ area: mod, file: f, route, status: "action", detail: act[1]! });
      continue;
    }
    const tool = above.match(TOOL_MARK);
    if (tool) {
      if (!TOOL_NAMES.has(tool[1]!)) {
        findings.push({ where, route, problem: `AI-TOOL names "${tool[1]}", which packages/workspace-tools does not register` });
      }
      registry.push({ area: mod, file: f, route, status: "tool", detail: tool[1]! });
      continue;
    }
    if (REACH_MARK.test(above)) {
      registry.push({ area: mod, file: f, route, status: "no-door", detail: reachReason(above) });
      continue;
    }
    registry.push({ area: mod, file: f, route, status: "open", detail: "" });
    findings.push({ where, route, problem: "no AI-ACTION / AI-REACH annotation" });
  }
}

// ── The kernel's own routes ────────────────────────────────────────────────
// Every action id declared anywhere: a kernel route may be covered by a
// module's action (nav headings are core-presentation's), so the whole
// registry is the vocabulary here.
const allActionIds = new Set<string>();
for (const mod of readdirSync(MODULES)) for (const man of manifestSources(join(MODULES, mod))) {
  for (const m of readFileSync(man, "utf8").matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) {
    allActionIds.add(m[1]!);
  }
}
// The kernel declares a few actions of its own (add a field, create a list,
// toggle an automation) outside any module manifest. Missing them made three
// real doors read as gaps, and a route they cover read as unreachable.
const PLATFORM_ACTIONS_FILE = join("api", "src", "platform", "platform-actions.ts");
const platformActionSrc = existsSync(PLATFORM_ACTIONS_FILE) ? readFileSync(PLATFORM_ACTIONS_FILE, "utf8") : "";
for (const m of platformActionSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) allActionIds.add(m[1]!);
// ...and there must go on being only one such file. A second one would read as
// a pile of gaps here while working perfectly at runtime, which is how these
// three hid: the registry said 67 doors when there were 70.
for (const f of walk(join("api", "src", "platform"))) {
  if (f === PLATFORM_ACTIONS_FILE) continue;
  if (/PlatformActionDecl\s*\[\s*\]\s*=/.test(readFileSync(f, "utf8"))) {
    findings.push({
      where: f,
      route: "-",
      problem: `declares kernel actions outside ${PLATFORM_ACTIONS_FILE}; this lint reads that file only, so those actions would look like gaps`,
    });
  }
}

/** Each worklist entry says what door the route needs. A bare list of routes
 *  said which capabilities were missing and nothing about what closing one
 *  would take, so nobody could pick one up without re-deriving it (#4199). */
const baselineReasons: Record<string, string> = existsSync(BASELINE_FILE)
  ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { unreachable: Record<string, string> }).unreachable
  : {};
const baseline = Object.keys(baselineReasons);
const baselined = new Set(baseline);
for (const [key, why] of Object.entries(baselineReasons)) {
  if (typeof why !== "string" || why.trim().length < 12) {
    findings.push({ where: BASELINE_FILE, route: key, problem: "the worklist entry does not say what door the route needs" });
  }
}
const stillUnreachable = new Set<string>();
const unbaselined: string[] = [];
/** `--write-baseline` records today's unreachable kernel routes as the worklist.
 *  Run once, when the rule is first turned on; after that a new one must say
 *  which it is at the route. */
const WRITING = process.argv.includes("--write-baseline");

{
  for (const r of kernelRoutes(LOOKBACK)) {
    const f = r.file;
    const full = r.path;
    if (PLUMBING.test(full)) continue;
    checked++;

    const route = `${r.verb} ${full}`;
    const key = `${f.replace(/^api\/src\/routes\//, "")} ${route}`;
    const above = r.above;
    const act = above.match(ACTION_MARK);
    if (act) {
      if (!allActionIds.has(act[1]!)) {
        findings.push({ where: `${f}:${r.line}`, route, problem: `AI-ACTION names "${act[1]}", which no module declares` });
      }
      registry.push({ area: "kernel", file: f, route, status: "action", detail: act[1]! });
      continue;
    }
    if (REACH_MARK.test(above)) {
      registry.push({ area: "kernel", file: f, route, status: "no-door", detail: reachReason(above) });
      continue;
    }
    const family = noDoorFor(f, full);
    if (family) {
      registry.push({ area: "kernel", file: f, route, status: "no-door", detail: family });
      continue;
    }
    registry.push({ area: "kernel", file: f, route, status: "open", detail: baselineReasons[key] ?? "" });
    if (baselined.has(key)) {
      stillUnreachable.add(key);
      continue;
    }
    unbaselined.push(key);
    findings.push({
      where: `${f}:${r.line}`,
      route,
      problem: "no AI-ACTION / AI-REACH annotation (kernel route, not in the baseline)",
    });
  }
}

// ── The combined registry ─────────────────────────────────────────────────
// One generated page answering "what can Cobb do here, what will he never be
// allowed to do, and what can't he do yet" — from the annotations themselves,
// so it cannot drift from the code and nobody has to remember to add a line.
const actionLabels = new Map<string, string>();
const actionsByModule = new Map<string, string[]>();
/** Is this declaration wire-only — fired by an event or a card press and
 *  never offered to the assistant? Read from the id to the next declaration,
 *  since the flag sits at the end of the object, after the label. */
function wireOnlyDecl(src: string, from: number): boolean {
  const rest = src.slice(from + 4);
  const next = rest.search(/\bid:\s*["'`][a-z0-9-]+:[a-z0-9-]+["'`]/);
  const window = next < 0 ? rest : rest.slice(0, next);
  return /\b(?:wire_only|wireOnly):\s*true/.test(window);
}
for (const m of platformActionSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]([\s\S]{0,200}?)label:\s*["'`]([^"'`]+)["'`]/g)) {
  actionLabels.set(m[1]!, m[3]!);
  // A card-pressed decision (approve/deny a request) is not a door the
  // assistant can walk through, and the registry must not say it is.
  if (wireOnlyDecl(platformActionSrc, m.index)) continue;
  actionsByModule.set("the kernel itself", [...new Set([...(actionsByModule.get("the kernel itself") ?? []), m[1]!])]);
}
for (const mod of readdirSync(MODULES)) for (const man of manifestSources(join(MODULES, mod))) {
  const src = readFileSync(man, "utf8");
  for (const m of src.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]([\s\S]{0,400}?)label:\s*["'`]([^"'`]+)["'`]/g)) {
    // An action that exists only as the way back for another is no door the
    // assistant can walk through, so it is not listed as one.
    if (/internal:\s*true/.test(m[2]!)) continue;
    if (!actionLabels.has(m[1]!)) actionLabels.set(m[1]!, m[3]!);
    if (wireOnlyDecl(src, m.index)) continue;
    actionsByModule.set(mod, [...new Set([...(actionsByModule.get(mod) ?? []), m[1]!])]);
  }
}

function renderRegistry(): string {
  const of = (s: Entry["status"]): Entry[] =>
    registry.filter((e) => e.status === s).sort((a, b) => `${a.area} ${a.route}`.localeCompare(`${b.area} ${b.route}`));
  const open = of("open");
  const doors = of("action");
  const crud = of("crud");
  const tools = of("tool");
  const shut = of("no-door");

  // Group the closed doors by the SENTENCE, so a family that covers thirty
  // routes reads as one decision rather than thirty.
  const byReason = new Map<string, Entry[]>();
  for (const e of shut) byReason.set(e.detail, [...(byReason.get(e.detail) ?? []), e]);
  // Alphabetical, never by size: every line here must stay where it is when a
  // route elsewhere is added, so two pull requests that each add one merge
  // into exactly what a fresh generation writes (see the header of this doc).
  const reasons = [...byReason.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const acts = [...new Set(doors.map((d) => d.detail))].sort();
  const allActs = [...actionsByModule.values()].flat();
  const L: string[] = [];
  L.push("<!-- GENERATED by scripts/lint-ai-reach-routes.ts --write-registry. Do not edit. -->");
  L.push("# What the assistant can reach");
  L.push("");
  L.push(
    "Every route in this platform that CHANGES something, sorted into three piles: the ones Cobb can " +
      "run, the ones he must never run, and the ones he cannot run yet. Generated from the annotations " +
      "at the routes themselves, so it is the code's own answer rather than a list someone keeps.",
  );
  L.push("");
  // No counts in the doc. Every route added anywhere changed them, so any two
  // pull requests that each added a route conflicted on these lines or merged
  // them stale, and merge-pr sent both round again. The lint's own run says
  // how many routes it checked.
  L.push("- **Reachable**: the actions he can run by name, each record kind's own create/update/delete, and the doors with a tool of their own");
  L.push("- **Shut, and why**: routes he must never run, grouped by the stated reason");
  L.push("- **Not reachable yet**: the worklist");
  L.push("");
  L.push("## Reachable");
  L.push("");
  L.push(
    "Nothing here is hand-listed to the assistant. Registered actions are enumerated live by the " +
      "`list_actions` tool, with their arguments, so an action added today is usable in the next " +
      "sentence a person types. Record kinds are reachable the same way through create/update/delete.",
  );
  L.push("");
  for (const [mod, ids] of [...actionsByModule.entries()].sort()) {
    L.push(`**${mod}**`);
    L.push("");
    for (const id of [...ids].sort()) {
      const routes = doors.filter((d) => d.detail === id).map((d) => d.route);
      L.push(
        `- \`${id}\`${actionLabels.get(id) ? ` — ${actionLabels.get(id)}` : ""}` +
          (routes.length ? ` (${routes.join(", ")})` : ""),
      );
    }
    L.push("");
  }
  if (tools.length) {
    L.push("**Doors with a tool of their own**");
    L.push("");
    for (const e of tools) L.push(`- \`${e.detail}\`: ${e.area}: ${e.route}`);
    L.push("");
  }
  if (acts.length !== allActs.length) {
    L.push("Some of these are the door on a route this lint checks; the rest act through the platform rather than an HTTP endpoint of their own.");
    L.push("");
  }
  L.push("");
  L.push("## Shut, and why");
  L.push("");
  L.push(
    "A door is shut by naming a family once (an operator console, someone's own credentials, the wire) " +
      "or by a sentence at the route. Both live in the code; neither is a list to maintain.",
  );
  for (const [why, entries] of reasons) {
    L.push("");
    L.push(`**${why}**`);
    L.push("");
    for (const e of entries) L.push(`- ${e.area === "kernel" ? "" : `${e.area}: `}${e.route} \`${e.file}\``);
  }
  L.push("");
  L.push("## Not reachable yet");
  L.push("");
  L.push(
    "A capability a person has and Cobb does not. Each one is a sentence someone will say to him that " +
      "he can only answer by pointing at a screen. Give it an action and it leaves this list by itself.",
  );
  L.push("");
  // By file, because the gaps come in clusters — the fields screen, instances,
  // bundles — and a flat list of 42 routes hides that there are really six jobs.
  const byFile = new Map<string, Entry[]>();
  for (const e of open) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, entries] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`**${file}**`);
    L.push("");
    for (const e of entries) L.push(`- ${e.route}${e.detail ? `: ${e.detail}` : ""}`);
    L.push("");
  }
  L.push("");
  return L.join("\n");
}

// `--write-registry` rewrites the capability doc ONLY. The doc is a pure
// function of the routes, so merge-pr regenerates it on a merge tree
// (lib/generated-files.mjs); the kernel baseline beside it is a worklist that
// may only shrink, and must never be rewritten by a merge.
if (process.argv.includes("--write-registry")) {
  writeFileSync(REGISTRY_FILE, renderRegistry());
  console.log(`wrote ${REGISTRY_FILE}`);
  process.exit(0);
}

if (WRITING) {
  writeFileSync(REGISTRY_FILE, renderRegistry());
  const all = Object.fromEntries([...new Set([...stillUnreachable, ...unbaselined])].sort().map((k) => [k, baselineReasons[k] ?? ""]));
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        _why:
          "Kernel routes the assistant cannot reach. A WORKLIST, not an allowance: it may only shrink. " +
          "Each is a capability a person has and Cobb does not, which is how he came to print a stage " +
          "direction instead of grouping two nav sections. Give one an action (// AI-ACTION: <id>) or say " +
          "why it should never have a door (// AI-REACH: <reason>), then delete its line. A NEW kernel " +
          "route cannot be added here: it says which it is on the day it is written.",
        unreachable: all,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`ai-reach-routes: wrote ${Object.keys(all).length} kernel route(s) to ${BASELINE_FILE}, registry to ${REGISTRY_FILE}`);
  process.exit(0);
}

// The baseline may only shrink. A line that no longer matches anything is a
// capability someone gave the assistant — take it out, or it silently excuses
// the next route that happens to land on the same path.
const staleBaseline = baseline.filter((k) => !stillUnreachable.has(k));

// `--prune` only REMOVES those lines and can never add one, so merge-pr runs
// it on the merge tree (lib/generated-files.mjs). Two pull requests that each
// closed a route otherwise left the second one red against main, carrying the
// first one's line (#6539 after #6544, 2026-10-14).
if (process.argv.includes("--prune")) {
  if (staleBaseline.length) {
    const keep = Object.fromEntries(Object.entries(baselineReasons).filter(([k]) => stillUnreachable.has(k)));
    const whole = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, unknown>;
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...whole, unreachable: keep }, null, 2)}\n`);
    console.log(`ai-reach-routes: pruned ${staleBaseline.length} closed line(s) from ${BASELINE_FILE}`);
  }
  process.exit(0);
}
if (staleBaseline.length) {
  console.error(
    `✗ ai-reach-routes lint: ${staleBaseline.length} baseline entr(y/ies) no longer match a route.\n` +
      "Remove them from scripts/ai-reach-kernel-baseline.json:\n" +
      staleBaseline.map((k) => `  ${k}`).join("\n"),
  );
  process.exit(1);
}

// Findings first: a stale registry is the SYMPTOM of an unannotated route,
// and reporting it first hid which route it was.
if (findings.length > 0) {
  console.error(`✗ ai-reach-routes lint: ${findings.length} mutating route(s) neither reachable by the assistant nor justified.\n`);
  for (const f of findings) console.error(`  ${f.where}\n      ${f.route}\n      ${f.problem}`);
  console.error(`
A route the assistant cannot reach is a capability that exists for a person and
not for Cobb, and nothing fails when that happens - he just says he can't. Say
which it is, at the route, within ${LOOKBACK} lines above it:

    // AI-ACTION: <module>:<action>     it is backed by that registered action
    // AI-REACH: <why not>              it should not have a door (an upload,
                                        the wire, credentials, a financial
                                        deletion, an unshipped stub)

A kind's declared CRUD endpoint needs nothing - the manifest already says so.`);
  process.exit(1);
}

// The registry is generated, so a stale one is a lie about what the assistant
// can do — and the people most likely to read it are the ones deciding whether
// a capability needs building.
const wantRegistry = renderRegistry();
if (!existsSync(REGISTRY_FILE) || readFileSync(REGISTRY_FILE, "utf8") !== wantRegistry) {
  console.error(
    `✗ ai-reach-routes lint: ${REGISTRY_FILE} is stale.\n` +
      "  Regenerate: npx tsx scripts/lint-ai-reach-routes.ts --write-baseline",
  );
  process.exit(1);
}


console.log(
  `✓ ai-reach-routes lint: all ${checked} mutating route(s) are reachable, backed by an action, or justified` +
    (stillUnreachable.size ? ` (${stillUnreachable.size} kernel route(s) still on the baseline worklist)` : "") +
    ".",
);

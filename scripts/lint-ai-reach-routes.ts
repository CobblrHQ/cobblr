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
//      deleteEndpoint in the manifest) - already reachable, nothing to write;
//   2. backed by a registered ACTION - annotate `// AI-ACTION: <action-id>`
//      within 6 lines above the route, and that action must exist in the
//      manifest;
//   3. deliberately NOT reachable - annotate `// AI-REACH: <reason>` above the
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
// written. Kernel routes are matched to actions by the whole registry (any
// module's action may cover a kernel route), since the kernel has no manifest
// of its own.
//
//   cd <repo> && npx tsx scripts/lint-ai-reach-routes.ts
//
// Escape hatch: none beyond the two markers - they ARE the hatch, and they
// leave a sentence behind.

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";
const KERNEL = join("api", "src", "routes");
const BASELINE_FILE = join("scripts", "ai-reach-kernel-baseline.json");
const REGISTRY_FILE = join("docs", "architecture", "ai-capability-registry.md");
const LOOKBACK = 6;
const ACTION_MARK = /AI-ACTION:\s*([a-z0-9-]+:[a-z0-9-]+)/;
const REACH_MARK = /AI-REACH:/;

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
const PLUMBING =
  /\/(edge|poll|respond|register|webhook|hooks?|callback|heartbeat|probe|healthz|sweep|openapi|_internal)(\/|$)/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

const norm = (p: string): string =>
  ("/" + p.replace(/^\/+/, "")).replace(/\{[^}]+\}/g, ":x").replace(/:[a-zA-Z_]+/g, ":x").replace(/\/+$/, "") || "/";

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
  status: "crud" | "action" | "no-door" | "open";
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
    out.push(raw.replace(/^AI-REACH:\s*/, "").trim());
  }
  return out.join(" ").trim() || "stated at the route";
}

const findings: Finding[] = [];
let checked = 0;

for (const mod of readdirSync(MODULES)) {
  const dir = join(MODULES, mod);
  const man = join(dir, "src", "module.ts");
  const api = join(dir, "src", "api");
  if (!existsSync(man) || !existsSync(api)) continue;

  const manSrc = readFileSync(man, "utf8");
  const declared = new Set(
    [...manSrc.matchAll(/(get|create|update|delete)Endpoint:\s*["'`]([^"'`]+)["'`]/g)].map((m) => norm(m[2]!)),
  );
  const actionIds = new Set([...manSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)].map((m) => m[1]!));

  // Router mount prefixes, from the module's api/index.ts.
  const idx = join(api, "index.ts");
  const mounts = new Map<string, string>();
  if (existsSync(idx)) {
    for (const m of readFileSync(idx, "utf8").matchAll(/\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+)\s*\)/g)) {
      mounts.set(m[2]!, m[1] ? norm(m[1]) : "");
    }
  }

  for (const f of walk(api)) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*(\w+)\s*\.\s*(post|patch|put|delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/);
      if (!m) continue;
      const [, varName, verb, sub] = m;
      if (!/[Rr]outer$/.test(varName!)) continue;
      // The path may sit on the next line: `router.post(\n  "/x",`
      let path = sub;
      if (path === undefined) {
        const nxt = lines[i + 1]?.match(/^\s*["'`]([^"'`]*)["'`]/);
        path = nxt?.[1];
      }
      if (path === undefined) continue;
      const prefix = mounts.get(varName!);
      const full = prefix === undefined ? norm(path) : norm(prefix + (path === "/" ? "" : path));
      const where = `${f}:${i + 1}`;
      const route = `${verb!.toUpperCase()} ${full}`;
      checked++;

      if (declared.has(full)) {
        registry.push({ area: mod, file: f, route, status: "crud", detail: "a record kind's own create/update/delete" });
        continue; // a kind's CRUD endpoint
      }
      if (PLUMBING.test(full)) continue; // the wire, operator plumbing

      const above = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
      const act = above.match(ACTION_MARK);
      if (act) {
        if (!actionIds.has(act[1]!)) {
          findings.push({ where, route, problem: `AI-ACTION names "${act[1]}", which ${mod}'s manifest does not declare` });
        }
        registry.push({ area: mod, file: f, route, status: "action", detail: act[1]! });
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
}

// ── The kernel's own routes ────────────────────────────────────────────────
// Every action id declared anywhere: a kernel route may be covered by a
// module's action (nav headings are core-presentation's), so the whole
// registry is the vocabulary here.
const allActionIds = new Set<string>();
for (const mod of readdirSync(MODULES)) {
  const man = join(MODULES, mod, "src", "module.ts");
  if (!existsSync(man)) continue;
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

const baseline: string[] = existsSync(BASELINE_FILE)
  ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { unreachable: string[] }).unreachable
  : [];
const baselined = new Set(baseline);
const stillUnreachable = new Set<string>();
const unbaselined: string[] = [];
/** `--write-baseline` records today's unreachable kernel routes as the worklist.
 *  Run once, when the rule is first turned on; after that a new one must say
 *  which it is at the route. */
const WRITING = process.argv.includes("--write-baseline");

if (existsSync(KERNEL)) {
  for (const f of walk(KERNEL)) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*(\w+)\s*\.\s*(post|patch|put|delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/);
      if (!m) continue;
      const [, varName, verb, sub] = m;
      if (!/[Rr]outer$/.test(varName!)) continue;
      let path = sub;
      if (path === undefined) path = lines[i + 1]?.match(/^\s*["'`]([^"'`]*)["'`]/)?.[1];
      if (path === undefined) continue;
      const full = norm(path);
      if (PLUMBING.test(full)) continue;
      checked++;

      const route = `${verb!.toUpperCase()} ${full}`;
      const key = `${f.replace(/^api\/src\/routes\//, "")} ${route}`;
      const above = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
      const act = above.match(ACTION_MARK);
      if (act) {
        if (!allActionIds.has(act[1]!)) {
          findings.push({ where: `${f}:${i + 1}`, route, problem: `AI-ACTION names "${act[1]}", which no module declares` });
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
      registry.push({ area: "kernel", file: f, route, status: "open", detail: "" });
      if (baselined.has(key)) {
        stillUnreachable.add(key);
        continue;
      }
      unbaselined.push(key);
      findings.push({
        where: `${f}:${i + 1}`,
        route,
        problem: "no AI-ACTION / AI-REACH annotation (kernel route, not in the baseline)",
      });
    }
  }
}

// ── The combined registry ─────────────────────────────────────────────────
// One generated page answering "what can Cobb do here, what will he never be
// allowed to do, and what can't he do yet" — from the annotations themselves,
// so it cannot drift from the code and nobody has to remember to add a line.
const actionLabels = new Map<string, string>();
const actionsByModule = new Map<string, string[]>();
for (const m of platformActionSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]([\s\S]{0,200}?)label:\s*["'`]([^"'`]+)["'`]/g)) {
  actionLabels.set(m[1]!, m[3]!);
  actionsByModule.set("the kernel itself", [...new Set([...(actionsByModule.get("the kernel itself") ?? []), m[1]!])]);
}
for (const mod of readdirSync(MODULES)) {
  const man = join(MODULES, mod, "src", "module.ts");
  if (!existsSync(man)) continue;
  const src = readFileSync(man, "utf8");
  for (const m of src.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]([\s\S]{0,400}?)label:\s*["'`]([^"'`]+)["'`]/g)) {
    if (!actionLabels.has(m[1]!)) actionLabels.set(m[1]!, m[3]!);
    actionsByModule.set(mod, [...new Set([...(actionsByModule.get(mod) ?? []), m[1]!])]);
  }
}

function renderRegistry(): string {
  const of = (s: Entry["status"]): Entry[] =>
    registry.filter((e) => e.status === s).sort((a, b) => `${a.area} ${a.route}`.localeCompare(`${b.area} ${b.route}`));
  const open = of("open");
  const doors = of("action");
  const crud = of("crud");
  const shut = of("no-door");

  // Group the closed doors by the SENTENCE, so a family that covers thirty
  // routes reads as one decision rather than thirty.
  const byReason = new Map<string, Entry[]>();
  for (const e of shut) byReason.set(e.detail, [...(byReason.get(e.detail) ?? []), e]);
  const reasons = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);

  const acts = [...new Set(doors.map((d) => d.detail))].sort();
  const allActs = [...actionsByModule.values()].flat();
  const L: string[] = [];
  L.push("<!-- GENERATED by scripts/lint-ai-reach-routes.ts --write-baseline. Do not edit. -->");
  L.push("# What the assistant can reach");
  L.push("");
  L.push(
    "Every route in this platform that CHANGES something, sorted into three piles: the ones Cobb can " +
      "run, the ones he must never run, and the ones he cannot run yet. Generated from the annotations " +
      "at the routes themselves, so it is the code's own answer rather than a list someone keeps.",
  );
  L.push("");
  L.push(`- **${allActs.length} actions** he can run by name, ${crud.length} routes that are a record kind's own create/update/delete`);
  L.push(`- **${shut.length} deliberately shut**, for ${reasons.length} stated reasons`);
  L.push(`- **${open.length} not reachable yet** — the worklist`);
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
  if (acts.length !== allActs.length) {
    L.push(
      `${acts.length} of these are the door on a route this lint checks; the rest act through the platform ` +
        "rather than an HTTP endpoint of their own.",
    );
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
  for (const [file, entries] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`**${file}** (${entries.length})`);
    L.push("");
    for (const e of entries) L.push(`- ${e.route}`);
    L.push("");
  }
  L.push("");
  return L.join("\n");
}

if (WRITING) {
  writeFileSync(REGISTRY_FILE, renderRegistry());
  const all = [...new Set([...stillUnreachable, ...unbaselined])].sort();
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
  console.log(`ai-reach-routes: wrote ${all.length} kernel route(s) to ${BASELINE_FILE}, registry to ${REGISTRY_FILE}`);
  process.exit(0);
}

// The baseline may only shrink. A line that no longer matches anything is a
// capability someone gave the assistant — take it out, or it silently excuses
// the next route that happens to land on the same path.
const staleBaseline = baseline.filter((k) => !stillUnreachable.has(k));
if (staleBaseline.length) {
  console.error(
    `✗ ai-reach-routes lint: ${staleBaseline.length} baseline entr(y/ies) no longer match a route.\n` +
      "Remove them from scripts/ai-reach-kernel-baseline.json:\n" +
      staleBaseline.map((k) => `  ${k}`).join("\n"),
  );
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

console.log(
  `✓ ai-reach-routes lint: all ${checked} mutating route(s) are reachable, backed by an action, or justified` +
    (stillUnreachable.size ? ` (${stillUnreachable.size} kernel route(s) still on the baseline worklist)` : "") +
    ".",
);

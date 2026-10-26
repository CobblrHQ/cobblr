#!/usr/bin/env tsx
// Every notification the code sends is a kind somebody declared with a label, so the inbox and the channel settings name it in words instead of showing its id.
//
// THE BUG THIS PREVENTS. The fundamentals audit (#4115) found the inbox
// showing raw ids under a notification: digifab.print.failed,
// platform.approval.requested, core-scan.email.imported. Nobody had declared
// those kinds, so nothing knew their names, and the per-event routing on the
// Channels page was a free-text box a person had to guess ids into.
//
// THE RULE. A notification type is sent when the code passes it as
// `eventType:` (dispatch) or `notificationType:` (notifyAccount), as a string,
// including a string schema’s default for one of these fields,
// as a constant naming one (resolved in the same file), or as a template whose
// fixed front is `<a>.<b>.` (then some declared kind must start with it).
// Each must be declared in one of:
//   - a module manifest's `exposes.notifications` ({ eventType, label }),
//   - the kernel's list, api/src/platform/notification-kinds.ts,
//   - the account catalog, api/src/platform/notification-catalog.ts ({ key }).
// A type deliberately left unnamed says so on the line or the one above:
// `// notification-unnamed: <why>`.
//
// AND THE OTHER WAY: every declared kind is one something sends. A declared
// kind is a row on the Delivery page or a choice on the Channels page, so one
// nothing sends is a switch for mail that never comes. The account catalog
// carried three of those for months ("Messages from Claude", "Feature
// announcements", "Workspace updates") on every person's Delivery page. A
// kind sent where this cannot see it (the auth-email path, the hosted
// overlay, an index into a list) names its sender on the line above:
// `// notification-sent-elsewhere: <what sends it>`. `event_type:` counts as a
// send too (a row written straight into the notifications table), but only as
// an object key: `first.event_type : "x"` in a ternary is not one.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `eventType` is also the key
// of the event bus (`events.emit("digifab.print.completed")`) and of a wire;
// those are events, not notifications, and are left alone: only object keys
// named `eventType`/`notificationType` are read, and the manifests' own
// declarations and the registries are the other side, not senders. A
// sandboxed module's `sandbox:<name>` type is named by its manifest at run
// time, not in this tree.
//
//   npx tsx scripts/lint-notifications-are-named.ts   (pnpm lint notifications-are-named)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { manifestSources } from "./lib/manifest-sources.ts";

const KERNEL_LIST = join("api", "src", "platform", "notification-kinds.ts");
const ACCOUNT_CATALOG = join("api", "src", "platform", "notification-catalog.ts");
const OPT_OUT = /notification-unnamed:\s*\S/;

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "ui" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

// ── What is declared ──────────────────────────────────────────────────────
const declared = new Set<string>();
const declaredAt = new Map<string, string>();
const manifests: string[] = [];
// A family's manifest (scripts/lib/manifest-sources.ts) declares its own.
for (const mod of readdirSync("modules")) for (const man of manifestSources(join("modules", mod))) {
  manifests.push(man);
  const src = readFileSync(man, "utf8");
  // An entry of exposes.notifications carries a label beside its eventType.
  for (const m of src.matchAll(/eventType:\s*["'`]([a-z0-9-]+\.[a-z0-9._-]+)["'`][^}]{0,400}?\blabel:/g)) {
    declared.add(m[1]!);
    declaredAt.set(m[1]!, man);
  }
}
if (existsSync(KERNEL_LIST)) {
  for (const m of readFileSync(KERNEL_LIST, "utf8").matchAll(/eventType:\s*["'`]([^"'`]+)["'`]/g)) {
    declared.add(m[1]!);
    declaredAt.set(m[1]!, KERNEL_LIST);
  }
}
const bridgeKinds = join("api", "src", "platform", "edge-outages.ts");
if (existsSync(bridgeKinds)) {
  for (const m of readFileSync(bridgeKinds, "utf8").matchAll(/eventType:\s*["'`]([^"'`]+)["'`]/g)) {
    declared.add(m[1]!);
    declaredAt.set(m[1]!, bridgeKinds);
  }
}
if (existsSync(ACCOUNT_CATALOG)) {
  for (const m of readFileSync(ACCOUNT_CATALOG, "utf8").matchAll(/\bkey:\s*["'`]([^"'`]+)["'`]/g)) {
    declared.add(m[1]!);
    declaredAt.set(m[1]!, ACCOUNT_CATALOG);
  }
}

// ── What is sent ──────────────────────────────────────────────────────────
const SKIP = new Set([KERNEL_LIST, ACCOUNT_CATALOG, bridgeKinds, ...manifests]);
const SENT = /(?<![.\w])(?:eventType|notificationType|event_type)\s*:\s*(?:z\.string\(\)(?:\.\w+\([^)]*\))*?\.default\(\s*)?(["'`])((?:(?!\1).)*)\1|(?<![.\w])(?:eventType|notificationType|event_type)\s*:\s*([A-Z][A-Z0-9_]*)\b/g;
const out: string[] = [];
let sent = 0;
const sentExact = new Set<string>();
const sentPrefixes: string[] = [];
for (const root of ["api/src", "modules"]) {
  for (const f of walk(root)) {
    if (SKIP.has(f)) continue;
    const src = readFileSync(f, "utf8");
    if (!/\b(eventType|notificationType|event_type)\s*:/.test(src)) continue;
    const consts = new Map([...src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g)].map((m) => [m[1]!, m[2]!] as const));
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(SENT)) {
        const raw = m[2] ?? (m[3] ? consts.get(m[3]) : undefined);
        if (raw === undefined) continue;
        if (raw.startsWith("sandbox:")) continue;
        const template = raw.includes("${");
        const fixed = template ? raw.slice(0, raw.indexOf("${")) : raw;
        if (!/^[a-z0-9-]+\.[a-z0-9._-]*$/.test(fixed)) continue;
        sent++;
        if (template) sentPrefixes.push(fixed);
        else sentExact.add(fixed);
        const ok = template ? [...declared].some((d) => d.startsWith(fixed)) : declared.has(fixed);
        if (ok || OPT_OUT.test(lines[i]!) || OPT_OUT.test(lines[i - 1] ?? "")) continue;
        out.push(`  ${f}:${i + 1}  sends "${raw}", which no module, the kernel list or the account catalog names`);
      }
    }
  }
}

// ── And the other way: every kind offered is one something sends ─────────
// A declared kind is a row on the Delivery page or a choice in the Channels
// picker. One nobody sends is a switch for mail that never comes.
const SENT_ELSEWHERE = /notification-sent-elsewhere:\s*\S/;
const unsent: string[] = [];
for (const kind of [...declared].sort()) {
  if (sentExact.has(kind) || sentPrefixes.some((p) => kind.startsWith(p))) continue;
  const file = declaredAt.get(kind)!;
  const lines = readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`"${kind}"`));
  if (i >= 0 && (SENT_ELSEWHERE.test(lines[i]!) || SENT_ELSEWHERE.test(lines[i - 1] ?? ""))) continue;
  unsent.push(`  ${file}:${i + 1}  declares "${kind}", which nothing sends`);
}
if (out.length) {
  console.error(
    `✗ lint:notifications-are-named: ${out.length} notification type(s) sent with no name:\n${out.join("\n")}\n\n` +
      "Declare it with a label where it belongs: the module's exposes.notifications, or the kernel's list in " +
      `${KERNEL_LIST}. Otherwise the inbox shows its id and the Channels page cannot offer it.`,
  );
}
if (unsent.length) {
  console.error(
    `✗ lint:notifications-are-named: ${unsent.length} declared kind(s) nothing sends:\n${unsent.join("\n")}\n\n` +
      "Remove the declaration (it offers a switch for mail that never comes), or, when something this lint " +
      "cannot see sends it, name that sender on the line above: // notification-sent-elsewhere: <what sends it>.",
  );
}
if (out.length || unsent.length) process.exit(1);
console.log(`✓ lint:notifications-are-named: ${sent} notification send(s), each a named kind (${declared.size} declared)`);

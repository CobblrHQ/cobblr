#!/usr/bin/env tsx
// Dark text tokens and muted utility lifts read at least 4.5:1 on every dark ground.
//
// THE BUG THIS PREVENTS. Settings hints used a readable faint token, then overrode it with a slate
// utility that read 4.03:1 on cards. Check the overrides as well as the tokens.
// THE RULE. Check all semantic text tokens and muted lifts on every standard
// dark ground, including force-dark. Missing tokens or lifts fail closed.
// THE BOUNDARY. Border tokens are deliberately quieter and are judged by dark-line-reads;
// this rule covers text on the standard grounds, not badges with their own fill.
// PROVE IT RED: the original slate-500 lift reads 4.03:1 on a card.
// The environment headers (web/src/lib/deploy-env.ts: Dev, Test, Staging) are
// dark grounds too: the header's account name, Build, Scan and the open nav
// entry sit on them. Dev's amber-900/85 read 3.87:1 under the account name
// (#7864), so each header's dark ground, laid over the dark canvas, is judged
// with the others.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const file = "web/src/index.css";
const css = readFileSync(file, "utf8");
type RGB = [number, number, number];
const problems: string[] = [];
const luminance = (rgb: RGB) => {
  const c = rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
};
function check(name: string, fg: RGB, grounds: Map<string, RGB>) {
  for (const [ground, bg] of grounds) {
    const a = luminance(fg), b = luminance(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5) problems.push(`${name} on ${ground} reads ${ratio.toFixed(2)}:1, below 4.5:1`);
  }
}
/** Each environment header's dark ground (`dark:bg-<colour>-<shade>/<alpha>`)
 *  as drawn over the dark canvas. None found fails closed: the parse broke. */
function envHeaderGrounds(canvas: RGB): Map<string, RGB> {
  const envFile = "web/src/lib/deploy-env.ts";
  const src = readFileSync(envFile, "utf8");
  const palette = createRequire(new URL("../web/package.json", import.meta.url))("tailwindcss/colors") as Record<string, Record<string, string>>;
  const out = new Map<string, RGB>();
  for (const m of src.matchAll(/(\w+):\s*\{[^}]*?header:\s*"[^"]*\bdark:bg-(\w+)-(\d+)(?:\/(\d+))?/g)) {
    const hex = palette[m[2]!]?.[m[3]!];
    if (!hex) throw new Error(`${envFile}: ${m[1]}'s header colour ${m[2]}-${m[3]} is not in Tailwind's palette`);
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
    const alpha = m[4] ? Number(m[4]) / 100 : 1;
    out.set(`the ${m[1]} header`, rgb.map((v, i) => Math.round(v * alpha + canvas[i]! * (1 - alpha))) as RGB);
  }
  if (out.size === 0) throw new Error(`${envFile}: no environment header grounds found`);
  return out;
}

for (const selector of ["html.dark:not([data-ws-themed])", ".force-dark"]) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${file}: missing ${selector}`);
  const block = css.slice(start, css.indexOf("}", start));
  const tokens = new Map<string, RGB>();
  for (const m of block.matchAll(/--c-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)/g)) {
    tokens.set(m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  const grounds = new Map<string, RGB>();
  for (const name of ["surface", "canvas", "subtle"]) {
    const value = tokens.get(name);
    if (!value) throw new Error(`${file}: missing ${selector} --c-${name}`);
    grounds.set(name, value);
  }
  if (selector.startsWith("html.dark")) for (const [name, rgb] of envHeaderGrounds(grounds.get("canvas")!)) grounds.set(name, rgb);
  for (const name of ["content", "muted", "faint", "accent", "danger"]) {
    if (!tokens.has(name)) throw new Error(`${file}: missing ${selector} --c-${name}`);
  }
  for (const [name, value] of tokens) {
    if (!grounds.has(name) && name !== "line") check(`${selector} --c-${name}`, value, grounds);
  }
  for (const utility of ["text-slate-400", "text-slate-500", "text-slate-600", "text-cobble-300"]) {
    const marker = `html.dark .dark\\:${utility}`;
    const ruleStart = css.indexOf(marker);
    if (ruleStart < 0) throw new Error(`${file}: missing ${marker} lift`);
    const rule = css.slice(ruleStart, css.indexOf("}", ruleStart));
    const color = /color:\s*([^;]+)/.exec(rule)?.[1];
    const token = /rgb\(var\(--c-([\w-]+)\)\)/.exec(color ?? "")?.[1];
    const hex = /^#([\da-f]{6})$/i.exec(color ?? "")?.[1];
    const value = token ? tokens.get(token) : hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB : undefined;
    if (!value) throw new Error(`${file}: cannot resolve ${marker} colour: ${color}`);
    check(`${marker} (${selector})`, value, grounds);
  }
}
if (problems.length) {
  console.error(`lint:dark-text-reads - ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${file}:1 ${problem}`);
  process.exit(1);
}
console.log("lint:dark-text-reads OK - all dark text tokens and muted lifts read at least 4.5:1");

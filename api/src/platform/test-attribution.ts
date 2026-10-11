// Which source lines each api test file runs (#5761 A1). A test door, never on production or canary
// (test-doors.ts), and only when COBBLR_TEST_ATTRIBUTION=1: the nightly attribution run boots the built
// api with it and runs the suite one file at a time, asking before and after each file. V8's precise
// coverage with call counts resets on every take, so each answer is what ran since the last one.
//
// The answer is in source terms: each executed function's dist offsets go through the file's source map
// (fast-build and tsc both write one beside it) to the .ts lines it spans, repo-relative. A change to a
// line inside one of those spans can change what that test saw; scripts/lib/test-impact.mjs selects by it.
import { Session } from "node:inspector/promises";
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CoverageFunction {
  functionName: string;
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
}
export interface ScriptCoverage {
  url: string;
  functions: CoverageFunction[];
}

/** A dist file as source: its text's line starts and its source map, or null without one. */
export interface DistFile {
  lineStarts: number[];
  map: { findEntry(line: number, column: number): { originalSource?: string; originalLine?: number } | Record<string, never> };
}

/** PURE. Offset → [line, column], both 0-based, in a file with these line starts. */
export function lineColumn(lineStarts: number[], offset: number): [number, number] {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [lo, offset - lineStarts[lo]!];
}

/**
 * PURE. The source spans that ran: for each script under `root` (never node_modules), each function
 * called at least once (its first range is the whole function), as 1-based [first, last] lines of the
 * source it came from, keyed by that source's repo-relative path. A module's own top level (the
 * function at offset 0 with no name) is the load, not a call, and is left out.
 */
export function executedSpans(scripts: ScriptCoverage[], root: string, distOf: (path: string) => DistFile | null): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const s of scripts) {
    if (!s.url.startsWith("file://")) continue;
    const path = fileURLToPath(s.url);
    if (!path.startsWith(`${root}/`) || path.includes("/node_modules/")) continue;
    let dist: DistFile | null = null;
    for (const f of s.functions) {
      const whole = f.ranges[0];
      if (!whole || whole.count === 0) continue;
      if (whole.startOffset === 0 && f.functionName === "") continue;
      dist ??= distOf(path);
      if (!dist) break;
      const start = dist.map.findEntry(...lineColumn(dist.lineStarts, whole.startOffset));
      const end = dist.map.findEntry(...lineColumn(dist.lineStarts, Math.max(whole.startOffset, whole.endOffset - 1)));
      if (!("originalSource" in start) || !start.originalSource || start.originalLine === undefined) continue;
      const src = start.originalSource.startsWith("file://") ? fileURLToPath(start.originalSource) : resolve(dirname(path), start.originalSource);
      const key = relative(root, src).split("\\").join("/");
      if (key.startsWith("..")) continue;
      const last = "originalSource" in end && end.originalSource === start.originalSource && end.originalLine !== undefined ? end.originalLine : start.originalLine;
      (out[key] ??= []).push([start.originalLine + 1, Math.max(start.originalLine, last) + 1]);
    }
  }
  for (const k of Object.keys(out)) {
    const spans = out[k]!.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out[k] = spans.filter((s, i) => i === 0 || s[0] !== spans[i - 1]![0] || s[1] !== spans[i - 1]![1]);
  }
  return out;
}

/** PURE. The repo-relative sources of every script under `root` the api has loaded (never node_modules):
 *  a file it never loaded runs nothing at its boot, whatever its top level does. */
export function loadedSources(scripts: ScriptCoverage[], root: string, distOf: (path: string) => DistFile | null): string[] {
  const out = new Set<string>();
  for (const s of scripts) {
    if (!s.url.startsWith("file://")) continue;
    const path = fileURLToPath(s.url);
    if (!path.startsWith(`${root}/`) || path.includes("/node_modules/")) continue;
    const at = distOf(path)?.map.findEntry(0, 0);
    const src = at && "originalSource" in at && at.originalSource ? (at.originalSource.startsWith("file://") ? fileURLToPath(at.originalSource) : resolve(dirname(path), at.originalSource)) : path;
    const key = relative(root, src).split("\\").join("/");
    if (!key.startsWith("..")) out.add(key);
  }
  return [...out].sort();
}

let session: Session | null = null;
let booted = false;
const dists = new Map<string, DistFile | null>();

function distOf(path: string): DistFile | null {
  if (dists.has(path)) return dists.get(path)!;
  let file: DistFile | null = null;
  try {
    const text = readFileSync(path, "utf8");
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    // A package the api runs as .ts source (platform-contract) has no map: node strips its types in
    // place, so a position in what ran is the same position in the source.
    const map = /\.[cm]?ts$/.test(path)
      ? { findEntry: (line: number) => ({ originalSource: pathToFileURL(path).href, originalLine: line }) }
      : new SourceMap(JSON.parse(readFileSync(`${path}.map`, "utf8")));
    file = { lineStarts, map };
  } catch {
    file = null;
  }
  dists.set(path, file);
  return file;
}

/** Start counting. Called once at boot when the run asked for attribution. */
export async function startTestAttribution(): Promise<void> {
  if (session) return;
  session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
}

/** What ran since the last take, as source spans, and every source loaded so far; counting starts over.
 *  `boot` marks the first take: what ran then ran while the api started, before any test asked. */
export async function takeTestAttribution(root: string): Promise<{ spans: Record<string, Array<[number, number]>>; loaded: string[]; boot: boolean }> {
  if (!session) throw new Error("test attribution is not running (COBBLR_TEST_ATTRIBUTION=1)");
  const { result } = (await session.post("Profiler.takePreciseCoverage")) as unknown as { result: ScriptCoverage[] };
  const boot = !booted;
  booted = true;
  return { spans: executedSpans(result, root, distOf), loaded: loadedSources(result, root, distOf), boot };
}

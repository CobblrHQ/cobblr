// The kernel's boot passes: the heals, reconciles and backfills boot() runs
// before the api listens. Each pass is one file in ./boot/ that default-exports
// a bootPass(...), found by reading that directory, so a new pass is a new file
// and never an edit to api/src/index.ts (#7387: every PR adding a pass used to
// add an import and a call there, and any two of them collided).
//
// boot() runs one phase at each point the order matters; within a phase a
// pass runs after every pass it names in `after`, and otherwise by name.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BOOT_PHASES = [
  /** Before the tenant migration sync: a pass whose rows the sync catches up. */
  "before-migrations",
  /** After every tenant's migrations ran, before bundles catch up. */
  "after-migrations",
  /** Installed bundles against the catalog. */
  "bundles",
  /** Per-workspace heals once the sweepers are registered. */
  "workspaces",
  /** After module apis mounted: a pass that writes through a module's own writer. */
  "after-mount",
  /** Not awaited: started once the api is up, never holding up boot. */
  "background",
] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];

export interface BootPass<R = unknown> {
  /** The [bootphase] label, unique across passes. */
  name: string;
  phase: BootPhase;
  /** Passes in the same phase this one must run after. */
  after?: string[];
  run: () => Promise<R> | R;
  /** A line for the boot log when the pass did something, or null. */
  report?: (result: R) => string | null;
}

export function bootPass<R>(pass: BootPass<R>): BootPass<R> {
  return pass;
}

/** A phase's passes in run order: each after what it names, ties by name. Pure. */
export function inRunOrder(passes: BootPass[], phase: BootPhase): BootPass[] {
  const mine = passes.filter((p) => p.phase === phase).sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(mine.map((p) => [p.name, p]));
  for (const p of mine)
    for (const a of p.after ?? []) if (!byName.has(a)) throw new Error(`boot pass ${p.name} runs after ${a}, which is not a ${phase} pass`);
  const out: BootPass[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: BootPass, path: string[]) => {
    if (state.get(p.name) === "done") return;
    if (state.get(p.name) === "visiting") throw new Error(`boot passes run after each other in a circle: ${[...path, p.name].join(" -> ")}`);
    state.set(p.name, "visiting");
    for (const a of p.after ?? []) visit(byName.get(a)!, [...path, p.name]);
    state.set(p.name, "done");
    out.push(p);
  };
  for (const p of mine) visit(p, []);
  return out;
}

let loaded: BootPass[] | undefined;

/** Every pass in ./boot/, imported once. Built (.js) or run from source (.ts), whichever this file is. */
export async function bootPasses(): Promise<BootPass[]> {
  if (loaded) return loaded;
  const dir = new URL("./boot/", import.meta.url);
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const files = readdirSync(fileURLToPath(dir))
    .filter((f) => f.endsWith(ext) && !f.endsWith(`.d${ext}`) && !f.includes(".test."))
    .sort();
  const passes: BootPass[] = [];
  for (const f of files) {
    const mod = (await import(new URL(f, dir).href)) as { default?: BootPass };
    if (!mod.default?.name || !BOOT_PHASES.includes(mod.default.phase)) throw new Error(`api/src/platform/boot/${f} does not default-export a bootPass(...)`);
    passes.push(mod.default);
  }
  const names = new Set<string>();
  for (const p of passes) {
    if (names.has(p.name)) throw new Error(`two boot passes are named ${p.name}`);
    names.add(p.name);
  }
  return (loaded = passes);
}

type Timer = <R>(label: string, p: Promise<R>) => Promise<R>;

/** Run one phase, each pass timed under its name. A background pass is started, not awaited. */
export async function runBootPhase(phase: BootPhase, time: Timer): Promise<void> {
  for (const pass of inRunOrder(await bootPasses(), phase)) {
    if (phase === "background") {
      void Promise.resolve()
        .then(() => pass.run())
        .then((r) => say(pass, r))
        .catch((err: unknown) => console.error(`[boot] ${pass.name}:`, (err as Error).message));
      continue;
    }
    say(pass, await time(pass.name, Promise.resolve(pass.run())));
  }
}

function say(pass: BootPass, result: unknown): void {
  const line = pass.report?.(result);
  if (line) console.log(`[cobblr-api] ${line}`);
}

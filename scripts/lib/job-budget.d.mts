// Types for job-budget.mjs (plain ESM so configs and npm scripts use it with node).
export declare const UNIT_MIB: { tsc: number; vitest: number; lint: number };
export declare const SHARE: number;
export declare const HEAP_NEED_MIB: { tsc: number };
export declare function availableMib(): number | null;
export declare function cgroupLimitMib(): number | null;
export declare function heapFor(kind: "tsc", o?: { limitMib?: number | null; defaultHeapMib?: number }): { ok: true; flag: string } | { ok: false; need: number; limit: number; message: string };
export declare const CAPPED_SHARE: number;
export declare function memoryRoom(): { mib: number | null; capped: boolean };
export declare function roomUnderLimitMib(v: { limit: number; current: number; file?: number }): number;
export declare function shareOf(env?: Record<string, string | undefined>, capped?: boolean): number;
export declare function splitShare(n: number, env?: Record<string, string | undefined>, capped?: boolean): Record<string, string>;
export declare function width(
  kind: "tsc" | "vitest" | "lint",
  o?: { max?: number; cores?: number; memMib?: number | null; capped?: boolean; env?: Record<string, string | undefined> },
): number;
export declare function unitMib(kind: "tsc" | "vitest" | "lint"): number;
export declare function kindOfCommand(cmd: string): "tsc" | null;
export declare const SUITE_MIN_FORKS: number;
export declare const SUITE_FULL_WIDTH_MIB: number;
export declare function suiteForks(o?: { max?: number; cores?: number; memMib?: number | null; capped?: boolean; limitMib?: number | null; env?: Record<string, string | undefined> }): { ok: true; forks: number } | { ok: false; forks: number; message: string };
export declare function slotCores(cores: number, env?: Record<string, string | undefined>): number;

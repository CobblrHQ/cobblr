// Types for load-factor.mjs. The implementation stays plain ESM so the vitest
// configs and node scripts can load it directly; these declarations let a
// test under `strict` (api, web, a package) import worn() for its timeouts.
export declare const LOAD_FACTOR_MAX: number;
export declare function loadPerCore(): number | null;
export declare function loadFactor(perCore?: number | null): number;
export declare function worn(ms: number): number;

// Types for git-env.mjs (plain ESM so shell and vitest setup can use it).
export declare const REPO_LOCATING_VARS: readonly string[];
export declare function isRepoLocating(name: string): boolean;
export declare function envForOtherRepo(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function clearRepoLocating(env?: NodeJS.ProcessEnv): string[];
